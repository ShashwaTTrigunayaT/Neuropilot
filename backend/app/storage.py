"""Patient store.

Preference order (override with PATIENT_DATA=adni|mock):
  1. REAL ADNI cohort: data/processed/adni_cohort.json (scripts/ingest_adni.py)
     -- 3.6k subjects, real DIAGNOSIS labels, all four stages where measured
  2. Mock cohort (backend/app/seed_data.py) so the API demos standalone

The synthetic and OASIS-1 paths were removed once real ADNI became the served
cohort; every fallback that could silently put a simulated subject in front of a
clinician went with them.

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
                     MISSING_DATA_SOURCE, PROJECT_ROOT, STUB_DATA_SOURCE, risk_tier)
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
    """De-identified seed entry -> internal patient record (fallback only).

    risk_scores.json carries no measured values, so corroborating evidence is
    inferred from whether the model actually used a biomarker feature for this
    subject. Without one the tier stays capped at Medium, exactly as it would
    for a cognition-only record.
    """
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
                "text": f"Scored {score:.2f} → prioritized {tier} at Stage 1 (de-identified seed)",
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

    # Fallback: the de-identified seed's heuristic scores (no model artifact).
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
    """Records from the real ADNI cohort, or the mock cohort when it is absent."""
    processed = PROJECT_ROOT / "data" / "processed"
    adni_path = processed / "adni_cohort.json"

    mode = os.getenv("PATIENT_DATA", "auto").strip().lower()
    if mode not in {"adni", "mock"}:
        mode = "auto"

    def _load(path: Path) -> Optional[list[dict]]:
        if not path.exists():
            return None
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            print(f"[storage] could not load {path} ({exc})")
            return None
        if not isinstance(raw, list) or not raw:
            return None
        return _cohort_records(raw)

    if mode in {"auto", "adni"}:
        rows = _load(adni_path)
        if rows:
            return rows, "adni"

    if mode == "adni":
        print(f"[storage] PATIENT_DATA=adni requested but {adni_path} is missing; "
              "run scripts/ingest_adni.py against the 'ADNI DATA' drop")
        return [], MISSING_DATA_SOURCE

    if not MOCK_PATIENTS:
        print("[storage] no cohort file and no stubs available -- serving nothing")
        return [], MISSING_DATA_SOURCE
    print("[storage] no real cohort file -- falling back to placeholder stubs "
          "(no measurements; a database holding real patients takes precedence)")
    return [copy.deepcopy(p) for p in MOCK_PATIENTS], STUB_DATA_SOURCE


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


def load_cohort_file() -> tuple[list[dict], str]:
    """The cohort as read from disk -- no database involved.

    Public because it is the source of truth for seeding a remote database
    (scripts/seed_db.py) and for the self-heal path in load_patients().
    """
    records, source = _file_records()
    return _only_patients_with_real_results(records), source


def load_patients() -> tuple[dict[str, dict], str]:
    """Return (id -> record, data_source).

    When DATABASE_URL is set, Postgres is the STORE OF RECORD and memory stays
    the read cache. This is the deployment path: the real cohort is under an ADNI
    Data Use Agreement, so it is neither committed nor baked into the image --
    it is seeded into the database once (scripts/seed_db.py) and the container
    reads it back from there.

    Which means a container normally has NO cohort file, and the placeholder
    stubs must not be mistaken for the cohort. Three rules follow, all of them
    written after seeing a real deploy go wrong:

    1. Stubs are seeded ONLY when nothing else can serve -- never over a database
       that already holds a real cohort (db.seed_if_empty enforces this too).
    2. A stored cohort that filters down to nothing is REPAIRED from the file
       instead of being served, because "0 patients" is never the intent.
    3. The reported data_source says where the served rows actually came from, so
       /health and the UI cannot claim a source that was not used.
    """
    records, source = load_cohort_file()
    stubs = source == STUB_DATA_SOURCE

    from . import db
    if db.enabled():
        print("[storage] DATABASE_URL detected -- initializing database store...")
        try:
            db.init_db()
            if not stubs:
                db.seed_if_empty(records, source)
            else:
                print("[storage] no real cohort file; placeholder stubs are only used "
                      "if the database has nothing to serve")
            loaded = db.load_all() or []
            usable = _only_patients_with_real_results(loaded)
            stored = db.stored_cohort_source()
            # A real cohort file is the only thing that can repair a bad store.
            repairable = bool(records) and not stubs

            if stored == STUB_DATA_SOURCE or (loaded and not usable):
                # Two states, one fix. Either the stored cohort is the placeholder
                # stubs (an earlier deploy wrote them into the database before the
                # guard existed -- they carry illustrative lab values, so they can
                # pass the cohort filter and be served as if they were patients),
                # or its rows cannot pass the filter at all. A database is the
                # store of record for real workups, so neither is served.
                if repairable:
                    print(
                        f"[storage] stored cohort is unusable (source={stored or 'unknown'}, "
                        f"{len(loaded)} row(s)) -- re-seeding from the {source} cohort file"
                    )
                    db.seed_if_empty(records, source, force=True)
                    usable = _only_patients_with_real_results(db.load_all() or []) or records
                else:
                    print(
                        f"[storage] serving 0 patients: the database holds {len(loaded)} "
                        f"row(s) sourced from {stored or 'an unknown cohort'} and no real "
                        "cohort file is present to repair it from.\n"
                        "          Seed the database from a machine that holds the cohort:\n"
                        "            DATABASE_URL='<the deployment database>' "
                        "python scripts/seed_db.py"
                    )
                    return {}, "stub-cohort" if stored == STUB_DATA_SOURCE else "unusable-cohort"
            if usable:
                db_name = "sqlite" if (db.get_database_url() or "").startswith("sqlite") else "postgres"
                # `origin` is read from the STORED fingerprint, not assumed: a
                # database seeded with stubs must never be reported (or labelled
                # in the UI) as the real ADNI cohort.
                origin = db.stored_cohort_source() or "postgres"
                return {r["id"]: r for r in usable}, f"{origin}+{db_name}"
        except Exception as exc:  # noqa: BLE001 -- DB down should not crash the API
            print(f"[storage] Database unavailable ({exc}); using in-memory store")
    else:
        print("[storage] DATABASE_URL not set -- using in-memory store (no persistence)")
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