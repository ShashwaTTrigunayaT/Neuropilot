#!/usr/bin/env python3
"""Risk-scoring model + explainability (blueprint sections 4.3 / 4.4 / 5).

Two data modes (auto-detected, overridable with --data):

  synthetic (default when present)
    Trains on the ADNI-shaped synthetic cohort produced by
    scripts/generate_adni_like.py. Features span ALL FOUR pipeline stages:
    cognitive (MMSE + decline), blood biomarkers (p-tau181, Aβ42/40),
    MRI volumetrics (hippocampal volume), and PET (amyloid/tau status).
    Label: a transparent severity rule (NOT circular — the label uses the
    same signal the cohort was generated with, but the model only sees the
    observed feature values, including missingness).

  real (fallback / --data real)
    Trains on real OASIS-1 longitudinal data via ingest.py outputs.
    Real OASIS has no blood/PET, so those features simply do not exist in
    this mode and the model is cognitive+volume only.

Missing-value handling: test results are only present for subjects whose
pipeline stage has reached that test. Biomarker features are therefore NaN
for most Stage-1 subjects — XGBoost learns from missingness itself (a test
not yet ordered is informative), and RandomForest is median-imputed as
before. This mirrors clinical reality: the model uses what it has.

Guardrails (also written to artifacts/eval_report.txt):
  * CDR is NOT a feature (clinician rating ~= diagnosis: label leakage).
  * Subject-level stratified split (no subject in both train and test).
  * 5-fold CV AUC reported alongside held-out AUC.
  * The synthetic provenance is recorded in the model card.

Outputs:
  artifacts/pipeline.joblib        -- served by the FastAPI API (POST /patients/score)
  artifacts/rf_pipeline.joblib     -- fallback baseline pipeline
  artifacts/model_meta.json        -- model card consumed by GET /model/info
  artifacts/eval_report.txt        -- metrics + decisions (audit trail)
  artifacts/global_importance.csv  -- global SHAP importances
  data/processed/risk_scores.json  -- per-subject risk + top factors (dashboard-ready)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import shap
from sklearn.compose import ColumnTransformer
from sklearn.dummy import DummyClassifier
from sklearn.impute import SimpleImputer
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, roc_auc_score
from sklearn.model_selection import StratifiedKFold, cross_val_score, train_test_split
from sklearn.pipeline import Pipeline
from sklearn.ensemble import RandomForestClassifier

try:
    from xgboost import XGBClassifier

    XGB_AVAILABLE = True
except ImportError:  # pragma: no cover -- fallback path
    XGB_AVAILABLE = False

PROCESSED = Path("data/processed")
ARTIFACTS = Path("artifacts")

import random

# Separate RNG for label noise, seeded independently so the label draw does
# not shift the cohort's own generation stream.
_label_rng = random.Random(42)

# Features spanning all four pipeline stages. In real-OASIS mode the biomarker
# columns are absent and the list is filtered down automatically.
FEATURES_ALL = [
    # Stage 1 -- cognitive
    "age", "education_years", "sex", "mmse", "mmse_change",
    # Stage 2 -- blood biomarkers
    "ptau181", "abeta4240",
    # Stage 3 -- MRI volumetrics
    "hippocampal_volume",
    # Stage 4 -- PET
    "amyloid_positive", "tau_positive",
]

# Real-ADNI mode. The 16-feature vector and its stage mapping live in
# scripts/ingest_adni.py -- imported so the ingester and the trainer can never
# drift apart (a silent mismatch here would train on different columns than
# the API serves at inference time).
sys.path.insert(0, str(Path(__file__).resolve().parent))
try:  # pragma: no cover -- import-time wiring
    from ingest_adni import FEATURES as FEATURES_ADNI, STAGE_OF as STAGE_OF_ADNI

    ADNI_FEATURES_AVAILABLE = True
except Exception:  # noqa: BLE001 -- trainer must still run in synthetic/OASIS modes
    FEATURES_ADNI, STAGE_OF_ADNI, ADNI_FEATURES_AVAILABLE = [], {}, False

FEATURES_OASIS = [
    "age", "education_years", "ses", "mmse",
    "etiv", "nwbv", "asf",
    "sex", "mmse_change", "n_visits", "study_years",
]

# feature -> pipeline stage, for every cohort's naming scheme. Used to report
# how much each *stage* (cognition / blood / MRI / PET) contributes to the score.
STAGE_OF_FEATURE = {
    # legacy synthetic names
    "ptau181": 2, "amyloid_positive": 4, "tau_positive": 4,
    # real ADNI names
    **STAGE_OF_ADNI,
    # OASIS names
    "ses": 1, "n_visits": 1, "study_years": 1,
    "etiv": 3, "nwbv": 3, "asf": 3,
}

STAGE_NAMES = {1: "cognitive / clinical", 2: "blood biomarkers", 3: "MRI volumetrics", 4: "PET"}

LABEL_MAP = {"Demented": 1, "Nondemented": 0}

HIGH = float(os.getenv("HIGH_RISK_THRESHOLD", "0.7"))
MEDIUM = float(os.getenv("MEDIUM_RISK_THRESHOLD", "0.4"))


def _num(v, digits: int = 4):
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return None
    return round(float(v), digits)


def _make_clf(model_type: str, early_stopping: bool):
    if model_type == "rf":
        return RandomForestClassifier(
            n_estimators=400, max_depth=8, min_samples_leaf=3,
            random_state=42, n_jobs=-1,
        )
    kwargs = dict(
        learning_rate=0.05, max_depth=3, subsample=0.8, colsample_bytree=0.8,
        eval_metric="logloss", random_state=42,
    )
    if early_stopping:
        kwargs.update(n_estimators=1000, early_stopping_rounds=25)
    else:
        kwargs.update(n_estimators=200)
    return XGBClassifier(**kwargs)


# --------------------------------------------------------------------------- #
# Synthetic-cohort loading (all four stages)
# --------------------------------------------------------------------------- #
def load_synthetic(path: Path | None = None) -> tuple[pd.DataFrame, pd.Series, list[str], list[str]]:
    """Synthetic cohort -> feature frame, label, feature list, subject ids."""
    path = path or PROCESSED / "synthetic_patients.json"
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw_ids = [str(r.get("id")) for r in raw]
    rows = []
    labels = []
    for r in raw:
        cog = r.get("cognitive") or {}
        blood = r.get("blood") or {}
        imaging = r.get("imaging") or {}
        pet = r.get("pet") or {}
        mmse_latest = cog.get("latest")
        mmse_prior = cog.get("prior", mmse_latest)
        age = r.get("age") or 73
        rows.append(
            {
                "age": r.get("age"),
                "education_years": r.get("education_years"),
                "sex": 1 if r.get("sex") == "M" else 0,
                "mmse": mmse_latest,
                "mmse_change": (mmse_latest - mmse_prior) if (mmse_latest is not None and mmse_prior is not None) else np.nan,
                # Test slots: NaN when not yet ordered/completed (native missing)
                "ptau181": blood.get("pTau181") if isinstance(blood, dict) else np.nan,
                "abeta4240": blood.get("abeta4240") if isinstance(blood, dict) else np.nan,
                "hippocampal_volume": imaging.get("hippocampalVolumeCm3") if isinstance(imaging, dict) else np.nan,
                "amyloid_positive": (1.0 if str(pet.get("amyloid")).lower() == "positive" else 0.0) if isinstance(pet, dict) and pet.get("amyloid") else np.nan,
                "tau_positive": (1.0 if str(pet.get("tau")).lower() == "positive" else 0.0) if isinstance(pet, dict) and pet.get("tau") else np.nan,
                # Keep provenance columns out of FEATURES but useful for audit
                "_stage": r.get("stage"),
            }
        )
        # Transparent severity label from the observed data (NOT a feature).
        # A SOFT probabilistic rule: each factor contributes log-odds and the
        # total drives a Bernoulli draw. This leaves genuine label noise in
        # the overlap zone, so the model must learn a graded risk signal
        # (AUC < 1) instead of memorizing a hard cutoff.
        import math

        mmse = mmse_latest if mmse_latest is not None else 30
        logit = 0.0
        logit += (26.0 - mmse) * 0.55                       # cognition: dominant driver
        if mmse_latest is not None and mmse_prior is not None:
            logit += (mmse_prior - mmse_latest) * 0.18      # decline raises risk
        if isinstance(blood, dict) and blood.get("pTau181") is not None:
            logit += (blood.get("pTau181") - 2.5) * 0.45    # elevated p-tau raises risk
        if isinstance(blood, dict) and blood.get("abeta4240") is not None:
            logit += (0.09 - blood.get("abeta4240")) * 14.0 # low ratio raises risk
        if isinstance(imaging, dict) and imaging.get("hippocampalVolumeCm3") is not None:
            logit += (2.6 - imaging.get("hippocampalVolumeCm3")) * 0.9
        if isinstance(pet, dict) and pet.get("amyloid") == "Positive":
            logit += 0.8
        if isinstance(pet, dict) and pet.get("tau") == "Positive":
            logit += 0.9
        logit += (age - 73) * 0.04
        if r.get("family_history"):
            logit += 0.25

        p_severe = 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, logit))))
        labels.append(1 if _label_rng.random() < p_severe else 0)

    X = pd.DataFrame(rows)
    y = pd.Series(labels, index=X.index, name="label")
    features = [f for f in FEATURES_ALL if f in X.columns]
    return X, y, features, raw_ids


# --------------------------------------------------------------------------- #
# Real-ADNI loading (scripts/ingest_adni.py output)
# --------------------------------------------------------------------------- #
def load_adni() -> tuple[pd.DataFrame, list[str], list[str]]:
    """Real ADNI cohort -> feature frame (with real labels), feature list, ids.

    One row per subject: their latest visit that carries a real DIAGNOSIS.
    label = 1 for MCI or Dementia, 0 for CN -- the cohort's own clinician
    labels, not a simulated rule. Feature slots with no measurement stay NaN
    (XGBoost consumes that missingness natively; see the coverage report).
    """
    path = PROCESSED / "adni_features.csv"
    if not path.exists():
        print(f"ERROR: {path} missing.\nRun ingest first:  python scripts/ingest_adni.py")
        sys.exit(1)
    feat = pd.read_csv(path)
    features = [f for f in FEATURES_ADNI if f in feat.columns]
    missing = [f for f in FEATURES_ADNI if f not in feat.columns]
    if missing:
        print(f"[warn] ADNI feature columns absent from ingest output: {missing}")
    return feat, features, feat["subject_id"].astype(str).tolist()


# --------------------------------------------------------------------------- #
# Real-OASIS loading (unchanged behavior)
# --------------------------------------------------------------------------- #
def load_oasis() -> tuple[pd.DataFrame, pd.Series, list[str]]:
    visits_path = PROCESSED / "visits.csv"
    patients_path = PROCESSED / "patients.csv"
    if not visits_path.exists() or not patients_path.exists():
        print(f"ERROR: {visits_path} or {patients_path} missing.\nRun ingest first:  python scripts/ingest.py")
        sys.exit(1)

    visits = pd.read_csv(visits_path)
    patients = pd.read_csv(patients_path)
    for df in (visits, patients):
        df["subject_id"] = df["subject_id"].astype(str).str.strip()

    first_mmse = (
        visits.sort_values("visit_no")
        .drop_duplicates(subset="subject_id", keep="first")[["subject_id", "mmse"]]
        .rename(columns={"mmse": "mmse_first"})
    )
    n_visits = visits.groupby("subject_id").size().rename("n_visits")

    feat = patients.merge(first_mmse, on="subject_id", how="left").merge(n_visits, on="subject_id", how="left")
    feat["mmse_change"] = feat["mmse"] - feat["mmse_first"]
    feat["sex"] = (feat["sex"] == "M").astype(int)
    feat["study_years"] = feat["mr_delay_days"] / 365.25
    feat["label"] = feat["diagnosis_group"].map(LABEL_MAP)

    features = list(FEATURES_OASIS)
    return feat, feat["label"], features


def main() -> int:
    parser = argparse.ArgumentParser(description="Train and export the risk model.")
    parser.add_argument("--model", choices=["xgb", "rf", "auto"], default="auto")
    parser.add_argument("--data", choices=["adni", "synthetic", "real", "auto"], default="auto",
                        help="adni (real ADNI drop, all 4 stages) | synthetic (ADNI-shaped) "
                             "| real (OASIS) | auto")
    args = parser.parse_args()

    model_type = args.model
    if model_type == "auto":
        model_type = "xgb" if XGB_AVAILABLE else "rf"
    if model_type == "xgb" and not XGB_AVAILABLE:
        print("[warn] xgboost not installed — falling back to RandomForest.")
        model_type = "rf"

    synthetic_v2_path = PROCESSED / "synthetic_patients_v2.json"
    synthetic_path = PROCESSED / "synthetic_patients.json"
    adni_path = PROCESSED / "adni_features.csv"
    data_mode = args.data
    if data_mode == "auto":
        # Real ADNI first (real labels, all four stages, no simulation),
        # then the v2 synthetic cohort, then OASIS.
        if adni_path.exists() and ADNI_FEATURES_AVAILABLE:
            data_mode = "adni"
        elif synthetic_v2_path.exists():
            data_mode = "synthetic"
            synthetic_path = synthetic_v2_path
        elif synthetic_path.exists():
            data_mode = "synthetic"
        else:
            data_mode = "real"
    elif data_mode == "synthetic" and synthetic_v2_path.exists():
        synthetic_path = synthetic_v2_path

    raw_ids = None
    if data_mode == "adni":
        feat, FEATURES, raw_ids = load_adni()
        y_all = pd.to_numeric(feat["label"], errors="coerce")
        labeled_mask = y_all.notna()
    elif data_mode == "synthetic":
        feat, y_all, FEATURES, raw_ids = load_synthetic(synthetic_path)
        labeled_mask = ~y_all.isna()
    else:
        feat, y_series, FEATURES = load_oasis()
        y_all = y_series
        labeled_mask = ~y_all.isna()

    labeled = feat[labeled_mask].copy()
    y = y_all[labeled_mask].astype(int)
    n_train = len(labeled)
    n_scored = len(feat)

    if data_mode == "adni":
        src = "real ADNI (13-table drop, 17 Sep 2026) — 16 features across all 4 stages"
    elif data_mode == "synthetic":
        src = "synthetic ADNI-shaped cohort (all 4 stages)"
    else:
        src = "real OASIS-1 longitudinal (cognitive + volume)"
    print(f"[data]  {n_scored} subjects scored · {n_train} with trainable labels "
          f"({int(y.sum())} positive / {int((1 - y).sum())} negative)")
    print(f"[data]  source: {src}")
    print(f"[data]  features ({len(FEATURES)}): {', '.join(FEATURES)}")

    X_all = feat[FEATURES]

    X_tr, X_te, y_tr, y_te = train_test_split(
        labeled[FEATURES], y, test_size=0.2,
        stratify=y, random_state=42,
    )

    # ---- Bundled preprocessing + classifier (blueprint section 3) ----------
    # xgboost: NO imputer — it consumes NaN natively (missing = test not yet
    # ordered, which is itself informative). RandomForest: median impute.
    if model_type == "xgb":
        prep = ColumnTransformer([("identity", "passthrough", FEATURES)], remainder="drop")
        prep_fitted = prep.fit(X_tr)
        X_tr_np = prep_fitted.transform(X_tr)
        X_te_np = prep_fitted.transform(X_te)

        clf = _make_clf(model_type, early_stopping=True)
        clf.fit(X_tr_np, y_tr, eval_set=[(X_te_np, y_te)], verbose=False)
    else:
        prep = ColumnTransformer([("num", SimpleImputer(strategy="median"), FEATURES)], remainder="drop")
        prep_fitted = prep.fit(X_tr)
        X_tr_np = prep_fitted.transform(X_tr)

        clf = _make_clf(model_type, early_stopping=False)
        clf.fit(X_tr_np, y_tr)

    pipeline = Pipeline([("prep", prep_fitted), ("clf", clf)])
    proba_te = pipeline.predict_proba(X_te)[:, 1]
    pred_te = (proba_te >= 0.5).astype(int)
    test_auc = roc_auc_score(y_te, proba_te)
    test_acc = accuracy_score(y_te, pred_te)

    # ---- 5-fold CV AUC (fresh estimator without early stopping) ------------
    cv_clf = _make_clf(model_type, early_stopping=False)
    cv_prep = ColumnTransformer(
        [("num", SimpleImputer(strategy="median"), FEATURES)] if model_type == "rf" else [("identity", "passthrough", FEATURES)],
        remainder="drop",
    )
    cv_pipe = Pipeline([("prep", cv_prep), ("clf", cv_clf)])
    cv = cross_val_score(cv_pipe, X_tr, y_tr, cv=StratifiedKFold(5, shuffle=True, random_state=42), scoring="roc_auc")

    # ---- RF fallback baseline (always trained for comparison) --------------
    rf_pipe = Pipeline([
        ("prep", ColumnTransformer([("num", SimpleImputer(strategy="median"), FEATURES)], remainder="drop")),
        ("clf", _make_clf("rf", early_stopping=False)),
    ])
    rf_pipe.fit(X_tr, y_tr)
    rf_auc = roc_auc_score(y_te, rf_pipe.predict_proba(X_te)[:, 1])

    dummy = DummyClassifier(strategy="most_frequent").fit(X_tr, y_tr)
    dummy_acc = accuracy_score(y_te, dummy.predict(X_te))

    report_lines = [
        f"Risk model evaluation -- {src}",
        f"model type             : {model_type}",
        f"subjects scored        : {n_scored}",
        f"subjects in training   : {n_train}",
        f"test set               : {len(X_te)} (20%, stratified)",
        f"features               : {', '.join(FEATURES)}",
        f"5-fold CV AUC (train)  : {cv.mean():.3f} +/- {cv.std():.3f}",
        f"held-out test AUC      : {test_auc:.3f}",
        f"held-out accuracy@0.5  : {test_acc:.3f}",
        f"RF fallback test AUC   : {rf_auc:.3f}",
        f"majority-class baseline: accuracy {dummy_acc:.3f}, AUC 0.500 (chance)",
        "",
        "guardrails:",
        "- CDR excluded from features (clinician rating ~= diagnosis: label leakage)",
        "- subject-level stratified split (no subject in both train and test)",
        "- biomarker features are NaN until the corresponding test is ordered;",
        "  xgboost consumes NaN natively (missingness = informative), RF median-imputes",
        "- preprocessing bundled into the served pipeline",
        "- early stopping used the held-out set, so test numbers are slightly optimistic",
        "confusion matrix (test):",
        str(confusion_matrix(y_te, pred_te)),
        "",
        classification_report(y_te, pred_te, target_names=["Low", "High"], digits=3, zero_division=0),
    ]
    print("\n" + "\n".join(report_lines))

    # ---- SHAP on the (possibly imputed) feature space -----------------------
    prep_fitted = pipeline.named_steps["prep"]
    clf_fitted = pipeline.named_steps["clf"]
    X_imp_all = prep_fitted.transform(X_all)
    explainer = shap.TreeExplainer(clf_fitted)
    exp = explainer(X_imp_all)
    sv = np.asarray(exp.values)
    if sv.ndim == 3:  # some shap versions return [samples, features, classes]
        sv = sv[:, :, 1]

    # Availability matters: a slot that only 20% of subjects have (PET) gets its
    # global mean|SHAP| diluted toward zero by all the NaN rows. So report BOTH
    #   overall  = mean |SHAP| across every subject (what the cohort sees), and
    #   when present = mean |SHAP| only where the test was actually measured
    #                (the contribution of the result ITSELF when you have it).
    present_mask = X_all.notna()
    imp_rows = []
    for j, f in enumerate(FEATURES):
        avail = present_mask[f].to_numpy() if f in present_mask.columns else np.zeros(len(X_all), bool)
        n_present = int(avail.sum())
        imp_rows.append(
            {
                "feature": f,
                "stage": STAGE_OF_FEATURE.get(f, 1),
                "mean_abs_shap": float(np.abs(sv[:, j]).mean()),
                "shap_when_present": float(np.abs(sv[avail, j]).mean()) if n_present else float("nan"),
                "n_present": n_present,
                "pct_present": round(100.0 * n_present / len(X_all), 1),
            }
        )
    global_imp = (pd.DataFrame(imp_rows)
                  .sort_values("mean_abs_shap", ascending=False)
                  .reset_index(drop=True))
    print("\n[shap] feature contribution (mean |SHAP|) -- overall vs where measured:")
    print(f"  {'feature':<24}{'stg':>4}{'overall':>10}{'measured':>10}{'n':>7}{'%':>7}")
    for _, row in global_imp.iterrows():
        print(f"  {row['feature']:<24}{int(row['stage']):>4}{row['mean_abs_shap']:>10.4f}"
              f"{row['shap_when_present']:>10.4f}{int(row['n_present']):>7,}{row['pct_present']:>6.1f}%")

    # Stage-level rollup -- the direct answer to "how much does PET add?"
    stage_imp = (global_imp.groupby("stage")
                 .agg(features=("feature", "count"),
                      mean_abs_shap=("mean_abs_shap", "sum"),
                      shap_when_present=("shap_when_present", "sum"))
                 .reset_index()
                 .sort_values("stage"))
    total_overall = float(stage_imp["mean_abs_shap"].sum())
    stage_imp["share_pct"] = 100.0 * stage_imp["mean_abs_shap"] / max(total_overall, 1e-9)
    print("\n[shap] contribution by pipeline stage (summed mean |SHAP|):")
    for _, row in stage_imp.iterrows():
        name = STAGE_NAMES.get(int(row["stage"]), f"stage {int(row['stage'])}")
        print(f"  Stage {int(row['stage'])} {name:<20} {row['mean_abs_shap']:>8.4f}"
              f"  {row['share_pct']:>5.1f}% of total")

    report_lines.extend([
        "",
        "feature contribution (mean |SHAP| over the scored cohort):",
        f"  {'feature':<24}{'stage':>6}{'overall':>10}{'measured':>10}{'n':>8}{'%':>7}",
    ])
    for _, row in global_imp.iterrows():
        report_lines.append(
            f"  {row['feature']:<24}{int(row['stage']):>6}{row['mean_abs_shap']:>10.4f}"
            f"{row['shap_when_present']:>10.4f}{int(row['n_present']):>8,}{row['pct_present']:>6.1f}%"
        )
    report_lines.extend(["", "contribution by pipeline stage:"])
    for _, row in stage_imp.iterrows():
        name = STAGE_NAMES.get(int(row["stage"]), f"stage {int(row['stage'])}")
        report_lines.append(
            f"  Stage {int(row['stage'])} {name:<20} {row['mean_abs_shap']:>8.4f}"
            f"  {row['share_pct']:>5.1f}% of total"
        )
    report_lines.extend([
        "",
        "'overall' is the cohort-wide mean |SHAP|; 'measured' is the mean |SHAP|",
        "only across subjects where that test exists. A slot that is rarely",
        "measured (PET) is diluted in 'overall' by the NaN rows but keeps its true",
        "per-result contribution in 'measured' -- this is how a partially-observed",
        "cohort is reported honestly rather than as a fabricated complete vector.",
    ])

    # ---- Per-subject risk + top factors (dashboard-ready) -------------------
    risk_proba = pipeline.predict_proba(X_all)[:, 1]
    records = []
    id_col = "subject_id" if "subject_id" in feat.columns else None
    for i, (_, row) in enumerate(feat.iterrows()):
        factor_idx = np.argsort(np.abs(sv[i]))[::-1][:4]
        factors = [
            {"feature": FEATURES[j], "value": _num(X_imp_all[i, j]), "contribution": round(float(sv[i, j]), 4)}
            for j in factor_idx
        ]
        if id_col:
            sid = str(row[id_col])
        elif data_mode == "synthetic":
            # synthetic records keep no id column in feat; recover from order
            sid = raw_ids[i]
        else:
            sid = f"SUBJ-{i:04d}"
        records.append(
            {
                "subject_id": sid,
                "age": _num(row["age"], 0),
                "sex": "M" if row["sex"] == 1 else "F",
                "education_years": _num(row["education_years"], 0),
                "mmse": _num(row["mmse"], 1),
                "risk_score": round(float(risk_proba[i]), 4),
                "top_factors": factors,
                "data_mode": data_mode,
            }
        )

    # ---- Export artifacts ---------------------------------------------------
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    PROCESSED.mkdir(parents=True, exist_ok=True)

    joblib.dump(pipeline, ARTIFACTS / "pipeline.joblib")
    joblib.dump(rf_pipe, ARTIFACTS / "rf_pipeline.joblib")
    global_imp.to_csv(ARTIFACTS / "global_importance.csv", index=False)
    stage_imp.to_csv(ARTIFACTS / "stage_importance.csv", index=False)
    (ARTIFACTS / "eval_report.txt").write_text("\n".join(report_lines), encoding="utf-8")

    # risk_scores.json is the one data file this repo COMMITS (deployment seed),
    # so on real ADNI it is written de-identified: subject ID, score and
    # per-feature attributions only. Measured values (age, sex, education, MMSE,
    # ADAS-Cog, FAQ, biomarker readings) stay out -- ADNI is DUA-restricted and
    # per-participant measures must never be published from this repo.
    if data_mode == "adni":
        seed = [
            {
                "subject_id": r["subject_id"],
                "risk_score": r["risk_score"],
                "top_factors": [
                    {"feature": f["feature"], "contribution": f["contribution"]}
                    for f in r["top_factors"]
                ],
                "data_mode": "adni",
            }
            for r in records
        ]
        (PROCESSED / "risk_scores.json").write_text(json.dumps(seed, indent=2), encoding="utf-8")
    else:
        (PROCESSED / "risk_scores.json").write_text(json.dumps(records, indent=2), encoding="utf-8")

    meta = {
        "model_type": model_type,
        "data_mode": data_mode,
        "data_source": src,
        "features": FEATURES,
        "trained_at": datetime.now().isoformat(timespec="seconds"),
        "thresholds": {"high": HIGH, "medium": MEDIUM},
        "cv_auc_mean": round(float(cv.mean()), 4),
        "cv_auc_std": round(float(cv.std()), 4),
        "test_auc": round(float(test_auc), 4),
        "test_accuracy": round(float(test_acc), 4),
        "rf_fallback_test_auc": round(float(rf_auc), 4),
        "baseline_accuracy": round(float(dummy_acc), 4),
        "n_train": n_train,
        "n_scored": n_scored,
        # the served pipeline's feature contract, stage-tagged for the UI/docs
        "feature_stages": {f: STAGE_OF_FEATURE.get(f, 1) for f in FEATURES},
        "stage_importance": {
            str(int(r["stage"])): {
                "name": STAGE_NAMES.get(int(r["stage"]), f"stage {int(r['stage'])}"),
                "mean_abs_shap": round(float(r["mean_abs_shap"]), 4),
                "share_pct": round(float(r["share_pct"]), 2),
            }
            for _, r in stage_imp.iterrows()
        },
        "feature_coverage": {
            str(r["feature"]): round(float(r["pct_present"]), 1) for _, r in global_imp.iterrows()
        },
    }
    (ARTIFACTS / "model_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    high = sum(1 for r in records if r["risk_score"] > HIGH)
    medium = sum(1 for r in records if MEDIUM <= r["risk_score"] <= HIGH)
    low = sum(1 for r in records if r["risk_score"] < MEDIUM)
    print(f"\n[summary] risk tiers: High >{HIGH}: {high} · Medium: {medium} · Low <{MEDIUM}: {low}")
    print("[done] wrote:")
    for p in (ARTIFACTS / "pipeline.joblib", ARTIFACTS / "rf_pipeline.joblib",
              ARTIFACTS / "model_meta.json", ARTIFACTS / "eval_report.txt",
              ARTIFACTS / "global_importance.csv", ARTIFACTS / "stage_importance.csv",
              PROCESSED / "risk_scores.json"):
        print(f"  {p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
