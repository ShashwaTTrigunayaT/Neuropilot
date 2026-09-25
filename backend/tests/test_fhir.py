"""FHIR export tests (Phase 1, FHIR_INTEGRATION.md).

Data-agnostic like test_api.py: snapshots the cohort from the live store, then
asserts structure and the decision-support contract on what it finds.

The headline invariant: **model output never becomes a Condition** -- no bundle
NeuroPilot emits may contain a Condition resource, and every RiskAssessment
carries the decision-support disclaimer.
"""
from fastapi.testclient import TestClient

from app import fhir
from app.main import app

client = TestClient(app)


def _all_ids(limit: int = 200) -> list[str]:
    r = client.get("/patients", params={"limit": limit})
    assert r.status_code == 200
    return [i["id"] for i in r.json()["items"]]


_IDS = _all_ids()
assert _IDS, "cohort is empty -- cannot run FHIR tests"


# --------------------------------------------------------------------------- #
# CapabilityStatement
# --------------------------------------------------------------------------- #
def test_fhir_metadata():
    r = client.get("/fhir/metadata")
    assert r.status_code == 200
    assert "application/fhir+json" in r.headers["content-type"]
    body = r.json()
    assert body["resourceType"] == "CapabilityStatement"
    assert body["fhirVersion"] == "4.0.1"
    types = {res["type"] for res in body["rest"][0]["resource"]}
    assert {"Patient", "Observation", "RiskAssessment"} <= types


# --------------------------------------------------------------------------- #
# Patient read + search
# --------------------------------------------------------------------------- #
def test_fhir_patient_read():
    pid = _IDS[0]
    r = client.get(f"/fhir/Patient/{pid}")
    assert r.status_code == 200
    p = r.json()
    assert p["resourceType"] == "Patient"
    assert p["id"] == pid
    assert p["gender"] in ("male", "female", "unknown")
    assert p["identifier"][0]["system"] == "urn:neuropilot:subject-id"
    # age extension present when the record carries age
    if "birthDate" in p:
        assert any(e["url"] == "urn:neuropilot:fhir:age-years" for e in p.get("extension", []))


def test_fhir_patient_read_404():
    r = client.get("/fhir/Patient/NOPE")
    assert r.status_code == 200  # FHIR reports not-found as an OperationOutcome payload
    body = r.json()
    assert body["resourceType"] == "OperationOutcome"
    assert body["issue"][0]["code"] == "not-found"


def test_fhir_patient_search():
    r = client.get("/fhir/Patient", params={"count": 5})
    assert r.status_code == 200
    b = r.json()
    assert b["resourceType"] == "Bundle"
    assert b["type"] == "searchset"
    assert b["total"] >= len(_IDS)
    entries = b["entry"][:5]
    assert all(e["resource"]["resourceType"] == "Patient" for e in entries)


# --------------------------------------------------------------------------- #
# Observation export: verified LOINC where it exists, honest custom codes where not
# --------------------------------------------------------------------------- #
def _patient_observations(pid: str) -> list[dict]:
    r = client.get("/fhir/Observation", params={"patient": f"Patient/{pid}", "count": 500})
    assert r.status_code == 200
    b = r.json()
    assert b["resourceType"] == "Bundle"
    return [e["resource"] for e in b["entry"]]


def test_fhir_observations_loinc_codes():
    obs = _patient_observations(_IDS[0])
    assert obs, "expected at least one Observation for the highest-risk patient"
    systems = set()
    for o in obs:
        assert o["resourceType"] == "Observation"
        assert o["status"] == "final"
        assert o["subject"]["reference"] == f"Patient/{_IDS[0]}"
        for c in o["code"]["coding"]:
            systems.add(c["system"])
    # MMSE must be LOINC 72106-8; NP custom system only for unmapped measures
    assert "http://loinc.org" in systems
    assert "urn:neuropilot:codes" in systems  # imaging/PET have no standard LOINC (L1)


def test_fhir_observation_values_match_record():
    pid = _IDS[0]
    detail = client.get(f"/patients/{pid}").json()
    obs = _patient_observations(pid)
    by_code_text = {o["code"]["text"]: o for o in obs}
    cog = detail.get("cognitive") or {}
    if cog.get("latest") is not None:
        mmse = by_code_text.get("MMSE total score")
        assert mmse is not None
        assert mmse["valueQuantity"]["value"] == cog["latest"]
    blood = detail.get("blood") or {}
    if isinstance(blood, dict) and blood.get("pTau181") is not None:
        ptau = by_code_text.get("p-tau181 (plasma)")
        assert ptau is not None
        assert ptau["valueQuantity"]["value"] == blood["pTau181"]
        assert ptau["valueQuantity"]["code"] == "pg/mL"


# --------------------------------------------------------------------------- #
# a record the export must not choke on
#
# The result form stores what the clinician typed, so a slot can hold text. A
# Quantity cannot be built from it -- and `observation_resources` runs over the
# WHOLE cohort in /fhir/status, so raising here once took the integration panel
# down for every patient in the store.
# --------------------------------------------------------------------------- #
def _record(**slots) -> dict:
    return {"id": "EXPORT-TEXT", "age": 74, "sex": "M", "score": 0.72, "stage": 3,
            "updated_at": "2026-09-25 10:00", "history": [], "factors": [], **slots}


def test_observation_skips_a_value_that_is_not_a_number():
    obs = fhir.observation_resources(_record(blood={
        "status": "completed", "outcome": "abnormal", "note": "units typed in",
        "pTau181": "5.1 ng/mL", "abeta4240": 0.058,
    }))
    ids = [o["id"] for o in obs]
    assert "obs-EXPORT-TEXT-ptau181" not in ids, "text is not a measurement"
    assert "obs-EXPORT-TEXT-abeta4240" in ids, "the rest of the record must survive"
    quantity = next(o["valueQuantity"] for o in obs if o["id"].endswith("abeta4240"))
    assert quantity["value"] == 0.058


def test_observation_accepts_a_numeric_string():
    obs = fhir.observation_resources(_record(blood={"status": "completed", "pTau181": "5.1"}))
    value = next(o["valueQuantity"]["value"] for o in obs if o["id"].endswith("ptau181"))
    assert value == 5.1 and isinstance(value, float)


def test_pet_suvr_exports_under_either_spelling():
    """Inbound mapping writes `amyloidSuvr` while the export asked for
    `amyloidSUVr`, so a value that arrived from a hospital exported as nothing."""
    for key in ("amyloidSUVr", "amyloidSuvr"):
        obs = fhir.observation_resources(_record(pet={"status": "completed", key: 1.31}))
        suvr = [o for o in obs if o["id"].endswith("amyloid-suvr")]
        assert len(suvr) == 1, f"{key} produced {len(suvr)} observations"
        assert suvr[0]["valueQuantity"]["value"] == 1.31


def test_one_measurement_named_both_ways_yields_one_observation():
    obs = fhir.observation_resources(_record(
        pet={"status": "completed", "amyloidSUVr": 1.31, "amyloidSuvr": 1.31}))
    assert len([o for o in obs if o["id"].endswith("amyloid-suvr")]) == 1


def test_fhir_observation_patient_not_found():
    r = client.get("/fhir/Observation", params={"patient": "Patient/NOPE"})
    assert r.json()["resourceType"] == "OperationOutcome"


# --------------------------------------------------------------------------- #
# RiskAssessment export: the decision-support contract in FHIR form
# --------------------------------------------------------------------------- #
def test_fhir_risk_assessment_search():
    r = client.get("/fhir/RiskAssessment", params={"count": 10})
    assert r.status_code == 200
    b = r.json()
    assert b["type"] == "searchset"
    ras = [e["resource"] for e in b["entry"]][:10]
    assert ras
    for ra in ras:
        assert ra["resourceType"] == "RiskAssessment"
        pred = ra["prediction"][0]
        assert 0.0 <= pred["probabilityDecimal"] <= 1.0
        assert pred["qualitativeRisk"]["coding"][0]["code"] in ("H", "M", "L")
        # Contract: the disclaimer rides every RiskAssessment
        assert any("never a diagnosis" in n["text"] for n in ra["note"])


def test_fhir_risk_assessment_for_patient():
    pid = _IDS[0]
    r = client.get("/fhir/RiskAssessment", params={"patient": pid})
    b = r.json()
    ras = [e["resource"] for e in b["entry"]]
    assert len(ras) == 1
    ra = ras[0]
    assert ra["subject"]["reference"] == f"Patient/{pid}"
    detail = client.get(f"/patients/{pid}").json()
    assert ra["prediction"][0]["probabilityDecimal"] == detail["score"]


# --------------------------------------------------------------------------- #
# $everything bundle + the headline invariant
# --------------------------------------------------------------------------- #
def test_fhir_everything_bundle_shape():
    pid = _IDS[0]
    r = client.get(f"/fhir/Patient/{pid}/$everything")
    assert r.status_code == 200
    b = r.json()
    assert b["resourceType"] == "Bundle"
    assert b["type"] == "collection"
    types = [e["resource"]["resourceType"] for e in b["entry"]]
    assert types[0] == "Patient"
    assert "RiskAssessment" in types
    assert "Observation" in types
    # fullUrls are unique and well-formed
    urls = [e["fullUrl"] for e in b["entry"]]
    assert len(urls) == len(set(urls))


def test_fhir_never_emits_condition():
    """The contract: model output never becomes a diagnosis, in ANY bundle.

    Scans Patient/$everything for a full page of the cohort. No `Condition` is
    ever emitted. A `DiagnosticReport` may appear (Phase 3: it is the report on
    an ordered panel), but its conclusion may only describe THAT TEST --
    normal/abnormal/inconclusive -- and never the model's risk output or a
    disease name. That is the line that keeps decision support from silently
    becoming a diagnosis once it syncs into an EHR.
    """
    forbidden = ("alzheimer", "dementia", "neuropilot risk", "priority tier")
    for pid in _IDS[:25]:
        b = client.get(f"/fhir/Patient/{pid}/$everything").json()
        for e in b["entry"]:
            res = e["resource"]
            assert res["resourceType"] != "Condition", "no-diagnosis contract violated!"
            if res["resourceType"] != "DiagnosticReport":
                continue
            conclusion = str(res.get("conclusion") or "").lower()
            assert not any(word in conclusion for word in forbidden), conclusion
            # The conclusion is the panel's own read, nothing more.
            assert conclusion.split(":")[-1].strip() in ("normal", "abnormal", "inconclusive")
            for coding in res.get("conclusionCode") or []:
                assert coding["coding"][0]["system"].endswith("v3-ObservationInterpretation")


def test_fhir_everything_unknown_patient():
    b = client.get("/fhir/Patient/NOPE/$everything").json()
    assert b["resourceType"] == "OperationOutcome"
    assert b["issue"][0]["code"] == "not-found"


# --------------------------------------------------------------------------- #
# AuditEvent export (event & reasoning trail)
# --------------------------------------------------------------------------- #
def test_fhir_audit_events_present():
    # pick a mutated patient (auto-workup adds history rows); fall back to any
    items = client.get("/patients", params={"limit": 200}).json()["items"]
    pid = items[0]["id"]
    b = client.get(f"/fhir/Patient/{pid}/$everything").json()
    audits = [e["resource"] for e in b["entry"] if e["resource"]["resourceType"] == "AuditEvent"]
    detail = client.get(f"/patients/{pid}").json()
    if detail["history"]:
        assert audits, "history rows must surface as AuditEvents"
        texts = [a["entity"][0]["detail"][0]["valueString"] for a in audits]
        assert any(t for t in texts), "audit events must carry the event text"
