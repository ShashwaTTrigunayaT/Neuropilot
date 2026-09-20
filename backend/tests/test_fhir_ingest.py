"""FHIR inbound ingestion tests (Phase 2, FHIR_INTEGRATION.md).

Covers the contract a hospital integration is judged on:

* a transaction Bundle creates/refreshes a patient and the served model
  re-scores it (via service.ingest_record -- never a re-implementation);
* units are enforced, and a wrong unit rejects the WHOLE bundle (atomic) so a
  patient is never half-written;
* unrecognised observations are reported, not silently dropped;
* a $everything export round-trips back through /fhir/Bundle;
* the no-diagnosis invariant holds after ingestion (no Condition appears).

Every test uses its own patient id, because ingestion mutates the shared
in-process PATIENTS store for the lifetime of the test session.
"""
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

NP = "urn:neuropilot:codes"
LOINC = "http://loinc.org"
ID_SYSTEM = "urn:neuropilot:subject-id"
AGE_EXT = "urn:neuropilot:fhir:age-years"


# --------------------------------------------------------------------------- #
# fixtures
# --------------------------------------------------------------------------- #
def _patient(pid: str, *, gender: str = "female", age: int = 72, local_id: str = "local-1") -> dict:
    return {
        "resourceType": "Patient",
        "id": local_id,
        "identifier": [{"system": ID_SYSTEM, "value": pid}],
        "gender": gender,
        "extension": [{"url": AGE_EXT, "valueInteger": age}],
    }


def _obs(oid: str, coding: list[dict], *, subject: str, quantity: dict | None = None,
         codeable: dict | None = None, effective: str = "2026-01-01") -> dict:
    res: dict = {
        "resourceType": "Observation",
        "id": oid,
        "status": "final",
        "code": {"coding": coding},
        "subject": {"reference": f"Patient/{subject}"},
        "effectiveDateTime": effective,
    }
    if quantity is not None:
        res["valueQuantity"] = quantity
    if codeable is not None:
        res["valueCodeableConcept"] = codeable
    return res


def _bundle(resources: list[dict], btype: str = "transaction") -> dict:
    return {"resourceType": "Bundle", "type": btype, "entry": [{"resource": r} for r in resources]}


def _mmse(oid: str, value: float, subject: str, effective: str = "2026-01-01") -> dict:
    return _obs(
        oid,
        [{"system": LOINC, "code": "72106-8", "display": "Total score [MMSE]"}],
        subject=subject,
        quantity={"value": value, "unit": "score", "system": "http://unitsofmeasure.org", "code": "{score}"},
        effective=effective,
    )


def _quantity(value: float, unit: str, code: str) -> dict:
    return {"value": value, "unit": unit, "system": "http://unitsofmeasure.org", "code": code}


def _post(bundle: dict):
    return client.post("/fhir/Bundle", json=bundle)


# --------------------------------------------------------------------------- #
# happy path: create + re-score
# --------------------------------------------------------------------------- #
def test_ingest_creates_patient_and_rescores():
    pid = "FHIR-TEST-CREATE"
    bundle = _bundle([
        _patient(pid),
        _mmse("m1", 23.0, pid),
        _obs("b1", [{"system": NP, "code": "ptau217-plasma"}], subject=pid,
             quantity=_quantity(0.61, "pg/mL", "pg/mL")),
        _obs("b2", [{"system": NP, "code": "nfl-plasma"}], subject=pid,
             quantity=_quantity(31.2, "pg/mL", "pg/mL")),
        _obs("i1", [{"system": NP, "code": "hippocampal-volume"}], subject=pid,
             quantity=_quantity(2.71, "cm3", "cm3")),
    ])
    r = _post(bundle)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["resourceType"] == "Bundle"
    assert body["type"] == "transaction-response"
    assert any(e["response"]["location"] == f"Patient/{pid}" for e in body["entry"])

    detail = client.get(f"/patients/{pid}")
    assert detail.status_code == 200
    d = detail.json()
    assert d["blood"]["pTau217"] == 0.61
    assert d["blood"]["nfl"] == 31.2
    assert d["imaging"]["hippocampalVolumeCm3"] == 2.71
    assert d["cognitive"]["latest"] == 23.0
    # blood + MRI on file, no PET -> contiguous prefix reaches stage 3
    assert d["stage"] == 3
    assert isinstance(d["score"], float)
    assert d["risk_tier"] in ("low", "medium", "high")


def test_ingest_response_reports_scoring():
    pid = "FHIR-TEST-REPORT"
    r = _post(_bundle([_patient(pid), _mmse("m1", 21.0, pid)]))
    assert r.status_code == 200
    extension = {e["url"]: e["valueString"] for e in r.json()["extension"]}
    assert "1 created" in extension["urn:neuropilot:fhir:ingest-summary"]
    issue = r.json()["entry"][0]["outcome"]["issue"][0]["diagnostics"]
    assert "tier" in issue and "stage" in issue


# --------------------------------------------------------------------------- #
# two MMSE observations resolve to latest / prior
# --------------------------------------------------------------------------- #
def test_ingest_resolves_mmse_latest_and_prior():
    pid = "FHIR-TEST-MMSE"
    bundle = _bundle([
        _patient(pid),
        _mmse("m-old", 29.0, pid, effective="2025-06-01"),
        _mmse("m-new", 24.0, pid, effective="2026-01-01"),
    ])
    assert _post(bundle).status_code == 200
    cog = client.get(f"/patients/{pid}").json()["cognitive"]
    assert cog["latest"] == 24.0
    assert cog["prior"] == 29.0


# --------------------------------------------------------------------------- #
# PET status maps from valueCodeableConcept
# --------------------------------------------------------------------------- #
def test_ingest_pet_status_codeable():
    pid = "FHIR-TEST-PET"
    bundle = _bundle([
        _patient(pid),
        _mmse("m1", 22.0, pid),
        _obs("p1", [{"system": NP, "code": "amyloid-pet-status"}], subject=pid,
             codeable={"text": "Positive"}),
        _obs("p2", [{"system": NP, "code": "centiloids"}], subject=pid,
             quantity=_quantity(84.0, "1", "1")),
    ])
    assert _post(bundle).status_code == 200
    pet = client.get(f"/patients/{pid}").json()["pet"]
    assert pet["amyloid"] == "Positive"
    assert pet["centiloids"] == 84.0


# --------------------------------------------------------------------------- #
# unit enforcement + atomicity
# --------------------------------------------------------------------------- #
def test_ingest_rejects_wrong_unit_atomically():
    pid = "FHIR-TEST-BADUNIT"
    bundle = _bundle([
        _patient(pid),
        _mmse("m1", 24.0, pid),
        # mg/dL is the wrong dimension for a plasma p-tau -> must be refused
        _obs("b1", [{"system": NP, "code": "ptau217-plasma"}], subject=pid,
             quantity=_quantity(0.5, "mg/dL", "mg/dL")),
    ])
    r = _post(bundle)
    assert r.status_code == 422
    assert "application/fhir+json" in r.headers["content-type"]
    oo = r.json()
    assert oo["resourceType"] == "OperationOutcome"
    assert any("does not match the expected UCUM unit" in i["diagnostics"] for i in oo["issue"])
    # atomic: the patient must not have been partially created
    assert client.get(f"/patients/{pid}").status_code == 404


def test_ingest_rejects_missing_unit():
    pid = "FHIR-TEST-NOUNIT"
    bundle = _bundle([
        _patient(pid),
        _obs("b1", [{"system": NP, "code": "nfl-plasma"}], subject=pid,
             quantity={"value": 22.0}),  # no unit declared at all -> refuse, never guess
    ])
    r = _post(bundle)
    assert r.status_code == 422
    assert any("does not match the expected UCUM unit" in i["diagnostics"] for i in r.json()["issue"])


# --------------------------------------------------------------------------- #
# structural rejection
# --------------------------------------------------------------------------- #
def test_ingest_rejects_non_bundle():
    r = _post({"resourceType": "RiskAssessment", "status": "final"})
    assert r.status_code == 422
    assert r.json()["resourceType"] == "OperationOutcome"


def test_ingest_rejects_unknown_bundle_type():
    """`document` is now ACCEPTED (an NRCES exchange submits documents — see
    test_fhir_nrces.py); a type with no ingestion meaning is still refused."""
    r = _post({"resourceType": "Bundle", "type": "message", "entry": [{"resource": _patient("X")}]})
    assert r.status_code == 422
    assert any("Bundle.type" in i["diagnostics"] for i in r.json()["issue"])


def test_ingest_rejects_observation_without_resolvable_subject():
    r = _post(_bundle([_obs("o1", [{"system": NP, "code": "nfl-plasma"}], subject="Patient/GHOST",
                              quantity=_quantity(20.0, "pg/mL", "pg/mL"))]))
    # a dangling reference must not silently create a phantom patient
    assert r.status_code == 422
    assert any("neither defined" in i["diagnostics"] for i in r.json()["issue"])
    assert client.get("/patients/GHOST").status_code == 404


# --------------------------------------------------------------------------- #
# unknown observations are reported, not dropped silently
# --------------------------------------------------------------------------- #
def test_ingest_reports_ignored_observation():
    pid = "FHIR-TEST-IGNORED"
    bundle = _bundle([
        _patient(pid),
        _mmse("m1", 26.0, pid),
        _obs("v1", [{"system": LOINC, "code": "8867-4", "display": "Heart rate"}], subject=pid,
             quantity=_quantity(72.0, "/min", "/min")),
    ])
    r = _post(bundle)
    assert r.status_code == 200
    ignored = [e["valueString"] for e in r.json()["extension"] if e["url"] == "urn:neuropilot:fhir:ingest-ignored"]
    assert any("Heart rate" in s or "Observation/v1" in s for s in ignored)


# --------------------------------------------------------------------------- #
# round-trip: export -> ingest
# --------------------------------------------------------------------------- #
def test_everything_bundle_round_trips():
    ids = [i["id"] for i in client.get("/patients", params={"limit": 200}).json()["items"]]
    assert ids, "cohort is empty -- cannot run the round-trip test"
    pid = ids[0]
    before = client.get(f"/patients/{pid}").json()
    exported = client.get(f"/fhir/Patient/{pid}/$everything").json()
    assert exported["resourceType"] == "Bundle"

    r = _post(exported)
    assert r.status_code == 200, r.text
    after = client.get(f"/patients/{pid}").json()
    # re-ingesting the same measurements must not change the official score
    assert abs(after["official_score"] - before["official_score"]) < 1e-6
    assert after["stage"] == before["stage"]


# --------------------------------------------------------------------------- #
# no-diagnosis invariant survives ingestion
# --------------------------------------------------------------------------- #
def test_ingest_never_creates_condition():
    pid = "FHIR-TEST-NOCONDITION"
    assert _post(_bundle([_patient(pid), _mmse("m1", 23.0, pid)])).status_code == 200
    exported = client.get(f"/fhir/Patient/{pid}/$everything").json()
    types = {e["resource"]["resourceType"] for e in exported.get("entry", [])}
    assert "Condition" not in types


# --------------------------------------------------------------------------- #
# capability statement advertises the transaction
# --------------------------------------------------------------------------- #
def test_capability_statement_advertises_transaction():
    rest = client.get("/fhir/metadata").json()["rest"][0]
    assert {"code": "transaction"} in rest.get("interaction", [])
