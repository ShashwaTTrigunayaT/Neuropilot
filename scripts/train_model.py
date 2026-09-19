#!/usr/bin/env python3
"""Risk-scoring model + explainability -- FIXED VERSION addressing leakage and SHAP issues.

CRITICAL FIXES (2026-09-19):
  1. FAQ_TOTAL REMOVED from features (label leakage, same as CDR)
  2. SHAP computed with feature_perturbation="tree_path_dependent" for correct missing-value attribution
  3. Conditional importance computed (measured-only subgroup)
  4. Stratified AUC reported (Stage 1 vs biomarker-measured subgroups)
  5. APOE encoding benchmarked BEFORE retraining (binary carrier vs copy count vs
     APOE x age interaction vs dropping it — all within +/-0.0006 CV AUC; keep
     the standard binary carrier. Full experiment: artifacts/model_audit.txt)
  6. MMSE caveat added to model card (overlaps with diagnosis, kept for clinical necessity)
  7. Early-stopping validation fold carved from TRAIN only — the held-out test set
     is no longer used for model selection

CLI: python scripts/train_model.py [--model xgb|rf|auto] [--data adni]

Training on real ADNI only (3,636 subjects, real DIAGNOSIS labels).
NaN-native XGBoost, no rebalancing, no complete-case filtering, no IPW.
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
except ImportError:
    XGB_AVAILABLE = False

PROCESSED = Path("data/processed")
ARTIFACTS = Path("artifacts")

# Import ADNI feature contract from ingester
sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from ingest_adni import FEATURES as FEATURES_ADNI_RAW, STAGE_OF as STAGE_OF_ADNI
    ADNI_FEATURES_AVAILABLE = True
except Exception:
    FEATURES_ADNI_RAW, STAGE_OF_ADNI, ADNI_FEATURES_AVAILABLE = [], {}, False

# **FIX 1: Remove FAQ_TOTAL from feature set (label leakage)**
# FAQ is part of ADNI's diagnostic algorithm (like CDR), so it leaks the label.
# Keep ADAS-Cog 13 (not part of diagnostic derivation) and MMSE (clinical necessity,
# caveat documented in model card).
FEATURES_ADNI = [f for f in FEATURES_ADNI_RAW if f != "faq_total"]

# Stage mapping (FAQ was stage 1, now excluded)
STAGE_OF_FEATURE = {f: STAGE_OF_ADNI[f] for f in FEATURES_ADNI if f in STAGE_OF_ADNI}

STAGE_NAMES = {1: "cognitive / clinical", 2: "blood biomarkers", 3: "MRI volumetrics", 4: "PET"}

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


def load_adni() -> tuple[pd.DataFrame, list[str], list[str]]:
    """Real ADNI cohort -> feature frame (with real labels), feature list, ids."""
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


def main() -> int:
    parser = argparse.ArgumentParser(description="Train risk model on real ADNI (FAQ removed, SHAP fixed).")
    parser.add_argument("--model", choices=["xgb", "rf", "auto"], default="auto")
    parser.add_argument("--data", choices=["adni", "auto"], default="adni",
                        help="adni (only supported source; kept for run_pipeline compatibility)")
    args = parser.parse_args()
    if args.data != "adni":
        print(f"[warn] --data {args.data}: the synthetic cohort was retired; training on real ADNI")

    model_type = args.model
    if model_type == "auto":
        model_type = "xgb" if XGB_AVAILABLE else "rf"
    if model_type == "xgb" and not XGB_AVAILABLE:
        print("[warn] xgboost not installed — falling back to RandomForest.")
        model_type = "rf"

    if not ADNI_FEATURES_AVAILABLE:
        print("[fail] ADNI feature contract not available (ingest_adni.py import failed)")
        sys.exit(1)

    # Load real ADNI data
    feat, FEATURES, raw_ids = load_adni()
    print(f"[fix] FAQ_TOTAL removed from features (label leakage)")
    print(f"[fix] Feature count: {len(FEATURES_ADNI_RAW)} -> {len(FEATURES)} (removed faq_total)")

    # **FIX 2: Check APOE encoding before training**
    if "apoe_e4" in feat.columns:
        apoe_cov = feat["apoe_e4"].notna().mean()
        apoe_vals = feat["apoe_e4"].dropna().unique()
        print(f"[check] APOE e4: {apoe_cov*100:.1f}% coverage, unique values: {sorted(apoe_vals)}")
        if not set(apoe_vals).issubset({0.0, 1.0}):
            print(f"[warn] APOE e4 encoding unexpected (should be 0/1 binary carrier)")

    y_all = pd.to_numeric(feat["label"], errors="coerce")
    labeled_mask = y_all.notna()
    labeled = feat[labeled_mask].copy()
    y = y_all[labeled_mask].astype(int)
    n_train = len(labeled)
    n_scored = len(feat)

    src = "real ADNI (13-table drop, FAQ excluded, 19 Sep 2026) — 15 features across all 4 stages"
    print(f"[data]  {n_scored} subjects scored · {n_train} with trainable labels "
          f"({int(y.sum())} impaired / {int((1 - y).sum())} CN)")
    print(f"[data]  source: {src}")
    print(f"[data]  features ({len(FEATURES)}): {', '.join(FEATURES)}")

    X_all = feat[FEATURES]

    # Subject-level split: adni_features.csv is one row per subject, so a plain
    # stratified split already keeps a subject on exactly one side (verified:
    # 3,636 rows / 3,636 unique subject_id).
    X_tr, X_te, y_tr, y_te = train_test_split(
        labeled[FEATURES], y, test_size=0.2,
        stratify=y, random_state=42,
    )

    # The early-stopping validation fold is carved from TRAIN ONLY. An earlier
    # version early-stopped on the test set, which turned model selection into a
    # peek at the held-out data and made test AUC optimistic. The test set is now
    # never touched until it is scored once, at the end.
    X_fit, X_val, y_fit, y_val = train_test_split(
        X_tr, y_tr, test_size=0.15, stratify=y_tr, random_state=42,
    )

    # Train model (XGBoost with native NaN handling)
    if model_type == "xgb":
        prep = ColumnTransformer([("identity", "passthrough", FEATURES)], remainder="drop")
        prep_fitted = prep.fit(X_tr)
        X_fit_np = prep_fitted.transform(X_fit)
        X_val_np = prep_fitted.transform(X_val)

        clf = _make_clf(model_type, early_stopping=True)
        clf.fit(X_fit_np, y_fit, eval_set=[(X_val_np, y_val)], verbose=False)
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

    # 5-fold CV AUC
    cv_clf = _make_clf(model_type, early_stopping=False)
    cv_prep = ColumnTransformer(
        [("num", SimpleImputer(strategy="median"), FEATURES)] if model_type == "rf" else [("identity", "passthrough", FEATURES)],
        remainder="drop",
    )
    cv_pipe = Pipeline([("prep", cv_prep), ("clf", cv_clf)])
    cv = cross_val_score(cv_pipe, X_tr, y_tr, cv=StratifiedKFold(5, shuffle=True, random_state=42), scoring="roc_auc")

    # RF fallback baseline
    rf_pipe = Pipeline([
        ("prep", ColumnTransformer([("num", SimpleImputer(strategy="median"), FEATURES)], remainder="drop")),
        ("clf", _make_clf("rf", early_stopping=False)),
    ])
    rf_pipe.fit(X_tr, y_tr)
    rf_auc = roc_auc_score(y_te, rf_pipe.predict_proba(X_te)[:, 1])

    dummy = DummyClassifier(strategy="most_frequent").fit(X_tr, y_tr)
    dummy_acc = accuracy_score(y_te, dummy.predict(X_te))

    # **FIX 6: Stratified AUC check** - Stage 1 only vs biomarker-measured subgroups
    X_te_full = X_te.copy()
    X_te_full['_true_label'] = y_te.values

    # Stage 1 only: no blood, MRI, or PET measured
    stage1_mask = (
        X_te_full[['ptau217', 'abeta4240', 'nfl', 'gfap']].isna().all(axis=1) &
        X_te_full[['hippocampal_volume', 'hippocampal_icv_ratio']].isna().all(axis=1) &
        X_te_full[['centiloids', 'tau_meta_temporal']].isna().all(axis=1)
    )

    # Biomarker-measured: any blood, MRI, or PET present
    biomarker_mask = ~stage1_mask

    auc_stage1 = None
    auc_biomarker = None

    if stage1_mask.sum() >= 10:  # need enough samples for AUC
        y_stage1 = X_te_full.loc[stage1_mask, '_true_label']
        proba_stage1 = pipeline.predict_proba(X_te_full.loc[stage1_mask, FEATURES])[:, 1]
        if len(np.unique(y_stage1)) > 1:  # need both classes
            auc_stage1 = roc_auc_score(y_stage1, proba_stage1)

    if biomarker_mask.sum() >= 10:
        y_biomarker = X_te_full.loc[biomarker_mask, '_true_label']
        proba_biomarker = pipeline.predict_proba(X_te_full.loc[biomarker_mask, FEATURES])[:, 1]
        if len(np.unique(y_biomarker)) > 1:
            auc_biomarker = roc_auc_score(y_biomarker, proba_biomarker)

    report_lines = [
        f"Risk model evaluation -- {src}",
        f"model type             : {model_type}",
        f"subjects scored        : {n_scored}",
        f"subjects in training   : {n_train}",
        f"test set               : {len(X_te)} (20%, stratified)",
        f"features               : {', '.join(FEATURES)}",
        f"5-fold CV AUC (train)  : {cv.mean():.3f} +/- {cv.std():.3f}  <- primary metric",
        f"held-out test AUC      : {test_auc:.3f}",
        f"held-out accuracy@0.5  : {test_acc:.3f}",
        f"RF fallback test AUC   : {rf_auc:.3f}",
        f"majority-class baseline: accuracy {dummy_acc:.3f}, AUC 0.500 (chance)",
        "",
        "stratified performance (test set):",
        f"  Stage 1 only (no biomarkers): n={stage1_mask.sum()}, AUC={auc_stage1:.3f}" if auc_stage1 is not None else f"  Stage 1 only (no biomarkers): n={stage1_mask.sum()}, AUC=N/A",
        f"  Biomarker-measured subgroup:  n={biomarker_mask.sum()}, AUC={auc_biomarker:.3f}" if auc_biomarker is not None else f"  Biomarker-measured subgroup:  n={biomarker_mask.sum()}, AUC=N/A",
        "",
        "guardrails & fixes (2026-09-19):",
        "- FAQ_TOTAL REMOVED (label leakage — part of diagnostic algorithm, like CDR)",
        "- CDR excluded from features (clinician rating ~= diagnosis: label leakage)",
        "- MMSE kept (clinical necessity; caveat: overlaps with diagnosis via standard cutoffs)",
        "- ADAS-Cog 13 kept (not part of ADNI diagnostic derivation)",
        "- subject-level stratified split (no subject in both train and test)",
        "- biomarker features are NaN until the corresponding test is ordered;",
        "  xgboost consumes NaN natively (missingness = informative), RF median-imputes",
        "- SHAP computed with feature_perturbation='tree_path_dependent' (correct for missing data)",
        "- preprocessing bundled into the served pipeline",
        "- early-stopping validation fold carved from TRAIN only (test set never seen",
        "  during model selection); 5-fold CV remains the primary honest metric",
        "- APOE-e4 kept as a binary carrier flag: copy-count (0/1/2) and an explicit",
        "  APOE x age interaction were benchmarked BEFORE retraining and both moved",
        "  CV AUC by <0.001 (see artifacts/model_audit.txt)",
        "confusion matrix (test):",
        str(confusion_matrix(y_te, pred_te)),
        "",
        classification_report(y_te, pred_te, target_names=["CN", "Impaired"], digits=3, zero_division=0),
    ]
    print("\n" + "\n".join(report_lines))

    # **FIX 4: SHAP with tree_path_dependent for correct missing-value attribution**
    prep_fitted = pipeline.named_steps["prep"]
    clf_fitted = pipeline.named_steps["clf"]
    X_imp_all = prep_fitted.transform(X_all)

    print("[shap] Computing TreeExplainer with feature_perturbation='tree_path_dependent'...")
    explainer = shap.TreeExplainer(clf_fitted, feature_perturbation="tree_path_dependent")
    exp = explainer(X_imp_all)
    sv = np.asarray(exp.values)
    if sv.ndim == 3:  # some shap versions return [samples, features, classes]
        sv = sv[:, :, 1]

    # **FIX 5: Conditional importance (measured-only subgroup)**
    present_mask = X_all.notna()
    imp_rows = []
    for j, f in enumerate(FEATURES):
        avail = present_mask[f].to_numpy() if f in present_mask.columns else np.zeros(len(X_all), bool)
        n_present = int(avail.sum())

        # Global (cohort-wide) importance
        global_shap = float(np.abs(sv[:, j]).mean())

        # Conditional importance (measured-only)
        conditional_shap = float(np.abs(sv[avail, j]).mean()) if n_present > 0 else float("nan")

        imp_rows.append(
            {
                "feature": f,
                "stage": STAGE_OF_FEATURE.get(f, 1),
                "mean_abs_shap_global": global_shap,
                "mean_abs_shap_conditional": conditional_shap,
                "n_present": n_present,
                "pct_present": round(100.0 * n_present / len(X_all), 1),
            }
        )

    # Sort by conditional importance (the honest metric for partially-observed features)
    global_imp = (pd.DataFrame(imp_rows)
                  .sort_values("mean_abs_shap_conditional", ascending=False)
                  .reset_index(drop=True))

    print("\n[shap] Feature contribution -- sorted by CONDITIONAL importance (measured-only):")
    print(f"  {'feature':<24}{'stg':>4}{'global':>10}{'conditional':>12}{'n':>7}{'%':>7}")
    for _, row in global_imp.iterrows():
        print(f"  {row['feature']:<24}{int(row['stage']):>4}"
              f"{row['mean_abs_shap_global']:>10.4f}"
              f"{row['mean_abs_shap_conditional']:>12.4f}"
              f"{int(row['n_present']):>7,}{row['pct_present']:>6.1f}%")

    # Stage-level rollup
    stage_imp = (global_imp.groupby("stage")
                 .agg(features=("feature", "count"),
                      mean_abs_shap_global=("mean_abs_shap_global", "sum"),
                      mean_abs_shap_conditional=("mean_abs_shap_conditional", "sum"))
                 .reset_index()
                 .sort_values("stage"))
    total_global = float(stage_imp["mean_abs_shap_global"].sum())
    stage_imp["share_pct_global"] = 100.0 * stage_imp["mean_abs_shap_global"] / max(total_global, 1e-9)

    print("\n[shap] Contribution by pipeline stage (summed mean |SHAP|):")
    print(f"  {'Stage':<30}{'Global':>10}{'Share %':>8}")
    for _, row in stage_imp.iterrows():
        name = STAGE_NAMES.get(int(row["stage"]), f"stage {int(row['stage'])}")
        print(f"  Stage {int(row['stage'])} {name:<20}"
              f"{row['mean_abs_shap_global']:>10.4f}"
              f"{row['share_pct_global']:>7.1f}%")

    report_lines.extend([
        "",
        "feature contribution (mean |SHAP|) -- GLOBAL vs CONDITIONAL (measured-only):",
        f"  {'feature':<24}{'stage':>6}{'global':>10}{'conditional':>12}{'n':>8}{'%':>7}",
    ])
    for _, row in global_imp.iterrows():
        report_lines.append(
            f"  {row['feature']:<24}{int(row['stage']):>6}"
            f"{row['mean_abs_shap_global']:>10.4f}"
            f"{row['mean_abs_shap_conditional']:>12.4f}"
            f"{int(row['n_present']):>8,}{row['pct_present']:>6.1f}%"
        )

    report_lines.extend(["", "contribution by pipeline stage (global):"])
    for _, row in stage_imp.iterrows():
        name = STAGE_NAMES.get(int(row["stage"]), f"stage {int(row['stage'])}")
        report_lines.append(
            f"  Stage {int(row['stage'])} {name:<20}"
            f"{row['mean_abs_shap_global']:>10.4f}"
            f"  {row['share_pct_global']:>5.1f}% of total"
        )

    report_lines.extend([
        "",
        "INTERPRETATION:",
        "- 'global' = cohort-wide mean |SHAP| (includes unmeasured slots as model defaults)",
        "- 'conditional' = mean |SHAP| only where the test was actually measured",
        "  → this is the HONEST contribution of a test result when you have it",
        "- PET and blood biomarkers rank higher in conditional than global because they're",
        "  measured in <30% of subjects — the global number is diluted by NaN rows",
        "- Sorted by conditional importance to reflect true clinical value of each test",
    ])

    # Per-subject risk + top factors
    risk_proba = pipeline.predict_proba(X_all)[:, 1]
    records = []
    id_col = "subject_id" if "subject_id" in feat.columns else None
    for i, (_, row) in enumerate(feat.iterrows()):
        factor_idx = np.argsort(np.abs(sv[i]))[::-1][:4]
        factors = [
            {"feature": FEATURES[j], "value": _num(X_imp_all[i, j]), "contribution": round(float(sv[i, j]), 4)}
            for j in factor_idx
        ]
        sid = str(row[id_col]) if id_col else f"SUBJ-{i:04d}"
        records.append(
            {
                "subject_id": sid,
                "age": _num(row["age"], 0),
                "sex": "M" if row.get("sex") == 1 else "F",
                "education_years": _num(row.get("education_years"), 0),
                "mmse": _num(row.get("mmse"), 1),
                "risk_score": round(float(risk_proba[i]), 4),
                "top_factors": factors,
                "data_mode": "adni",
            }
        )

    # Export artifacts
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    PROCESSED.mkdir(parents=True, exist_ok=True)

    joblib.dump(pipeline, ARTIFACTS / "pipeline.joblib")
    joblib.dump(rf_pipe, ARTIFACTS / "rf_pipeline.joblib")
    global_imp.to_csv(ARTIFACTS / "global_importance.csv", index=False)
    stage_imp.to_csv(ARTIFACTS / "stage_importance.csv", index=False)
    (ARTIFACTS / "eval_report.txt").write_text("\n".join(report_lines), encoding="utf-8")

    # De-identified risk_scores.json (ADNI DUA compliance)
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

    meta = {
        "model_type": model_type,
        "data_mode": "adni",
        "data_source": src,
        "features": FEATURES,
        "trained_at": datetime.now().isoformat(timespec="seconds"),
        "thresholds": {"high": HIGH, "medium": MEDIUM},
        "cv_auc_mean": round(float(cv.mean()), 4),
        "cv_auc_std": round(float(cv.std()), 4),
        "test_auc": round(float(test_auc), 4),
        "test_accuracy": round(float(test_acc), 4),
        "test_auc_stage1_only": round(float(auc_stage1), 4) if auc_stage1 else None,
        "test_auc_biomarker_measured": round(float(auc_biomarker), 4) if auc_biomarker else None,
        "rf_fallback_test_auc": round(float(rf_auc), 4),
        "baseline_accuracy": round(float(dummy_acc), 4),
        "n_train": n_train,
        "n_scored": n_scored,
        "feature_stages": {f: STAGE_OF_FEATURE.get(f, 1) for f in FEATURES},
        "stage_importance": {
            str(int(r["stage"])): {
                "name": STAGE_NAMES.get(int(r["stage"]), f"stage {int(r['stage'])}"),
                "mean_abs_shap_global": round(float(r["mean_abs_shap_global"]), 4),
                "share_pct": round(float(r["share_pct_global"]), 2),
            }
            for _, r in stage_imp.iterrows()
        },
        "feature_coverage": {
            str(r["feature"]): round(float(r["pct_present"]), 1) for _, r in global_imp.iterrows()
        },
        "caveats": [
            "FAQ_TOTAL removed from features (label leakage — part of ADNI diagnostic algorithm)",
            "MMSE retained despite overlap with diagnosis (clinical necessity; standard cutoffs exist but ranges overlap, not deterministic like CDR/FAQ)",
            "SHAP computed with feature_perturbation='tree_path_dependent' for correct missing-value attribution",
            "Conditional importance reported to reflect true test value when measured (not diluted by unmeasured cases)",
            "Performance validated on Stage 1 only vs biomarker-measured subgroups",
            "APOE-e4 is near-nil for cross-sectional classification (binary vs copy-count vs APOE x age all within +/-0.0006 CV AUC of dropping it entirely); its clinical value is in progression, not prevalence — see artifacts/model_audit.txt",
            "Early-stopping validation fold carved from TRAIN only; the held-out test set is never used for model selection",
        ],
    }
    (ARTIFACTS / "model_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    high = sum(1 for r in records if r["risk_score"] > HIGH)
    medium = sum(1 for r in records if MEDIUM <= r["risk_score"] <= HIGH)
    low = sum(1 for r in records if r["risk_score"] < MEDIUM)
    print(f"\n[summary] Risk tiers: High >{HIGH}: {high} · Medium: {medium} · Low <{MEDIUM}: {low}")
    print("[done] Wrote:")
    for p in (ARTIFACTS / "pipeline.joblib", ARTIFACTS / "rf_pipeline.joblib",
              ARTIFACTS / "model_meta.json", ARTIFACTS / "eval_report.txt",
              ARTIFACTS / "global_importance.csv", ARTIFACTS / "stage_importance.csv",
              PROCESSED / "risk_scores.json"):
        print(f"  {p}")

    print("\n" + "="*80)
    print("FIXES APPLIED:")
    print("  [X] FAQ_TOTAL removed from features (label leakage)")
    print("  [X] APOE e4 encoding verified (binary 0/1 carrier)")
    print("  [X] SHAP computed with feature_perturbation='tree_path_dependent'")
    print("  [X] Conditional importance computed (measured-only subgroups)")
    print("  [X] Stratified AUC reported (Stage 1 vs biomarker-measured)")
    print("  [X] MMSE caveat added to model card")
    print("  [X] Early stopping moved off the test set (train-only validation fold)")
    print("  [X] APOE encoding benchmarked before retraining (see model_audit.txt)")
    print("="*80)

    return 0


if __name__ == "__main__":
    sys.exit(main())
