#!/usr/bin/env python3
"""Retrain the risk model with 500 fewer cognition-only subjects.

Hypothesis: The cognition-only subgroup (n=1,055, 68.4% impaired) is biasing
the model toward cognitive features because they're both (1) numerous and
(2) more impaired than the biomarker-measured group (32.7% impaired among
tau-scanned). Removing 500 of them should rebalance toward biomarkers.

Strategy:
  1. Load adni_features.csv (3,636 subjects)
  2. Identify cognition-only subjects (no blood/MRI/PET)
  3. Randomly drop 500 of them
  4. Retrain on the reduced cohort (3,136 subjects)
  5. Compare SHAP importance: does PET rise?

Output: writes a new training run to artifacts_reduced/ so it doesn't overwrite
        the production model.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from train_model import (
    _make_clf, _num,
    FEATURES_ADNI, STAGE_OF_ADNI, STAGE_NAMES,
    HIGH, MEDIUM
)

import joblib
import shap
from sklearn.compose import ColumnTransformer
from sklearn.dummy import DummyClassifier
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, roc_auc_score
from sklearn.model_selection import StratifiedKFold, cross_val_score, train_test_split
from sklearn.pipeline import Pipeline

PROCESSED = Path("data/processed")
ARTIFACTS_REDUCED = Path("artifacts_reduced")

def main() -> int:
    parser = argparse.ArgumentParser(description="Retrain with 500 fewer cognition-only subjects")
    parser.add_argument("--drop", type=int, default=500, help="Number of cognition-only subjects to drop")
    parser.add_argument("--seed", type=int, default=42, help="Random seed for subject selection")
    args = parser.parse_args()

    # Load full ADNI feature table
    feat_path = PROCESSED / "adni_features.csv"
    if not feat_path.exists():
        print(f"ERROR: {feat_path} not found. Run scripts/ingest_adni.py first.")
        return 1

    feat = pd.read_csv(feat_path)
    n_original = len(feat)

    # Identify cognition-only subjects (no blood, MRI, or PET measured)
    blood_cols = [c for c in ['ptau217','abeta4240','nfl','gfap'] if c in feat.columns]
    mri_cols = [c for c in ['hippocampal_volume','hippocampal_icv_ratio'] if c in feat.columns]
    pet_cols = [c for c in ['centiloids','tau_meta_temporal'] if c in feat.columns]

    has_blood = feat[blood_cols].notna().any(axis=1) if blood_cols else pd.Series(False, index=feat.index)
    has_mri = feat[mri_cols].notna().any(axis=1) if mri_cols else pd.Series(False, index=feat.index)
    has_pet = feat[pet_cols].notna().any(axis=1) if pet_cols else pd.Series(False, index=feat.index)

    cog_only_mask = ~has_blood & ~has_mri & ~has_pet
    n_cog_only = int(cog_only_mask.sum())
    cog_only_ids = feat.loc[cog_only_mask, 'subject_id'].tolist()

    print(f"[data] Full ADNI cohort: {n_original} subjects")
    print(f"[data] Cognition-only subjects: {n_cog_only} ({100*n_cog_only/n_original:.1f}%)")
    print(f"[data]   Impaired rate among them: {feat.loc[cog_only_mask, 'label'].mean():.3f}")
    print(f"[data]   Impaired rate among biomarker-measured: {feat.loc[~cog_only_mask, 'label'].mean():.3f}")

    if args.drop > n_cog_only:
        print(f"[warn] Cannot drop {args.drop} subjects (only {n_cog_only} cognition-only exist)")
        args.drop = n_cog_only

    # Randomly select subjects to drop
    random.seed(args.seed)
    drop_ids = set(random.sample(cog_only_ids, args.drop))

    # Create reduced dataset
    feat_reduced = feat[~feat['subject_id'].isin(drop_ids)].copy().reset_index(drop=True)
    n_reduced = len(feat_reduced)

    print(f"[data] Dropping {args.drop} cognition-only subjects (seed={args.seed})")
    print(f"[data] Reduced cohort: {n_reduced} subjects")
    print(f"[data]   Remaining cognition-only: {int((~has_blood & ~has_mri & ~has_pet).sum()) - args.drop}")

    # Check label distribution
    y_all = pd.to_numeric(feat_reduced["label"], errors="coerce")
    labeled_mask = y_all.notna()
    y = y_all[labeled_mask].astype(int)
    labeled = feat_reduced[labeled_mask].copy()
    n_train = len(labeled)

    print(f"[data] Training subjects: {n_train} ({int(y.sum())} impaired / {int((1-y).sum())} CN)")

    # Use the same 15 features (FAQ already removed)
    FEATURES = [f for f in FEATURES_ADNI if f != "faq_total"]
    print(f"[data] Features: {len(FEATURES)}")

    X_all = feat_reduced[FEATURES]
    X_tr, X_te, y_tr, y_te = train_test_split(
        labeled[FEATURES], y, test_size=0.2,
        stratify=y, random_state=42,
    )

    # Train XGBoost
    prep = ColumnTransformer([("identity", "passthrough", FEATURES)], remainder="drop")
    prep_fitted = prep.fit(X_tr)
    X_tr_np = prep_fitted.transform(X_tr)
    X_te_np = prep_fitted.transform(X_te)

    clf = _make_clf("xgb", early_stopping=True)
    clf.fit(X_tr_np, y_tr, eval_set=[(X_te_np, y_te)], verbose=False)

    pipeline = Pipeline([("prep", prep_fitted), ("clf", clf)])
    proba_te = pipeline.predict_proba(X_te)[:, 1]
    pred_te = (proba_te >= 0.5).astype(int)
    test_auc = roc_auc_score(y_te, proba_te)
    test_acc = accuracy_score(y_te, pred_te)

    # 5-fold CV
    cv_clf = _make_clf("xgb", early_stopping=False)
    cv_prep = ColumnTransformer([("identity", "passthrough", FEATURES)], remainder="drop")
    cv_pipe = Pipeline([("prep", cv_prep), ("clf", cv_clf)])
    cv = cross_val_score(cv_pipe, X_tr, y_tr, cv=StratifiedKFold(5, shuffle=True, random_state=42), scoring="roc_auc")

    dummy = DummyClassifier(strategy="most_frequent").fit(X_tr, y_tr)
    dummy_acc = accuracy_score(y_te, dummy.predict(X_te))

    print(f"\n[results] CV AUC: {cv.mean():.3f} ± {cv.std():.3f}")
    print(f"[results] Test AUC: {test_auc:.3f}")
    print(f"[results] Test accuracy: {test_acc:.3f}")
    print(f"[results] Baseline: {dummy_acc:.3f}")

    # SHAP with tree_path_dependent
    print("\n[shap] Computing conditional importance...")
    X_imp_all = prep_fitted.transform(X_all)
    explainer = shap.TreeExplainer(clf, feature_perturbation="tree_path_dependent")
    exp = explainer(X_imp_all)
    sv = np.asarray(exp.values)
    if sv.ndim == 3:
        sv = sv[:, :, 1]

    # Conditional importance
    present_mask = X_all.notna()
    imp_rows = []
    for j, f in enumerate(FEATURES):
        avail = present_mask[f].to_numpy() if f in present_mask.columns else np.zeros(len(X_all), bool)
        n_present = int(avail.sum())
        global_shap = float(np.abs(sv[:, j]).mean())
        conditional_shap = float(np.abs(sv[avail, j]).mean()) if n_present > 0 else float("nan")

        imp_rows.append({
            "feature": f,
            "stage": STAGE_OF_ADNI.get(f, 0),
            "mean_abs_shap_global": global_shap,
            "mean_abs_shap_conditional": conditional_shap,
            "n_present": n_present,
            "pct_present": round(100.0 * n_present / len(X_all), 1),
        })

    imp_df = pd.DataFrame(imp_rows).sort_values("mean_abs_shap_conditional", ascending=False)

    print("\n[shap] Conditional importance (top 10):")
    print(f"  {'feature':<24}{'conditional':>12}{'global':>10}{'%':>7}")
    for _, row in imp_df.head(10).iterrows():
        print(f"  {row['feature']:<24}{row['mean_abs_shap_conditional']:>12.4f}"
              f"{row['mean_abs_shap_global']:>10.4f}{row['pct_present']:>6.1f}%")

    # Stage rollup
    stage_imp = imp_df.groupby("stage").agg(
        features=("feature", "count"),
        global_shap=("mean_abs_shap_global", "sum")
    ).reset_index().sort_values("stage")
    total = stage_imp["global_shap"].sum()
    stage_imp["share_pct"] = 100.0 * stage_imp["global_shap"] / max(total, 1e-9)

    print("\n[shap] Stage contribution:")
    for _, row in stage_imp.iterrows():
        stage_name = STAGE_NAMES.get(int(row["stage"]), f"stage {int(row['stage'])}")
        print(f"  Stage {int(row['stage'])} {stage_name:<20} {row['share_pct']:>6.1f}%")

    # Export
    ARTIFACTS_REDUCED.mkdir(exist_ok=True)
    joblib.dump(pipeline, ARTIFACTS_REDUCED / "pipeline.joblib")
    imp_df.to_csv(ARTIFACTS_REDUCED / "global_importance.csv", index=False)
    stage_imp.to_csv(ARTIFACTS_REDUCED / "stage_importance.csv", index=False)

    meta = {
        "experiment": "reduced_cognition_only",
        "n_original": n_original,
        "n_dropped": args.drop,
        "n_trained": n_train,
        "n_reduced": n_reduced,
        "features": FEATURES,
        "cv_auc_mean": round(float(cv.mean()), 4),
        "cv_auc_std": round(float(cv.std()), 4),
        "test_auc": round(float(test_auc), 4),
        "test_accuracy": round(float(test_acc), 4),
        "comparison_to_full_model": {
            "full_cv_auc": 0.9013,
            "reduced_cv_auc": round(float(cv.mean()), 4),
            "delta": round(float(cv.mean()) - 0.9013, 4),
        }
    }
    (ARTIFACTS_REDUCED / "model_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    report = [
        f"Reduced-cohort experiment: drop {args.drop} cognition-only subjects",
        f"Original cohort: {n_original} subjects",
        f"Reduced cohort: {n_reduced} subjects (-{args.drop})",
        f"Training set: {n_train} subjects",
        "",
        f"CV AUC: {cv.mean():.3f} ± {cv.std():.3f}",
        f"Test AUC: {test_auc:.3f}",
        f"Full model CV AUC: 0.9013 ± 0.0107",
        f"Delta: {cv.mean() - 0.9013:+.4f}",
        "",
        "Conditional importance (sorted):",
        f"  {'feature':<24}{'stage':>6}{'conditional':>12}{'global':>10}{'%':>7}",
    ]
    for _, row in imp_df.iterrows():
        report.append(
            f"  {row['feature']:<24}{int(row['stage']):>6}"
            f"{row['mean_abs_shap_conditional']:>12.4f}"
            f"{row['mean_abs_shap_global']:>10.4f}{row['pct_present']:>6.1f}%"
        )

    (ARTIFACTS_REDUCED / "experiment_report.txt").write_text("\n".join(report), encoding="utf-8")

    print(f"\n[done] Wrote to artifacts_reduced/")
    print(f"  pipeline.joblib, global_importance.csv, stage_importance.csv")
    print(f"  model_meta.json, experiment_report.txt")

    return 0


if __name__ == "__main__":
    sys.exit(main())
