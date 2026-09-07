#!/usr/bin/env python3
"""Synthetic ADNI-shaped cohort generator (blueprint section 4.1 extension).

Produces data/processed/synthetic_patients.json: 500 subjects with plausible
Stage 1-4 measures (cognitive, blood biomarkers, MRI volumetrics, PET), so the
app can demonstrate the full escalation loop without depending on real OASIS-1
data (which has no blood/MRI/PET results).

This is a constrained synthetic dataset, not real patients. Do not treat it as
clinical truth -- it is a demo cohort shaped by published ADNI ranges and
internal correlation heuristics, with risk tier coherent with biomarker severity.
"""
from __future__ import annotations

import json
import random
from datetime import datetime, timedelta
from pathlib import Path

SLOT_LABEL = {"blood": "Blood biomarkers", "imaging": "MRI volumetrics", "pet": "PET imaging"}


def risk_tier(score):
    return "high" if score > 0.7 else ("medium" if score >= 0.4 else "low")

SEED = 20260822
rng = random.Random(SEED)

OUT = Path("data/processed/synthetic_patients.json")
OUT.parent.mkdir(parents=True, exist_ok=True)

NUM_SUBJECTS = 500


def _clamp(x, lo, hi):
    return max(lo, min(hi, x))


def _round(v, d=2):
    return round(float(v), d)


def _cdr_from_score(score):
    if score > 0.75:
        r = rng.random()
        if r < 0.25:
            return 0.5
        if r < 0.70:
            return 1.0
        return 2.0
    if score > 0.45:
        r = rng.random()
        if r < 0.45:
            return 0.0
        if r < 0.80:
            return 0.5
        return 1.0
    r = rng.random()
    return 0.0 if r < 0.7 else 0.5


def _age(sex):
    base = rng.gauss(73, 7.5)
    if sex == "F":
        base += 1.2
    return int(_clamp(base, 55, 94))


def _sex():
    if rng.random() < 0.48:
        return "M"
    return "F"


def _edu():
    r = rng.random()
    if r < 0.08:
        return 8
    if r < 0.18:
        return 10
    if r < 0.46:
        return 12
    if r < 0.61:
        return 13
    if r < 0.73:
        return 15
    if r < 0.93:
        return 16
    return 18


def _ses():
    r = rng.random()
    if r < 0.05:
        return 1
    if r < 0.25:
        return 2
    if r < 0.55:
        return 3
    if r < 0.83:
        return 4
    return 5


def _mmse_from_cdr(cdr):
    table = {0.0: (24, 30), 0.5: (20, 26), 1.0: (14, 22), 2.0: (5, 16), 3.0: (0, 10)}
    lo, hi = table[cdr]
    return rng.randint(lo, hi)


def _mmse_first(age, cdr):
    mid = _mmse_from_cdr(cdr)
    drift = max(-3, min(3, int((age - 73) / 5)))
    return int(_clamp(mid + drift, 0, 30))


def _mmse_latest(mmse_first, cdr, months=6):
    if cdr >= 1.0:
        _p = rng.random()
        if _p < 0.15:
            decline = 0
        elif _p < 0.35:
            decline = 1
        elif _p < 0.60:
            decline = 2
        elif _p < 0.80:
            decline = 3
        elif _p < 0.90:
            decline = 4
        else:
            decline = 5
    elif cdr >= 0.5:
        _p = rng.random()
        if _p < 0.25:
            decline = 0
        elif _p < 0.50:
            decline = 0
        elif _p < 0.70:
            decline = 1
        elif _p < 0.85:
            decline = 1
        elif _p < 0.95:
            decline = 2
        else:
            decline = 3
    else:
        _p = rng.random()
        if _p < 0.35:
            decline = 0
        elif _p < 0.65:
            decline = 0
        elif _p < 0.85:
            decline = 0
        elif _p < 0.95:
            decline = 1
        elif _p < 0.99:
            decline = 1
        else:
            decline = 2
    return int(_clamp(mmse_first - decline, 0, 30))


def _comorbidities(age, sex, score):
    base = []
    if rng.random() < 0.55:
        base.append("Hypertension")
    if rng.random() < 0.20:
        base.append("Type 2 diabetes")
    if rng.random() < 0.18:
        base.append("Cardiovascular disease")
    if rng.random() < 0.12:
        base.append("Hyperlipidemia")
    if score > 0.7 and rng.random() < 0.5:
        if rng.random() < 0.7:
            base.append("Family history of dementia")
    return list(dict.fromkeys(base))


def _family_history(score):
    if score > 0.7:
        return rng.random() < 0.5
    if score > 0.45:
        return rng.random() < 0.3
    return rng.random() < 0.15


def _blood(score, cdr):
    if score <= 0.3 and rng.random() < 0.65:
        return None
    if cdr >= 1.0:
        pt = rng.gauss(5.2, 1.2)
    elif cdr >= 0.5:
        pt = rng.gauss(3.2, 1.4)
    else:
        pt = rng.gauss(1.9, 1.0)
    if cdr >= 1.0:
        ab = rng.gauss(0.055, 0.012)
    elif cdr >= 0.5:
        ab = rng.gauss(0.080, 0.016)
    else:
        ab = rng.gauss(0.115, 0.018)
    pt = _clamp(pt, 0.2, 10.0)
    ab = _clamp(ab, 0.020, 0.200)
    note_parts = []
    if pt > 4.0:
        note_parts.append("Elevated p-tau181")
    elif pt > 2.5:
        note_parts.append("Borderline p-tau181")
    else:
        note_parts.append("p-tau181 within reference")
    if ab < 0.065:
        note_parts.append(f"Abeta42/40 ratio below reference ({_round(ab, 3)})")
    elif ab < 0.090:
        note_parts.append(f"Abeta42/40 ratio at lower reference ({_round(ab, 3)})")
    else:
        note_parts.append(f"Abeta42/40 ratio normal ({_round(ab, 3)})")
    if pt > 4.0 or ab < 0.065:
        outcome = "abnormal"
    elif pt > 2.5 or ab < 0.090:
        outcome = "inconclusive"
    else:
        outcome = "normal"
    return {
        "status": "completed",
        "outcome": outcome,
        "pTau181": _round(pt, 2),
        "abeta4240": _round(ab, 3),
        "note": "; ".join(note_parts),
    }


def _imaging(score, cdr, age):
    if score <= 0.3 and rng.random() < 0.6:
        return None
    age_effect = max(-0.4, min(0.4, (age - 73) / 20))
    if cdr >= 1.0:
        hvol = rng.gauss(1.95, 0.25) + age_effect
    elif cdr >= 0.5:
        hvol = rng.gauss(2.55, 0.30) + age_effect
    else:
        hvol = rng.gauss(3.05, 0.32) + age_effect
    hvol = _clamp(hvol, 1.2, 4.2)
    note = (
        "<2nd percentile for age" if hvol < 2.1
        else "<5th percentile for age" if hvol < 2.6
        else "within expected range"
    )
    outcome = "abnormal" if hvol < 2.1 else "inconclusive" if hvol < 2.6 else "normal"
    return {
        "status": "completed",
        "outcome": outcome,
        "hippocampalVolumeCm3": _round(hvol, 2),
        "note": note,
    }


def _pet(score, cdr):
    if score <= 0.3 and rng.random() < 0.7:
        return None
    amyloid_prob = {0.0: 0.10, 0.5: 0.55, 1.0: 0.80, 2.0: 0.92, 3.0: 0.97}[cdr]
    amyloid = "Positive" if rng.random() < amyloid_prob else "Negative"
    tau = "Positive" if amyloid == "Positive" and rng.random() < 0.8 else "Negative"
    note = (
        "Consistent with AD pathology" if amyloid == "Positive" and tau == "Positive"
        else "Amyloid-positive, tau-negative — atypical pattern"
        if amyloid == "Positive"
        else "No significant amyloid burden"
    )
    outcome = "abnormal" if amyloid == "Positive" and tau == "Positive" else "inconclusive" if amyloid == "Positive" else "normal"
    return {
        "status": "completed",
        "outcome": outcome,
        "amyloid": amyloid,
        "tau": tau,
        "note": note,
    }


def _factors(score, mmse_latest, mmse_first, age, edu, comorbidities, family_history, cdr):
    factors = []
    mmse_decline = mmse_first - mmse_latest
    if mmse_decline > 0:
        factors.append({"text": f"MMSE declined {mmse_decline} points", "effect": _round(0.08 + mmse_decline * 0.05, 2)})
    else:
        factors.append({"text": "MMSE stable over 6 months", "effect": _round(-0.06, 2)})
    factors.append({"text": f"Age {age}", "effect": _round(0.04 if age >= 75 else 0.02, 2)})
    if edu >= 16:
        factors.append({"text": f"Higher education ({edu} yrs)", "effect": _round(-0.08, 2)})
    elif edu <= 10:
        factors.append({"text": f"Lower education ({edu} yrs)", "effect": _round(0.05, 2)})
    if comorbidities:
        factors.append({"text": ", ".join(comorbidities), "effect": _round(0.05, 2)})
    if family_history:
        factors.append({"text": "Family history of dementia", "effect": _round(0.07, 2)})
    if cdr >= 0.5:
        factors.append({"text": f"CDR {cdr}", "effect": _round(0.10 + cdr * 0.05, 2)})
    factors.sort(key=lambda f: f["effect"], reverse=True)
    return factors


def make_subject(i):
    sex = _sex()
    age = _age(sex)
    edu = _edu()
    ses = _ses()
    score = _clamp(rng.gauss(0.55, 0.18), 0.05, 0.97)
    cdr = _cdr_from_score(score)
    mmse_first = _mmse_first(age, cdr)
    mmse_latest = _mmse_latest(mmse_first, cdr)
    comorbidities = _comorbidities(age, sex, score)
    family_history = _family_history(score)

    # --- Stage assignment (coherent with the escalation workflow) ----------
    # Everyone is scored at Stage 1 (cognitive). A minority of subjects are
    # further along the diagnostic pipeline; a patient at stage N has
    # COMPLETED results for all slots below N (in order) and nothing beyond.
    # Result slots are filled by escalating in order: blood -> imaging -> pet.
    r = rng.random()
    if score > 0.7:
        # Higher-risk subjects progress more often (but most are still fresh)
        stage = 1 if r < 0.62 else (2 if r < 0.82 else (3 if r < 0.94 else 4))
    elif score > 0.45:
        stage = 1 if r < 0.78 else (2 if r < 0.94 else 3)
    else:
        stage = 1 if r < 0.92 else 2

    blood = imaging = pet = None
    ordered_at = {}
    now = datetime.now()

    def _days_ago(n):
        return (now - timedelta(days=n)).strftime("%Y-%m-%d %H:%M")

    scored_at = _days_ago(rng.randint(20, 60))
    history = [
        {"at": scored_at, "text": f"Synthetic ADNI-shaped subject scored {_round(score, 2)} → prioritized at Stage 1"},
    ]

    if stage >= 2:
        blood = _blood(score, cdr)
        if blood is None:  # ordered but result not yet returned -> pending
            blood = {"status": "pending"}
        ordered_at["blood"] = rng.randint(5, 18)
        history.append({
            "at": _days_ago(ordered_at["blood"] + 3),
            "text": f"Blood biomarker panel ordered (risk {risk_tier(score)})",
        })
    if stage >= 3:
        imaging = _imaging(score, cdr, age)
        if imaging is None:
            imaging = {"status": "pending"}
        ordered_at["imaging"] = rng.randint(2, 9)
        history.append({
            "at": _days_ago(ordered_at["imaging"] + 2),
            "text": "MRI with volumetric analysis ordered",
        })
    if stage >= 4:
        pet = _pet(score, cdr)
        if pet is None:
            pet = {"status": "pending"}
        ordered_at["pet"] = rng.randint(1, 5)
        history.append({
            "at": _days_ago(ordered_at["pet"] + 1),
            "text": "Amyloid/tau PET ordered",
        })

    # Fill result timestamps chronologically (they were generated newest-first)
    for slot in ("blood", "imaging", "pet"):
        result = {"blood": blood, "imaging": imaging, "pet": pet}[slot]
        if result and result.get("status") == "completed":
            days = ordered_at.get(slot, 7)
            history.append({
                "at": _days_ago(max(0, days - 1)),
                "text": f"{SLOT_LABEL[slot]} result recorded — {result.get('outcome', 'normal')}",
            })

    # History was appended newest-first; display order is chronological.
    history.reverse()

    factors = _factors(score, mmse_latest, mmse_first, age, edu, comorbidities, family_history, cdr)
    return {
        "id": f"SYN-{i:04d}",
        "age": age,
        "sex": sex,
        "education_years": edu,
        "ses": ses,
        "family_history": family_history,
        "comorbidities": comorbidities,
        "cognitive": {"scale": "MMSE", "latest": mmse_latest, "prior": mmse_first, "months": 6},
        "blood": blood,
        "imaging": imaging,
        "pet": pet,
        "score": _round(score, 4),
        "stage": stage,
        "factors": factors,
        "updated_at": _days_ago(rng.randint(0, 6)),
        "history": history,
    }


def main():
    print(f"Generating {NUM_SUBJECTS} synthetic ADNI-shaped subjects (seed={SEED})...")
    subjects = [make_subject(i) for i in range(1, NUM_SUBJECTS + 1)]
    OUT.write_text(json.dumps(subjects, indent=2), encoding="utf-8")
    print(f"Wrote {OUT} ({len(subjects)} subjects)")
    high = sum(1 for s in subjects if s["score"] > 0.7)
    med = sum(1 for s in subjects if 0.4 <= s["score"] <= 0.7)
    low = sum(1 for s in subjects if s["score"] < 0.4)
    print(f"Risk tiers: High={high} · Medium={med} · Low={low}")
    stages = {s: sum(1 for x in subjects if x["stage"] == s) for s in (1, 2, 3, 4)}
    print(f"Stages: {stages}")
    pending = sum(1 for x in subjects for slot in ("blood", "imaging", "pet") if (x.get(slot) or {}).get("status") == "pending")
    print(f"Pending results: {pending}")


if __name__ == "__main__":
    main()
