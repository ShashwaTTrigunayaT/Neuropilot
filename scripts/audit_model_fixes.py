#!/usr/bin/env python3
"""Pre/post-training audits for the real-ADNI risk model (2026-09-19 review).

Three checks, all written to artifacts/model_audit.txt so a reviewer can re-run
them instead of taking the model card's word for it:

  A. APOE-e4 encoding benchmark -- run BEFORE retraining (the review's point 2).
     Compares, at identical CV folds:
       binary carrier (the current served encoding)  vs
       copy count 0/1/2                              vs
       binary + explicit APOE x age interaction      vs
       copy count + explicit interaction             vs
       dropping APOE entirely
     If none of these move CV AUC beyond noise, the encoding is not the problem --
     APOE is simply a weak *cross-sectional* signal in a cohort whose label IS a
     same-day clinical diagnosis. Its value shows up in progression, not prevalence.

  B. Complete-case cross-check (the review's optional point 7) -- run AFTER
     training. Trains a throwaway model on the stage-complete subset only and
     compares its SHAP ranking against the served model's SHAP on the SAME rows.
     Agreement means the missing-data handling is not fabricating structure the
     complete-case subset does not independently support.

Usage:
    python scripts/audit_model_fixes.py            # both checks
    python scripts/audit_model_fixes.py --skip-apoe
    python scripts/audit_model_fixes.py --skip-completecase
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
PROCESSED = ROOT / "data" / "processed"
ARTIFACTS = ROOT / "artifacts"
ADNI_DIR = ROOT / "ADNI DATA"

sys.path.insert(0, str(ROOT / "scripts"))


def _features() -> list[str]:
    """The served (FAQ-excluded) feature contract, read from model_meta when present."""
    meta_path = ARTIFACTS / "model_meta.json"
    if meta_path.exists():
        try:
            return list(json.loads(meta_path.read_text(encoding="utf-8"))["features"])
        except Exception:
            pass
    from ingest_adni import FEATURES  # noqa: WPS433 (script-local import)
    return [f for f in FEATURES if f != "faq_total"]


def _load() -> tuple[pd.DataFrame, list[str]]:
    feat = pd.read_csv(PROCESSED / "adni_features.csv")
    feats = [f for f in _features() if f in feat.columns]
    # APOE copy count comes straight from the genotype table (not in the feature csv)
    apoe_path = ADNI_DIR / "APOERES_17Sep2026.csv"
    if apoe_path.exists() and "subject_rid" in feat.columns:
        apoe = pd.read_csv(apoe_path, usecols=["RID", "GENOTYPE"], low_memory=False)
        apoe["GENOTYPE"] = apoe["GENOTYPE"].astype("string").str.strip()
        apoe = apoe.drop_duplicates(subset=["RID"], keep="first")
        apoe["apoe_copies"] = apoe["GENOTYPE"].str.count("4").astype(float)
        feat = feat.merge(apoe[["RID", "apoe_copies"]], left_on="subject_rid",
                          right_on="RID", how="left")
    else:
        feat["apoe_copies"] = np.nan
    return feat, feats


def _cv_auc(X: pd.DataFrame, y: pd.Series, folds: int = 5, n_est: int = 300) -> tuple[float, float]:
    from sklearn.model_selection import StratifiedKFold
    from sklearn.metrics import roc_auc_score
    from xgboost import XGBClassifier

    skf = StratifiedKFold(folds, shuffle=True, random_state=42)
    aucs = []
    for tr, te in skf.split(X, y):
        m = XGBClassifier(n_estimators=n_est, learning_rate=0.05, max_depth=3,
                          subsample=0.8, colsample_bytree=0.8,
                          eval_metric="logloss", random_state=42, n_jobs=-1)
        m.fit(X.iloc[tr], y.iloc[tr])
        aucs.append(roc_auc_score(y.iloc[te], m.predict_proba(X.iloc[te])[:, 1]))
    return float(np.mean(aucs)), float(np.std(aucs))


def audit_apoe(feat: pd.DataFrame, feats: list[str], out: list[str]) -> None:
    y = feat["label"].astype(int)
    base = feats
    if "apoe_e4" not in base:
        out.append("A. APOE benchmark -- SKIPPED (apoe_e4 not in feature contract)")
        return

    configs: list[tuple[str, pd.DataFrame]] = []

    x = feat[base].copy()
    configs.append(("binary carrier (served)", x))

    x = feat[base].copy()
    x["apoe_e4"] = feat["apoe_copies"]
    configs.append(("copy count 0/1/2", x))

    x = feat[base].copy()
    x["apoe_x_age"] = feat["apoe_e4"] * feat["age"]
    configs.append(("binary + APOE x age", x))

    x = feat[base].copy()
    x["apoe_e4"] = feat["apoe_copies"]
    x["apoe_x_age"] = feat["apoe_copies"] * feat["age"]
    configs.append(("copies + APOE x age", x))

    x = feat[[f for f in base if f != "apoe_e4"]].copy()
    configs.append(("no APOE at all", x))

    out.append("A. APOE-e4 ENCODING BENCHMARK (identical 5-fold CV folds, 300 trees)")
    out.append(f"   {'encoding':<26}{'CV AUC':>10}{'+/-':>9}   n_feat")
    results: dict[str, float] = {}
    for name, X in configs:
        m, s = _cv_auc(X, y)
        results[name] = m
        out.append(f"   {name:<26}{m:>10.4f}{s:>9.4f}{len(X.columns):>9}")

    spread = max(results.values()) - min(results.values())
    best = max(results, key=results.get)
    served = results.get("binary carrier (served)", float("nan"))
    out.append("")
    out.append(f"   spread across ALL encodings (incl. dropping APOE): {spread:.4f} CV AUC")
    out.append(f"   best config: {best}  |  served (binary carrier): {served:.4f}")
    out.append(f"   coverage of APOE in this cohort: {100 * feat['apoe_e4'].notna().mean():.1f}%")
    if "apoe_copies" in feat.columns:
        dist = feat["apoe_copies"].value_counts(dropna=False).sort_index()
        out.append("   copy-count distribution: " + ", ".join(
            f"{int(k)}={int(v)}" if pd.notna(k) else f"missing={int(v)}" for k, v in dist.items()))
    if spread < 0.003:
        out.append("   VERDICT: encoding is NOT the limiting factor -- every variant (including")
        out.append("            removing APOE) lands within noise. Keep the standard binary")
        out.append("            carrier flag; report APOE as a progression signal, not a")
        out.append("            cross-sectional one. No encoding change made.")
    else:
        out.append(f"   VERDICT: {best} wins by {spread:.4f} CV AUC -- adopt it.")


def audit_completecase(feat: pd.DataFrame, feats: list[str], out: list[str]) -> None:
    pipeline_path = ARTIFACTS / "pipeline.joblib"
    if not pipeline_path.exists():
        out.append("")
        out.append("B. Complete-case cross-check -- SKIPPED (artifacts/pipeline.joblib missing; train first)")
        return

    import joblib
    import shap
    from sklearn.metrics import roc_auc_score
    from xgboost import XGBClassifier

    # Stage-complete subset: every one of the four families actually measured.
    blood = feat["ptau217"].notna()
    mri = feat["hippocampal_volume"].notna()
    pet = feat["centiloids"].notna()
    mask = blood & mri & pet
    n = int(mask.sum())
    sub = feat[mask].reset_index(drop=True)
    y_sub = sub["label"].astype(int)

    out.append("")
    out.append("B. COMPLETE-CASE CROSS-CHECK (all four families measured)")
    out.append(f"   stage-complete subjects: {n} "
               f"({int((y_sub == 0).sum())} CN / {int((y_sub == 1).sum())} impaired)")
    if n < 100:
        out.append("   too few rows for a meaningful cross-check -- skipped")
        return

    X_sub = sub[feats]

    # 1) served model's SHAP on exactly these rows
    pipe = joblib.load(pipeline_path)
    prep = pipe.named_steps["prep"]
    main_clf = pipe.named_steps["clf"]
    X_main = prep.transform(X_sub)
    main_sv = np.asarray(shap.TreeExplainer(
        main_clf, feature_perturbation="tree_path_dependent")(X_main).values)
    if main_sv.ndim == 3:
        main_sv = main_sv[:, :, 1]
    main_imp = pd.Series(np.abs(main_sv).mean(axis=0), index=feats)

    # 2) throwaway model trained ONLY on complete-case rows
    thr = XGBClassifier(n_estimators=300, learning_rate=0.05, max_depth=3,
                        subsample=0.8, colsample_bytree=0.8, eval_metric="logloss",
                        random_state=42, n_jobs=-1)
    thr.fit(X_sub, y_sub)
    thr_sv = np.asarray(shap.TreeExplainer(
        thr, feature_perturbation="tree_path_dependent")(X_sub).values)
    if thr_sv.ndim == 3:
        thr_sv = thr_sv[:, :, 1]
    thr_imp = pd.Series(np.abs(thr_sv).mean(axis=0), index=feats)

    # Performance on this subset, honestly labelled:
    #   - throwaway: 5-fold cross-validated on the subset (out-of-fold, meaningful)
    #   - served:    scored on the subset, but some of these rows were in its
    #                training split, so treat it as an upper bound, not a fair test
    from sklearn.model_selection import cross_val_score
    thr_cv = cross_val_score(thr, X_sub, y_sub, cv=5, scoring="roc_auc")
    thr_auc = float(thr_cv.mean())
    main_auc = roc_auc_score(y_sub, pipe.predict_proba(X_sub)[:, 1])

    order_main = main_imp.sort_values(ascending=False)
    order_thr = thr_imp.sort_values(ascending=False)
    top10_main = list(order_main.index[:10])
    top10_thr = list(order_thr.index[:10])
    overlap = len(set(top10_main) & set(top10_thr))
    try:
        from scipy.stats import spearmanr
        rho = float(spearmanr(main_imp.values, thr_imp.values).statistic)
    except Exception:
        rho = float(pd.Series(main_imp.values).corr(pd.Series(thr_imp.values), method="spearman"))

    out.append(f"   AUC on these rows: served {main_auc:.4f} (partly in-sample — upper bound)"
               f" | complete-case-only model {thr_auc:.4f} (5-fold CV, honest)")
    out.append(f"   top-10 feature overlap    : {overlap}/10")
    out.append(f"   Spearman rho of the two mean|SHAP| vectors: {rho:.3f}")
    out.append("")
    out.append(f"   {'#':>3}  {'served model (SHAP)':<26}{'complete-case model (SHAP)':<28}")
    for i in range(10):
        out.append(f"   {i + 1:>3}  {top10_main[i]:<26}{top10_thr[i]:<28}")
    if overlap >= 7 and rho > 0.5:
        out.append("")
        out.append("   VERDICT: the served model's attributions on complete cases agree with a")
        out.append("            model that never saw a missing value -- the NaN handling is not")
        out.append("            inventing structure the complete-case subset does not support.")


def audit_incremental(feat: pd.DataFrame, feats: list[str], out: list[str]) -> None:
    """What each stage actually ADDS -- the counterweight to the SHAP table.

    A SHAP share is not incremental value: cognition can own 60% of attribution
    and still be almost entirely redundant with a single cognitive scale. These
    ablations answer "isn't it just MMSE?" with numbers rather than a ranking.
    """
    from sklearn.metrics import roc_auc_score

    y = feat["label"].astype(int)
    out.append("")
    out.append("C. INCREMENTAL VALUE BY FEATURE / STAGE (identical 5-fold CV folds)")

    out.append("   single-feature AUC (rows where measured):")
    for c in ("adas_cog_13", "mmse", "tau_meta_temporal", "centiloids", "mmse_change"):
        if c not in feat.columns:
            continue
        m = feat[c].notna()
        if m.sum() > 50 and feat.loc[m, "label"].nunique() == 2:
            auc = roc_auc_score(feat.loc[m, "label"].astype(int), feat.loc[m, c])
            out.append(f"     {c:<22}{max(auc, 1 - auc):.3f}   (n={int(m.sum())})")

    cog = [c for c in ("mmse", "mmse_change", "adas_cog_13") if c in feats]
    demo = [c for c in ("age", "sex", "education_years") if c in feats]
    bio = [c for c in feats if c not in cog + demo]
    arms = [
        ("full model", feats),
        ("minus adas_cog_13", [c for c in feats if c != "adas_cog_13"]),
        ("minus mmse", [c for c in feats if c != "mmse"]),
        ("cognition + demographics only", cog + demo),
        ("biomarkers only (no cognition)", bio + demo),
    ]
    out.append("")
    out.append(f"   {'arm':<34}{'n_feat':>7}{'CV AUC':>9}{'±':>8}{'delta':>9}")
    base = None
    for arm, cols in arms:
        m, s = _cv_auc(feat[cols], y)
        if base is None:
            base = m
            delta = ""
        else:
            delta = f"{m - base:+.4f}"
        out.append(f"   {arm:<34}{len(cols):>7}{m:>9.4f}{s:>8.4f}{delta:>9}")

    cog_only_auc = _cv_auc(feat[cog + demo], y)[0]
    bio_only_auc = _cv_auc(feat[bio + demo], y)[0]
    out.append("")
    out.append(f"   all biomarker families combined (blood + MRI + PET) add {base - cog_only_auc:+.4f} CV AUC")
    out.append(f"   over cognition + demographics alone ({base:.4f} vs {cog_only_auc:.4f}).")
    out.append(f"   Dropping cognition entirely costs {cog_only_auc - bio_only_auc:+.4f} "
               f"({cog_only_auc:.4f} -> {bio_only_auc:.4f}).")
    out.append("   Cognition carries this model for cross-sectional diagnosis. That is why the")
    out.append("   High TIER is evidence-gated rather than the training data rebalanced:")
    out.append("   resampling subjects cannot change how predictive a feature is.")



def main() -> int:
    ap = argparse.ArgumentParser(description="Audit the real-ADNI model: APOE encoding + complete-case cross-check.")
    ap.add_argument("--skip-apoe", action="store_true")
    ap.add_argument("--skip-completecase", action="store_true")
    ap.add_argument("--skip-incremental", action="store_true")
    args = ap.parse_args()

    feat, feats = _load()
    out: list[str] = [
        "=" * 78,
        "NeuroPilot -- real-ADNI model audit (2026-09-19 review items 2 and 7)",
        "=" * 78,
        f"cohort: {len(feat):,} subjects | feature contract: {len(feats)} features",
        "",
    ]
    if not args.skip_apoe:
        audit_apoe(feat, feats, out)
    if not args.skip_completecase:
        audit_completecase(feat, feats, out)
    if not args.skip_incremental:
        audit_incremental(feat, feats, out)

    text = "\n".join(out)
    print(text)
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    (ARTIFACTS / "model_audit.txt").write_text(text + "\n", encoding="utf-8")
    print(f"\n[done] wrote {ARTIFACTS / 'model_audit.txt'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
