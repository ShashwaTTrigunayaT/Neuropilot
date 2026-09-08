#!/usr/bin/env python3
"""Progression forecaster training (12-month horizon).

Trains two XGBoost models on the SAME 10-feature stage-aware baseline vector
the risk model uses (age, education, sex, MMSE + change, blood, MRI, PET --
NaN when the stage was never ordered):

  1. mmse_delta_12mo   XGBRegressor  -- expected MMSE point change over 12 months
  2. conversion_12mo   XGBClassifier -- probability of clinical progression
     (CN->MCI, MCI->AD, or for AD subjects crossing into severe decline)

Labels come from scripts/simulate_followup.py (data/processed/followup_12mo.json):
biomarker-driven 12-month trajectories for the synthetic v2 cohort.

Serving contract (backend/app/progression.py):
  baseline features -> (expected MMSE delta, conversion probability), then the
  CURRENT risk model re-scores the PROJECTED 12-month feature vector to derive
  the projected risk tier. Both models ship as joblib pipelines and are loaded
  into the API process.

Outputs:
  artifacts/progression_delta.joblib
  artifacts/progression_conversion.joblib
  artifacts/progression_meta.json
  artifacts/progression_report.txt
"""
from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import (
    average_precision_score,
    brier_score_loss,
    mean_absolute_error,
    mean_squared_error,
    r2_score,
    roc_auc_score,
)
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.dummy import DummyRegressor, DummyClassifier
from xgboost import XGBClassifier, XGBRegressor

PROCESSED = Path("data/processed")
ARTIFACTS = Path("artifacts")
COHORT = PROCESSED / "synthetic_patients_v2.json"
FOLLOWUP = PROCESSED / "followup_12mo.json"

FEATURES = [
    "age", "education_years", "sex", "mmse", "mmse_change",
    "ptau181", "abeta4240",
    "hippocampal_volume",
    "amyloid_positive", "tau_positive",
]


def baseline_features(record: dict) -> dict:
    """Synthetic record -> the 10-feature baseline vector (mirrors train_model.load_synthetic)."""
    cog = record.get("cognitive") or {}
    blood = record.get("blood") or {}
    imaging = record.get("imaging") or {}
    pet = record.get("pet") or {}
    mmse_latest = cog.get("latest")
    mmse_prior = cog.get("prior", mmse_latest)
    return {
        "age": record.get("age"),
        "education_years": record.get("education_years"),
        "sex": 1 if record.get("sex") == "M" else 0,
        "mmse": mmse_latest,
        "mmse_change": (mmse_latest - mmse_prior) if (mmse_latest is not None and mmse_prior is not None) else np.nan,
        "ptau181": blood.get("pTau181") if isinstance(blood, dict) else np.nan,
        "abeta4240": blood.get("abeta4240") if isinstance(blood, dict) else np.nan,
        "hippocampal_volume": imaging.get("hippocampalVolumeCm3") if isinstance(imaging, dict) else np.nan,
        "amyloid_positive": (1.0 if str(pet.get("amyloid")).lower() == "positive" else 0.0) if isinstance(pet, dict) and pet.get("amyloid") else np.nan,
        "tau_positive": (1.0 if str(pet.get("tau")).lower() == "positive" else 0.0) if isinstance(pet, dict) and pet.get("tau") else np.nan,
    }


def main() -> int:
    if not COHORT.exists() or not FOLLOWUP.exists():
        print("ERROR: cohort or followup file missing.")
        print("  run: python scripts/generate_adni_like_v2.py && python scripts/simulate_followup.py")
        return 1

    cohort = {r["id"]: r for r in json.loads(COHORT.read_text(encoding="utf-8"))}
    followup = {r["id"]: r for r in json.loads(FOLLOWUP.read_text(encoding="utf-8"))}

    rows, y_delta, y_conv, ids = [], [], [], []
    for sid, fu in followup.items():
        rec = cohort.get(sid)
        if rec is None:
            continue
        rows.append(baseline_features(rec))
        y_delta.append(float(fu["mmse_delta"]))
        y_conv.append(int(fu["converted"]))
        ids.append(sid)

    X = pd.DataFrame(rows)[FEATURES]
    y_delta = pd.Series(y_delta, name="mmse_delta_12mo")
    y_conv = pd.Series(y_conv, name="converted_12mo")
    print(f"[data] {len(X)} subjects · {int(y_conv.sum())} conversions ({100 * y_conv.mean():.1f}%)")
    print(f"[data] features ({len(FEATURES)}): {', '.join(FEATURES)}")

    idx = np.arange(len(X))
    tr, te = train_test_split(idx, test_size=0.2, random_state=42, stratify=y_conv)
    X_tr, X_te = X.iloc[tr], X.iloc[te]
    d_tr, d_te = y_delta.iloc[tr], y_delta.iloc[te]
    c_tr, c_te = y_conv.iloc[tr], y_conv.iloc[te]

    common = dict(n_estimators=400, learning_rate=0.05, max_depth=3,
                  subsample=0.8, colsample_bytree=0.8, random_state=42)

    # ---- MMSE-delta regressor ------------------------------------------------
    delta_pipe = Pipeline([("prep", "passthrough"),
                           ("reg", XGBRegressor(**common))])
    delta_pipe.fit(X_tr, d_tr)
    pred_d = delta_pipe.predict(X_te)
    mae = mean_absolute_error(d_te, pred_d)
    rmse = float(np.sqrt(mean_squared_error(d_te, pred_d)))
    r2 = r2_score(d_te, pred_d)
    dummy_reg = DummyRegressor().fit(X_tr, d_tr)
    mae_base = mean_absolute_error(d_te, dummy_reg.predict(X_te))

    # ---- Conversion classifier (scale_pos_weight for the rare positive class)
    spw = float((c_tr == 0).sum()) / max(1, float((c_tr == 1).sum()))
    conv_pipe = Pipeline([("prep", "passthrough"),
                          ("clf", XGBClassifier(**common, eval_metric="logloss", scale_pos_weight=spw))])
    conv_pipe.fit(X_tr, c_tr)
    proba_c = conv_pipe.predict_proba(X_te)[:, 1]
    pred_c = (proba_c >= 0.5).astype(int)
    auc = roc_auc_score(c_te, proba_c)
    pr_auc = average_precision_score(c_te, proba_c)
    brier = brier_score_loss(c_te, proba_c)
    acc = float((pred_c == c_te).mean())
    dummy_clf = DummyClassifier(strategy="most_frequent").fit(X_tr, c_tr)
    acc_base = float((dummy_clf.predict(X_te) == c_te).mean())

    lines = [
        "Progression forecaster evaluation -- 12-month horizon (synthetic v2 cohort)",
        "models                : XGBRegressor (mmse_delta_12mo) + XGBClassifier (conversion_12mo)",
        f"subjects              : {len(X)} ({int(y_conv.sum())} conversions, {100 * y_conv.mean():.1f}%)",
        f"test set              : {len(te)} (20%, stratified by conversion)",
        f"features              : {', '.join(FEATURES)}",
        "",
        "MMSE-delta regressor:",
        f"  test MAE            : {mae:.3f} points (baseline 'predict the mean': {mae_base:.3f})",
        f"  test RMSE           : {rmse:.3f}",
        f"  test R^2            : {r2:.3f}",
        "",
        "Conversion classifier:",
        f"  test ROC AUC        : {auc:.3f}",
        f"  test PR AUC         : {pr_auc:.3f} (prevalence {c_te.mean():.3f})",
        f"  test Brier score    : {brier:.3f} (lower = better calibrated)",
        f"  accuracy@0.5        : {acc:.3f} (majority baseline {acc_base:.3f})",
        "",
        "guardrails:",
        "- same 10 baseline features as the risk model; NaN = stage not yet ordered",
        "- subject-level 20% holdout, stratified by conversion label",
        "- conversion class imbalance handled via scale_pos_weight "
        f"({spw:.2f})",
        "- projected 12-month risk tier = CURRENT risk model re-scored on the",
        "  projected future feature vector (age+1, forecast MMSE, carried-forward",
        "  biomarkers) -- one consistent model family end-to-end",
        "- labels are simulated trajectories shaped by published progression",
        "  dynamics (synthetic data, not real patient outcomes)",
    ]
    print("\n" + "\n".join(lines))

    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    joblib.dump(delta_pipe, ARTIFACTS / "progression_delta.joblib")
    joblib.dump(conv_pipe, ARTIFACTS / "progression_conversion.joblib")
    (ARTIFACTS / "progression_report.txt").write_text("\n".join(lines), encoding="utf-8")

    meta = {
        "model_type": "xgb_regressor+xgb_classifier",
        "horizon_months": 12,
        "features": FEATURES,
        "trained_at": datetime.now().isoformat(timespec="seconds"),
        "data_source": "synthetic v2 cohort + biomarker-driven 12-month follow-up simulation",
        "n_train": int(len(tr)),
        "n_test": int(len(te)),
        "conversion_prevalence": round(float(y_conv.mean()), 4),
        "metrics": {
            "delta_mae": round(float(mae), 4),
            "delta_mae_baseline": round(float(mae_base), 4),
            "delta_rmse": round(float(rmse), 4),
            "delta_r2": round(float(r2), 4),
            "conversion_auc": round(float(auc), 4),
            "conversion_pr_auc": round(float(pr_auc), 4),
            "conversion_brier": round(float(brier), 4),
            "conversion_accuracy": round(float(acc), 4),
        },
    }
    (ARTIFACTS / "progression_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    print("\n[done] wrote:")
    for p in ("progression_delta.joblib", "progression_conversion.joblib",
              "progression_meta.json", "progression_report.txt"):
        print(f"  artifacts/{p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
