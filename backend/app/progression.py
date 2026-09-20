"""Outlook serving -- trajectory and projected state for one patient.

Loads artifacts/progression_delta.joblib (MMSE-change regressor) and
artifacts/progression_conversion.joblib (the refined classifier) into the API
process, mirroring model_service.py. The window and the feature list are read
from artifacts/progression_meta.json, so they can be changed without touching
this module.

This module supplies what the score alone cannot: the observed-vs-projected
cognition trajectory, the projected score and tier, and the point at which each
completed test landed. The score itself comes from model_service (the refined
model), so there is exactly one source of truth for risk.

Labels are real clinician follow-up diagnoses (see scripts/ingest_adni.py).

forecast(record) composes:  * expected MMSE change (regressor) and the projected value
  * top SHAP drivers of the score
  * the PROJECTED score and tier: the served model (model_service) re-scores the
    projected future feature vector (older age, forecast MMSE, carried-forward
    biomarkers) -- one consistent model family end-to-end
  * a chart-ready trajectory series: observed past (prior visit -> now,
    annotated with the current workup stage) and predicted future with an
    uncertainty band derived from the regressor's test RMSE
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Optional

import joblib
import numpy as np
import pandas as pd
import shap

from .config import PROJECT_ROOT

# Stage order -> slot mapping (mirrors escalation.py)
_SLOT_STAGE = [("blood", 2), ("imaging", 3), ("pet", 4)]
_SLOT_LABEL = {"blood": "Blood panel", "imaging": "MRI", "pet": "PET"}

DELTA_PATH = PROJECT_ROOT / "artifacts" / "progression_delta.joblib"
CONV_PATH = PROJECT_ROOT / "artifacts" / "progression_conversion.joblib"
META_PATH = PROJECT_ROOT / "artifacts" / "progression_meta.json"
IMPORTANCE_PATH = PROJECT_ROOT / "artifacts" / "progression_importance.csv"

_cache: dict = {"delta": None, "conv": None, "meta": None, "explainer": None,
                "importance": []}
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
        # tree_path_dependent is REQUIRED, not stylistic: interventional mode
        # raises NotImplementedError on XGBoost's categorical splits, and every
        # feature here is legitimately NaN for patients who were never tested.
        _cache["explainer"] = shap.TreeExplainer(
            clf, feature_perturbation="tree_path_dependent"
        )
    # Feature attribution in the SAME shape the served model's card uses
    # ({feature, mean_abs_shap}) so the UI renders both families through one
    # component. Conditional (measured-only) values, matching the other card's
    # convention -- a rarely ordered test must not be diluted to near-zero by
    # the subjects who were never scanned.
    try:
        imp = pd.read_csv(IMPORTANCE_PATH)
        col = ("mean_abs_shap_conditional" if "mean_abs_shap_conditional" in imp.columns
               else "mean_abs_shap_global")
        _cache["importance"] = [
            {"feature": str(r["feature"]), "mean_abs_shap": float(r[col])}
            for _, r in imp.sort_values(col, ascending=False).iterrows()
        ]
    except Exception:  # noqa: BLE001 -- attribution is optional, never fatal
        _cache["importance"] = []

    _forecast_cache.clear()
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


def _score_checkpoints(record: dict) -> list[dict]:
    """Risk score at each completed stage test, for chart annotation.

    For every completed slot (blood < imaging < pet) the trained model is
    re-run on the patient's data AS IT EXISTED at that stage -- later-stage
    results masked to unmeasured -- so the marker shows the score the model
    would have produced when that test's result landed. Timestamps come from
    the audit history ('<Slot> result recorded' events); completed stages
    without a parseable timestamp get spaced positions in the observed window.
    """
    from . import model_service

    completed = [
        (slot, stage)
        for slot, stage in _SLOT_STAGE
        if isinstance(record.get(slot), dict) and record[slot].get("status") == "completed"
    ]
    if not completed:
        return []

    # Latest '<Slot> result recorded' timestamp per slot from the audit trail
    # (kept for the `at` reference field -- NOT for x-positioning: auto-workup
    # completes stages minutes apart, which clusters unreadably on the axis)
    event_times: dict[str, datetime] = {}
    now = datetime.now()
    label_prefixes = {
        "blood": ("Blood biomarkers result", "Blood panel result"),
        "imaging": ("MRI volumetrics result", "MRI result"),
        "pet": ("PET imaging result", "PET result"),
    }
    for h in record.get("history", []):
        text = str(h.get("text", ""))
        for slot, _stage in _SLOT_STAGE:
            if any(text.startswith(prefix) for prefix in label_prefixes[slot]):
                try:
                    at = datetime.strptime(str(h.get("at", "")), "%Y-%m-%d %H:%M")
                    prev = event_times.get(slot)
                    if prev is None or at > prev:
                        event_times[slot] = at
                except ValueError:
                    continue

    checkpoints = []
    for slot, stage in completed:
        masked = dict(record)
        for s2, st2 in _SLOT_STAGE:
            if st2 > stage:
                masked[s2] = None
        # Keep the stage consistent with the mask: record_to_features gates on it
        # too (a slot beyond the ordered prefix is hidden from the score).
        masked["stage"] = stage
        try:
            res = model_service.score_features(model_service.record_to_features(masked), top_n=None)
        except Exception:  # noqa: BLE001 -- annotation must never break the forecast
            res = None
        if not res:
            continue
        at_dt = event_times.get(slot)
        slot_result = record.get(slot) or {}
        checkpoints.append(
            {
                "score": res["score"],
                "slot": slot,
                "stage": stage,
                "label": _SLOT_LABEL[slot],
                "outcome": slot_result.get("outcome", ""),
                "at": at_dt.strftime("%Y-%m-%d %H:%M") if at_dt else None,
            }
        )

    # Position markers EVENLY across the observed window (-6..0) so multiple
    # checkpoints never overlap: rightmost at -0.6, stepping back 1.5 months
    # per earlier stage (1 marker -> -0.6, 2 -> -2.1/-0.6, 3 -> -3.6/-2.1/-0.6).
    checkpoints.sort(key=lambda c: c["stage"])
    k = len(checkpoints)
    for i, cp in enumerate(checkpoints):
        cp["t"] = round(-0.6 - 1.5 * (k - 1 - i), 2)
    return checkpoints


def forecast(record: dict) -> Optional[dict]:
    """Full outlook for one internal patient record."""
    if not _load():
        return None
    meta = _cache["meta"] or {}

    # The model identity is part of the key: a retrain must never serve a
    # forecast computed by the previous artifacts.
    cache_key = (record.get("id"), record.get("updated_at"), record.get("stage"),
                 meta.get("trained_at"))
    if _forecast_cache.get(cache_key) is not None:
        return _forecast_cache[cache_key]

    horizon = int(meta.get("horizon_months") or 24)
    horizon_years = round(horizon / 12)

    from . import model_service
    from .config import has_biomarker_evidence, risk_tier

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

    # ---- 2. Drivers --------------------------------------------------------
    # The score itself is NOT recomputed here: the served model already produced
    # it (model_service is the single source of truth), so the same model run
    # twice would just yield the same number under a second label.
    drivers = _top_drivers(feats)

    # ---- 3. Projected risk tier: current risk model on the future vector ----
    mmse_prior = cog.get("prior")
    future_feats = dict(feats)
    future_feats["age"] = (feats.get("age") or 74) + horizon_years
    future_feats["mmse"] = mmse_future
    future_feats["mmse_change"] = (
        (mmse_future - mmse_prior) if mmse_prior is not None else None
    )
    projected = model_service.score_features(future_feats, top_n=None)
    score_future = projected["score"] if projected else record.get("score")
    # Tier, not score, is evidence-gated -- and the projection is held to the same
    # rule: a "nothing changes" future in which no biomarker was ever ordered is
    # still cognition alone, so it cannot project High.
    tier_future = risk_tier(score_future, has_biomarker_evidence(future_feats))
    score_now = record.get("score")
    tier_now = risk_tier(score_now, has_biomarker_evidence(record))

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
            "t": horizon,
            "mmse": mmse_future,
            "kind": "predicted",
            "lo": max(0, round(mmse_future - band)),
            "hi": min(30, round(mmse_future + band)),
        },
    ]

    score_checkpoints = _score_checkpoints(record)

    payload = {
        "id": record.get("id"),
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
            "score": round(float(score_future), 4),
            "risk_tier": tier_future,
            "tier_shift": tier_now != tier_future,
        },
        "trajectory": trajectory,
        "score_checkpoints": score_checkpoints,
        "drivers": drivers,
        "disclaimer": (
            "Model-derived decision support, trained on real clinician follow-up "
            "visits — never a diagnosis and never a guarantee of outcome."
        ),
    }
    _forecast_cache[cache_key] = payload
    return payload
