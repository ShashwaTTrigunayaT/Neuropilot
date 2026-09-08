"""Progression forecaster serving (12-month horizon).

Loads artifacts/progression_delta.joblib (MMSE-delta regressor) and
artifacts/progression_conversion.joblib (conversion classifier) into the API
process, mirroring model_service.py.

forecast(record) composes:
  * expected MMSE change over 12 months (regressor) and the projected value
  * probability of clinical progression (classifier) with top SHAP drivers
  * the PROJECTED risk tier: the CURRENT risk model (model_service) re-scores
    the projected future feature vector (age+1, forecast MMSE, carried-forward
    biomarkers) -- one consistent model family end-to-end
  * a chart-ready trajectory series: observed past (prior visit -> now,
    annotated with the current workup stage) and predicted future with an
    uncertainty band derived from the regressor's test RMSE
"""
from __future__ import annotations

import json
from typing import Optional

import joblib
import numpy as np
import pandas as pd
import shap

from .config import PROJECT_ROOT

DELTA_PATH = PROJECT_ROOT / "artifacts" / "progression_delta.joblib"
CONV_PATH = PROJECT_ROOT / "artifacts" / "progression_conversion.joblib"
META_PATH = PROJECT_ROOT / "artifacts" / "progression_meta.json"

_cache: dict = {"delta": None, "conv": None, "meta": None, "explainer": None}
# (patient_id, updated_at, stage) -> forecast payload; recomputed on any change
_forecast_cache: dict = {}


def available() -> bool:
    return DELTA_PATH.exists() and CONV_PATH.exists()


def _load() -> bool:
    if _cache["delta"] is not None:
        return True
    if not available():
        return False
    _cache["delta"] = joblib.load(DELTA_PATH)
    _cache["conv"] = joblib.load(CONV_PATH)
    try:
        _cache["meta"] = json.loads(META_PATH.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        _cache["meta"] = {}
    clf = _cache["conv"].named_steps.get("clf")
    if clf is not None:
        _cache["explainer"] = shap.TreeExplainer(clf)
    return True


def _features(record: dict) -> dict:
    from .model_service import record_to_features

    return record_to_features(record)


def _top_drivers(features: dict, top_n: int = 3) -> list[dict]:
    """Top SHAP drivers of the conversion probability for one row."""
    explainer = _cache["explainer"]
    meta = _cache["meta"] or {}
    names = meta.get("features") or list(features.keys())
    if explainer is None:
        return []
    row = pd.DataFrame([{f: (np.nan if features.get(f) is None else features.get(f)) for f in names}], columns=names)
    sv = np.asarray(explainer.shap_values(row))
    if sv.ndim == 3:
        sv = sv[:, :, 1]
    sv_row = sv[0]
    order = sorted(range(len(names)), key=lambda j: abs(sv_row[j]), reverse=True)[:top_n]
    return [
        {"feature": names[j], "contribution": round(float(sv_row[j]), 3)}
        for j in order
    ]


def forecast(record: dict) -> Optional[dict]:
    """Full 12-month progression forecast for one internal patient record."""
    if not _load():
        return None
    meta = _cache["meta"] or {}

    cache_key = (record.get("id"), record.get("updated_at"), record.get("stage"))
    if _forecast_cache.get(cache_key) is not None:
        return _forecast_cache[cache_key]

    from . import model_service
    from .config import risk_tier

    names = meta.get("features") or []
    if not names:
        return None

    feats = _features(record)
    cog = record.get("cognitive") or {}
    mmse_now = cog.get("latest")
    if mmse_now is None:
        mmse_now = 27

    row = pd.DataFrame(
        [{f: (np.nan if feats.get(f) is None else feats.get(f)) for f in names}],
        columns=names,
    )

    # ---- 1. Expected MMSE change -------------------------------------------
    delta = float(_cache["delta"].predict(row)[0])
    mmse_future = int(max(0, min(30, round(mmse_now + delta))))
    rmse = float((meta.get("metrics") or {}).get("delta_rmse") or 0.75)
    band = round(1.44 * rmse, 1)  # ~75% interval for a roughly-normal residual

    # ---- 2. Conversion probability ------------------------------------------
    p_convert = float(_cache["conv"].predict_proba(row)[0, 1])
    drivers = _top_drivers(feats)

    # ---- 3. Projected risk tier: current risk model on the future vector ----
    mmse_prior = cog.get("prior")
    future_feats = dict(feats)
    future_feats["age"] = (feats.get("age") or 74) + 1
    future_feats["mmse"] = mmse_future
    future_feats["mmse_change"] = (
        (mmse_future - mmse_prior) if mmse_prior is not None else None
    )
    projected = model_service.score_features(future_feats, top_n=None)
    score_future = projected["score"] if projected else record.get("score")
    tier_future = risk_tier(score_future)
    score_now = record.get("score")
    tier_now = risk_tier(score_now)

    stage = record.get("stage", 1)
    stage_label = {
        1: "Stage 1 — cognitive baseline",
        2: "Stage 2 — blood panel completed",
        3: "Stage 3 — MRI volumetrics completed",
        4: "Stage 4 — PET completed (full workup)",
    }.get(stage, f"Stage {stage}")

    trajectory = [
        {"t": -6, "mmse": mmse_prior, "kind": "observed"},
        {"t": 0, "mmse": mmse_now, "kind": "observed", "stage": stage, "stage_label": stage_label},
        {
            "t": 12,
            "mmse": mmse_future,
            "kind": "predicted",
            "lo": max(0, round(mmse_future - band)),
            "hi": min(30, round(mmse_future + band)),
        },
    ]

    payload = {
        "id": record.get("id"),
        "horizon_months": 12,
        "model_available": True,
        "current": {
            "mmse": mmse_now,
            "score": score_now,
            "risk_tier": tier_now,
            "stage": stage,
            "stage_label": stage_label,
        },
        "projected": {
            "mmse": mmse_future,
            "mmse_delta": round(delta, 2),
            "band": band,
            "conversion_probability": round(p_convert, 4),
            "score": round(float(score_future), 4),
            "risk_tier": tier_future,
            "tier_shift": tier_now != tier_future,
        },
        "trajectory": trajectory,
        "drivers": drivers,
        "disclaimer": (
            "Forecasts are model-derived decision support on simulated 12-month "
            "trajectories — never a diagnosis or a guarantee of progression."
        ),
    }
    _forecast_cache[cache_key] = payload
    return payload
