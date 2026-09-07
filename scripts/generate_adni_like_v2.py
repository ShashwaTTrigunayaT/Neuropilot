#!/usr/bin/env python3
"""Synthetic ADNI-1-proportioned cohort generator (v2).

Differences from v1 (scripts/generate_adni_like.py):
  * 800 subjects (the ADNI-1 target size), not 500
  * Diagnostic composition mirrors ADNI-1 exactly: 200 CN / 400 MCI / 200 AD
  * The Stage-1..4 workup mix is tied to diagnostic phase (CN subjects are
    mostly fresh walk-ins; AD subjects have usually completed blood + MRI and
    often PET), so every pipeline stage is well-populated and the trained
    model gets real signal from blood, MRI and PET features -- fixing the
    "weightless PET" problem of the v1 cohort (5/500 PET subjects).

Output: data/processed/synthetic_patients_v2.json
Same record shape as v1 -- drop-in for ingest/training/storage.

This is a constrained synthetic dataset, not real patients. It is shaped by
published ADNI-1 composition and plausible biomarker ranges, with risk tier
coherent with biomarker severity.
"""
from __future__ import annotations

import json
import random
from datetime import datetime, timedelta
from pathlib import Path

SLOT_LABEL = {"blood": "Blood biomarkers", "imaging": "MRI volumetrics", "pet": "PET imaging"}
DATA_SOURCE_TAG = "synthetic_v2_adni_shape"


def risk_tier(score):
    return "high" if score > 0.7 else ("medium" if score >= 0.4 else "low")


SEED = 20260906
OUT = Path("data/processed/synthetic_patients_v2.json")
OUT.parent.mkdir(parents=True, exist_ok=True)

# --- ADNI-1 ground truth composition (adni.loni.usc.edu) -------------------- #
N_TOTAL = 800
N_CN = 200   # cognitively normal controls
N_MCI = 400  # mild cognitive impairment
N_AD = 200   # Alzheimer's disease (early)

rng = random.Random(SEED)


def _clamp(x, lo, hi):
    return max(lo, min(hi, x))


def _round(v, d=2):
    return round(float(v), d)


# --------------------------------------------------------------------------- #
# Demographics
# --------------------------------------------------------------------------- #
def _demo(phase):
    age = {
        "CN": rng.gauss(75.9, 5.0),   # ADNI-1 CN mean ~75.9y
        "MCI": rng.gauss(74.8, 7.4),  # ADNI-1 MCI mean ~74.8y
        "AD": rng.gauss(75.4, 7.9),   # ADNI-1 AD mean ~75.4y
    }[phase]
    sex = "M" if rng.random() < (0.51 if phase == "CN" else 0.63 if phase == "MCI" else 0.52) else "F"
    edu = int(_clamp(round(rng.gauss(16.2, 2.8)), 6, 20))  # ADNI-1 mean edu ~16y
    ses = int(_clamp(round(rng.gauss(2.5, 1.1)), 1, 5))
    return _clamp(age, 55, 90), sex, edu, ses


# --------------------------------------------------------------------------- #
# Phase-conditioned latent severity -> MMSE / CDR
# --------------------------------------------------------------------------- #
def _severity(phase):
    base = {"CN": rng.gauss(0.14, 0.07), "MCI": rng.gauss(0.52, 0.12), "AD": rng.gauss(0.88, 0.07)}[phase]
    return _clamp(base, 0.02, 0.99)


def _cdr(phase, score):
    if phase == "CN":
        return 0.0 if rng.random() < 0.92 else 0.5
    if phase == "MCI":
        r = rng.random()
        if score > 0.6:
            return 0.5 if r < 0.75 else 1.0
        return 0.5 if r < 0.9 else 0.0
    # AD
    r = rng.random()
    if r < 0.35:
        return 1.0
    if r < 0.8:
        return 2.0
    return 0.5


def _mmse(phase, cdr, score):
    if phase == "CN":
        mu = 29.1
    elif phase == "MCI":
        mu = 27.0
    else:
        mu = 20.5 if cdr <= 1.0 else 17.5
    latest = int(_clamp(round(rng.gauss(mu, 1.8)), 4, 30))
    drift = {"CN": rng.gauss(0.1, 0.6), "MCI": rng.gauss(-0.8, 1.4), "AD": rng.gauss(-1.9, 1.8)}[phase]
    prior = int(_clamp(round(latest - drift), 4, 30))
    return latest, prior


# --------------------------------------------------------------------------- #
# Stage 2: blood biomarkers (p-tau181 pg/mL, Aβ42/40 ratio)
# --------------------------------------------------------------------------- #
def _blood(phase, score):
    sev = score
    pt = _clamp(rng.gauss(1.6 + 4.2 * sev, 0.75), 0.6, 7.5)
    ab = _clamp(rng.gauss(0.125 - 0.062 * sev, 0.016), 0.04, 0.16)
    if ab < 0.068 or pt > 4.0:
        outcome, note = "abnormal", f"p-tau181 elevated ({_round(pt)} pg/mL); Aβ42/40 below reference ({_round(ab, 3)})"
    elif pt > 3.0 or ab < 0.085:
        outcome, note = "inconclusive", f"Borderline panel — p-tau181 {_round(pt)} pg/mL near threshold; repeat in 6 months"
    else:
        outcome, note = "normal", f"Both markers within reference range (p-tau181 {_round(pt)}, Aβ42/40 {_round(ab, 3)})"
    return {"status": "completed", "outcome": outcome, "pTau181": _round(pt), "abeta4240": _round(ab, 3), "note": note}


# --------------------------------------------------------------------------- #
# Stage 3: MRI volumetrics (hippocampal volume cm3)
# --------------------------------------------------------------------------- #
def _imaging(phase, score, age):
    sev = score
    hv = _clamp(rng.gauss(3.35 - 1.05 * sev - 0.012 * max(0, age - 70), 0.28), 1.6, 4.3)
    if hv < 2.25:
        outcome, note = "abnormal", f"Bilateral medial temporal atrophy — hippocampal volume {_round(hv)} cm³ (<5th percentile)"
    elif hv < 2.55:
        outcome, note = "inconclusive", f"Hippocampal volume {_round(hv)} cm³ borders age-adjusted reference; correlate clinically"
    else:
        outcome, note = "normal", f"No focal atrophy — hippocampal volume {_round(hv)} cm³ within age-adjusted range"
    return {"status": "completed", "outcome": outcome, "hippocampalVolumeCm3": _round(hv), "note": note}


# --------------------------------------------------------------------------- #
# Stage 4: PET (amyloid/tau status + SUVR)
# --------------------------------------------------------------------------- #
def _pet(phase, score):
    p_amy = _clamp(0.05 + 0.9 * score, 0.03, 0.98)
    amyloid = "Positive" if rng.random() < p_amy else "Negative"
    tau = "Positive" if amyloid == "Positive" and rng.random() < 0.82 else "Negative"
    suvr = _round(rng.gauss(1.42 if amyloid == "Positive" else 1.07, 0.09), 2)
    if amyloid == "Positive" and tau == "Positive":
        outcome, note = "abnormal", f"Neocortical amyloid retention (SUVR {suvr}) with tau spread — pathological"
    elif amyloid == "Positive":
        outcome, note = "inconclusive", f"Amyloid-positive (SUVR {suvr}) but tau-negative — atypical profile, specialist review"
    else:
        outcome, note = "normal", f"No significant amyloid binding (SUVR {suvr})"
    return {"status": "completed", "outcome": outcome, "amyloid": amyloid, "tau": tau, "amyloidSUVr": suvr, "note": note}


# --------------------------------------------------------------------------- #
# Workup-stage assignment: correlated to diagnostic phase (like real care paths)
# --------------------------------------------------------------------------- #
# CN: nearly all fresh Stage-1 walk-ins (a small share have blood drawn)
# MCI: half still at cognition-only; most of the rest have completed blood
# AD: virtually all have blood+MRI; a large share have PET too
def _workup_stage(phase, score):
    r = rng.random()
    if phase == "CN":
        return 1 if r < 0.90 else 2
    if phase == "MCI":
        if score > 0.6:
            return 2 if r < 0.55 else (3 if r < 0.90 else 4)
        return 1 if r < 0.60 else (2 if r < 0.92 else 3)
    # AD
    return 3 if r < 0.40 else 4


def _comorbidities(age, sex, score):
    out = []
    if age > 72 and rng.random() < 0.35:
        out.append("Hypertension")
    if sex == "M" and rng.random() < 0.18:
        out.append("Type 2 Diabetes")
    if score > 0.7 and rng.random() < 0.22:
        out.append("Hyperlipidemia")
    if score > 0.55 and rng.random() < 0.12:
        out.append("Atrial Fibrillation")
    return out


def make_subject(i, phase):
    age, sex, edu, ses = _demo(phase)
    score = _severity(phase)
    cdr = _cdr(phase, score)
    mmse_latest, mmse_first = _mmse(phase, cdr, score)
    comorbidities = _comorbidities(age, sex, score)
    family_history = rng.random() < (0.14 if phase == "CN" else 0.24 if phase == "MCI" else 0.38)

    stage = _workup_stage(phase, score)
    now = datetime.now()

    def _days_ago(n):
        return (now - timedelta(days=n)).strftime("%Y-%m-%d %H:%M")

    scored_at = _days_ago(rng.randint(20, 60))
    tier = risk_tier(score)
    phase_label = {"CN": "Cognitively Normal", "MCI": "MCI", "AD": "Alzheimer's disease"}[phase]
    history = [
        {"at": scored_at, "text": f"Synthetic ADNI-1-shaped subject scored {_round(score, 2)} → prioritized {tier} ({phase_label})"},
    ]

    blood = imaging = pet = None
    ordered_at = {}
    if stage >= 2:
        blood = _blood(phase, score)
        ordered_at["blood"] = rng.randint(5, 18)
        history.append({"at": _days_ago(ordered_at["blood"] + 3), "text": f"Blood biomarker panel ordered (risk {tier})"})
    if stage >= 3:
        imaging = _imaging(phase, score, age)
        ordered_at["imaging"] = rng.randint(2, 9)
        history.append({"at": _days_ago(ordered_at["imaging"] + 2), "text": "MRI with volumetric analysis ordered"})
    if stage >= 4:
        pet = _pet(phase, score)
        ordered_at["pet"] = rng.randint(1, 5)
        history.append({"at": _days_ago(ordered_at["pet"] + 1), "text": "Amyloid/tau PET ordered"})

    for slot in ("blood", "imaging", "pet"):
        result = {"blood": blood, "imaging": imaging, "pet": pet}[slot]
        if result and result.get("status") == "completed":
            days = ordered_at.get(slot, 7)
            history.append({
                "at": _days_ago(max(0, days - 1)),
                "text": f"{SLOT_LABEL[slot]} result recorded — {result.get('outcome', 'normal')}",
            })
    history.reverse()

    return {
        "id": f"ADNI-{i:04d}",
        "phase": phase,
        "age": int(round(age)),
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
        "factors": [],  # filled by the trained model at API load time
        "updated_at": _days_ago(rng.randint(0, 6)),
        "history": history,
    }


def main():
    print(f"Generating {N_TOTAL} synthetic subjects (seed={SEED})")
    print(f"  ADNI-1 composition: {N_CN} CN / {N_MCI} MCI / {N_AD} AD")
    phases = ["CN"] * N_CN + ["MCI"] * N_MCI + ["AD"] * N_AD
    rng.shuffle(phases)

    subjects = []
    for i, phase in enumerate(phases, start=1):
        s = make_subject(i, phase)
        s["data_source_tag"] = DATA_SOURCE_TAG
        subjects.append(s)

    OUT.write_text(json.dumps(subjects, indent=2), encoding="utf-8")
    print(f"Wrote {OUT} ({len(subjects)} subjects)")

    tiers = {"high": 0, "medium": 0, "low": 0}
    for s in subjects:
        tiers[risk_tier(s["score"])] += 1
    print(f"Risk tiers: High={tiers['high']} · Medium={tiers['medium']} · Low={tiers['low']}")
    stages = {st: sum(1 for x in subjects if x["stage"] == st) for st in (1, 2, 3, 4)}
    print(f"Workup stages: {stages}")
    counts = {p: sum(1 for x in subjects if x["phase"] == p) for p in ("CN", "MCI", "AD")}
    print(f"Diagnostic phases: {counts}")
    pet_done = sum(1 for x in subjects if isinstance(x.get("pet"), dict) and x["pet"].get("status") == "completed")
    blood_done = sum(1 for x in subjects if isinstance(x.get("blood"), dict) and x["blood"].get("status") == "completed")
    print(f"Completed results: blood={blood_done}, pet={pet_done}")


if __name__ == "__main__":
    main()
