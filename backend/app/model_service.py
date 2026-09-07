"""Model serving (blueprint section 3 / 4.3).

Loads the trained preprocessing + classifier pipeline (artifacts/pipeline.joblib)
directly into the API process -- no separate model server needed at this scale.
Scores arbitrary feature vectors via POST /patients/score and explains them with
a cached SHAP TreeExplainer.
"""
from __future__ import annotations

import json
from typing import Optional

import joblib
import numpy as np
import pandas as pd
import shap

from .config import MODEL_META_PATH, MODEL_PATH, HIGH_THRESHOLD, MEDIUM_THRESHOLD

_cache: dict = {"pipeline": None, "meta": None, "explainer": None}


def available() -> bool:
    return MODEL_PATH.exists() and MODEL_META_PATH.exists()


def _load() -> bool:
    if _cache["pipeline"] is not None:
        return True
    if not available():
        return False
    _cache["pipeline"] = joblib.load(MODEL_PATH)
    try:
        _cache["meta"] = json.loads(MODEL_META_PATH.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        _cache["meta"] = {}
    clf = _cache["pipeline"].named_steps.get("clf")
    if clf is not None:
        _cache["explainer"] = shap.TreeExplainer(clf)
    return True


def info() -> dict:
    meta = _cache["meta"] if _cache["meta"] is not None else {}
    if not available():
        return {"available": False, "model_type": None, "features": [], "trained_at": None}
    _load()
    meta = _cache["meta"]
    return {
        "available": True,
        "model_type": meta.get("model_type"),
        "features": meta.get("features", []),
        "trained_at": meta.get("trained_at"),
        "thresholds": {"high": HIGH_THRESHOLD, "medium": MEDIUM_THRESHOLD},
        "test_auc": meta.get("test_auc"),
        "cv_auc_mean": meta.get("cv_auc_mean"),
    }


def record_to_features(record: dict) -> dict:
    """Internal patient record -> trained-model feature vector.

    Mirrors the mapping in scripts/train_model.py exactly (same keys, same
    slot field names). Slots never ordered/completed map to None -> NaN, which
    the served pipeline handles natively.
    """
    cog = record.get("cognitive") or {}
    blood = record.get("blood") or {}
    imaging = record.get("imaging") or {}
    pet = record.get("pet") or {}
    mmse_latest = cog.get("latest")
    mmse_prior = cog.get("prior", mmse_latest)

    def _positive(slot: dict, key: str):
        raw = slot.get(key)
        if raw is None:
            return None
        return 1.0 if str(raw).lower() == "positive" else 0.0

    return {
        "age": record.get("age"),
        "education_years": record.get("education_years"),
        "sex": 1 if record.get("sex") == "M" else 0,
        "mmse": mmse_latest,
        "mmse_change": (mmse_latest - mmse_prior) if (mmse_latest is not None and mmse_prior is not None) else None,
        "ptau181": blood.get("pTau181") if isinstance(blood, dict) else None,
        "abeta4240": blood.get("abeta4240") if isinstance(blood, dict) else None,
        "hippocampal_volume": imaging.get("hippocampalVolumeCm3") if isinstance(imaging, dict) else None,
        "amyloid_positive": _positive(pet, "amyloid") if isinstance(pet, dict) else None,
        "tau_positive": _positive(pet, "tau") if isinstance(pet, dict) else None,
    }


def score_features(features: dict, top_n: Optional[int] = 3) -> Optional[dict]:
    """Predict + SHAP-explain a single feature vector. None when no model artifact exists.

    top_n limits the returned factors (default 3, matching the score endpoint
    contract); pass None to receive every feature's contribution.
    """
    if not _load():
        return None
    meta = _cache["meta"]
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

    pipeline = _cache["pipeline"]
    proba = float(pipeline.predict_proba(X)[0, 1])

    prep = pipeline.named_steps.get("prep")
    X_imp = prep.transform(X) if prep is not None else X.to_numpy()
    explainer = _cache["explainer"]
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
        "risk_tier": "high" if proba > HIGH_THRESHOLD else ("medium" if proba >= MEDIUM_THRESHOLD else "low"),
        "factors": factors,
        "model_type": meta.get("model_type"),
    }


def score_batch(rows: list[dict]) -> list[Optional[dict]]:
    """Vectorized score + full SHAP explanation for many feature vectors.

    Used at startup to recompute every patient's score/factors from the served
    model in one pass (one predict_proba + one shap_values call). Rows missing
    features are NaN-imputed exactly like score_features.
    """
    if not _load() or not rows:
        return [None] * len(rows)
    meta = _cache["meta"]
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
    pipeline = _cache["pipeline"]
    probas = pipeline.predict_proba(X)[:, 1]

    prep = pipeline.named_steps.get("prep")
    X_imp = prep.transform(X) if prep is not None else X.to_numpy()
    explainer = _cache["explainer"]
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
                "risk_tier": "high" if p > HIGH_THRESHOLD else ("medium" if p >= MEDIUM_THRESHOLD else "low"),
                "factors": factors,
                "model_type": meta.get("model_type"),
            }
        )
    return out