"""Patient store.

Preference order (override with PATIENT_DATA=adni|synthetic|real|mock):
  1. REAL ADNI cohort: data/processed/adni_cohort.json (scripts/ingest_adni.py)
     -- 3.6k subjects, real DIAGNOSIS labels, all four stages where measured
  2. Synthetic ADNI-shaped cohort: data/processed/synthetic_patients_v2.json
  3. Real OASIS scores: data/processed/risk_scores.json
  4. Mock cohort (backend/app/seed_data.py) so the API demos standalone

Each subject carries only the stages that were actually measured, so the
missing slots stay empty and the escalation engine recommends the next test
from their risk tier exactly as it would for a patient entering the pipeline.
"""
from __future__ import annotations

import copy
import csv
import json
import math
import os
from datetime import datetime
from pathlib import Path
from typing import Optional

from .config import (BIOMARKER_FEATURES, GLOBAL_IMPORTANCE_PATH, RISK_SCORES_PATH,
                     PROJECT_ROOT, risk_tier)
from .seed_data import MOCK_PATIENTS

# Feature name -> human-readable explanation (blueprint section 4.4)
HUMAN_FEATURES = {
    "mmse": "Latest MMSE score",
    "age": "Age",
    "education_years": "Education (years)",
    "ses": "Socioeconomic status (SES)",
    "etiv": "Intracranial volume (eTIV)",
    "nwbv": "Normalized whole-brain volume (nWBV)",
    "asf": "Atlas scaling factor (ASF)",
    "sex": "Sex",
    "mmse_change": "MMSE change vs first visit",
    "n_visits": "Number of recorded visits",
    "study_years": "Years in study",
    "ptau181": "p-tau181 (blood biomarker)",
    "abeta4240": "Aβ42/40 ratio (blood biomarker)",
    "hippocampal_volume": "Hippocampal volume (MRI)",
    "amyloid_positive": "Amyloid PET status",
    "tau_positive": "Tau PET status",
    # --- real ADNI 15-feature vector (FAQ removed 2026-09-19) ---
    "adas_cog_13": "ADAS-Cog 13 (cognitive scale)",
    # "faq_total": REMOVED (label leakage — part of ADNI diagnostic algorithm)
    "apoe_e4": "APOE ε4 carrier",
    "ptau217": "p-tau217 (plasma)",
    "nfl": "NfL (plasma, neuroaxonal injury)",
    "gfap": "GFAP (plasma, astrocyte activation)",
    "hippocampal_icv_ratio": "Hippocampus / intracranial volume (MRI)",
    "centiloids": "Amyloid PET burden (Centiloids)",
    "tau_meta_temporal": "Tau PET (temporal meta SUVR)",
    "icv_cm3": "Intracranial volume (MRI)",
}

NOW = datetime.now().strftime("%Y-%m-%d %H:%M")

# Static global importances used in mock mode (mirror of the frontend panel).
MOCK_GLOBAL_IMPORTANCE = [
    {"feature": "MoCA / MMSE decline (6 mo)", "mean_abs_shap": 0.24},
    {"feature": "p-tau181 (blood)", "mean_abs_shap": 0.19},
    {"feature": "Hippocampal volume (MRI)", "mean_abs_shap": 0.16},
    {"feature": "Age", "mean_abs_shap": 0.12},
    {"feature": "Aβ42/40 ratio (blood)", "mean_abs_shap": 0.09},
    {"feature": "Education (years)", "mean_abs_shap": 0.07},
    {"feature": "Hypertension", "mean_abs_shap": 0.05},
    {"feature": "Type 2 diabetes", "mean_abs_shap": 0.04},
    {"feature": "Family history", "mean_abs_shap": 0.03},
]


def _map_real_record(r: dict) -> dict:
    """risk_scores.json entry -> internal patient record."""
    score = float(r.get("risk_score", 0.5))
    mmse = r.get("mmse")
    factors = []
    for f in r.get("top_factors", []):
        feature = f.get("feature", "")
        factors.append(
            {
                "feature": feature,
                "text": HUMAN_FEATURES.get(feature, feature),
                "value": f.get("value"),
                "effect": float(f.get("contribution", 0.0)),
            }
        )
    # risk_scores.json is the de-identified seed: it carries no measured values,
    # so corroborating evidence is inferred from whether the model actually used
    # a biomarker feature for this subject. Without one the tier stays capped at
    # Medium, exactly as it would for a cognition-only record.
    evidence = any(f["feature"] in BIOMARKER_FEATURES for f in factors)
    tier = risk_tier(score, evidence)
    return {
        "id": str(r.get("subject_id")),
        "age": r.get("age"),
        "sex": r.get("sex"),
        "education_years": r.get("education_years"),
        "family_history": False,
        "comorbidities": [],
        "cognitive": {"scale": "MMSE", "latest": mmse, "prior": mmse, "months": 6} if mmse is not None else None,
        "blood": None,
        "imaging": None,
        "pet": None,
        "score": score,
        "stage": 1,
        "factors": factors,
        "updated_at": NOW,
        "history": [
            {
                "at": NOW,
                "text": f"Scored {score:.2f} → prioritized {tier} at Stage 1 (latest OASIS visit)",
            }
        ],
    }


def _finalize(records: list[dict]) -> list[dict]:
    """Guarantee the fields every consumer assumes -- never serve a null score.

    Records arrive from the ingester with score=None (the score is a model
    output, not an input), so a missing/failed artifact must still leave the
    API with a usable number instead of crashing the dashboard sort.
    """
    for rec in records:
        s = rec.get("score")
        if s is None or (isinstance(s, float) and math.isnan(s)):
            rec["score"] = 0.5
        rec.setdefault("factors", [])
        rec.setdefault("stage", 1)
        rec.setdefault("history", [])
    return records


def _cohort_records(rows: list[dict]) -> list[dict]:
    """Cohort records are already in the internal API shape.

    Scores and per-patient factors are recomputed from the SERVED model
    (artifacts/pipeline.joblib) in one vectorized batch pass at startup, so the
    dashboard always reflects the actual trained classifier -- including every
    feature's SHAP contribution (not just a top-3 cut). Falls back to the
    generator's heuristic scores when no model artifact exists.
    """
    records = [copy.deepcopy(r) for r in rows]
    try:
        from . import model_service

        if model_service.available():
            feature_rows = [model_service.record_to_features(rec) for rec in records]
            results = model_service.score_batch(feature_rows)
            scored = 0
            for rec, res in zip(records, results):
                if res is None:
                    continue
                rec["score"] = res["score"]
                rec["factors"] = [
                    {
                        "feature": f["feature"],
                        "text": HUMAN_FEATURES.get(f["feature"], f["feature"]),
                        "value": f["value"],
                        "effect": float(f["contribution"]),
                    }
                    for f in res["factors"]
                ]
                scored += 1
            print(f"[storage] re-scored {scored}/{len(records)} records from the served model")
            return _finalize(records)
    except Exception as exc:  # noqa: BLE001 -- fall back to generator scores
        print(f"[storage] model batch rescore failed ({exc}); keeping generator scores")

    # Fallback: generator's heuristic scores with whatever factors the file has
    try:
        if RISK_SCORES_PATH.exists():
            model_scores = json.loads(RISK_SCORES_PATH.read_text(encoding="utf-8"))
            by_id = {str(m.get("subject_id")): m for m in model_scores}
            overlaid = 0
            for rec in records:
                m = by_id.get(str(rec.get("id")))
                if not m:
                    continue
                rec["score"] = float(m.get("risk_score", rec.get("score", 0.5)))
                rec["factors"] = [
                    {
                        "feature": f.get("feature"),
                        "text": HUMAN_FEATURES.get(f.get("feature"), f.get("feature")),
                        "value": f.get("value"),
                        "effect": float(f.get("contribution", 0.0)),
                    }
                    for f in m.get("top_factors", [])
                ]
                overlaid += 1
            if overlaid:
                print(f"[storage] overlaid risk_scores.json onto {overlaid} records (fallback path)")
    except Exception as exc:  # noqa: BLE001
        print(f"[storage] could not overlay model scores ({exc})")
    return _finalize(records)


def _file_records() -> tuple[list[dict], str]:
    """Records from the real ADNI cohort, synthetic cohort, OASIS or mock."""
    processed = PROJECT_ROOT / "data" / "processed"
    adni_path = processed / "adni_cohort.json"
    # v2 = ADNI-1-proportioned cohort (800 subjects, all stages populated)
    synthetic_path = processed / "synthetic_patients_v2.json"
    if not synthetic_path.exists():
        synthetic_path = processed / "synthetic_patients.json"

    mode = os.getenv("PATIENT_DATA", "auto").strip().lower()
    # legacy flag: OASIS_DATA_MODE=real still means "use the OASIS cohort"
    if mode == "auto" and os.getenv("OASIS_DATA_MODE", "").strip().lower() in {"real", "1", "true"}:
        mode = "real"
    if mode not in {"adni", "synthetic", "real", "mock"}:
        mode = "auto"

    def _load(path: Path, tag: str) -> Optional[list[dict]]:
        if not path.exists():
            return None
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            print(f"[storage] could not load {path} ({exc})")
            return None
        if not isinstance(raw, list) or not raw:
            return None
        return _cohort_records(raw) if tag in {"adni", "synthetic"} else None

    order: list[tuple[Path, str]] = []
    if mode in {"auto", "adni"}:
        order.append((adni_path, "adni"))
    if mode in {"auto", "synthetic"}:
        order.append((synthetic_path, "synthetic"))
    for path, tag in order:
        rows = _load(path, tag)
        if rows:
            return rows, tag

    if mode == "real" and RISK_SCORES_PATH.exists():
        pass  # fall through to the OASIS branch below
    elif mode in {"mock"}:
        return [copy.deepcopy(p) for p in MOCK_PATIENTS], "mock"

    if RISK_SCORES_PATH.exists():
        try:
            raw = json.loads(RISK_SCORES_PATH.read_text(encoding="utf-8"))
            return [_map_real_record(r) for r in raw], "real"
        except Exception as exc:  # noqa: BLE001 -- bad/missing file should not crash the API
            print(f"[storage] could not load {RISK_SCORES_PATH} ({exc}); falling back to mock data")

    return [copy.deepcopy(p) for p in MOCK_PATIENTS], "mock"


def _only_patients_with_real_results(records: list[dict]) -> list[dict]:
    """Drop patients whose file holds no blood / MRI / PET result at all.

    NeuroPilot is a workup product: a patient with no measured biomarker
    anywhere can never be re-scored by ordering a test, because there is no
    result for the order to return. Those records are removed from the served
    cohort instead of sitting in the UI as a permanent dead end.

    The test is STAGE-INDEPENDENT on purpose. A patient who reads as
    "cognitive" in the UI because ADNI delivers modalities out of order can
    still hold a real MRI on file -- those are exactly the records the pathway
    has something to do for, and they must survive this filter.
    """
    from .config import real_result_slots

    kept = [rec for rec in records if real_result_slots(rec)]
    dropped = len(records) - len(kept)
    if dropped:
        print(
            f"[storage] cohort filter: dropped {dropped} patient(s) with no "
            f"blood/MRI/PET result on file — serving {len(kept)}"
        )
    return kept


def load_patients() -> tuple[dict[str, dict], str]:
    """Return (id -> record, data_source).

    When DATABASE_URL is set, Postgres is seeded from the same source and becomes
    the store of record (memory stays the read cache). Otherwise in-memory only.
    """
    records, source = _file_records()
    records = _only_patients_with_real_results(records)
    from . import db
    if db.enabled():
        print("[storage] DATABASE_URL detected — initializing database store...")
    else:
        print("[storage] DATABASE_URL not set — using in-memory store (no persistence)")
    if db.enabled():
        try:
            db.init_db()
            db.seed_if_empty(records, source)
            loaded = db.load_all()
            if loaded:
                db_name = "sqlite" if (db.get_database_url() or "").startswith("sqlite") else "postgres"
                # Re-applied after load: an existing database can still hold rows
                # seeded before the filter existed.
                served = _only_patients_with_real_results(loaded)
                return {r["id"]: r for r in served}, f"{source}+{db_name}"
        except Exception as exc:  # noqa: BLE001 -- DB down should not crash the API
            print(f"[storage] Database unavailable ({exc}); using in-memory store")
    return {r["id"]: r for r in records}, source


def persist(record: dict) -> None:
    """Mirror a mutation (stage advance) to DB. Best-effort; never raises."""
    from . import db
    if not db.enabled():
        return
    try:
        db.save_record(record)
    except Exception as exc:  # noqa: BLE001
        print(f"[storage] could not persist {record['id']} to DB ({exc})")


def load_global_importance() -> list[dict]:
    """Attribution of the SERVED model; falls back to the static mock.

    Routed through model_service on purpose: the panel must never describe a
    different model family than the one producing the scores. Measured-only
    (conditional) values are used, so a rarely-ordered test is not diluted to
    near-zero by the subjects who were never scanned.
    """
    try:
        from . import model_service

        rows = model_service.load_importance()
        if rows:
            return rows
        print("[storage] served model publishes no attribution file; using static list")
    except Exception as exc:  # noqa: BLE001
        print(f"[storage] could not load served-model attribution ({exc}); using static list")
    return copy.deepcopy(MOCK_GLOBAL_IMPORTANCE)


# Repo root, exposed for tests/scripts that need to reference processed data
ROOT = PROJECT_ROOT