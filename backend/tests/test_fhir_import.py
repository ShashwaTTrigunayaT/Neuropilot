"""SMART-session patient import (POST /fhir/smart/import-patient).

The feature exists to remove the pasted Bundle from the workflow: a clinician
already inside a chart should not have to copy JSON into another browser tab.
What has to be true for that to be safe:

* the read uses the SESSION's `iss` and token, and refuses with a named reason —
  no session, expired token, no patient in context — rather than a generic 401;
* what is fetched is exactly what the inbound mapper can read, and the write goes
  through the SAME `fhir_ingest` entry point as the paste flow, so there is one
  mapper, one write path and one scorer;
* paging is followed, because a fragment of a chart would silently produce a
  score computed from an incomplete record;
* re-importing the same chart is recognised as a duplicate instead of appending
  another audit line and churning the score;
* `Condition` is never requested (L4: no model output becomes a diagnosis, and the
  ingester has no path that can create one).

Every test uses its own subject id, because ingestion mutates the shared
in-process PATIENTS store for the lifetime of the test session.

The EHR is a MOCK server speaking the real contract shapes (searchsets with
`link[rel=next]`), for the same reason test_smart.py uses one: no hospital network
has been exercised, and saying so is part of the claim.
"""
from __future__ import annotations

import time
import uuid

import httpx
import pytest
from fastapi.testclient import TestClient

from app import config, fhir_client, fhir_import, fhir_ingest, service, smart
from app.main import app

client = TestClient(app)

ISS = "https://ehr.test/fhir"
NP = "urn:neuropilot:codes"
LOINC = "http://loinc.org"


@pytest.fixture()
def pid() -> str:
    """A subject id nothing else in the suite has touched."""
    return f"SMART-IMPORT-{uuid.uuid4().hex[:8]}"


def patient_resource(pid: str) -> dict:
    return {
        "resourceType": "Patient",
        "id": pid,
        "gender": "female",
        "birthDate": "1952-04-01",
        # An MRN-style identifier: not our subject-id system and not an ABHA shape,
        # so the served subject id must fall back to the resource id -- which is
        # what the session's patient claim and the Observations both address.
        "identifier": [{"system": "http://hospital.test/mrn", "value": "A1234"}],
    }


def _obs(pid: str, oid: str, coding: list[dict], *, quantity: dict | None = None,
         effective: str = "2026-02-01") -> dict:
    return {
        "resourceType": "Observation",
        "id": oid,
        "status": "final",
        "code": {"coding": coding},
        "subject": {"reference": f"Patient/{pid}"},
        "effectiveDateTime": effective,
        "valueQuantity": quantity,
    }


def _q(value: float, unit: str) -> dict:
    return {"value": value, "unit": unit, "system": "http://unitsofmeasure.org", "code": unit}


def observations(pid: str) -> list[dict]:
    return [
        _obs(pid, "o-mmse", [{"system": LOINC, "code": "72106-8"}], quantity=_q(24.0, "{score}")),
        _obs(pid, "o-ptau", [{"system": NP, "code": "ptau217-plasma"}], quantity=_q(0.61, "pg/mL")),
        _obs(pid, "o-hippo", [{"system": NP, "code": "hippocampal-volume"}], quantity=_q(2.71, "cm3")),
        # Recognised by the server but not part of our feature set -> reported.
        _obs(pid, "o-hr", [{"system": LOINC, "code": "8867-4"}], quantity=_q(72.0, "/min")),
    ]


def reports(pid: str) -> list[dict]:
    return [
        {
            "resourceType": "DiagnosticReport",
            "id": "dr-blood",
            "status": "final",
            "code": {"coding": [{"system": NP, "code": "panel-blood-plasma-ad"}]},
            "subject": {"reference": f"Patient/{pid}"},
            "issued": "2026-02-02T10:00:00Z",
            "conclusion": "abnormal",
        }
    ]


def _searchset(resources: list[dict], next_url: str | None = None) -> dict:
    body: dict = {"resourceType": "Bundle", "type": "searchset",
                  "entry": [{"resource": r} for r in resources]}
    if next_url:
        body["link"] = [{"relation": "next", "url": next_url}]
    return body


@pytest.fixture(autouse=True)
def _clean_smart_state():
    smart.reset()
    yield
    smart.reset()


def connect(patient: str | None, *, iss: str = ISS, token: str = "tok-1",
            expires_in: float = 3600) -> None:
    """A bound session, exactly the shape handle_callback stores."""
    smart._SESSION = {
        "iss": iss,
        "token_endpoint": f"{iss}/oauth2/token",
        "access_token": token,
        "refresh_token": "r1",
        "token_type": "Bearer",
        "scope": " ".join(smart.scopes()),
        "patient": patient,
        "encounter": None,
        "fhir_user": None,
        "id_token": None,
        "expires_at": time.time() + expires_in,
        "connected_at": time.time(),
    }


def ehr(pid: str, *, patient: dict | None = None, obs: list[dict] | None = None,
        reps: list[dict] | None = None, calls: list[str] | None = None,
        status_for: dict[str, int] | None = None):
    """A mock EHR: the three reads the import makes, in the shapes they return."""
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path.rstrip("/")
        if calls is not None:
            calls.append(str(request.url))
        for needle, code in (status_for or {}).items():
            if needle in str(request.url):
                return httpx.Response(code, text=f"refused ({code})")
        if path.endswith(f"/Patient/{pid}"):
            return httpx.Response(200, json=patient or patient_resource(pid))
        if path.endswith("/Observation"):
            return httpx.Response(200, json=_searchset(observations(pid) if obs is None else obs))
        if path.endswith("/DiagnosticReport"):
            return httpx.Response(200, json=_searchset(reports(pid) if reps is None else reps))
        return httpx.Response(404)

    return handler


def mock(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


# --------------------------------------------------------------------------- #
# the session is the gate
# --------------------------------------------------------------------------- #
def test_no_session_is_a_401_that_names_the_fix():
    with pytest.raises(fhir_import.FhirImportError) as exc:
        fhir_import.import_from_smart_session()
    assert exc.value.status_code == 401
    assert "/fhir/smart/launch" in exc.value.message


def test_expired_token_is_a_401_about_the_token():
    connect("Patient/x", expires_in=-1)
    assert smart.access_token() is None
    with pytest.raises(fhir_import.FhirImportError) as exc:
        fhir_import.import_from_smart_session()
    assert exc.value.status_code == 401
    assert "expired" in exc.value.message


def test_session_without_patient_context_is_a_401_about_the_scope():
    connect(None)
    with pytest.raises(fhir_import.FhirImportError) as exc:
        fhir_import.import_from_smart_session()
    assert exc.value.status_code == 401
    assert "patient context" in exc.value.message


def test_endpoint_returns_an_operation_outcome_401_without_a_session():
    response = client.post("/fhir/smart/import-patient")
    assert response.status_code == 401
    assert "application/fhir+json" in response.headers["content-type"]
    body = response.json()
    assert body["resourceType"] == "OperationOutcome"
    assert body["issue"][0]["code"] == "login"


# --------------------------------------------------------------------------- #
# the read
# --------------------------------------------------------------------------- #
def test_reads_only_the_resource_types_the_mapper_can_use(pid):
    """`Condition` is never requested -- the ingester cannot create one (L4)."""
    calls: list[str] = []
    connect(f"Patient/{pid}")
    fhir_import.import_from_smart_session(client=mock(ehr(pid, calls=calls)))

    assert any(f"/Patient/{pid}" in c for c in calls)
    assert any("/Observation?" in c for c in calls)
    assert any("/DiagnosticReport?" in c for c in calls)
    assert not any("Condition" in c for c in calls)
    # One read of each type when the server offers no next page.
    assert len(calls) == 3


def test_search_results_are_paginated(pid):
    """A chart spanning several pages must be read completely, not partially."""
    pages = {
        "1": [observations(pid)[0], observations(pid)[1]],
        "2": [observations(pid)[2]],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith(f"/Patient/{pid}"):
            return httpx.Response(200, json=patient_resource(pid))
        if request.url.path.endswith("/Observation"):
            page = dict(request.url.params).get("page", "1")
            nxt = f"{ISS}/Observation?patient={pid}&page=2" if page == "1" else None
            return httpx.Response(200, json=_searchset(pages[page], nxt))
        return httpx.Response(200, json=_searchset([]))

    fetched = fhir_import.fetch_patient_resources(ISS, "tok-1", pid, client=mock(handler))
    assert len(fetched["Observation"]) == 3


def test_paging_is_capped(pid):
    """A server that always offers a `next` link must not be walked forever."""
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/Observation"):
            calls.append(str(request.url))
            return httpx.Response(200, json=_searchset(
                [observations(pid)[0]], f"{ISS}/Observation?patient={pid}&page=next"))
        if request.url.path.endswith(f"/Patient/{pid}"):
            return httpx.Response(200, json=patient_resource(pid))
        return httpx.Response(200, json=_searchset([]))

    fhir_import.fetch_patient_resources(ISS, "tok-1", pid, client=mock(handler))
    assert len(calls) == fhir_import._MAX_SEARCH_PAGES


def test_ehr_refusal_of_the_read_is_reported_as_401(pid):
    connect(f"Patient/{pid}")
    with pytest.raises(fhir_import.FhirImportError) as exc:
        fhir_import.import_from_smart_session(
            client=mock(ehr(pid, status_for={"/Patient/": 403})))
    assert exc.value.status_code == 401
    assert "refused" in exc.value.message


def test_missing_patient_is_a_404(pid):
    connect(f"Patient/{pid}")
    with pytest.raises(fhir_import.FhirImportError) as exc:
        fhir_import.import_from_smart_session(
            client=mock(ehr(pid, status_for={"/Patient/": 404})))
    assert exc.value.status_code == 404


# --------------------------------------------------------------------------- #
# the write: one ingest path, re-scored, idempotent
# --------------------------------------------------------------------------- #
def test_import_creates_the_patient_and_reports_the_served_score(pid):
    connect(f"Patient/{pid}")
    result = fhir_import.import_from_smart_session(client=mock(ehr(pid)))

    assert result["subject_id"] == pid
    assert result["created"] is True
    assert result["duplicate"] is False
    assert result["fetched"] == {"Patient": 1, "Observation": 4, "DiagnosticReport": 1}
    assert result["mapped"] == {"observations": 3, "reports": 1, "slots": ["blood", "imaging"]}

    # The score returned is the SERVED score, computed through
    # service.ingest_record by the served model -- not a number computed at the
    # integration boundary.
    served = service.get_patient(pid)
    assert served is not None
    assert result["score"] == served["official_score"]
    assert result["risk_tier"] == served["risk_tier"]
    assert result["stage"] == served["stage"] == 3   # blood + MRI on file, no PET


def test_import_maps_the_measurements_and_ignores_the_rest(pid):
    connect(f"Patient/{pid}")
    result = fhir_import.import_from_smart_session(client=mock(ehr(pid)))

    record = service.PATIENTS[pid]
    assert record["blood"]["pTau217"] == 0.61
    assert record["imaging"]["hippocampalVolumeCm3"] == 2.71
    assert record["cognitive"]["latest"] == 24.0
    assert record["sex"] == "F" and record["age"] == 2026 - 1952
    assert record["reports"]["blood"]["outcome"] == "abnormal"
    # Unrecognised, reported rather than dropped silently.
    assert any("o-hr" in line for line in result["ignored"])


def test_reimporting_the_same_chart_is_a_duplicate(pid):
    """Idempotent on the measurements themselves: no header, nothing written twice."""
    connect(f"Patient/{pid}")
    first = fhir_import.import_from_smart_session(client=mock(ehr(pid)))
    history_after_first = len(service.PATIENTS[pid]["history"])

    second = fhir_import.import_from_smart_session(client=mock(ehr(pid)))
    assert first["duplicate"] is False
    assert second["duplicate"] is True
    assert second["created"] is False
    assert len(service.PATIENTS[pid]["history"]) == history_after_first


def test_the_assembled_bundle_carries_no_document_header(pid):
    """The duplicate guard above depends on this: no identifier, no timestamp."""
    bundle = fhir_import.collection_bundle({
        "Patient": [patient_resource(pid)],
        "Observation": observations(pid),
        "DiagnosticReport": reports(pid),
    })
    assert bundle["type"] == "collection"
    assert "identifier" not in bundle and "timestamp" not in bundle
    assert len(bundle["entry"]) == 1 + len(observations(pid)) + len(reports(pid))


def test_a_chart_with_nothing_mappable_is_rejected_by_the_shared_mapper(pid):
    """No measurements, no demographics, no ABHA -> the ingester's own 422."""
    connect(f"Patient/{pid}")
    bare = {"resourceType": "Patient", "id": pid}
    with pytest.raises(fhir_ingest.IngestError) as exc:
        fhir_import.import_from_smart_session(
            client=mock(ehr(pid, patient=bare, obs=[], reps=[])))
    assert any("nothing mappable" in issue["diagnostics"] for issue in exc.value.issues)


# --------------------------------------------------------------------------- #
# HTTP surface
# --------------------------------------------------------------------------- #
def test_endpoint_imports_over_http(pid, monkeypatch):
    """The served path: the endpoint owns client construction, so patch the factory."""
    connect(f"Patient/{pid}")
    transport = httpx.MockTransport(ehr(pid))
    real_client = httpx.Client

    def factory(*args, **kwargs):
        kwargs.setdefault("transport", transport)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "Client", factory)

    response = client.post("/fhir/smart/import-patient")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["subject_id"] == pid
    assert isinstance(body["score"], float)
    assert body["receipt"]["resourceType"] == "Bundle"
    assert body["session"]["iss"] == ISS

    # And the imported patient is served by the app afterwards.
    detail = client.get(f"/patients/{pid}")
    assert detail.status_code == 200
    assert detail.json()["official_score"] == body["score"]


# --------------------------------------------------------------------------- #
# where an outbound push goes
# --------------------------------------------------------------------------- #
def test_push_targets_the_session_server_over_the_configured_one(monkeypatch):
    monkeypatch.setattr(config, "FHIR_BASE_URL", "http://configured.test/fhir")
    connect("Patient/whatever")

    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        return httpx.Response(200, json={"resourceType": "Bundle", "type": "transaction-response",
                                         "entry": [{"response": {"status": "200 OK"}}]})

    pid = next(iter(service.PATIENTS))
    fhir_client.push_patient(pid, client=mock(handler))
    # A transaction POST goes to the server root: the session's iss, not the
    # configured base URL...
    assert seen["url"] == ISS
    # ...and with the token that belongs to it.
    assert seen["auth"] == "Bearer tok-1"


def test_push_falls_back_to_the_configured_server_without_a_session(monkeypatch):
    monkeypatch.setattr(config, "FHIR_BASE_URL", "http://configured.test/fhir")
    assert fhir_client.session_base_url() is None
    assert fhir_client._base_url() == "http://configured.test/fhir"


def test_push_without_any_target_says_so(monkeypatch):
    monkeypatch.setattr(config, "FHIR_BASE_URL", "")
    pid = next(iter(service.PATIENTS))
    with pytest.raises(fhir_client.FHIRClientError) as exc:
        fhir_client.push_patient(pid)
    assert "FHIR_BASE_URL" in exc.value.message


def test_probe_reports_the_session_as_the_source(monkeypatch):
    monkeypatch.setattr(config, "FHIR_BASE_URL", "")
    connect("Patient/whatever")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"resourceType": "CapabilityStatement", "fhirVersion": "4.0.1",
                                         "software": {"name": "Mock EHR"}})

    report = fhir_client.probe(client=mock(handler))
    assert report["configured"] is True
    assert report["source"] == "smart-session"
    assert report["base_url"] == ISS
    assert report["reachable"] is True
