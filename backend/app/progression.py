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
    projected future feature vector -- one consistent model family end-to-end. The
    vector is moved forward attribute by attribute (artifacts/
    progression_projection.joblib), not just at MMSE: every attribute whose own
    24-month change the data can predict (a CV-MAE gain over assuming no change) is
    projected, and every other one is carried forward at its measured value and
    reported as carried in `carried_attributes`, so nothing on the projected
    vector is silently standing in for a forecast that was never made
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

from . import visits as visits_mod
from .config import PROJECT_ROOT

# Stage order -> slot mapping (mirrors escalation.py)
_SLOT_STAGE = [("blood", 2), ("imaging", 3), ("pet", 4)]
_SLOT_LABEL = {"blood": "Blood panel", "imaging": "MRI", "pet": "PET"}

DELTA_PATH = PROJECT_ROOT / "artifacts" / "progression_delta.joblib"
CONV_PATH = PROJECT_ROOT / "artifacts" / "progression_conversion.joblib"
# One regressor per projectable attribute (see train_progression_model.py).
PROJECTION_PATH = PROJECT_ROOT / "artifacts" / "progression_projection.joblib"
META_PATH = PROJECT_ROOT / "artifacts" / "progression_meta.json"
IMPORTANCE_PATH = PROJECT_ROOT / "artifacts" / "progression_importance.csv"

_cache: dict = {"delta": None, "conv": None, "meta": None, "explainer": None,
                "importance": [], "projection": {}}
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
        # Optional on purpose: without it every attribute is carried forward, which
        # is exactly the behaviour that shipped before, so a missing bundle
        # degrades the outlook instead of breaking it.
        _cache["projection"] = joblib.load(PROJECTION_PATH)
    except Exception:  # noqa: BLE001
        _cache["projection"] = {}
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


def _score_checkpoints(record: dict, observed_months: float = 6.0) -> list[dict]:
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

    # Position markers EVENLY so multiple checkpoints never overlap: the most
    # recent sits one step left of "today", each earlier stage a further step
    # back. The step SCALES with how much observed history the subject has,
    # because the chart's observed window is now the real visit span (which can
    # be 20 years): a fixed 1.5-month step would stack every marker into a single
    # blob against the right edge. The x-placement is a spacing convention, not a
    # date -- stage completions in this cohort carry no measured timestamp -- so
    # it stays inside the last stretch of the observed window.
    checkpoints.sort(key=lambda c: c["stage"])
    k = len(checkpoints)
    step = max(1.5, float(observed_months or 6.0) * 0.05)
    for i, cp in enumerate(checkpoints):
        cp["t"] = round(-step * (k - i), 2)
    return checkpoints


def _observed_series(visit_rows: list[dict], mmse_prior, mmse_now, stage: int,
                     stage_label: str) -> list[dict]:
    """The observed half of the chart.

    With the visits artifact present this is every real follow-up visit the
    subject has, positioned in months relative to their most recent one (so
    `t = 0` is today and the axis break lands on the last visit). It is a real
    trajectory instead of a two-point line: 58% of the served cohort has three
    or more visits, and the longest runs are 21 visits over twenty years.

    Without the artifact it falls back to the two scores the record carries, so
    the chart degrades to what it showed before rather than breaking.
    """
    if len(visit_rows) < 2:
        return [
            {"t": -6, "mmse": mmse_prior, "kind": "observed"},
            {"t": 0, "mmse": mmse_now, "kind": "observed", "stage": stage,
             "stage_label": stage_label},
        ]

    span = visits_mod.months_between(visit_rows[0]["date"], visit_rows[-1]["date"])
    series = []
    for i, row in enumerate(visit_rows):
        point = {
            "t": round(visits_mod.months_between(visit_rows[0]["date"], row["date"]) - span, 1),
            "mmse": row["mmse"],
            "kind": "observed",
            "date": row["date"],
            # Carried for the hover readout -- the visit's other instruments are
            # what separate "one bad MMSE" from a decline on every measure.
            "adas": row.get("adas"),
            "cdr": row.get("cdr"),
            "visit_no": row.get("visit_no"),
            "n_visits": row.get("total"),
        }
        if i == len(visit_rows) - 1:
            point["stage"] = stage
            point["stage_label"] = stage_label
        series.append(point)
    return series


def _risk_series(record: dict, visit_rows: list[dict]) -> list[dict]:
    """Risk score at EVERY visit, so the chart can plot risk against time.

    Each visit is scored on the record AS IT EXISTED THEN: the values that visit
    actually measured, and nothing else. Every feature the visit did not measure is
    masked to None rather than borrowed from today's record -- filling those in
    would let a 2013 PET result raise a 2006 score, which is exactly the hindsight
    a retrospective trajectory must not have. The served model consumes missing
    features natively, so masking degrades the score honestly instead of inventing
    it.

    Positions are months relative to the subject's most recent visit (`t = 0` is
    today), matching the x-scale the trajectory chart already uses, so risk and
    cognition share one clock.
    """
    from . import model_service

    if not visit_rows or not model_service.available():
        return []
    names = model_service.active_feature_names()
    if not names:
        return []
    span = visits_mod.months_between(visit_rows[0]["date"], visit_rows[-1]["date"])

    series = []
    for row in visit_rows:
        measured = row.get("model_features") or {}
        vector = {}
        for name in names:
            key = "sex" if name in ("sex", "sex_m") else name
            value = measured.get(key)
            if key == "sex" and isinstance(value, str):
                value = {"M": 1.0, "F": 0.0}.get(value.strip().upper())
            vector[name] = value
        result = model_service.score_features(vector, top_n=None)
        if not result or result.get("score") is None:
            continue
        series.append({
            "t": round(visits_mod.months_between(visit_rows[0]["date"], row["date"]) - span, 1),
            "score": round(float(result["score"]), 4),
            "date": row["date"],
            "mmse": row.get("mmse"),
            "adas": row.get("adas"),
            "cdr": row.get("cdr"),
            "visit_no": row.get("visit_no"),
            "n_visits": row.get("total"),
        })
    return series


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

    # Real visit history, when the visits artifact is available. The record's
    # `latest` is derived from this same file, so reading the last visit here
    # keeps "today" on the chart identical to the point the projection grows from.
    visit_rows = [r for r in visits_mod.series(record.get("id")) if r.get("mmse") is not None]
    if visit_rows:
        mmse_now = visit_rows[-1]["mmse"]

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

    # ---- 2b. Move the rest of the vector forward ---------------------------- #
    # The projected score is only as good as the vector it is scored on. Freezing
    # every biomarker at today's value would understate change exactly where this
    # model's heaviest drivers live, so each attribute with a trainable 24-month
    # change is projected (see the gain gate in train_progression_model.py).
    #
    # Everything else is CARRIED at its measured value and reported as carried with
    # the reason its projection was refused -- the page must be able to say which
    # numbers on the projected vector are forecasts and which are today's values.
    projection_models = _cache.get("projection") or {}
    projection_meta = meta.get("projection_targets") or {}
    projected_attributes: list[dict] = []
    carried_attributes: list[dict] = []

    def _num(value, digits: int = 4):
        if value is None or (isinstance(value, float) and np.isnan(value)):
            return None
        try:
            return round(float(value), digits)
        except (TypeError, ValueError):
            return None

    # age and MMSE are projected by construction -- the horizon advances the clock
    # and the delta regressor above predicts the cognitive change -- so they are
    # reported here rather than re-derived.
    projected_attributes.append({
        "feature": "age",
        "today": _num(feats.get("age"), 2),
        "projected": _num((feats.get("age") or 74) + horizon_years, 2),
        "kind": "model",
        "method": f"advances with the {horizon}-month horizon",
    })
    projected_attributes.append({
        "feature": "mmse",
        "today": _num(mmse_now, 2),
        "projected": _num(mmse_future, 2),
        "delta": _num(mmse_future - mmse_now, 2),
        "kind": "model",
        "method": "MMSE-change regressor",
        "cv_mae": (meta.get("metrics") or {}).get("delta_cv_mae_mean"),
        "mae_no_change": (meta.get("metrics") or {}).get("delta_mae_baseline"),
    })

    for name in names:
        if name in ("age", "mmse"):
            continue
        today_val = feats.get(name)
        entry = {"feature": name, "today": _num(today_val)}
        model = projection_models.get(name)
        # NOT `record`: that name is the patient record this function was handed,
        # and rebinding it here silently wiped the subject's own score.
        target_meta = projection_meta.get(name) or {}
        if model is not None and today_val is not None and not (
                isinstance(today_val, float) and np.isnan(today_val)):
            raw_delta = float(model.predict(row)[0])
            # Apply the out-of-fold calibration fitted at training time. Without it
            # the raw regressor can call the SIGN wrong for one subject: hippocampal
            # volume came out growing at +0.11 cm^3 on a cohort that measurably
            # shrinks by -0.11, because the model's error was as large as its
            # prediction. The slope is <1 by construction, so a weak prediction is
            # pulled onto the cohort's measured mean change instead of being trusted.
            cal = (target_meta.get("calibration") or {})
            delta = float(cal.get("intercept", 0.0)) + float(cal.get("slope", 1.0)) * raw_delta
            future_feats[name] = float(today_val) + delta
            entry.update({
                "projected": _num(float(today_val) + delta),
                "delta": _num(delta),
                "kind": "model",
                "cv_mae": target_meta.get("cv_mae_mean"),
                "mae_no_change": target_meta.get("mae_no_change"),
                "gain_vs_no_change": target_meta.get("gain_vs_no_change"),
            })
            projected_attributes.append(entry)
        elif today_val is not None and not (isinstance(today_val, float) and np.isnan(today_val)):
            entry.update({
                "projected": entry["today"],
                "delta": 0.0,
                "kind": "carried",
                "reason": target_meta.get("reason") or "no usable 24-month follow-up to train on",
            })
            carried_attributes.append(entry)

    projected = model_service.score_features(future_feats, top_n=None)
    score_future = projected["score"] if projected else record.get("score")
    # Tier, not score, is evidence-gated -- and the projection is held to the same
    # rule: a "nothing changes" future in which no biomarker was ever ordered is
    # still cognition alone, so it cannot project High.
    tier_future = risk_tier(score_future, has_biomarker_evidence(future_feats))
    score_now = record.get("score")
    tier_now = risk_tier(score_now, has_biomarker_evidence(record))

    # ---- 3b. Risk score over time ------------------------------------------ #
    # The chart's main panel is the risk SCORE against time, so it needs a score at
    # every visit rather than only at stage completions.
    risk_series = _risk_series(record, visit_rows)
    # The forecast's uncertainty, mapped through the model rather than assumed: the
    # MMSE interval from the delta regressor is scored at BOTH ends, so the wedge on
    # the chart is the model's own output at those inputs -- no invented error term.
    score_band = None
    if projected:
        ends = []
        for mmse_end in (max(0, mmse_future - band), min(30, mmse_future + band)):
            feats_end = dict(future_feats)
            feats_end["mmse"] = mmse_end
            res_end = model_service.score_features(feats_end, top_n=None)
            if res_end and res_end.get("score") is not None:
                ends.append(round(float(res_end["score"]), 4))
        # A zero-width interval is not an interval: where the model is saturated the
        # two ends coincide, and drawing that as a band would claim a precision the
        # inputs do not carry. Null means "no measurable interval here".
        if len(ends) == 2 and ends[0] != ends[1]:
            score_band = [min(ends), max(ends)]

    stage = record.get("stage", 1)
    stage_label = {
        1: "Stage 1 — cognitive baseline",
        2: "Stage 2 — blood panel completed",
        3: "Stage 3 — MRI volumetrics completed",
        4: "Stage 4 — PET completed (full workup)",
    }.get(stage, f"Stage {stage}")

    trajectory = _observed_series(visit_rows, mmse_prior, mmse_now, stage, stage_label) + [
        {
            "t": horizon,
            "mmse": mmse_future,
            "kind": "predicted",
            "lo": max(0, round(mmse_future - band)),
            "hi": min(30, round(mmse_future + band)),
        }
    ]

    if visit_rows:
        observed_months = visits_mod.months_between(visit_rows[0]["date"], visit_rows[-1]["date"])
    else:
        observed_months = 6.0
    score_checkpoints = _score_checkpoints(record, observed_months)

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
            # Score at the low and high end of the MMSE forecast interval, scored by
            # the same model: the width of the forecast, not a claimed confidence
            # level.
            "score_band": score_band,
        },
        "trajectory": trajectory,
        # Risk score at every real visit (each scored on the record as it existed
        # then, unmeasured features masked), plus the score at each completed stage
        # in score_checkpoints. This is what the main panel plots.
        "risk_trajectory": risk_series,
        # What the projected vector is actually made of: which attributes the model
        # moved forward (with the accuracy that earned them a place) and which were
        # carried at today's value because their own projection did not beat
        # assuming no change.
        "projected_attributes": projected_attributes,
        "carried_attributes": carried_attributes,
        "projection": {
            "horizon_months": horizon,
            "min_gain_vs_no_change": meta.get("projection_min_gain"),
            "n_projected": len(projected_attributes),
            "n_carried": len(carried_attributes),
        },
        # How much observed history the chart is drawn from, plus its fitted
        # slope, so the caption can state the span rather than imply it.
        "history": visits_mod.history(record.get("id")),
        "score_checkpoints": score_checkpoints,
        "drivers": drivers,
        "disclaimer": (
            "Model-derived decision support, trained on real clinician follow-up "
            "visits — never a diagnosis and never a guarantee of outcome."
        ),
    }
    _forecast_cache[cache_key] = payload
    return payload
