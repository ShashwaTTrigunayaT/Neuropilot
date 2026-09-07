"""API tests (run from backend/: pytest).

Data-agnostic: the suite snapshots the cohort from the live store at import
(mock seed OR real OASIS risk scores) and asserts the decision-support contract
around what it finds, so it passes whichever data source the API is serving.

Each test that mutates state (stage advance) is assigned its own dedicated
subject at import, so tests stay order-independent.
"""
from fastapi.testclient import TestClient

from app.escalation import STAGES_FULL
from app.main import app

client = TestClient(app)


def _all_patients() -> list[dict]:
    items = []
    page = 1
    while True:
        r = client.get("/patients", params={"limit": 200, "page": page})
        assert r.status_code == 200
        body = r.json()
        items.extend(body["items"])
        if len(items) >= body["total"] or not body["items"]:
            return items
        page += 1


_ITEMS = _all_patients()
_TOTAL = len(_ITEMS)
_TIER_COUNTS = {t: sum(1 for i in _ITEMS if i["risk_tier"] == t) for t in ("high", "medium", "low")}
# Subjects still fresh at Stage 1 (cohort may include already-progressed patients)
_HIGH_FRESH = [i["id"] for i in _ITEMS if i["risk_tier"] == "high" and i["stage"] == 1]
_LOW_FRESH = [i["id"] for i in _ITEMS if i["risk_tier"] == "low" and i["stage"] == 1]
_LOW_ANY = [i["id"] for i in _ITEMS if i["risk_tier"] == "low" and i["stage"] < 4]

# Dedicated subjects: read-only tests share READ_HIGH (never mutated); each
# mutating test owns its own subject.
assert len(_HIGH_FRESH) >= 6, "cohort needs >= 6 stage-1 high-tier patients for the test plan"
assert len(_LOW_FRESH) >= 1, "cohort needs >= 1 stage-1 low-tier patient for the test plan"
assert len(_LOW_ANY) >= 2, "cohort needs >= 2 low-tier patients below stage 4 for the test plan"
ADV_HIGH = _HIGH_FRESH[0]        # advanced once (stage 1 -> 2)
COMPLETE_HIGH = _HIGH_FRESH[1]   # advanced to completion (1 -> 2 -> 3 -> 4)
RESULT_HIGH = _HIGH_FRESH[2]     # orders blood panel, then records the result
AUTO_HIGH = _HIGH_FRESH[3]       # model-driven cascade
AUTO_INFLIGHT = _HIGH_FRESH[4]   # cascade resumes from an in-flight stage
AUTO_LOW = _LOW_FRESH[0]         # low tier -> 409 (no test indicated)
READ_HIGH = _HIGH_FRESH[-1]      # never mutated -- used by read-only tests
LOW_409 = _LOW_ANY[0]            # never mutated -- only a 409 is asserted
LOW_OVERRIDE = _LOW_FRESH[0]     # advanced once via clinician override


# --------------------------------------------------------------------------- #
# System
# --------------------------------------------------------------------------- #
def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"
    assert r.json()["data_source"] in ("mock", "real", "synthetic", "real+postgres", "synthetic+postgres")


# --------------------------------------------------------------------------- #
# List / filter / sort / search / pagination
# --------------------------------------------------------------------------- #
def test_list_patients_sorted_by_risk_desc():
    r = client.get("/patients")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == _TOTAL
    scores = [i["score"] for i in body["items"]]
    assert scores == sorted(scores, reverse=True)
    assert body["items"][0]["risk_tier"] == "high"


def test_list_patients_sorted_by_risk_asc():
    r = client.get("/patients", params={"sort": "risk-asc"})
    scores = [i["score"] for i in r.json()["items"]]
    assert scores == sorted(scores)


def test_sort_by_stage():
    r = client.get("/patients", params={"sort": "stage"})
    assert r.status_code == 200
    stages = [i["stage"] for i in r.json()["items"]]
    assert stages == sorted(stages)


def test_tier_filter():
    for tier in ("high", "medium", "low"):
        if _TIER_COUNTS[tier] == 0:
            continue  # dataset has none of this tier -- nothing to assert
        r = client.get("/patients", params={"tier": tier, "limit": 200})
        assert r.status_code == 200
        body = r.json()
        assert body["total"] == _TIER_COUNTS[tier]
        assert all(i["risk_tier"] == tier for i in body["items"])


def test_search_by_id():
    r = client.get("/patients", params={"q": READ_HIGH, "limit": 200})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] >= 1
    assert READ_HIGH in [i["id"] for i in body["items"]]


def test_pagination():
    r = client.get("/patients", params={"limit": 3, "page": 2})
    assert r.status_code == 200
    body = r.json()
    assert body["page"] == 2
    assert body["limit"] == 3
    assert len(body["items"]) == 3
    assert body["total"] == _TOTAL


# --------------------------------------------------------------------------- #
# Detail / explain / pipeline (read-only, on an unmutated subject)
# --------------------------------------------------------------------------- #
def test_get_patient_detail():
    r = client.get(f"/patients/{READ_HIGH}")
    assert r.status_code == 200
    d = r.json()
    assert d["id"] == READ_HIGH
    assert d["cognitive"]["scale"] in ("MoCA", "MMSE")
    assert len(d["factors"]) >= 3  # top-3 SHAP factors
    assert len(d["history"]) >= 1
    # Decision-support contract: no diagnosis field anywhere
    assert "diagnosis" not in d


def test_get_patient_404():
    assert client.get("/patients/NOPE").status_code == 404


def test_explain():
    r = client.get(f"/patients/{READ_HIGH}/explain")
    assert r.status_code == 200
    body = r.json()
    assert body["risk_tier"] == "high"
    factors = body["factors"]
    abs_effects = [abs(f["contribution"]) for f in factors]
    assert abs_effects == sorted(abs_effects, reverse=True)
    for f in factors:
        assert {"feature", "text", "value", "contribution"} <= set(f)
    assert len(body["global_importance"]) >= 1


def test_pipeline():
    r = client.get(f"/patients/{READ_HIGH}/pipeline")
    assert r.status_code == 200
    body = r.json()
    assert body["current_stage"] == 1
    assert body["stages"] == STAGES_FULL
    assert body["recommended_next"]["button"] == "Order blood biomarker panel"


# --------------------------------------------------------------------------- #
# Escalation rules (clinician-in-the-loop)
# --------------------------------------------------------------------------- #
def test_advance_high_patient():
    before = len(client.get(f"/patients/{ADV_HIGH}").json()["history"])
    r = client.post(f"/patients/{ADV_HIGH}/advance-stage", json={"override": False})
    assert r.status_code == 200
    body = r.json()
    assert body["applied"] is True
    assert body["pipeline"]["current_stage"] == 2
    assert "Blood biomarkers" in body["event"]
    # Result arrives WITH the order (no pending-forever) + model re-ran
    assert body["result"]["slot"] == "blood"
    assert body["result"]["outcome"] in ("normal", "abnormal", "inconclusive")
    assert body["rescored"] is True
    assert body["new_score"] is not None

    detail = client.get(f"/patients/{ADV_HIGH}").json()
    assert detail["blood"]["status"] == "completed"
    assert detail["blood"]["outcome"] in ("normal", "abnormal", "inconclusive")
    assert len(detail["history"]) == before + 2  # order + result events


def test_advance_low_patient_conflicts_without_override():
    r = client.post(f"/patients/{LOW_409}/advance-stage", json={"override": False})
    assert r.status_code == 409
    assert "override" in r.json()["detail"]


def test_advance_low_patient_with_clinician_override():
    r = client.post(
        f"/patients/{LOW_OVERRIDE}/advance-stage",
        json={"override": True, "note": "clinical judgment"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["applied"] is True
    assert body["pipeline"]["current_stage"] == 2
    assert "note: clinical judgment" in body["event"]


def test_advance_completed_pipeline_conflicts():
    # Walk a dedicated high subject through all four stages, then the 5th
    # advance must conflict ("pipeline complete") even with override.
    for expected_stage in (2, 3, 4):
        r = client.post(f"/patients/{COMPLETE_HIGH}/advance-stage", json={"override": True})
        assert r.status_code == 200, r.text
        assert r.json()["pipeline"]["current_stage"] == expected_stage
    r = client.post(f"/patients/{COMPLETE_HIGH}/advance-stage", json={"override": True})
    assert r.status_code == 409
    assert "complete" in r.json()["detail"]


def test_advance_unknown_patient_404():
    assert client.post("/patients/NOPE/advance-stage", json={}).status_code == 404


# --------------------------------------------------------------------------- #
# Model-driven auto workup (tier-gated cascade)
# --------------------------------------------------------------------------- #
def test_auto_workup_high_patient_cascades():
    """High-tier patient: model orders tests; each result re-scores and the
    updated tier gates the next step. Final tier must be high at completion."""
    r = client.post(f"/patients/{AUTO_HIGH}/auto-workup")
    assert r.status_code == 200
    body = r.json()
    assert body["applied"] is True
    assert body["tests_run"] == ["blood", "imaging", "pet"]  # never downgrades tier mid-cascade
    assert body["final_stage"] == 4
    assert body["final_tier"] == "high"
    assert body["final_score"] > 0.7  # cognition-dominant high tier holds through the cascade
    # Every test step logged with outcome + score trajectory
    for step in body["steps"]:
        if step["action"] == "test":
            assert step["outcome"] in ("normal", "abnormal", "inconclusive")
            assert 0.0 <= step["score_after"] <= 1.0
    detail = client.get(f"/patients/{AUTO_HIGH}").json()
    for slot in ("blood", "imaging", "pet"):
        assert detail[slot]["status"] == "completed"
    # Audit trail: 1 scored + 2 events x 3 tests = 7 entries
    assert len(detail["history"]) == 7


def test_auto_workup_low_patient_conflicts():
    """Low-tier patient: the rule engine indicates no test, so the cascade
    endpoint conflicts with the reason instead of silently doing nothing."""
    r = client.post(f"/patients/{AUTO_LOW}/auto-workup")
    assert r.status_code == 409
    assert "re-screen" in r.json()["detail"].lower()


def test_auto_workup_respects_inflight_progress():
    """An already-progressed patient continues from their current stage."""
    # Push a dedicated subject to stage 2 first (blood auto-completes on order)
    r = client.post(f"/patients/{AUTO_INFLIGHT}/advance-stage", json={"override": False})
    assert r.status_code == 200
    r = client.post(f"/patients/{AUTO_INFLIGHT}/auto-workup")
    assert r.status_code == 200
    body = r.json()
    assert "blood" not in body["tests_run"]  # already completed
    assert body["tests_run"] == ["imaging", "pet"]
    assert body["final_stage"] == 4


def test_auto_workup_unknown_patient_404():
    assert client.post("/patients/NOPE/auto-workup").status_code == 404


# --------------------------------------------------------------------------- #
# Recording test results (closes the loop on "pending")
# --------------------------------------------------------------------------- #
def test_record_result_flow():
    # Order the blood panel first (stage 1 -> 2): the result auto-populates
    r = client.post(f"/patients/{RESULT_HIGH}/advance-stage", json={"override": False})
    assert r.status_code == 200

    # A slot that was never ordered has nothing to record
    r = client.post(f"/patients/{RESULT_HIGH}/results", json={"slot": "imaging", "outcome": "normal"})
    assert r.status_code == 409
    assert "not been ordered" in r.json()["detail"]

    # Amend the auto-derived result with the actual lab-report values
    r = client.post(
        f"/patients/{RESULT_HIGH}/results",
        json={
            "slot": "blood",
            "outcome": "abnormal",
            "values": {"pTau181": 5.1, "abeta4240": 0.058},
            "note": "lab-verified: elevated p-tau",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["applied"] is True
    assert body["outcome"] == "abnormal"
    assert "amended" in body["event"]
    assert "note: lab-verified: elevated p-tau" in body["event"]
    assert body["new_score"] is not None  # re-scored after the amendment

    detail = client.get(f"/patients/{RESULT_HIGH}").json()
    assert detail["blood"]["status"] == "completed"
    assert detail["blood"]["outcome"] == "abnormal"
    assert detail["blood"]["pTau181"] == 5.1
    assert detail["blood"]["note"] == "lab-verified: elevated p-tau"
    assert len(detail["history"]) == 4  # scored + ordered + result + amended

    # A second amendment is allowed (lab corrections happen)
    r2 = client.post(
        f"/patients/{RESULT_HIGH}/results",
        json={"slot": "blood", "outcome": "normal", "values": {"pTau181": 1.2, "abeta4240": 0.128}},
    )
    assert r2.status_code == 200
    detail2 = client.get(f"/patients/{RESULT_HIGH}").json()
    assert detail2["blood"]["outcome"] == "normal"

    # Invalid slot / unknown patient
    assert client.post(f"/patients/{RESULT_HIGH}/results", json={"slot": "xyz"}).status_code == 422
    assert client.post("/patients/NOPE/results", json={"slot": "blood"}).status_code == 404


# --------------------------------------------------------------------------- #
# Model serving
# --------------------------------------------------------------------------- #
def test_model_info():
    r = client.get("/model/info")
    assert r.status_code == 200
    body = r.json()
    assert "available" in body
    assert isinstance(body["global_importance"], list)
    assert len(body["global_importance"]) >= 1
    if body["available"]:
        assert "features" in body and body["features"]
        assert "test_auc" in body and "cv_auc_mean" in body


def test_score_endpoint():
    info = client.get("/model/info").json()
    if not info.get("available"):
        import pytest

        pytest.skip("no trained model artifact (run scripts/train_model.py first)")
    features = {f: 0.0 for f in info["features"]}
    features.update({"age": 78.0, "education_years": 12.0, "mmse": 19.0})
    r = client.post("/patients/score", json={"features": features})
    assert r.status_code == 200
    body = r.json()
    assert 0.0 <= body["score"] <= 1.0
    assert body["risk_tier"] in ("high", "medium", "low")
    assert len(body["factors"]) >= 3

    # Missing features are median-imputed by the bundled pipeline, not rejected
    r2 = client.post("/patients/score", json={"features": {"age": 80.0, "mmse": 18.0}})
    assert r2.status_code == 200
    assert 0.0 <= r2.json()["score"] <= 1.0

    # Test categorical sex and string values (should not 422)
    r3 = client.post("/patients/score", json={"features": {"sex": "F", "age": 78, "mmse": 21}})
    assert r3.status_code == 200
    assert 0.0 <= r3.json()["score"] <= 1.0

    r4 = client.post("/patients/score", json={"features": {"sex": "M", "age": 82, "ses": "2"}})
    assert r4.status_code == 200
    assert 0.0 <= r4.json()["score"] <= 1.0
