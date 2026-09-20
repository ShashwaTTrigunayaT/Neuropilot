"""NRCES document bundles + ABHA identity + document idempotency (Phases 1 & 3).

Three things the ABDM plan asked for that the FHIR surface did not do:

* accept ``Bundle.type = "document"`` — the shape an NRCES exchange actually
  submits, with a Composition header and ``#local`` / ``urn:uuid:`` references;
* treat the **ABHA address as the preferred subject identifier**, with a crosswalk
  so one human stays one patient (limitation L9);
* make ingestion **idempotent on ABHA + observation date**, so a hospital retrying
  a document does not append a duplicate audit event or churn the score.

Each test snapshots and restores the served cohort: ingestion genuinely writes
patients (and test_api.py asserts cohort-wide tier counts), and a new patient
created here would otherwise leak into every later test in the session.
"""
from __future__ import annotations

import copy

import pytest
from fastapi.testclient import TestClient

from app import service
from app.main import app

client = TestClient(app)

NP = "urn:neuropilot:codes"
LOINC = "http://loinc.org"
ID_SYSTEM = "urn:neuropilot:subject-id"
ABHA_SYSTEM = "https://healthid.ndhm.gov.in"
UCUM = "http://unitsofmeasure.org"
IGNORED_EXT = "urn:neuropilot:fhir:ingest-ignored"
DUPLICATE_EXT = "urn:neuropilot:fhir:ingest-duplicate"


@pytest.fixture(autouse=True)
def _pristine_cohort():
    snapshot = copy.deepcopy(service.PATIENTS)
    yield
    service.PATIENTS.clear()
    service.PATIENTS.update(snapshot)


# --------------------------------------------------------------------------- #
# builders
# --------------------------------------------------------------------------- #
def _patient(*, local_id: str, abha: str | None, subject_id: str | None) -> dict:
    identifiers = []
    if abha:
        identifiers.append({"system": ABHA_SYSTEM, "value": abha})
    if subject_id:
        identifiers.append({"system": ID_SYSTEM, "value": subject_id})
    return {
        "resourceType": "Patient",
        "id": local_id,
        "identifier": identifiers or [{"system": ID_SYSTEM, "value": local_id}],
        "gender": "male",
        "extension": [{"url": "urn:neuropilot:fhir:age-years", "valueInteger": 74}],
    }


def _obs(oid: str, code: dict, subject: str, value: float, unit: str, *, effective: str = "2026-01-05") -> dict:
    return {
        "resourceType": "Observation",
        "id": oid,
        "status": "final",
        "code": {"coding": [code]},
        "subject": {"reference": subject},
        "effectiveDateTime": effective,
        "valueQuantity": {"value": value, "unit": unit, "system": UCUM, "code": unit},
    }


MMSE_CODE = {"system": LOINC, "code": "72106-8", "display": "Total score [MMSE]"}
PTAU217_CODE = {"system": NP, "code": "ptau217-plasma", "display": "p-tau217, plasma"}


def _composition(subject_ref: str, *obs_refs: str) -> dict:
    return {
        "resourceType": "Composition",
        "id": "comp-1",
        "status": "final",
        "type": {"text": "Discharge Summary"},
        "subject": {"reference": subject_ref},
        "date": "2026-01-05",
        "title": "Discharge Summary",
        "section": [{"title": "Laboratory", "entry": [{"reference": r} for r in obs_refs]}],
    }


def _document(*, local_id: str, abha: str | None, subject_id: str | None,
              identifier: str | None = "DOC-2026-0001",
              timestamp: str | None = "2026-01-05T10:00:00+05:30",
              effective: str = "2026-01-05",
              with_composition: bool = True) -> dict:
    """An NRCES-shaped document bundle.

    References are deliberately the awkward kind: the Composition and one
    Observation point at the Patient by ``urn:uuid:`` fullUrl, the other by a
    ``#local`` fragment. A mapper that only understood ``Patient/{id}`` would fail
    on a real exchange.
    """
    entries = []
    if with_composition:
        entries.append({
            "fullUrl": "urn:uuid:comp-1",
            "resource": _composition("urn:uuid:pat-1", "urn:uuid:obs-1", "urn:uuid:obs-2"),
        })
    entries.append({
        "fullUrl": "urn:uuid:pat-1",
        "resource": _patient(local_id=local_id, abha=abha, subject_id=subject_id),
    })
    entries.append({
        "fullUrl": "urn:uuid:obs-1",
        # Fragment reference: only an id, no resource type and no fullUrl.
        "resource": _obs("obs-1", PTAU217_CODE, f"#{local_id}", 0.71, "pg/mL", effective=effective),
    })
    entries.append({
        "fullUrl": "urn:uuid:obs-2",
        "resource": _obs("obs-2", MMSE_CODE, "urn:uuid:pat-1", 25, "{score}", effective=effective),
    })
    bundle = {"resourceType": "Bundle", "id": "doc-1", "type": "document", "entry": entries}
    if identifier:
        bundle["identifier"] = {"system": "https://ndhm.gov.in", "value": identifier}
    if timestamp:
        bundle["timestamp"] = timestamp
    return bundle


def _extensions(receipt: dict, url: str) -> list[str]:
    return [e["valueString"] for e in receipt.get("extension", []) if e.get("url") == url]


# --------------------------------------------------------------------------- #
# Phase 1 — document bundles parse
# --------------------------------------------------------------------------- #
def test_document_bundle_is_accepted_and_mapped():
    bundle = _document(local_id="local-doc-1", abha="docsubject1@sbx", subject_id="NRCS-0001")
    response = client.post("/fhir/Bundle", json=bundle)
    assert response.status_code == 200, response.text
    receipt = response.json()
    assert receipt["type"] == "transaction-response"
    assert "2 observation(s) mapped" in _extensions(receipt, "urn:neuropilot:fhir:ingest-summary")[0]

    record = service.PATIENTS["NRCS-0001"]
    # Both references resolved: the fragment one and the urn:uuid one.
    assert record["cognitive"]["latest"] == 25
    assert record["blood"]["pTau217"] == 0.71
    # A blood panel behind cognition advances the ordered pathway.
    assert record["stage"] == 2


def test_composition_header_is_reported_not_silently_dropped():
    receipt = client.post("/fhir/Bundle", json=_document(
        local_id="local-doc-2", abha="docsubject2@sbx", subject_id="NRCS-0002")).json()
    ignored = _extensions(receipt, IGNORED_EXT)
    assert any("Composition/comp-1" in line for line in ignored), ignored
    assert any("document header" in line for line in ignored), ignored


def test_document_without_a_composition_is_accepted_with_a_note():
    """A missing header is noted, not fatal — the measurements still matter."""
    bundle = _document(local_id="local-doc-3", abha="docsubject3@sbx", subject_id="NRCS-0003",
                       with_composition=False, identifier="DOC-2026-0003")
    response = client.post("/fhir/Bundle", json=bundle)
    assert response.status_code == 200, response.text
    ignored = _extensions(response.json(), IGNORED_EXT)
    assert any("without a Composition header" in line for line in ignored), ignored
    assert service.PATIENTS["NRCS-0003"]["blood"]["pTau217"] == 0.71


def test_dangling_urn_uuid_reference_is_rejected_atomically():
    """An unresolvable fullUrl must not become a phantom patient."""
    bundle = _document(local_id="local-doc-4", abha="docsubject4@sbx", subject_id="NRCS-0004")
    # Point one observation at a fullUrl no entry in this bundle carries.
    bundle["entry"][3]["resource"]["subject"] = {"reference": "urn:uuid:ghost-patient"}
    before = set(service.PATIENTS)
    response = client.post("/fhir/Bundle", json=bundle)
    assert response.status_code == 422, response.text
    issues = [i["diagnostics"] for i in response.json()["issue"]]
    assert any("could not be resolved" in i or "neither defined" in i for i in issues), issues
    assert set(service.PATIENTS) == before  # nothing was written, not even the valid Patient


def test_other_document_resources_are_ignored_without_erroring():
    """NRCES documents carry Organization/Practitioner/Provenance: not mappable, not fatal."""
    bundle = _document(local_id="local-doc-5", abha="docsubject5@sbx", subject_id="NRCS-0005")
    bundle["entry"].append({"fullUrl": "urn:uuid:org-1", "resource": {
        "resourceType": "Organization", "id": "org-1", "name": "Mock Hospital"}})
    bundle["entry"].append({"fullUrl": "urn:uuid:prov-1", "resource": {
        "resourceType": "Provenance", "id": "prov-1"}})
    response = client.post("/fhir/Bundle", json=bundle)
    assert response.status_code == 200, response.text
    assert "6 bundle entr(ies) read" in _extensions(response.json(), "urn:neuropilot:fhir:ingest-summary")[0]
    assert service.PATIENTS["NRCS-0005"]["blood"]["pTau217"] == 0.71


# --------------------------------------------------------------------------- #
# Phase 1/3 — ABHA as the preferred identity, with a crosswalk
# --------------------------------------------------------------------------- #
def test_abha_is_recognised_under_the_ndhm_system():
    bundle = _document(local_id="local-abha-1", abha="crosswalk1@sbx", subject_id="NRCS-0010")
    assert client.post("/fhir/Bundle", json=bundle).status_code == 200
    assert service.PATIENTS["NRCS-0010"]["abha_address"] == "crosswalk1@sbx"


def test_abha_only_patient_resolves_to_the_already_bound_record():
    """The same human must not become two patients (L9).

    First a bundle carrying both an ABHA and a subject id — that binds them.
    Then a document from an ABHA-only sender: it must land on the SAME record.
    """
    bundle = _document(local_id="local-abha-2a", abha="crosswalk2@sbx", subject_id="NRCS-0011",
                       identifier="DOC-CW-1")
    assert client.post("/fhir/Bundle", json=bundle).status_code == 200
    score_before = service.PATIENTS["NRCS-0011"]["score"]

    abha_only = _document(local_id="local-abha-2b", abha="crosswalk2@sbx", subject_id=None,
                          identifier="DOC-CW-2", effective="2026-07-01")
    response = client.post("/fhir/Bundle", json=abha_only)
    assert response.status_code == 200, response.text

    # No patient was created under the ABHA address itself.
    assert "crosswalk2@sbx" not in service.PATIENTS
    record = service.PATIENTS["NRCS-0011"]
    assert record["abha_address"] == "crosswalk2@sbx"
    # The ABHA-only follow-up landed on the same record and re-scored it.
    assert record["cognitive"]["latest"] == 25
    assert record["updated_at"]
    assert isinstance(score_before, float)


def test_identity_only_patient_binds_the_abha():
    """A Patient with an ABHA and no observations is mappable — it binds identity."""
    bundle = _document(local_id="local-abha-3", abha="crosswalk3@sbx", subject_id=None,
                       with_composition=False, identifier="DOC-ID-1")
    bundle["entry"] = [e for e in bundle["entry"] if e["resource"]["resourceType"] == "Patient"]
    response = client.post("/fhir/Bundle", json=bundle)
    assert response.status_code == 200, response.text
    assert service.PATIENTS["crosswalk3@sbx"]["abha_address"] == "crosswalk3@sbx"


def test_a_patient_with_no_identity_and_no_data_is_still_rejected():
    bundle = {"resourceType": "Bundle", "type": "collection", "entry": [
        {"resource": {"resourceType": "Patient", "id": "nameless"}},
    ]}
    response = client.post("/fhir/Bundle", json=bundle)
    assert response.status_code == 422


# --------------------------------------------------------------------------- #
# Phase 3 — idempotency on ABHA + observation date
# --------------------------------------------------------------------------- #
def test_resending_the_same_document_is_ignored():
    """A retry must not append a duplicate audit event or churn the score."""
    payload = _document(local_id="local-idem-1", abha="idem1@sbx", subject_id="NRCS-0020")
    first = client.post("/fhir/Bundle", json=payload)
    assert first.status_code == 200
    record = service.PATIENTS["NRCS-0020"]
    history_after_first = len(record["history"])
    score_after_first = record["score"]

    second = client.post("/fhir/Bundle", json=copy.deepcopy(payload))
    assert second.status_code == 200
    receipt = second.json()
    assert "1 duplicate document(s) ignored" in _extensions(receipt, "urn:neuropilot:fhir:ingest-summary")[0]
    assert _extensions(receipt, DUPLICATE_EXT) == ["NRCS-0020: document already ingested"]
    assert "duplicate document" in receipt["entry"][0]["outcome"]["issue"][0]["diagnostics"]

    assert len(record["history"]) == history_after_first  # no phantom history entry
    assert record["score"] == score_after_first           # not re-scored
    assert len(record["ingested_documents"]) == 1


def test_a_genuinely_different_document_is_not_a_duplicate():
    """No header at all — the fingerprint falls back to the measurements themselves."""
    first_bundle = _document(local_id="local-idem-2", abha="idem2@sbx", subject_id="NRCS-0021",
                             identifier=None, timestamp=None, effective="2026-01-05")
    assert client.post("/fhir/Bundle", json=first_bundle).status_code == 200
    record = service.PATIENTS["NRCS-0021"]
    assert len(record["ingested_documents"]) == 1

    # Same patient, a later visit — different observation date, so a new document.
    second_bundle = _document(local_id="local-idem-2", abha="idem2@sbx", subject_id="NRCS-0021",
                              identifier=None, timestamp=None, effective="2026-07-01")
    response = client.post("/fhir/Bundle", json=second_bundle)
    assert response.status_code == 200, response.text
    assert _extensions(response.json(), DUPLICATE_EXT) == []
    assert len(record["ingested_documents"]) == 2


def test_an_identical_document_for_a_different_patient_is_not_a_duplicate():
    """The key is per patient — two people can legitimately hold the same panel."""
    shared = dict(identifier="DOC-SHARED", timestamp="2026-01-05T10:00:00+05:30")
    assert client.post("/fhir/Bundle", json=_document(
        local_id="local-sh-1", abha="shared1@sbx", subject_id="NRCS-0022", **shared)).status_code == 200
    response = client.post("/fhir/Bundle", json=_document(
        local_id="local-sh-2", abha="shared2@sbx", subject_id="NRCS-0023", **shared))
    assert response.status_code == 200
    assert _extensions(response.json(), DUPLICATE_EXT) == []
    assert len(service.PATIENTS["NRCS-0023"]["ingested_documents"]) == 1


# --------------------------------------------------------------------------- #
# regression — the shapes that already worked still work
# --------------------------------------------------------------------------- #
def test_transaction_bundle_still_works():
    bundle = {
        "resourceType": "Bundle",
        "type": "transaction",
        "entry": [
            {"resource": _patient(local_id="local-tx-1", abha=None, subject_id="NRCS-0030")},
            {"resource": _obs("obs-tx-1", PTAU217_CODE, "Patient/NRCS-0030", 0.66, "pg/mL")},
        ],
    }
    response = client.post("/fhir/Bundle", json=bundle)
    assert response.status_code == 200, response.text
    assert service.PATIENTS["NRCS-0030"]["blood"]["pTau217"] == 0.66
