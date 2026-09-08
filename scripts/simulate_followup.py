#!/usr/bin/env python3
"""Simulated 12-month follow-up for the synthetic v2 cohort (progression labels).

For every subject in data/processed/synthetic_patients_v2.json this derives a
plausible visit ~12 months later:

  * MMSE drift driven by the subject's OBSERVED biomarkers (amyloid/tau PET,
    p-tau181, Aβ42/40, hippocampal volume) plus age/education/cognition --
    the same clinical drivers real progression models use. Subjects without a
    completed stage simply contribute no drift term from it.
  * A binary conversion label (progression to a more severe diagnostic phase,
    CN->MCI or MCI->AD) drawn probabilistically from the projected trajectory
    crossing its phase's MMSE boundary, weighted by biomarker evidence.

The output is the FORECASTER'S GROUND TRUTH: (baseline features -> 12-month
outcome) pairs that scripts/train_progression_model.py learns from, and the
"observed" series the UI plots against the model's prediction.

Deterministic: every draw is seeded from the subject id, so regenerating the
file is stable. This is synthetic ground truth shaped by published progression
dynamics -- not real patient outcomes.
"""
from __future__ import annotations

import json
import math
import random
from pathlib import Path

SRC = Path("data/processed/synthetic_patients_v2.json")
OUT = Path("data/processed/followup_12mo.json")
HORIZON_MONTHS = 12

# MMSE boundaries where a phase transition becomes clinically apparent
# (aligned with the v2 generator's phase MMSE means: CN ~29, MCI ~27, AD ~20).
BOUNDARY = {"CN": 26.0, "MCI": 20.0}
TARGET = {"CN": "MCI", "MCI": "AD"}


def _clamp(x, lo, hi):
    return max(lo, min(hi, x))


def _sigmoid(x):
    return 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, x))))


def simulate_subject(subject: dict) -> dict:
    """Deterministic 12-month outcome for one subject."""
    rng = random.Random(f"followup12:{subject['id']}")

    mmse = subject.get("cognitive", {}).get("latest")
    if mmse is None:
        mmse = 27
    age = subject.get("age", 74)
    edu = subject.get("education_years", 14)
    phase = subject.get("phase", "MCI")
    blood = subject.get("blood") or {}
    imaging = subject.get("imaging") or {}
    pet = subject.get("pet") or {}

    # ---- MMSE drift over 12 months (negative = decline) -------------------- #
    drift = -0.45  # cohort-average slow decline
    drift += (age - 74) * 0.035                    # age accelerates decline
    drift += (edu - 14) * 0.05                     # cognitive reserve protects
    if isinstance(blood, dict) and blood.get("pTau181") is not None:
        drift -= (float(blood["pTau181"]) - 2.0) * 0.22   # tau pathology accelerates
    if isinstance(blood, dict) and blood.get("abeta4240") is not None:
        drift -= (0.09 - float(blood["abeta4240"])) * 16.0  # amyloid burden
    if isinstance(imaging, dict) and imaging.get("hippocampalVolumeCm3") is not None:
        drift -= (2.6 - float(imaging["hippocampalVolumeCm3"])) * 0.55  # neurodegeneration
    if isinstance(pet, dict) and str(pet.get("amyloid", "")).lower() == "positive":
        drift -= 0.85
    if isinstance(pet, dict) and str(pet.get("tau", "")).lower() == "positive":
        drift -= 1.05
    # Baseline slope the patient already exhibits (fast decliners keep declining)
    cog = subject.get("cognitive", {})
    prior = cog.get("prior", mmse)
    if prior is not None:
        drift += (mmse - prior) * 0.30
    drift += rng.gauss(0.0, 0.65)                  # individual noise
    drift = _clamp(drift, -7.5, 2.5)

    mmse_future = int(_clamp(round(mmse + drift), 0, 30))
    mmse_delta = mmse_future - mmse

    # ---- Conversion probability -------------------------------------------- #
    # Rises as the projected trajectory approaches/crosses the phase boundary,
    # weighted by pathological biomarker evidence.
    evidence = 0.0
    if isinstance(blood, dict) and blood.get("pTau181") is not None:
        evidence += _clamp((float(blood["pTau181"]) - 3.0) * 0.25, 0.0, 1.0)
    if isinstance(blood, dict) and blood.get("abeta4240") is not None:
        evidence += _clamp((0.085 - float(blood["abeta4240"])) * 12.0, 0.0, 1.0)
    if isinstance(pet, dict) and str(pet.get("amyloid", "")).lower() == "positive":
        evidence += 0.6
    if isinstance(pet, dict) and str(pet.get("tau", "")).lower() == "positive":
        evidence += 0.6
    evidence = _clamp(evidence, 0.0, 1.6)

    target = TARGET.get(phase)
    if target is None:
        # AD subjects: no further phase transition -- model "further decline"
        # as the conversion analogue (crossing the severe MMSE < 15 line).
        boundary, target = 15.0, "Severe AD"
    else:
        boundary = BOUNDARY[phase]

    # Annual base conversion rate by phase (published progression literature:
    # CN ~4%/yr, MCI ~10-15%/yr, AD further-decline much higher), modulated by
    # biomarker evidence and by how close the projected trajectory is to the
    # phase's MMSE boundary.
    base_rate = {"CN": 0.04, "MCI": 0.12, "AD": 0.28}.get(phase, 0.28)
    proximity = _sigmoid((boundary - (mmse + drift)) / 1.5)  # 1 = projected below boundary
    p_convert = base_rate * (0.3 + 0.7 * evidence) + 0.55 * proximity * (0.45 + 0.55 * evidence)
    p_convert = _clamp(p_convert, 0.01, 0.97)
    converted = rng.random() < p_convert

    return {
        "id": subject["id"],
        "months": HORIZON_MONTHS,
        "mmse_baseline": mmse,
        "mmse_future": mmse_future,
        "mmse_delta": mmse_delta,
        "converted": bool(converted),
        "conversion_target": target if converted else None,
        "conversion_probability_truth": round(p_convert, 4),
        "phase": phase,
    }


def main() -> int:
    if not SRC.exists():
        print(f"ERROR: {SRC} missing — run scripts/generate_adni_like_v2.py first.")
        return 1
    subjects = json.loads(SRC.read_text(encoding="utf-8"))
    rows = [simulate_subject(s) for s in subjects]
    OUT.write_text(json.dumps(rows, indent=2), encoding="utf-8")

    n_conv = sum(1 for r in rows if r["converted"])
    deltas = [r["mmse_delta"] for r in rows]
    by_phase = {}
    for r in rows:
        by_phase.setdefault(r["phase"], []).append(r)
    print(f"[followup] wrote {OUT} ({len(rows)} subjects, horizon {HORIZON_MONTHS} mo)")
    print(f"  conversions : {n_conv}/{len(rows)} ({100 * n_conv / len(rows):.1f}%)")
    print(f"  MMSE delta  : mean {sum(deltas)/len(deltas):+.2f} · min {min(deltas)} · max {max(deltas)}")
    for phase, rs in sorted(by_phase.items()):
        conv = sum(1 for r in rs if r["converted"])
        d = sum(r["mmse_delta"] for r in rs) / len(rs)
        print(f"  {phase:4s}: n={len(rs):3d} · conversion {100*conv/len(rs):5.1f}% · mean delta {d:+.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
