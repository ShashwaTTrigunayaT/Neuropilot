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
# Every served subject holds at least one REAL blood/MRI/PET result (the store
# filters out the rest), so the ladder below only ever deals with what exists.
_FRESH = [i for i in _ITEMS if i["stage"] == 1]
# Stage 1 is NEVER High: the ordered prefix contains no biomarker, so the
# evidence gate caps cognition alone at Medium. Ordering is indicated for any
# non-Low stage-1 subject, which is what the mutating tests below drive.
_ORDER_FRESH = [i["id"] for i in _FRESH if i["risk_tier"] == "medium"]
_LOW_FRESH = [i["id"] for i in _FRESH if i["risk_tier"] == "low"]
_LOW_ANY = [i["id"] for i in _ITEMS if i["risk_tier"] == "low" and i["stage"] < 4]
# A subject the rule engine genuinely STOPS on: low tier with nothing left to
# incorporate. At stage 1 every served patient still holds an unmatched result,
# so a real stop can only happen once the ordered prefix has reached it.
_STOP_POOL = [
    i["id"] for i in _ITEMS
    if i["risk_tier"] == "low" and 2 <= i["stage"] < 4 and not i.get("beyond_stage")
]

# Dedicated subjects: read-only tests share READ_ORDER / READ_HIGH (never
# mutated); every mutating test owns its own subject.
assert len(_ORDER_FRESH) >= 6, "cohort needs >= 6 orderable stage-1 subjects for the test plan"
assert len(_LOW_FRESH) >= 2, "cohort needs >= 2 stage-1 low-tier patients for the test plan"
assert len(_STOP_POOL) >= 2, "cohort needs >= 2 low-tier subjects with nothing left to incorporate"

# Assign distinct subjects, then build the remaining pools EXCLUDING them, so no
# two tests can ever share (and mutate) the same record.
(ADV_HIGH, COMPLETE_HIGH, RESULT_HIGH, AUTO_HIGH, AUTO_INFLIGHT, READ_ORDER) = _ORDER_FRESH[:6]
_TAKEN = set(_ORDER_FRESH[:6])

_GAP_POOL = [i["id"] for i in _FRESH if i.get("beyond_stage") and i["id"] not in _TAKEN]
assert _GAP_POOL, "cohort needs a stage-1 subject holding a scan beyond the ordered prefix"
HIGH_GAP = _GAP_POOL[0]

_HIGH_POOL = [
    i["id"] for i in _ITEMS
    if i["risk_tier"] == "high" and i["stage"] < 4 and i["id"] not in _TAKEN
]
assert _HIGH_POOL, "cohort needs an evidence-backed high-tier patient below stage 4"
READ_HIGH = _HIGH_POOL[0]

AUTO_LOW = _STOP_POOL[1]         # low tier, nothing to incorporate -> 409
LOW_409 = _STOP_POOL[0]          # never mutated -- only a 409 is asserted
LOW_OVERRIDE = _LOW_FRESH[0]     # advanced once via clinician override
# NB: every mutating test owns a DISTINCT subject. Reusing one (AUTO_LOW ==
# LOW_OVERRIDE) makes the outcome depend on test order -- the low-tier subject
# can be re-scored into a higher tier by the override's ordered result.


# --------------------------------------------------------------------------- #
# System
# --------------------------------------------------------------------------- #
def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"
    # "<cohort>[+<store>]" -- cohort: adni | synthetic | real (OASIS) | mock
    cohort, _, _store = r.json()["data_source"].partition("+")
    assert cohort in ("mock", "real", "synthetic", "adni")
    assert r.json()["patients"] == _TOTAL


# --------------------------------------------------------------------------- #
# List / filter / sort / search / pagination
# --------------------------------------------------------------------------- #
def test_list_patients_sorted_by_risk_desc():
    r = client.get("/patients")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == _TOTAL
    scores = [i["final_score"] for i in body["items"]]
    assert scores == sorted(scores, reverse=True)
    assert body["items"][0]["risk_tier"] == "high"


def test_list_patients_sorted_by_risk_asc():
    r = client.get("/patients", params={"sort": "risk-asc"})
    scores = [i["final_score"] for i in r.json()["items"]]
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
    # Decision-support contract: no diagnosis field anywhere -- including the
    # ADNI cohort's OWN label, which stays internal (training/audit only)
    for forbidden in ("diagnosis", "real_diagnosis", "diagnosis_code", "cdr_sb"):
        assert forbidden not in d
    # Label-proximal measures are dropped from the model AND the payload: CDR
    # (diagnosis is derived from it) and FAQ (part of ADNI's diagnostic
    # algorithm) both leak the label, so neither is a served input.
    assert "faq_total" not in d
    # ...while the model INPUTS a clinician needs are exposed for the workbench
    for exposed in ("adas_cog_13", "apoe_e4", "n_visits", "slots_on_file"):
        assert exposed in d, f"patient detail should expose {exposed}"

    # The stage must never claim a test that was not measured: any slot listed
    # beyond the stage is exactly the "already on file" case
    stage_slots = {2: "blood", 3: "imaging", 4: "pet"}
    reached = {stage_slots.get(s) for s in range(2, d["stage"] + 1)}
    assert d["beyond_stage"] == any(s not in reached for s in d["slots_on_file"])


def test_label_proximal_features_are_never_served_as_factors():
    """FAQ/CDR leak the label; the served attributions must never name one.

    Guards the store, not just the code: the cohort digest alone does not change
    on a retrain, so a stale database can keep explaining scores with a feature
    the current model dropped. The fingerprint now folds in the model identity,
    and this test fails loudly if that ever regresses.
    """
    leaks = {"faq_total", "cdr_sb", "cdr_global", "diagnosis", "real_diagnosis"}
    for item in _ITEMS[:40]:
        d = client.get(f"/patients/{item['id']}").json()
        served = {f["feature"] for f in d["factors"]}
        assert not (served & leaks), f"{item['id']} serves leaky factors: {served & leaks}"


def test_high_tier_requires_biomarker_evidence():
    """High asserts an actionable finding, so a biomarker result must be behind it.

    Cognition is the test the referral was already based on, so on its own it
    cannot corroborate itself -- a cognition-only patient is capped at Medium no
    matter how high the score climbs (452 of them would otherwise be High).
    """
    page = client.get("/patients", params={"tier": "high", "limit": 50}).json()
    assert page["items"], "expected evidence-backed high-tier patients in the cohort"
    for item in page["items"]:
        d = client.get(f"/patients/{item['id']}").json()
        assert d["slots_on_file"], (
            f"{item['id']} is served as High with no biomarker on file "
            f"(slots_on_file={d['slots_on_file']})"
        )


def test_cognition_only_patients_are_capped_at_medium():
    """The gate must actually bite: high-scoring cognition-only patients exist."""
    from app import service
    from app.config import has_biomarker_evidence, risk_tier

    capped, promoted = 0, 0
    for rec in service.PATIENTS.values():
        has_evidence = has_biomarker_evidence(rec)
        gated = risk_tier(rec["score"], has_evidence)
        if rec["score"] > 0.7 and not has_evidence:
            assert gated == "medium", f"{rec['id']} escaped the evidence gate"
            capped += 1
        elif gated == "high":
            promoted += 1
    assert capped > 0, "cohort should contain cognition-only patients the gate caps"
    assert promoted > 0, "cohort should contain evidence-backed High patients"


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
    r = client.get(f"/patients/{READ_ORDER}/pipeline")
    assert r.status_code == 200
    body = r.json()
    assert body["current_stage"] == 1
    assert body["stages"] == STAGES_FULL
    assert body["recommended_next"]["button"] == "Order blood biomarker panel"


# --------------------------------------------------------------------------- #
# Escalation rules (clinician-in-the-loop)
# --------------------------------------------------------------------------- #
def test_advance_high_patient():
    """Ordering places the test. A result already on file is attached as-is; a
    slot with nothing on file is recorded as `ordered` and NOTHING is invented
    to fill it, so the score cannot move on a number nobody measured."""
    before = client.get(f"/patients/{ADV_HIGH}").json()
    r = client.post(f"/patients/{ADV_HIGH}/advance-stage", json={"override": False})
    assert r.status_code == 200
    body = r.json()
    assert body["applied"] is True
    assert body["pipeline"]["current_stage"] == 2
    assert "Blood biomarkers" in body["event"]
    assert body["result"]["slot"] == "blood"
    assert body["rescored"] is True
    assert body["new_score"] is not None

    if body["result"]["carried_forward"]:
        # A real measurement existed beyond the prefix: used unchanged
        assert body["result"]["status"] == "completed"
        assert body["result"]["outcome"] in ("normal", "abnormal", "inconclusive")
    else:
        assert body["result"]["status"] == "ordered"
        assert body["result"]["outcome"] is None
        assert body["new_score"] == before["score"], (
            "an order that returned no result moved the score"
        )

    detail = client.get(f"/patients/{ADV_HIGH}").json()
    assert detail["blood"]["status"] == body["result"]["status"]
    assert len(detail["history"]) == len(before["history"]) + 2  # order + outcome


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
def test_auto_workup_orders_through_the_pathway():
    """The cascade orders the next indicated test. A step that returns no result
    leaves the score untouched; a step that incorporates a real on-file result
    re-scores. Nothing is ever invented to fill a gap."""
    official = client.get(f"/patients/{AUTO_HIGH}").json()["score"]
    r = client.post(f"/patients/{AUTO_HIGH}/auto-workup")
    assert r.status_code == 200
    body = r.json()
    assert body["applied"] is True
    assert body["tests_run"], "an orderable subject should run at least one test"
    assert body["final_stage"] >= 2

    score = body["score_start"]
    for step in body["steps"]:
        if step["action"] != "test":
            continue
        assert step["status"] in ("ordered", "completed")
        if step["status"] == "ordered":
            assert step["outcome"] is None
            assert step["official_score_after"] == official, (
                f"order to {step['slot']} returned no result but changed the official score"
            )
        assert 0.0 <= step["score_after"] <= 1.0
        if step["status"] == "completed":
            official = step["official_score_after"]
        score = step["score_after"]

    detail = client.get(f"/patients/{AUTO_HIGH}").json()
    for slot in body["tests_run"]:
        assert detail[slot]["status"] in ("ordered", "completed")


def test_auto_workup_low_patient_conflicts():
    """Low-tier patient: the rule engine indicates no test, so the cascade
    endpoint conflicts with the reason instead of silently doing nothing."""
    r = client.post(f"/patients/{AUTO_LOW}/auto-workup")
    assert r.status_code == 409
    assert "re-screen" in r.json()["detail"].lower()


def test_auto_workup_respects_inflight_progress():
    """An already-progressed patient continues from their current stage."""
    r = client.post(f"/patients/{AUTO_INFLIGHT}/advance-stage", json={"override": False})
    assert r.status_code == 200
    r = client.post(f"/patients/{AUTO_INFLIGHT}/auto-workup")
    assert r.status_code == 200
    body = r.json()
    assert "blood" not in body["tests_run"]  # the pathway already reached it
    assert body["final_stage"] >= 2


def test_auto_workup_unknown_patient_404():
    assert client.post("/patients/NOPE/auto-workup").status_code == 404


# --------------------------------------------------------------------------- #
# Real-cohort ordering gaps (a measured result the ordered pathway has not reached)
# --------------------------------------------------------------------------- #
_RESULT_SLOT = {2: "blood", 3: "imaging", 4: "pet"}
_DEDICATED = {ADV_HIGH, COMPLETE_HIGH, RESULT_HIGH, AUTO_HIGH, AUTO_INFLIGHT, AUTO_LOW,
              READ_HIGH, READ_ORDER, HIGH_GAP, LOW_409, LOW_OVERRIDE}


def _find_gap_subject(max_scan: int = 150):
    """A subject holding a result from a LATER stage than the pathway reached.

    Real ADNI arrives this way: 965 subjects have an MRI and no plasma panel.
    The stage stops at the first gap, so that MRI is "beyond stage".
    """
    import pytest

    scanned = 0
    for item in _ITEMS:
        if item["stage"] >= 4 or item["id"] in _DEDICATED:
            continue
        d = client.get(f"/patients/{item['id']}").json()
        scanned += 1
        if d.get("beyond_stage"):
            return d
        if scanned >= max_scan:
            break
    pytest.skip("cohort has no ordering-gap subject to exercise")


def test_ordering_gap_is_reported_not_hidden():
    d = _find_gap_subject()
    # the stage stops short of a measured slot...
    reached = {_RESULT_SLOT.get(s) for s in range(2, d["stage"] + 1)}
    ahead = [s for s in d["slots_on_file"] if s not in reached]
    assert ahead, "beyond_stage must be backed by a real later-stage result"
    # ...and the gap is visible to the UI rather than silently implied
    assert d["beyond_stage"] is True
    assert set(ahead) <= set(d["slots_on_file"])


def test_ordering_gap_never_overwrites_a_real_measurement():
    """Walking the pathway past an already-measured slot must carry the real
    values forward -- never replace them with a simulated result."""
    d = _find_gap_subject()
    pid = d["id"]
    ahead = [
        _RESULT_SLOT[s]
        for s in range(d["stage"] + 1, 5)
        if _RESULT_SLOT[s] in d["slots_on_file"]
    ]
    if not ahead:
        import pytest

        pytest.skip("no measured result sits ahead of this subject's stage")
    target = ahead[0]
    before = client.get(f"/patients/{pid}").json()[target]
    assert before is not None

    carried = False
    for _ in range(4):
        r = client.post(f"/patients/{pid}/advance-stage", json={"override": True})
        assert r.status_code == 200, r.text
        body = r.json()
        if body["result"]["slot"] == target:
            assert body["result"]["carried_forward"] is True
            carried = True
            break
    assert carried, f"pathway never reached the measured {target} slot"

    after = client.get(f"/patients/{pid}").json()[target]
    assert after == before, "real measurement was overwritten by a generated result"


def test_cohort_serves_only_patients_with_a_real_result():
    """A subject with no blood/MRI/PET result anywhere can never be re-scored by
    ordering a test, so the store does not serve them at all."""
    from app import service
    from app.config import real_result_slots

    assert service.PATIENTS, "cohort must not be empty"
    empty = [r["id"] for r in service.PATIENTS.values() if not real_result_slots(r)]
    assert empty == [], f"served patients with no blood/MRI/PET result: {empty[:5]}"


def test_missing_stage_estimates_are_display_only():
    """Missing stages may show model estimates, but estimates never become
    measured payloads or evidence-backed High tiers."""
    from app import service

    candidate = next((r for r in service.PATIENTS.values() if r.get("estimated_values")), None)
    assert candidate is not None, "cohort should expose at least one missing-stage estimate"
    detail = client.get(f"/patients/{candidate['id']}").json()
    assert detail["estimated_values"]
    for slot, values in detail["estimated_values"].items():
        assert values
        actual = detail.get(slot)
        assert not actual or actual.get("status") != "completed" or slot not in detail["estimated_values"]
    assert detail["risk_tier"] != "high" or detail["slots_on_file"]


def test_ordered_stage_keeps_predicted_values_visible():
    """Ordering a stage without a result keeps its display-only estimate visible
    so the patient page can show predicted stats plus Add real result."""
    from app import service

    candidate = next(
        (r for r in service.PATIENTS.values()
         if r.get("stage") == 1 and r.get("estimated_values", {}).get("blood")
         and not isinstance(r.get("blood"), dict)),
        None,
    )
    if candidate is None:
        import pytest
        pytest.skip("cohort has no untouched stage-1 blood estimate")
    pid = candidate["id"]
    response = client.post(f"/patients/{pid}/advance-stage", json={"override": True})
    assert response.status_code == 200, response.text
    detail = client.get(f"/patients/{pid}").json()
    assert detail["blood"]["status"] == "ordered"
    assert detail["estimated_values"].get("blood")
    assert detail["blood"].get("pTau217") is None


def test_real_result_replaces_display_estimate():
    """After an ordered real result is recorded, the actual completed payload
    is used and that slot disappears from the estimate map."""
    from app import service

    candidate = next(
        (r for r in service.PATIENTS.values()
         if r.get("stage") == 1 and r.get("estimated_values", {}).get("blood")
         and not isinstance(r.get("blood"), dict)),
        None,
    )
    if candidate is None:
        # Real ADNI rows usually have a blood placeholder after an earlier
        # probe; choose an uncompleted blood slot instead.
        candidate = next(
            (r for r in service.PATIENTS.values()
             if r.get("stage") == 1 and r.get("estimated_values", {}).get("blood")
             and (not isinstance(r.get("blood"), dict) or r["blood"].get("status") != "completed")),
            None,
        )
    if candidate is None:
        import pytest
        pytest.skip("cohort has no stage-1 estimated blood slot available")

    pid = candidate["id"]
    before = client.get(f"/patients/{pid}").json()
    if before["stage"] == 1:
        ordered = client.post(f"/patients/{pid}/advance-stage", json={"override": True})
        assert ordered.status_code == 200, ordered.text
    result = client.post(
        f"/patients/{pid}/results",
        json={"slot": "blood", "outcome": "abnormal", "values": {"pTau217": 0.91}},
    )
    assert result.status_code == 200, result.text
    after = client.get(f"/patients/{pid}").json()
    assert after["blood"]["status"] == "completed"
    assert "blood" not in after.get("estimated_values", {})


def test_stage_one_is_never_high():
    """The ordered prefix at stage 1 holds no biomarker, so cognition alone is
    capped at Medium -- there is no such thing as a High stage-1 patient."""
    from app import service
    from app.config import has_biomarker_evidence, risk_tier

    for rec in service.PATIENTS.values():
        if rec["stage"] != 1:
            continue
        evidence = has_biomarker_evidence(rec)
        assert evidence is False, f"{rec['id']} has evidence visible at stage 1"
        assert risk_tier(rec["score"], evidence) != "high", f"{rec['id']} escaped the gate"


def test_scoring_hides_results_the_pathway_has_not_reached():
    """A result beyond the ordered prefix must not reach the feature vector --
    otherwise ordering the intervening test could never change anything."""
    from app import model_service, service
    from app.config import slot_visible

    hidden = 0
    for rec in service.PATIENTS.values():
        f = model_service.record_to_features(rec)
        if not slot_visible(rec, "imaging"):
            assert f["hippocampal_volume"] is None
            assert f["hippocampal_icv_ratio"] is None
            hidden += 1
        if not slot_visible(rec, "pet"):
            assert f["centiloids"] is None and f["tau_meta_temporal"] is None
        if not slot_visible(rec, "blood"):
            assert f["ptau217"] is None and f["nfl"] is None and f["gfap"] is None
    assert hidden > 0, "cohort should contain patients with a gated MRI"


def test_ordering_reveals_a_real_result_and_moves_the_score():
    """The point of ordering: a result already on file enters the record only
    when the pathway reaches it, and it re-scores the patient for real."""
    pid = HIGH_GAP
    before = client.get(f"/patients/{pid}").json()
    assert before["beyond_stage"] is True
    score_before = before["score"]

    revealed = None
    for _ in range(3):
        r = client.post(f"/patients/{pid}/advance-stage", json={"override": True})
        assert r.status_code == 200, r.text
        body = r.json()
        if body["result"]["carried_forward"]:
            revealed = body
            break
        assert body["new_score"] == score_before, "a no-result order moved the score"

    assert revealed is not None, "the pathway never reached the on-file result"
    assert revealed["result"]["status"] == "completed"
    assert revealed["new_score"] != score_before, (
        "incorporating a real measurement must re-score the patient"
    )


# --------------------------------------------------------------------------- #
# Recording test results (closes the loop on "pending")
# --------------------------------------------------------------------------- #
def test_record_result_flow():
    # Order the blood panel first (stage 1 -> 2): the result auto-populates
    r = client.post(f"/patients/{RESULT_HIGH}/advance-stage", json={"override": False})
    assert r.status_code == 200
    before = len(client.get(f"/patients/{RESULT_HIGH}").json()["history"])

    # A slot with no result on file has nothing to record. (On real cohorts a
    # later-stage test can already be measured, so pick one that is genuinely
    # absent rather than assuming the pathway order.)
    on_file = set(client.get(f"/patients/{RESULT_HIGH}").json().get("slots_on_file") or [])
    absent = next((s for s in ("imaging", "pet") if s not in on_file), None)
    if absent is not None:
        r = client.post(f"/patients/{RESULT_HIGH}/results", json={"slot": absent, "outcome": "normal"})
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
    assert "note: lab-verified: elevated p-tau" in body["event"]
    assert body["new_score"] is not None  # re-scored after the amendment

    detail = client.get(f"/patients/{RESULT_HIGH}").json()
    assert detail["blood"]["status"] == "completed"
    assert detail["blood"]["outcome"] == "abnormal"
    assert detail["blood"]["pTau181"] == 5.1
    assert detail["blood"]["note"] == "lab-verified: elevated p-tau"
    assert len(detail["history"]) == before + 1  # + the amendment event

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


# --------------------------------------------------------------------------- #
# Refined model (the served model -- real ADNI follow-up labels)
# --------------------------------------------------------------------------- #
def test_refined_outlook_contract():
    """The served outlook must agree with the served model's card."""
    if not _ITEMS:
        import pytest

        pytest.skip("no patients in the cohort")
    info = client.get("/model/info").json()
    if not info.get("available"):
        import pytest

        pytest.skip("no served model artifact")

    pid = _ITEMS[0]["id"]
    r = client.get(f"/patients/{pid}/refined")
    assert r.status_code == 200
    body = r.json()

    predicted = [p for p in body["trajectory"] if p["kind"] == "predicted"]
    assert len(predicted) == 1
    assert predicted[0]["t"] > 0
    assert predicted[0]["lo"] is not None and predicted[0]["hi"] is not None

    assert 0.0 <= body["projected"]["score"] <= 1.0
    assert body["projected"]["risk_tier"] in ("high", "medium", "low")

    # Nothing user-facing may claim a forecast horizon, or describe a simulation
    assert "month" not in body["disclaimer"].lower()
    assert "simulated" not in body["disclaimer"].lower()
    assert "horizon" not in body


def test_served_model_is_refined_and_the_switch_is_reversible():
    """The card must describe the SERVED family, and the retained family must
    still be loadable -- that is what makes the swap reversible."""
    from app.config import PRIMARY_MODEL

    info = client.get("/model/info").json()
    if not info.get("available"):
        import pytest

        pytest.skip("no served model artifact")

    assert info.get("name") == PRIMARY_MODEL
    feats = set(info.get("features") or [])
    assert feats, "served model publishes no feature contract"
    assert info.get("global_importance"), "served model publishes no attribution"
    assert "xgb" in (info.get("model_type") or "").lower()

    legacy = info.get("legacy") or {}
    assert legacy.get("available") is True, "the retained family must stay loadable"
    assert legacy.get("name") and legacy["name"] != info["name"]
    assert set(legacy.get("features") or []) != feats


def test_served_features_exclude_leakage():
    """FAQ is label leakage and must not be in any served feature contract."""
    info = client.get("/model/info").json()
    if not info.get("available"):
        import pytest

        pytest.skip("no served model artifact")
    assert "faq_total" not in set(info.get("features") or []), "FAQ is label leakage"


def test_refined_labels_are_real_and_bounded():
    """Guards the exact bug that made an earlier draft of the index wrong:
    an unbounded 'ever worsened' rule labels a month-40 transition as a
    month-24 outcome."""
    from pathlib import Path

    import pandas as pd

    path = Path(__file__).resolve().parents[2] / "data" / "processed" / "adni_progression.csv"
    if not path.exists():
        import pytest

        pytest.skip("progression index absent (run scripts/ingest_adni.py)")

    df = pd.read_csv(path)
    horizon = int(df["horizon_months"].iloc[0])

    # One row per subject -> the train/test split is subject-level by construction
    assert df["subject_id"].is_unique

    # Nobody is kept without follow-up covering the window
    assert (df["follow_days"] >= horizon * 30.44).all()

    # Every conversion happened INSIDE the window
    conv = df[df["converted"] == 1]
    assert conv["months_to_conversion"].notna().all()
    assert (conv["months_to_conversion"] <= horizon).all()

    # Non-conversions carry no conversion time
    assert df.loc[df["converted"] == 0, "months_to_conversion"].isna().all()

    # Baseline is always the CN/MCI rung of the ladder
    assert set(df["baseline_diag"].unique()) <= {1, 2}
