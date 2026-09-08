"""Business logic behind the API endpoints."""
from __future__ import annotations

import random
from datetime import datetime
from typing import Optional

from .config import risk_tier
from .escalation import (
    RESULT_SLOT,
    RESULT_SLOT_LABEL,
    STAGES_FULL,
    can_advance,
    next_action_for,
)
from .storage import HUMAN_FEATURES, load_global_importance, load_patients, persist

PATIENTS, DATA_SOURCE = load_patients()
GLOBAL_IMPORTANCE = load_global_importance()

SORT_KEYS = {"risk-desc", "risk-asc", "stage"}


def _summary(record: dict) -> dict:
    action = next_action_for(record)
    return {
        "id": record["id"],
        "age": record.get("age"),
        "sex": record.get("sex"),
        "education_years": record.get("education_years"),
        "cognitive": record.get("cognitive"),
        "score": record["score"],
        "risk_tier": risk_tier(record["score"]),
        "stage": record["stage"],
        "stage_name": STAGES_FULL[record["stage"] - 1],
        "recommended_next": action["summary"] if action else None,
        "updated_at": record["updated_at"],
    }


def list_patients(tier: Optional[str] = None, q: Optional[str] = None, sort: str = "risk-desc", page: int = 1, limit: int = 50) -> dict:
    if sort not in SORT_KEYS:
        sort = "risk-desc"
    rows = list(PATIENTS.values())

    if tier:
        rows = [r for r in rows if risk_tier(r["score"]) == tier]
    if q:
        needle = q.strip().lower()
        rows = [r for r in rows if needle in r["id"].lower()]

    if sort == "risk-desc":
        rows.sort(key=lambda r: r["score"], reverse=True)
    elif sort == "risk-asc":
        rows.sort(key=lambda r: r["score"])
    else:  # stage
        rows.sort(key=lambda r: (r["stage"], -r["score"]))

    total = len(rows)
    start = (max(page, 1) - 1) * max(limit, 1)
    items = [_summary(r) for r in rows[start : start + limit]]
    return {"items": items, "total": total, "page": page, "limit": limit}


def get_patient(patient_id: str) -> Optional[dict]:
    record = PATIENTS.get(patient_id)
    if record is None:
        return None
    detail = _summary(record)
    detail.update(
        {
            "cognitive": record.get("cognitive"),
            "comorbidities": record.get("comorbidities", []),
            "family_history": record.get("family_history", False),
            "blood": record.get("blood"),
            "imaging": record.get("imaging"),
            "pet": record.get("pet"),
            "factors": record.get("factors", []),
            "history": record.get("history", []),
        }
    )
    return detail


def explain(patient_id: str) -> Optional[dict]:
    record = PATIENTS.get(patient_id)
    if record is None:
        return None
    factors = sorted(record.get("factors", []), key=lambda f: abs(f["effect"]), reverse=True)
    return {
        "id": record["id"],
        "score": record["score"],
        "risk_tier": risk_tier(record["score"]),
        "factors": [
            {
                "feature": f.get("feature"),
                "text": f["text"],
                "value": f.get("value"),
                "contribution": f["effect"],
            }
            for f in factors
        ],
        "global_importance": GLOBAL_IMPORTANCE,
    }


def pipeline(patient_id: str) -> Optional[dict]:
    record = PATIENTS.get(patient_id)
    if record is None:
        return None
    action = next_action_for(record)
    return {
        "id": record["id"],
        "current_stage": record["stage"],
        "stage_name": STAGES_FULL[record["stage"] - 1],
        "stages": STAGES_FULL,
        "history": record.get("history", []),
        "recommended_next": action,
    }


# --------------------------------------------------------------------------- #
# Simulated lab results + live rescoring
#
# Ordering a test no longer leaves the slot pending forever: the API derives a
# clinically-plausible result from the patient's current severity and returns
# it immediately, then re-runs the TRAINED model with the new values so the
# score and attribution factors actually reflect the new biomarkers.
# --------------------------------------------------------------------------- #


def _rescore(record: dict) -> None:
    """Re-run the trained model in-process and refresh score/tier/factors."""
    from . import model_service

    if not model_service.available():
        return  # keep generator score when no artifact exists (never crash the demo)
    result = model_service.score_features(model_service.record_to_features(record), top_n=None)
    if result is None:
        return
    record["score"] = result["score"]
    record["factors"] = [
        {
            "feature": f["feature"],
            "text": HUMAN_FEATURES.get(f.get("feature"), f.get("feature")),
            "value": f.get("value"),
            "effect": float(f.get("contribution", 0.0)),
        }
        for f in result.get("factors", [])
    ]


def _simulate_result(record: dict, slot: str) -> dict:
    """Derive a clinically-plausible result for `slot` from the patient's severity.

    Uses the current model score as a latent severity: high-severity patients
    draw abnormal values, low-severity normal ones, with realistic noise and
    boundary cases — the same value ranges the generator and presets use.
    """
    severity = max(0.0, min(1.0, float(record.get("score", 0.5))))
    rng = random.Random(f"{record['id']}:{slot}:{record.get('updated_at')}")
    u = rng.random()  # one uniform draw against severity -> coherent profiles

    abnormal = u < severity
    borderline = not abnormal and rng.random() < 0.18  # some normals land near the boundary

    if slot == "blood":
        ptau = round(rng.uniform(3.6, 6.2) if abnormal else rng.uniform(2.0, 2.9) if borderline else rng.uniform(0.9, 2.2), 2)
        ratio = round(rng.uniform(0.045, 0.078) if abnormal else rng.uniform(0.082, 0.089) if borderline else rng.uniform(0.095, 0.140), 3)
        values = {"pTau181": ptau, "abeta4240": ratio}
        if abnormal:
            outcome = "abnormal"
            note = f"p-tau181 elevated ({ptau} pg/mL); Aβ42/40 ratio below reference ({ratio})"
        elif borderline:
            outcome = "inconclusive"
            note = f"Borderline panel — p-tau181 {ptau} pg/mL near threshold; recommend repeat in 6 months"
        else:
            outcome = "normal"
            note = f"Both markers within reference range (p-tau181 {ptau}, Aβ42/40 {ratio})"
        return {"status": "completed", "outcome": outcome, **values, "note": note}

    if slot == "imaging":
        hv = round(rng.uniform(1.85, 2.25) if abnormal else rng.uniform(2.30, 2.55) if borderline else rng.uniform(2.70, 3.60), 2)
        values = {"hippocampalVolumeCm3": hv}
        if abnormal:
            outcome = "abnormal"
            note = f"Bilateral medial temporal atrophy — hippocampal volume {hv} cm³ (<5th percentile)"
        elif borderline:
            outcome = "inconclusive"
            note = f" Hippocampal volume {hv} cm³ borders age-adjusted reference; correlate clinically".strip()
        else:
            outcome = "normal"
            note = f"No focal atrophy — hippocampal volume {hv} cm³ within age-adjusted range"
        return {"status": "completed", "outcome": outcome, **values, "note": note}

    if slot == "pet":
        amy = "Positive" if abnormal or (borderline and rng.random() < 0.5) else "Negative"
        tau = "Positive" if abnormal and rng.random() < 0.85 else ("Positive" if amy == "Positive" and rng.random() < 0.2 else "Negative")
        suvr = round(rng.uniform(1.32, 1.58) if amy == "Positive" else rng.uniform(1.00, 1.14), 2)
        values = {"amyloid": amy, "tau": tau, "amyloidSUVr": suvr}
        if amy == "Positive" and tau == "Positive":
            outcome = "abnormal"
            note = f"Neocortical amyloid retention (SUVR {suvr}) with tau spread — pathological"
        elif amy == "Positive":
            outcome = "inconclusive"
            note = f"Amyloid-positive (SUVR {suvr}) but tau-negative — atypical profile, specialist review"
        else:
            outcome = "normal"
            note = f"No significant amyloid binding (SUVR {suvr})"
        return {"status": "completed", "outcome": outcome, **values, "note": note}

    return {"status": "completed", "outcome": "inconclusive", "note": "Unknown slot"}


def advance_stage(patient_id: str, override: bool = False, note: Optional[str] = None) -> tuple[Optional[dict], Optional[str]]:
    """Apply a clinician-confirmed stage advancement.

    Returns (payload, error) -- payload is the AdvanceResponse dict on success,
    error a human-readable message for the 409 case.
    """
    record = PATIENTS.get(patient_id)
    if record is None:
        return None, None  # caller turns this into 404

    if record["stage"] >= 4:
        return None, "Pipeline complete — no further stages to advance to."

    if not can_advance(record) and not override:
        action = next_action_for(record)
        hint = action["button"] if action else "no escalation"
        return None, (
            f"Rule engine recommends '{hint}', not a test escalation. "
            "Pass {\"override\": true} to force advancement anyway (clinician override)."
        )

    to_stage = record["stage"] + 1
    slot = RESULT_SLOT[to_stage]
    now = datetime.now().strftime("%Y-%m-%d %H:%M")

    action = next_action_for(record)
    event = (
        f"{action['button']} — advanced to {RESULT_SLOT_LABEL[slot]} (Stage {to_stage})"
        if action
        else f"Clinician override — advanced to {RESULT_SLOT_LABEL[slot]} (Stage {to_stage})"
    )
    if note:
        event = f"{event} · note: {note}"

    record["stage"] = to_stage
    # Result arrives with the order (simulated lab turnaround) -- the slot never
    # sits pending forever. The model is re-run immediately so the score,
    # tier and attribution factors reflect the new test values.
    result = _simulate_result(record, slot)
    record[slot] = result
    _rescore(record)
    tier = risk_tier(record["score"])
    result_event = (
        f"{RESULT_SLOT_LABEL[slot]} result recorded — {result['outcome']} · "
        f"re-scored {record['score']:.2f} → {tier} tier by trained model"
    )

    record["updated_at"] = now
    record.setdefault("history", []).extend(
        [
            {"at": now, "text": event},
            {"at": now, "text": result_event},
        ]
    )
    persist(record)  # mirror to Postgres when configured (best-effort)

    return {
        "applied": True,
        "event": event,
        "result": {"slot": slot, "outcome": result["outcome"], "note": result.get("note", "")},
        "rescored": True,
        "new_score": record["score"],
        "new_tier": tier,
        "pipeline": pipeline(patient_id),
    }, None


def auto_workup(patient_id: str) -> tuple[Optional[dict], Optional[str]]:
    """Run the tier-gated diagnostic cascade autonomously.

    The rule engine decides each next step from the CURRENT score, and the
    trained model re-scores after every simulated result -- so cognition drives
    blood, the blood-informed score drives MRI, and so on. A low tier (or a
    completed pathway) stops the cascade; every step is logged to the audit
    trail exactly like a clinician-driven advance.
    """
    record = PATIENTS.get(patient_id)
    if record is None:
        return None, None  # caller turns this into 404

    score_start = record["score"]
    steps: list[dict] = []

    for _ in range(3):  # at most blood, imaging, pet remain
        if record["stage"] >= 4:
            steps.append({"action": "complete", "summary": "Pathway complete — no further tests indicated."})
            break
        action = next_action_for(record)
        if action is None:
            steps.append({"action": "complete", "summary": "Pathway complete — no further tests indicated."})
            break
        if not can_advance(record):
            # Low tier (or monitor recommendation): cascade stops by design --
            # the model is NOT saying "healthy", it is saying "no test indicated now".
            steps.append({"action": "stop", "button": action["button"], "summary": action["summary"]})
            break

        to_stage = record["stage"] + 1
        slot = RESULT_SLOT[to_stage]
        now = datetime.now().strftime("%Y-%m-%d %H:%M")
        result = _simulate_result(record, slot)
        record[slot] = result
        record["stage"] = to_stage
        _rescore(record)
        tier = risk_tier(record["score"])
        record["updated_at"] = now
        record.setdefault("history", []).extend(
            [
                {"at": now, "text": f"{action['button']} (auto pathway)"},
                {
                    "at": now,
                    "text": (
                        f"{RESULT_SLOT_LABEL[slot]} result recorded — {result['outcome']} · "
                        f"re-scored {record['score']:.2f} → {tier} tier by trained model"
                    ),
                },
            ]
        )
        persist(record)  # mirror to Postgres when configured (best-effort)
        steps.append(
            {
                "action": "test",
                "stage": to_stage,
                "slot": slot,
                "button": action["button"],
                "outcome": result["outcome"],
                "note": result.get("note", ""),
                "score_after": record["score"],
                "tier_after": tier,
            }
        )

    return {
        "applied": True,
        "steps": steps,
        "tests_run": [s["slot"] for s in steps if s.get("action") == "test"],
        "score_start": score_start,
        "final_score": record["score"],
        "final_tier": risk_tier(record["score"]),
        "final_stage": record["stage"],
        "recommended_next": next_action_for(record),
        "pipeline": pipeline(patient_id),
    }, None


# --------------------------------------------------------------------------- #
# Autonomous triage loop
#
# The system ranks the whole cohort by CURRENT model score, takes the
# highest-ranked subject for whom the rule engine still indicates a test,
# performs exactly ONE next step (order -> result -> re-score), and returns
# the new ranking. Ranks can shift mid-cascade because a completed test can
# move a subject below a neighbor -- the queue is re-derived from live scores
# on every tick.
# --------------------------------------------------------------------------- #


def _ranked_testable() -> Optional[dict]:
    """Highest-scoring subject whose current tier still indicates a test. None when none do."""
    candidates = [
        r for r in PATIENTS.values()
        if r["stage"] < 4 and can_advance(r)
    ]
    if not candidates:
        all_active = [r for r in PATIENTS.values() if r["stage"] < 4]
        if not all_active:
            return None
        return max(all_active, key=lambda r: r["score"])  # fallback: keep going anyway
    return max(candidates, key=lambda r: r["score"])


def workup_next() -> dict:
    """One autonomous triage step on the highest-priority subject.

    Picks the subject by CURRENT score rank, runs the single next indicated
    test, re-scores, and reports the rank before/after so the UI can show the
    re-prioritization live.
    """
    ranked = sorted(PATIENTS.values(), key=lambda r: r["score"], reverse=True)
    rank_before = {r["id"]: i + 1 for i, r in enumerate(ranked)}

    subject = _ranked_testable()
    if subject is None:
        return {
            "applied": False,
            "done": True,
            "reason": "Every subject is at Stage 4 — the autonomous workup is complete for this cohort.",
        }

    subject_id = subject["id"]
    score_before = subject["score"]
    tier_before = risk_tier(score_before)
    stage_before = subject["stage"]

    payload, error = advance_stage(subject_id)
    if payload is None:
        return {
            "applied": False,
            "done": False,
            "reason": error or "Could not advance the selected subject.",
        }

    now_ranked = sorted(PATIENTS.values(), key=lambda r: r["score"], reverse=True)
    rank_after = {r["id"]: i + 1 for i, r in enumerate(now_ranked)}
    subject_rank_before = rank_before.get(subject_id)
    subject_rank_after = rank_after.get(subject_id)

    return {
        "applied": True,
        "done": False,
        "subject": {
            "id": subject_id,
            "stage_before": stage_before,
            "stage_after": payload["pipeline"]["current_stage"],
            "slot": payload["result"]["slot"],
            "outcome": payload["result"]["outcome"],
            "score_before": score_before,
            "score_after": payload["new_score"],
            "tier_after": payload["new_tier"],
            "rank_before": subject_rank_before,
            "rank_after": subject_rank_after,
        },
        "queue_remaining": sum(1 for r in PATIENTS.values() if r["stage"] < 4 and can_advance(r)),
        "total": len(PATIENTS),
    }


def record_result(
    patient_id: str,
    slot: str,
    outcome: str = "normal",
    values: Optional[dict] = None,
    note: Optional[str] = None,
) -> tuple[Optional[dict], Optional[str]]:
    """Record the outcome of an ordered test on a patient.

    Returns (payload, error) mirroring advance_stage: payload on success,
    a human-readable message for the 409 case.
    """
    record = PATIENTS.get(patient_id)
    if record is None:
        return None, None  # caller turns this into 404

    label = RESULT_SLOT_LABEL.get(slot, slot)
    current = record.get(slot)
    if not current:
        return None, f"{label} test has not been ordered yet — advance the pathway first."

    # New orders auto-populate a simulated result; recording onto a completed
    # slot AMENDS it (clinician enters the actual lab report over the derived one).
    amending = current.get("status") == "completed"

    # Normalize outcome; structured values pass through for display.
    outcome = outcome if outcome in ("normal", "abnormal", "inconclusive") else "normal"
    completed = {"status": "completed", "outcome": outcome}
    completed.update(values or {})
    if note:
        completed["note"] = note

    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    event = f"{label} result {'amended' if amending else 'recorded'} — {outcome}"
    if note:
        event = f"{event} · note: {note}"

    record[slot] = completed
    _rescore(record)
    tier = risk_tier(record["score"])
    event = f"{event} · re-scored {record['score']:.2f} → {tier} tier"
    record["updated_at"] = now
    record.setdefault("history", []).append({"at": now, "text": event})
    persist(record)  # mirror to Postgres when configured (best-effort)

    return {
        "applied": True,
        "event": event,
        "slot": slot,
        "outcome": outcome,
        "patient_id": patient_id,
        "new_score": record["score"],
        "new_tier": tier,
    }, None


def score_patient(features: dict) -> Optional[dict]:
    """Score an arbitrary feature vector with the trained pipeline + SHAP."""
    from . import model_service

    return model_service.score_features(features)


def model_info() -> dict:
    from . import model_service

    info = model_service.info()
    info["global_importance"] = GLOBAL_IMPORTANCE
    return info


def progression(patient_id: str) -> Optional[dict]:
    """12-month progression forecast (trajectory, conversion probability,
    projected risk tier). None when the patient or the forecaster is missing."""
    record = PATIENTS.get(patient_id)
    if record is None:
        return None
    from . import progression

    return progression.forecast(record)