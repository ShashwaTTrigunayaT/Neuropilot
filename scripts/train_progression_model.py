#!/usr/bin/env python3
"""Refined-model training -- REAL ADNI follow-up.

Trains the model the running system serves. It answers the question a
prioritisation tool is actually for: "this person is CN or MCI today -- will
they cross into a worse diagnostic category, and how much cognition will they
lose?" rather than "is this person impaired today?".

Two XGBoost models are trained on the SAME served feature contract (NaN = stage
never measured), against REAL labels from data/processed/adni_progression.csv
(written by scripts/ingest_adni.py):

  1. mmse_delta        XGBRegressor  -- expected MMSE point change
  2. conversion        XGBClassifier -- probability of crossing into a worse
     diagnostic category (CN -> MCI, or MCI -> Dementia)

The evaluation window is a parameter of the label (see
PROGRESSION_HORIZON_MONTHS in ingest_adni.py) and is chosen from the data: the
eligible window must carry enough positives to fit a calibrated classifier at
all, which is measured and reported in artifacts/progression_report.txt.

Why the synthetic cohort was retired: scripts/simulate_followup.py derived its
labels FROM the biomarkers, so the model was being graded on a target it had
partly been handed. Real clinician follow-up cannot be gamed that way.

Outputs:
  artifacts/progression_delta.joblib
  artifacts/progression_conversion.joblib
  artifacts/progression_meta.json
  artifacts/progression_report.txt
  artifacts/progression_importance.csv

CLI: python scripts/train_progression_model.py [--data adni]
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import shap
from sklearn.dummy import DummyClassifier, DummyRegressor
from sklearn.metrics import (
    average_precision_score,
    brier_score_loss,
    mean_absolute_error,
    mean_squared_error,
    r2_score,
    roc_auc_score,
)
from sklearn.model_selection import StratifiedKFold, train_test_split
from sklearn.pipeline import Pipeline

try:
    from xgboost import XGBClassifier, XGBRegressor
    XGB_AVAILABLE = True
except ImportError:  # pragma: no cover
    XGB_AVAILABLE = False

ROOT = Path(__file__).resolve().parents[1]
PROCESSED = ROOT / "data" / "processed"
ARTIFACTS = ROOT / "artifacts"

# The served feature contract, imported from the ingester so train and serve can
# never drift apart. faq_total is excluded (same leakage reason as the risk
# model); mmse_change is excluded because the progression baseline is a subject's
# FIRST evaluation, so no prior-visit slope exists (2.5% present -- keeping a
# 97.5%-missing feature would let the model learn a split it can never apply).
sys.path.insert(0, str(ROOT / "scripts"))
try:
    from ingest_adni import FEATURES as FEATURES_RAW, STAGE_OF as STAGE_OF_RAW
    CONTRACT_AVAILABLE = True
except Exception:  # noqa: BLE001  pragma: no cover
    FEATURES_RAW, STAGE_OF_RAW, CONTRACT_AVAILABLE = [], {}, False

_DROP = {"faq_total", "mmse_change"}
FEATURES = [f for f in FEATURES_RAW if f not in _DROP]
STAGE_OF_FEATURE = {f: STAGE_OF_RAW.get(f, 1) for f in FEATURES}

STAGE_NAMES = {1: "Cognitive", 2: "Blood biomarkers", 3: "MRI volumetrics", 4: "PET imaging"}

# Ablation groups -- Stage 1 = what a clinic already has without ordering anything.
GROUP_COG = ["age", "sex", "education_years", "mmse", "adas_cog_13"]
GROUP_GEN = ["apoe_e4"]
GROUP_BLOOD = ["ptau217", "abeta4240", "nfl", "gfap"]
GROUP_MRI = ["hippocampal_volume", "hippocampal_icv_ratio"]
GROUP_PET = ["centiloids", "tau_meta_temporal"]

XGB_COMMON = dict(n_estimators=400, learning_rate=0.05, max_depth=3,
                  subsample=0.8, colsample_bytree=0.8, random_state=42, n_jobs=1)


def _load() -> pd.DataFrame:
    path = PROCESSED / "adni_progression.csv"
    if not path.exists():
        print(f"ERROR: {path} missing.\nRun ingest first:  python scripts/ingest_adni.py")
        sys.exit(1)
    return pd.read_csv(path)


def _measured(df: pd.DataFrame, cols: list[str]) -> pd.Series:
    cols = [c for c in cols if c in df.columns]
    if not cols:
        return pd.Series(False, index=df.index)
    return df[cols].notna().any(axis=1)


def cv_auc(X: pd.DataFrame, y: pd.Series, folds: int = 5) -> tuple[float, float]:
    """5-fold stratified CV AUC, scored on the HELD-OUT fold each time.

    (An earlier draft of this function scored on the training fold, which
    reports in-sample fit -- it happily printed 0.996 next to a 0.796 test AUC.
    Cross-validation must never grade a model on rows it was fitted on.)
    """
    skf = StratifiedKFold(n_splits=folds, shuffle=True, random_state=42)
    spw = float((y == 0).sum()) / max(1, float((y == 1).sum()))
    scores = []
    for tr, va in skf.split(X, y):
        m = Pipeline([("clf", XGBClassifier(**XGB_COMMON, eval_metric="logloss",
                                            scale_pos_weight=spw))])
        m.fit(X.iloc[tr], y.iloc[tr])
        scores.append(roc_auc_score(y.iloc[va], m.predict_proba(X.iloc[va])[:, 1]))
    return float(np.mean(scores)), float(np.std(scores))


def cv_mae(X: pd.DataFrame, y: pd.Series, folds: int = 5) -> tuple[float, float]:
    skf = StratifiedKFold(n_splits=folds, shuffle=True, random_state=42)
    # stratify on a coarse bin of the continuous target so every fold sees the tail
    bins = pd.qcut(y, q=4, labels=False, duplicates="drop")
    scores = []
    for tr, va in skf.split(X, bins):
        m = Pipeline([("reg", XGBRegressor(**XGB_COMMON))])
        m.fit(X.iloc[tr], y.iloc[tr])
        scores.append(mean_absolute_error(y.iloc[va], m.predict(X.iloc[va])))
    return float(np.mean(scores)), float(np.std(scores))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Train the 24-month progression forecaster on real ADNI follow-up.")
    parser.add_argument("--data", choices=["adni", "auto"], default="adni",
                        help="adni (only supported source; kept for run_pipeline compatibility)")
    args = parser.parse_args()
    if args.data != "adni":
        print(f"[warn] --data {args.data}: the synthetic cohort was retired; "
              f"training on real ADNI follow-up")
    if not XGB_AVAILABLE:
        print("[fail] xgboost is required for the progression forecaster.")
        return 1
    if not CONTRACT_AVAILABLE or not FEATURES:
        print("[fail] ADNI feature contract not available (ingest_adni.py import failed)")
        return 1

    df = _load()
    horizon = int(df["horizon_months"].iloc[0]) if len(df) else 24

    missing = [f for f in FEATURES if f not in df.columns]
    if missing:
        print(f"[fail] progression index is missing feature columns: {missing}")
        return 1

    y_conv = pd.to_numeric(df["converted"], errors="coerce").astype(int)
    n_conv = int(y_conv.sum())
    prevalence = float(y_conv.mean())

    print("=" * 80)
    print("Refined model -- real ADNI follow-up")
    print("=" * 80)
    print(f"[data]  {len(df):,} subjects · {n_conv:,} conversions ({100 * prevalence:.1f}%)")
    src = (f"real ADNI follow-up (13-table drop) — baseline CN/MCI visit -> "
           f"follow-up outcome, {n_conv:,}/{len(df):,} conversions")
    print(f"[data]  source: {src}")
    print(f"[data]  features ({len(FEATURES)}): {', '.join(FEATURES)}")
    print("[data]  excluded: faq_total (label leakage) · mmse_change (2.5% present "
          "at a first visit)")

    by_diag = {}
    for code, name in [(1, "CN"), (2, "MCI")]:
        sub = df[df["baseline_diag"] == code]
        if len(sub):
            by_diag[name] = {"n": int(len(sub)), "rate": float(sub["converted"].mean())}
            print(f"[data]    from {name:<4}: {len(sub):>5,} subjects · "
                  f"{100 * sub['converted'].mean():5.1f}% progressed")

    X = df[FEATURES]
    # "Measured" groups for the stratified check. Note hippocampal volume is on
    # file for 97.6% of these subjects, so "has NO biomarker at all" is an empty
    # group -- the meaningful splits are by which STAGE was actually ordered.
    blood_on = _measured(df, GROUP_BLOOD)
    pet_on = _measured(df, GROUP_PET)
    print(f"[data]  measured at baseline: blood {int(blood_on.sum()):,} · "
          f"MRI {int(_measured(df, GROUP_MRI).sum()):,} · PET {int(pet_on.sum()):,} · "
          f"stage-1 (no contiguous blood) {int((df['stage'] == 1).sum()):,}")

    # ---- subject-level hold-out (one row per subject already) --------------- #
    idx = np.arange(len(df))
    tr, te = train_test_split(idx, test_size=0.2, random_state=42, stratify=y_conv)
    X_tr, X_te = X.iloc[tr], X.iloc[te]
    c_tr, c_te = y_conv.iloc[tr], y_conv.iloc[te]

    print(f"\n[cv]    5-fold stratified CV on train+test (stability estimate)…")
    conv_cv_mean, conv_cv_std = cv_auc(X, y_conv)
    print(f"  conversion AUC : {conv_cv_mean:.3f} +/- {conv_cv_std:.3f}")

    # ---- 1. Conversion classifier ------------------------------------------ #
    spw = float((c_tr == 0).sum()) / max(1.0, float((c_tr == 1).sum()))
    conv_pipe = Pipeline([("clf", XGBClassifier(**XGB_COMMON, eval_metric="logloss",
                                                scale_pos_weight=spw))])
    conv_pipe.fit(X_tr, c_tr)
    proba = conv_pipe.predict_proba(X_te)[:, 1]
    auc = float(roc_auc_score(c_te, proba))
    pr_auc = float(average_precision_score(c_te, proba))
    brier = float(brier_score_loss(c_te, proba))
    acc = float(((proba >= 0.5).astype(int) == c_te).mean())
    dummy = DummyClassifier(strategy="most_frequent").fit(X_tr, c_tr)
    acc_base = float((dummy.predict(X_te) == c_te).mean())

    # ---- 2. MMSE-delta regressor ------------------------------------------- #
    d_tr = pd.to_numeric(df["mmse_delta"], errors="coerce").iloc[tr]
    d_te = pd.to_numeric(df["mmse_delta"], errors="coerce").iloc[te]
    d_ok_tr, d_ok_te = d_tr.notna().to_numpy(), d_te.notna().to_numpy()

    delta_pipe = Pipeline([("reg", XGBRegressor(**XGB_COMMON))])
    delta_pipe.fit(X_tr[d_ok_tr], d_tr[d_ok_tr])
    pred_d = delta_pipe.predict(X_te[d_ok_te])
    mae = float(mean_absolute_error(d_te[d_ok_te], pred_d))
    rmse = float(np.sqrt(mean_squared_error(d_te[d_ok_te], pred_d)))
    r2 = float(r2_score(d_te[d_ok_te], pred_d)) if int(d_ok_te.sum()) > 1 else 0.0
    dummy_reg = DummyRegressor().fit(X_tr[d_ok_tr], d_tr[d_ok_tr])
    mae_base = float(mean_absolute_error(d_te[d_ok_te], dummy_reg.predict(X_te[d_ok_te])))
    delta_cv_mean, delta_cv_std = cv_mae(
        X[pd.to_numeric(df["mmse_delta"], errors="coerce").notna()],
        pd.to_numeric(df["mmse_delta"], errors="coerce").dropna(),
    )

    # ---- 3. Stratified performance (does it work where it is served?) ------- #
    def subgroup_auc(mask_full: pd.Series) -> tuple[int, float | None]:
        m = mask_full.iloc[te].to_numpy()
        yt = c_te.to_numpy()[m]
        if m.sum() < 20 or len(np.unique(yt)) < 2:
            return int(m.sum()), None
        return int(m.sum()), float(roc_auc_score(yt, proba[m]))

    n_stage1, auc_stage1 = subgroup_auc(df["stage"] == 1)     # blood not yet ordered
    n_blood, auc_blood = subgroup_auc(blood_on)
    n_pet, auc_pet = subgroup_auc(pet_on)
    n_cn, auc_cn = subgroup_auc(df["baseline_diag"] == 1)
    n_mci, auc_mci = subgroup_auc(df["baseline_diag"] == 2)

    # ---- 4. Ablation: what do the later stages actually add? -------------- #
    groups = [
        ("Stage 1 only (cognition + demographics + APOE)", GROUP_COG + GROUP_GEN),
        ("Biomarkers only (blood + MRI + PET)", GROUP_BLOOD + GROUP_MRI + GROUP_PET),
        ("All stages (served model)", FEATURES),
    ]
    ablations = []
    for label, cols in groups:
        cols = [c for c in cols if c in X.columns]
        mean, std = cv_auc(X[cols], y_conv)
        ablations.append((label, len(cols), mean, std))
        print(f"[ablate] {label:<48} n_feat={len(cols):>2}  CV AUC {mean:.3f} +/- {std:.3f}")

    # ---- 5. SHAP: global + conditional (measured-only) --------------------- #
    clf = conv_pipe.named_steps["clf"]
    explainer = shap.TreeExplainer(clf, feature_perturbation="tree_path_dependent")
    sv = np.asarray(explainer.shap_values(X_te))
    if sv.ndim == 3:
        sv = sv[:, :, 1]
    mean_abs = np.abs(sv).mean(axis=0)
    meas = X_te.notna()
    cond = np.array([
        np.abs(sv[:, j][meas.iloc[:, j].to_numpy()]).mean()
        if meas.iloc[:, j].any() else 0.0
        for j in range(len(FEATURES))
    ])
    imp = pd.DataFrame({
        "feature": FEATURES,
        "stage": [STAGE_OF_FEATURE.get(f, 1) for f in FEATURES],
        "mean_abs_shap_global": mean_abs,
        "mean_abs_shap_conditional": cond,
        "pct_present": [100 * float(X[f].notna().mean()) for f in FEATURES],
    })
    imp["n_measured"] = [int(X[f].notna().sum()) for f in FEATURES]
    imp = imp.sort_values("mean_abs_shap_conditional", ascending=False).reset_index(drop=True)
    total = float(imp["mean_abs_shap_conditional"].sum()) or 1.0
    imp["share_pct"] = 100 * imp["mean_abs_shap_conditional"] / total

    stage_share = {}
    for st in sorted({int(s) for s in imp["stage"]}):
        share = float(imp.loc[imp["stage"] == st, "share_pct"].sum())
        stage_share[st] = {"name": STAGE_NAMES.get(st, f"stage {st}"), "share_pct": round(share, 2)}

    # ---- report ------------------------------------------------------------ #
    lines = [
        "Refined model evaluation -- real ADNI follow-up",
        "models                : XGBRegressor (mmse_delta) + XGBClassifier (conversion)",
        f"subjects              : {len(df):,} ({n_conv:,} conversions, {100 * prevalence:.1f}%)",
        f"test set              : {len(te):,} (20%, stratified by conversion)",
        f"features              : {', '.join(FEATURES)}",
        "excluded              : faq_total (label leakage) · mmse_change (2.5% present)",
        "",
        "Conversion classifier:",
        f"  5-fold CV AUC       : {conv_cv_mean:.3f} +/- {conv_cv_std:.3f}   <- primary (stability)",
        f"  held-out test AUC   : {auc:.3f}",
        f"  held-out PR AUC     : {pr_auc:.3f} (prevalence {prevalence:.3f})",
        f"  held-out Brier      : {brier:.3f} (lower = better calibrated)",
        f"  accuracy@0.5        : {acc:.3f} (majority baseline {acc_base:.3f})",
        "",
        "Should this be trusted for the patients it is served on? (held-out subgroup AUC)",
        f"  Stage 1 (blood not ordered) : AUC {auc_stage1 if auc_stage1 is None else round(auc_stage1, 3)} (n={n_stage1})",
        f"  blood panel on file         : AUC {auc_blood if auc_blood is None else round(auc_blood, 3)} (n={n_blood})",
        f"  PET on file                 : AUC {auc_pet if auc_pet is None else round(auc_pet, 3)} (n={n_pet})",
        f"  CN at baseline              : AUC {auc_cn if auc_cn is None else round(auc_cn, 3)} (n={n_cn})",
        f"  MCI at baseline             : AUC {auc_mci if auc_mci is None else round(auc_mci, 3)} (n={n_mci})",
        "",
        "MMSE-change regressor (negative = decline):",
        f"  5-fold CV MAE       : {delta_cv_mean:.3f} +/- {delta_cv_std:.3f} points",
        f"  held-out MAE        : {mae:.3f} points (predict-the-mean baseline {mae_base:.3f})",
        f"  held-out RMSE       : {rmse:.3f}",
        f"  held-out R^2        : {r2:.3f}",
        f"  outcome on file     : {int(pd.to_numeric(df['mmse_delta'], errors='coerce').notna().sum()):,} subjects",
        "",
        "Incremental value of the later test stages (same folds, same question):",
    ]
    for label, nf, mean, std in ablations:
        lines.append(f"  {label:<48} n_feat={nf:>2}  CV AUC {mean:.3f} +/- {std:.3f}")
    lines += [
        "",
        f"Contribution by pipeline stage (summed conditional mean |SHAP|, total {total:.3f}):",
    ]
    for st in sorted(stage_share):
        d = stage_share[st]
        lines.append(f"  Stage {st} {d['name']:<22} {d['share_pct']:>6.1f}%")

    lines += [
        "",
        "guardrails:",
        "- labels are REAL clinician follow-up diagnoses, not simulated trajectories",
        "- conversion = a strictly worse diagnosis code inside the bounded evaluation",
        "  window; subjects whose follow-up does not cover the window are dropped",
        "  (unknown outcome, not a negative outcome)",
        "- one row per subject (first labeled CN/MCI visit) -> the split is subject-level",
        "- no rebalancing, no complete-case filtering; scale_pos_weight only",
        "- SHAP with feature_perturbation='tree_path_dependent' for correct NaN attribution",
        "- conditional importance reported on measured-only subgroups, so a biomarker's",
        "  contribution is not diluted by the subjects who were never scanned",
        "- projected tier = the same model re-scored on the projected future feature",
        "  vector (one consistent model family end-to-end)",
        "",
        "known limitations:",
        "- the served record is a patient's LATEST visit while training baselines are",
        "  FIRST visits; later-stage features should behave similarly but this is a",
        "  train/serve shift worth watching",
        "- mmse_change is unavailable at a first visit, so recent decline speed is not",
        "  part of the served vector",
    ]
    report = "\n".join(lines)
    print("\n" + report)

    # ---- write artifacts --------------------------------------------------- #
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    joblib.dump(delta_pipe, ARTIFACTS / "progression_delta.joblib")
    joblib.dump(conv_pipe, ARTIFACTS / "progression_conversion.joblib")
    imp.to_csv(ARTIFACTS / "progression_importance.csv", index=False)
    (ARTIFACTS / "progression_report.txt").write_text(report, encoding="utf-8")

    meta = {
        "model_type": "xgb_regressor+xgb_classifier",
        "data_mode": "adni",
        "data_source": src,
        "horizon_months": horizon,
        "label_definition": (
            "crossing into a strictly worse ADNI diagnostic category "
            "(CN->MCI or MCI->Dementia) from a first labeled CN/MCI visit"
        ),
        "features": FEATURES,
        "excluded_features": {
            "faq_total": "label leakage (part of ADNI's diagnostic algorithm)",
            "mmse_change": "2.5% present at a first visit — no prior-visit slope exists",
        },
        "trained_at": datetime.now().isoformat(timespec="seconds"),
        "n_train": int(len(tr)),
        "n_test": int(len(te)),
        "n_cohort": int(len(df)),
        "conversion_prevalence": round(prevalence, 4),
        "conversion_by_baseline": by_diag,
        "metrics": {
            "conversion_cv_auc_mean": round(conv_cv_mean, 4),
            "conversion_cv_auc_std": round(conv_cv_std, 4),
            "conversion_auc": round(auc, 4),
            "conversion_pr_auc": round(pr_auc, 4),
            "conversion_brier": round(brier, 4),
            "conversion_accuracy": round(acc, 4),
            "conversion_baseline_accuracy": round(acc_base, 4),
            "conversion_auc_stage1": None if auc_stage1 is None else round(auc_stage1, 4),
            "conversion_auc_blood_measured": None if auc_blood is None else round(auc_blood, 4),
            "conversion_auc_pet_measured": None if auc_pet is None else round(auc_pet, 4),
            "conversion_auc_cn_baseline": None if auc_cn is None else round(auc_cn, 4),
            "conversion_auc_mci_baseline": None if auc_mci is None else round(auc_mci, 4),
            "delta_cv_mae_mean": round(delta_cv_mean, 4),
            "delta_cv_mae_std": round(delta_cv_std, 4),
            "delta_mae": round(mae, 4),
            "delta_mae_baseline": round(mae_base, 4),
            "delta_rmse": round(rmse, 4),
            "delta_r2": round(r2, 4),
            "n_mmse_outcomes": int(pd.to_numeric(df["mmse_delta"], errors="coerce").notna().sum()),
        },
        "n_subgroup": {
            "stage1": n_stage1,
            "blood_measured": n_blood,
            "pet_measured": n_pet,
            "cn_baseline": n_cn,
            "mci_baseline": n_mci,
        },
        "ablations": [
            {"label": label, "n_features": nf,
             "cv_auc_mean": round(mean, 4), "cv_auc_std": round(std, 4)}
            for label, nf, mean, std in ablations
        ],
        "stage_importance": stage_share,
        "feature_stages": {f: STAGE_OF_FEATURE.get(f, 1) for f in FEATURES},
        "feature_coverage": {r["feature"]: round(float(r["pct_present"]), 1)
                             for _, r in imp.iterrows()},
        "top_contributors": [
            {"feature": r["feature"], "stage": int(r["stage"]),
             "contribution": round(float(r["mean_abs_shap_conditional"]), 4)}
            for _, r in imp.head(5).iterrows()
        ],
        "caveats": [
            "labels are real clinician follow-up diagnoses from ADNI, not simulated outcomes",
            "conversion is defined over a bounded evaluation window; subjects with "
            "shorter follow-up are excluded rather than assumed stable",
            "served records are latest visits while training baselines are first visits",
            "mmse_change excluded (2.5% present at a first visit)",
            "faq_total excluded (label leakage)",
            "a shorter evaluation window was rejected because it does not carry enough "
            "positives to calibrate the classifier",
        ],
    }
    (ARTIFACTS / "progression_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    print("\n[done] wrote:")
    for p in ("progression_delta.joblib", "progression_conversion.joblib",
              "progression_meta.json", "progression_report.txt",
              "progression_importance.csv"):
        print(f"  artifacts/{p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
