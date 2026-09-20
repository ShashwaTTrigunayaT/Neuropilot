"""Model serving (blueprint section 3 / 4.3).

Serves whichever model family config.PRIMARY_MODEL names -- the refined model in
production, the cross-sectional model retained behind a switch. Both are loaded
directly into the API process (no separate model server at this scale) and share
one contract: predict_proba over a feature vector, plus SHAP attributions from a
cached TreeExplainer.

This module is the single place a feature vector becomes a score, so changing the
served model is a configuration change: the API, dashboard, ranking, escalation
engine, simulator and FHIR export all follow automatically.
"""
from __future__ import annotations

import csv
import json
from typing import Optional

import joblib
import numpy as np
import pandas as pd
import shap

from .config import (MODEL_VARIANTS, PRIMARY_MODEL, HIGH_THRESHOLD, MEDIUM_THRESHOLD,
                     has_biomarker_evidence, risk_tier, slot_visible)

# variant name -> loaded artifacts. The non-served family is still loadable so it
# can be inspected (GET /model/info -> legacy) without being scored against.
_loaded: dict[str, dict] = {}


def _read_importance(path) -> list[dict]:
    """Attribution CSV -> [{feature, mean_abs_shap}], measured-only values.

    Both families publish the same two columns after the leakage removal, so one
    reader serves either card.
    """
    if path is None or not path.exists():
        return []
    try:
        with path.open(encoding="utf-8", newline="") as fh:
            rows = []
            for row in csv.DictReader(fh):
                raw = (row.get("mean_abs_shap_conditional")
                       or row.get("mean_abs_shap_global")
                       or row.get("mean_abs_shap") or "0")
                try:
                    rows.append({"feature": row.get("feature", ""),
                                 "mean_abs_shap": float(raw)})
                except (TypeError, ValueError):
                    continue
        return sorted((r for r in rows if r["feature"]),
                      key=lambda r: r["mean_abs_shap"], reverse=True)
    except Exception:  # noqa: BLE001 -- attribution is never fatal
        return []


def _variant(name: str) -> dict:
    """Load (once per process) the artifacts of one model family."""
    if name in _loaded:
        return _loaded[name]
    spec = MODEL_VARIANTS.get(name) or MODEL_VARIANTS["cross_sectional"]
    entry: dict = {"spec": spec, "pipeline": None, "meta": {}, "explainer": None,
                   "importance": []}
    if spec["model_path"].exists() and spec["meta_path"].exists():
        entry["pipeline"] = joblib.load(spec["model_path"])
        try:
            entry["meta"] = json.loads(spec["meta_path"].read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            entry["meta"] = {}
        steps = entry["pipeline"].named_steps
        clf = steps.get("clf") or (list(steps.values())[-1] if steps else None)
        if clf is not None:
            # tree_path_dependent is REQUIRED, not stylistic: interventional mode
            # raises on categorical splits, and every feature here is legitimately
            # NaN for patients who were never tested.
            entry["explainer"] = shap.TreeExplainer(clf, feature_perturbation="tree_path_dependent")
        entry["importance"] = _read_importance(spec["importance_path"])
    _loaded[name] = entry
    return entry


def _active() -> dict:
    return _variant(PRIMARY_MODEL)


def available() -> bool:
    return _active()["pipeline"] is not None


def metrics_for(entry: dict) -> dict:
    """Both cards keep their metrics under different keys; normalise the four
    numbers the API and UI display."""
    meta = entry["meta"] or {}
    m = meta.get("metrics") or {}
    return {
        "test_auc": meta.get("test_auc", m.get("conversion_auc")),
        "cv_auc_mean": meta.get("cv_auc_mean", m.get("conversion_cv_auc_mean")),
        "cv_auc_std": meta.get("cv_auc_std", m.get("conversion_cv_auc_std")),
        "baseline_accuracy": meta.get("baseline_accuracy", m.get("conversion_baseline_accuracy")),
        "test_auc_stage1_only": meta.get("test_auc_stage1_only", m.get("conversion_auc_stage1")),
        "test_auc_biomarker_measured": meta.get(
            "test_auc_biomarker_measured", m.get("conversion_auc_blood_measured")
        ),
    }


def card(name: str) -> dict:
    """Model card for one family -- used for the served model AND the retained one."""
    entry = _variant(name)
    meta = entry["meta"] or {}
    if entry["pipeline"] is None:
        return {"available": False, "name": name,
                "label": entry["spec"].get("label", name), "model_type": None,
                "features": [], "trained_at": None, "global_importance": []}
    m = metrics_for(entry)
    return {
        "available": True,
        "name": name,
        "label": entry["spec"].get("label", name),
        "model_type": meta.get("model_type"),
        "features": meta.get("features", []),
        "trained_at": meta.get("trained_at"),
        "thresholds": {"high": HIGH_THRESHOLD, "medium": MEDIUM_THRESHOLD},
        "n_train": meta.get("n_train"),
        "global_importance": entry["importance"],
        "n_subgroup": meta.get("n_subgroup") or {},
        "stage_importance": meta.get("stage_importance") or {},
        "ablations": meta.get("ablations") or [],
        "caveats": meta.get("caveats") or [],
        **m,
    }


def info() -> dict:
    """Card for the model actually being served."""
    return card(PRIMARY_MODEL)


def legacy() -> dict:
    """Card for the family NOT being served (retained for reference/switching)."""
    other = "cross_sectional" if PRIMARY_MODEL == "refined" else "refined"
    return card(other)


def load_importance() -> list[dict]:
    """Attribution rows for the served model."""
    return _active()["importance"]


def record_to_features(record: dict) -> dict:
    """Internal patient record -> trained-model feature vector.

    Emits a SUPERSET of every cohort's slot names, so one function serves any
    trained pipeline: the model card's `features` list selects which keys are
    actually used, the rest are ignored. Slots never ordered/completed map to
    None -> NaN, which the served pipeline handles natively.

    Feature names/encodings mirror scripts/ingest_adni.py (real ADNI) and
    scripts/train_model.py (synthetic / OASIS) exactly -- a mismatch here would
    silently feed the model different columns than it was trained on.
    """
    cog = record.get("cognitive") or {}
    blood = record.get("blood") or {}
    imaging = record.get("imaging") or {}
    pet = record.get("pet") or {}

    # GATE: only slots inside the patient's ORDERED pathway contribute. A real
    # cohort can hold an MRI at Stage 1 because ADNI modalities arrive out of
    # order; scoring it there would mean a "cognitive-only" score that secretly
    # knows the scan -- and ordering the blood panel that stands between them
    # could then never change anything. Gated slots read as unmeasured (NaN),
    # which is the same missingness shape the model was trained under.
    if not slot_visible(record, "blood"):
        blood = {}
    if not slot_visible(record, "imaging"):
        imaging = {}
    if not slot_visible(record, "pet"):
        pet = {}

    mmse_latest = cog.get("latest")
    mmse_prior = cog.get("prior", mmse_latest)

    def _positive(slot: dict, key: str):
        raw = slot.get(key)
        if raw is None:
            return None
        return 1.0 if str(raw).lower() == "positive" else 0.0

    def _num(v):
        if v is None or v == "":
            return None
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    apoe = record.get("apoe_e4")
    if isinstance(apoe, str):
        apoe = 1.0 if apoe.strip().lower() in {"true", "1", "yes", "e4"} else 0.0
    elif apoe is not None:
        apoe = 1.0 if bool(apoe) else 0.0

    return {
        # ---- real-ADNI vector (15 features, FAQ removed 2026-09-19) --------
        "age": record.get("age"),
        "education_years": record.get("education_years"),
        "sex": 1 if record.get("sex") == "M" else 0,
        "mmse": mmse_latest,
        "mmse_change": (mmse_latest - mmse_prior) if (mmse_latest is not None and mmse_prior is not None) else None,
        "adas_cog_13": record.get("adas_cog_13"),
        # "faq_total": REMOVED (label leakage — part of ADNI diagnostic algorithm)
        "apoe_e4": apoe,
        "ptau217": blood.get("pTau217") if isinstance(blood, dict) else None,
        "abeta4240": blood.get("abeta4240") if isinstance(blood, dict) else None,
        "nfl": blood.get("nfl") if isinstance(blood, dict) else None,
        "gfap": blood.get("gfap") if isinstance(blood, dict) else None,
        "hippocampal_volume": imaging.get("hippocampalVolumeCm3") if isinstance(imaging, dict) else None,
        "hippocampal_icv_ratio": imaging.get("hippocampalIcvRatio") if isinstance(imaging, dict) else None,
        "centiloids": pet.get("centiloids") if isinstance(pet, dict) else None,
        "tau_meta_temporal": pet.get("tauMetaTemporalSuvr") if isinstance(pet, dict) else None,
        # ---- legacy slot names (synthetic cohort + progression models) -----
        "ptau181": blood.get("pTau181") if isinstance(blood, dict) else None,
        "amyloid_positive": _positive(pet, "amyloid") if isinstance(pet, dict) else None,
        "tau_positive": _positive(pet, "tau") if isinstance(pet, dict) else None,
        "icv_cm3": _num(imaging.get("icvCm3")) if isinstance(imaging, dict) else None,
    }


def score_features(features: dict, top_n: Optional[int] = 3) -> Optional[dict]:
    """Predict + SHAP-explain a single feature vector. None when no model artifact exists.

    top_n limits the returned factors (default 3, matching the score endpoint
    contract); pass None to receive every feature's contribution.
    """
    entry = _active()
    if entry["pipeline"] is None:
        return None
    meta = entry["meta"] or {}
    feature_names = meta.get("features", [])
    if not feature_names:
        return None

    # Sanitize and normalize feature values
    clean: dict[str, float] = {}
    for k, v in features.items():
        if k == "sex":
            if isinstance(v, str):
                clean[k] = 1.0 if v.strip().upper().startswith("M") else 0.0
            elif v is not None and not (isinstance(v, float) and np.isnan(v)):
                clean[k] = 1.0 if float(v) == 1.0 else 0.0
            else:
                clean[k] = np.nan
        else:
            if v is None or v == "" or (isinstance(v, float) and np.isnan(v)):
                clean[k] = np.nan
            else:
                try:
                    clean[k] = float(v)
                except (ValueError, TypeError):
                    clean[k] = np.nan

    row = {f: clean.get(f, np.nan) for f in feature_names}
    X = pd.DataFrame([row], columns=feature_names)

    pipeline = entry["pipeline"]
    proba = float(pipeline.predict_proba(X)[0, 1])

    prep = pipeline.named_steps.get("prep")
    X_imp = prep.transform(X) if prep is not None else X.to_numpy()
    explainer = entry["explainer"]
    sv = np.asarray(explainer.shap_values(X_imp))
    if sv.ndim == 3:  # some shap versions return [samples, features, classes]
        sv = sv[:, :, 1]
    sv_row = sv[0]

    order = sorted(range(len(feature_names)), key=lambda j: abs(sv_row[j]), reverse=True)
    if top_n is not None:
        order = order[:top_n]
    factors = [
        {
            "feature": feature_names[j],
            "value": None if pd.isna(row[feature_names[j]]) else float(row[feature_names[j]]),
            "contribution": round(float(sv_row[j]), 4),
        }
        for j in order
    ]
    return {
        "score": round(proba, 4),
        "risk_tier": risk_tier(proba, has_biomarker_evidence(features)),
        "factors": factors,
        "model_type": meta.get("model_type"),
    }


def active_feature_names() -> list[str]:
    """Feature names for the model currently served."""
    return list((_active().get("meta") or {}).get("features", []))


def predict_scores(rows: list[dict]) -> list[float]:
    """Fast probability-only batch prediction without SHAP explanations.

    Used for provisional scenario scoring, where one patient may need dozens of
    plausible missing-stage completions. Official scores still use score_batch()
    so the normal attribution contract is unchanged.
    """
    entry = _active()
    if entry["pipeline"] is None or not rows:
        return []
    names = active_feature_names()
    if not names:
        return []

    def clean(v):
        if v is None or v == "" or (isinstance(v, float) and np.isnan(v)):
            return np.nan
        if isinstance(v, str) and v.strip().upper() in {"M", "MALE"}:
            return 1.0
        if isinstance(v, str) and v.strip().upper() in {"F", "FEMALE"}:
            return 0.0
        try:
            return float(v)
        except (ValueError, TypeError):
            return np.nan

    X = pd.DataFrame(
        [{name: clean(row.get(name)) for name in names} for row in rows],
        columns=names,
    )
    return [float(p) for p in entry["pipeline"].predict_proba(X)[:, 1]]


def score_batch(rows: list[dict]) -> list[Optional[dict]]:
    """Vectorized score + full SHAP explanation for many feature vectors.

    Used at startup to recompute every patient's score/factors from the served
    model in one pass (one predict_proba + one shap_values call). Rows missing
    features are NaN-imputed exactly like score_features.
    """
    entry = _active()
    if entry["pipeline"] is None or not rows:
        return [None] * len(rows)
    meta = entry["meta"] or {}
    feature_names = meta.get("features", [])
    if not feature_names:
        return [None] * len(rows)

    def _clean(v) -> float:
        if v is None or v == "" or (isinstance(v, float) and np.isnan(v)):
            return np.nan
        try:
            return float(v)
        except (ValueError, TypeError):
            return np.nan

    data = []
    for features in rows:
        clean: dict[str, float] = {}
        for k, v in features.items():
            if k == "sex":
                if isinstance(v, str):
                    clean[k] = 1.0 if v.strip().upper().startswith("M") else 0.0
                elif v is not None:
                    clean[k] = 1.0 if _clean(v) == 1.0 else 0.0
                else:
                    clean[k] = np.nan
            else:
                clean[k] = _clean(v)
        data.append({f: clean.get(f, np.nan) for f in feature_names})

    X = pd.DataFrame(data, columns=feature_names)
    pipeline = entry["pipeline"]
    probas = pipeline.predict_proba(X)[:, 1]

    prep = pipeline.named_steps.get("prep")
    X_imp = prep.transform(X) if prep is not None else X.to_numpy()
    explainer = entry["explainer"]
    sv = np.asarray(explainer.shap_values(X_imp))
    if sv.ndim == 3:
        sv = sv[:, :, 1]

    out: list[Optional[dict]] = []
    for i in range(len(rows)):
        order = sorted(range(len(feature_names)), key=lambda j: abs(sv[i, j]), reverse=True)
        factors = [
            {
                "feature": feature_names[j],
                "value": None if pd.isna(X.iloc[i][feature_names[j]]) else float(X.iloc[i][feature_names[j]]),
                "contribution": round(float(sv[i, j]), 4),
            }
            for j in order
        ]
        p = float(probas[i])
        out.append(
            {
                "score": round(p, 4),
                "risk_tier": risk_tier(p, has_biomarker_evidence(rows[i])),
                "factors": factors,
                "model_type": meta.get("model_type"),
            }
        )
    return out