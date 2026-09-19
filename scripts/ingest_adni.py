#!/usr/bin/env python3
"""Real ADNI ingestion -- replaces the synthetic cohort with the genuine drop.

Reads the 13 ADNI tables in "ADNI DATA/" and produces three files:

  data/processed/adni_visits.csv    one row per scored MMSE visit, with the
                                    nearest value of every other modality
                                    attached (NaN when nothing falls inside
                                    +/- 183 days). This is the longitudinal
                                    base the progression model trains on.
  data/processed/adni_features.csv  one row per subject = their LATEST visit
                                    that carries a diagnosis. The 16-feature
                                    vector + the real label. Training input.
  data/processed/adni_cohort.json   the same subjects in the internal serving
                                    record shape (what the API/dashboard read).

Labels are REAL: `impaired` = 1 when DIAGNOSIS is MCI (2) or Dementia (3),
0 when CN (1). No simulated label rule anywhere.

Sentinels handled (each one silently poisons a naive read):
  MMSCORE  -1   not administered          -> filtered
  TOTAL13  none (0 is a perfect ADAS)     -> DONE == 0 filtered instead
  CDRSB    -1   not done                  -> filtered (and NEVER a feature)
  FAQTOTAL -1   not done                  -> filtered
  PTGENDER -4   not reported              -> filtered
  PTEDUCAT -4   not reported              -> filtered
  PTDOBYY  string, not a year             -> parsed as a date
  VISDATE/EXAMDATE/SCANDATE real timing; MMDATE is a 0/1 flag, unusable
  PET qc_flag: keep 2 (pass) only; MRI STATUS partial/complete both retained
  UCSFFSX7 volumes are mm^3 -> /1000 for cm^3

Usage:  python scripts/ingest_adni.py
"""
from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
ADNI_DIR = ROOT / "ADNI DATA"
PROCESSED = ROOT / "data" / "processed"

TOLERANCE_DAYS = 183          # +/- 6 months for a measurement to count as co-visit
DIAGNOSIS_TOLERANCE_DAYS = 92  # tighter: a label must belong to THIS visit
MMSE_MIN, MMSE_MAX = 0, 30

PET_QC_PASS = 2               # ADNI qc_flag convention: 2 = pass

# --------------------------------------------------------------------------- #
# The served feature vector -- 16 real measures spanning all four stages.
# Stage 4 (PET) contributes continuous burden (Centiloids, tau SUVR) instead of
# a fabricated binary call, so the same slot works whether or not the scan
# exists; XGBoost consumes the resulting NaN natively.
# --------------------------------------------------------------------------- #
FEATURES = [
    # Stage 1 -- cognitive
    "age", "sex", "education_years", "mmse", "mmse_change",
    "adas_cog_13", "faq_total",
    # genetic risk (new in the real drop; the synthetic cohort had none)
    "apoe_e4",
    # Stage 2 -- blood biomarkers (draw 13: p-tau217, Ab42/40, NfL, GFAP)
    "ptau217", "abeta4240", "nfl", "gfap",
    # Stage 3 -- MRI volumetrics (ICV-normalized: removes the head-size confound)
    "hippocampal_volume", "hippocampal_icv_ratio",
    # Stage 4 -- PET
    "centiloids", "tau_meta_temporal",
]

# feature -> (slot, where it lives in the serving record)
STAGE_OF = {
    "age": 1, "sex": 1, "education_years": 1, "mmse": 1, "mmse_change": 1,
    "adas_cog_13": 1, "faq_total": 1, "apoe_e4": 1,
    "ptau217": 2, "abeta4240": 2, "nfl": 2, "gfap": 2,
    "hippocampal_volume": 3, "hippocampal_icv_ratio": 3,
    "centiloids": 4, "tau_meta_temporal": 4,
}


def _read(fname: str, cols: list[str]) -> pd.DataFrame:
    path = ADNI_DIR / fname
    if not path.exists():
        print(f"[fail] missing {path}")
        sys.exit(1)
    head = pd.read_csv(path, nrows=0)
    use = [c for c in cols if c in head.columns]
    df = pd.read_csv(path, usecols=use, low_memory=False)
    return df


def _num(df: pd.DataFrame, cols: list[str]) -> pd.DataFrame:
    for c in cols:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce")
    return df


def _dated(df: pd.DataFrame, col: str) -> pd.DataFrame:
    df["date"] = pd.to_datetime(df[col], errors="coerce")
    return df[df["date"].notna()]


# --------------------------------------------------------------------------- #
# Loaders -- each returns a tidy frame: RID, date, <measures>
# --------------------------------------------------------------------------- #
def load_cognition() -> pd.DataFrame:
    df = _read("MMSE_17Sep2026.csv", ["RID", "PTID", "VISCODE", "VISDATE", "MMSCORE"])
    df = _num(df, ["MMSCORE"])
    df = _dated(df, "VISDATE")
    df = df[df["MMSCORE"].notna() & df["MMSCORE"].between(MMSE_MIN, MMSE_MAX)]
    df = df[df["RID"].notna()]
    df["RID"] = df["RID"].astype(int)
    return df[["RID", "PTID", "VISCODE", "date", "MMSCORE"]].sort_values(["RID", "date"])


def load_diagnosis() -> pd.DataFrame:
    df = _read("DXSUM_17Sep2026.csv", ["RID", "VISCODE", "EXAMDATE", "DIAGNOSIS"])
    df = _num(df, ["DIAGNOSIS"])
    df = _dated(df, "EXAMDATE")
    # 10 = TEAM (research-only) rows -> excluded from labeling
    df = df[df["DIAGNOSIS"].isin([1, 2, 3])]
    df = df[df["RID"].notna()]
    df["RID"] = df["RID"].astype(int)
    df = df.drop_duplicates(subset=["RID", "date"], keep="last")
    return df[["RID", "date", "DIAGNOSIS"]].sort_values(["RID", "date"])


def load_demographics() -> pd.DataFrame:
    df = _read("PTDEMOG_17Sep2026.csv", ["RID", "PTGENDER", "PTDOBYY", "PTEDUCAT"])
    df = _num(df, ["PTGENDER", "PTEDUCAT"])
    df = df[df["RID"].notna()].copy()
    df["RID"] = df["RID"].astype(int)
    df["sex"] = df["PTGENDER"].map({1.0: "M", 2.0: "F"})
    df["education_years"] = df["PTEDUCAT"].where(df["PTEDUCAT"] >= 0)
    # PTDOBYY is a date string ("1931-01-01"), not a year integer
    df["birth_year"] = pd.to_datetime(df["PTDOBYY"], errors="coerce").dt.year
    df = df.drop_duplicates(subset=["RID"], keep="first")
    return df[["RID", "sex", "education_years", "birth_year"]]


def load_blood() -> pd.DataFrame:
    df = _read("UPENN_PLASMA_FUJIREBIO_QUANTERIX_17Sep2026.csv",
               ["RID", "VISCODE", "EXAMDATE", "pT217_F", "AB42_F", "AB40_F",
                "AB42_AB40_F", "NfL_Q", "GFAP_Q"])
    df = _num(df, ["pT217_F", "AB42_F", "AB40_F", "AB42_AB40_F", "NfL_Q", "GFAP_Q"])
    # NfL_Q / GFAP_Q use -4 AND -5 as "not available" (695 of 2,422 rows!);
    # AB42_F/AB40_F/AB42_AB40_F use -4 in a handful. A negative concentration is
    # physically impossible, so drop every negative -- otherwise the model learns
    # from a sentinel that looks like a very low ("healthy") reading.
    for c in ("pT217_F", "AB42_F", "AB40_F", "AB42_AB40_F", "NfL_Q", "GFAP_Q"):
        df[c] = df[c].where(df[c] >= 0)
    df = _dated(df, "EXAMDATE")
    df = df[df["RID"].notna()].copy()
    df["RID"] = df["RID"].astype(int)
    df = df.rename(columns={"pT217_F": "ptau217", "AB42_AB40_F": "abeta4240",
                            "NfL_Q": "nfl", "GFAP_Q": "gfap", "AB42_F": "abeta42", "AB40_F": "abeta40"})
    return df[["RID", "date", "ptau217", "abeta4240", "nfl", "gfap", "abeta42", "abeta40"]] \
        .sort_values(["RID", "date"])


def load_mri() -> pd.DataFrame:
    df = _read("UCSFFSX7_17Sep2026.csv",
               ["RID", "VISCODE", "EXAMDATE", "STATUS", "OVERALLQC",
                "ST10CV", "ST29SV", "ST88SV"])
    df = _num(df, ["ST10CV", "ST29SV", "ST88SV"])
    df = _dated(df, "EXAMDATE")
    df = df[df["RID"].notna()].copy()
    df["RID"] = df["RID"].astype(int)
    # FreeSurfer volumes are mm^3 -> cm^3
    df["icv_cm3"] = df["ST10CV"].where(df["ST10CV"] > 0) / 1000.0
    df["hippocampus_left_cm3"] = df["ST29SV"].where(df["ST29SV"] > 0) / 1000.0
    df["hippocampus_right_cm3"] = df["ST88SV"].where(df["ST88SV"] > 0) / 1000.0
    df["hippocampal_volume"] = df[["hippocampus_left_cm3", "hippocampus_right_cm3"]].mean(axis=1)
    df["hippocampal_icv_ratio"] = df["hippocampal_volume"] / df["icv_cm3"]
    return df[["RID", "date", "icv_cm3", "hippocampus_left_cm3", "hippocampus_right_cm3",
               "hippocampal_volume", "hippocampal_icv_ratio", "STATUS", "OVERALLQC"]] \
        .sort_values(["RID", "date"])


def load_pet_amyloid() -> pd.DataFrame:
    df = _read("UCBERKELEY_AMY_6MM_17Sep2026.csv",
               ["RID", "VISCODE", "SCANDATE", "qc_flag", "TRACER",
                "AMYLOID_STATUS", "CENTILOIDS", "SUMMARY_SUVR"])
    df = _num(df, ["qc_flag", "CENTILOIDS", "SUMMARY_SUVR", "AMYLOID_STATUS"])
    df = _dated(df, "SCANDATE")
    df = df[df["qc_flag"] == PET_QC_PASS]
    df = df[df["RID"].notna()].copy()
    df["RID"] = df["RID"].astype(int)
    df = df.rename(columns={"AMYLOID_STATUS": "amyloid_status", "TRACER": "amyloid_tracer",
                            "CENTILOIDS": "centiloids", "SUMMARY_SUVR": "amyloid_suvr"})
    return df[["RID", "date", "centiloids", "amyloid_status", "amyloid_suvr", "amyloid_tracer"]] \
        .sort_values(["RID", "date"])


def load_pet_tau() -> pd.DataFrame:
    df = _read("UCBERKELEY_TAU_6MM_17Sep2026.csv",
               ["RID", "VISCODE", "SCANDATE", "qc_flag", "TRACER",
                "META_TEMPORAL_SUVR", "CTX_ENTORHINAL_SUVR"])
    df = _num(df, ["qc_flag", "META_TEMPORAL_SUVR", "CTX_ENTORHINAL_SUVR"])
    df = _dated(df, "SCANDATE")
    df = df[df["qc_flag"] == PET_QC_PASS]
    df = df[df["RID"].notna()].copy()
    df["RID"] = df["RID"].astype(int)
    df = df.rename(columns={"META_TEMPORAL_SUVR": "tau_meta_temporal",
                            "CTX_ENTORHINAL_SUVR": "tau_entorhinal", "TRACER": "tau_tracer"})
    return df[["RID", "date", "tau_meta_temporal", "tau_entorhinal", "tau_tracer"]] \
        .sort_values(["RID", "date"])


def load_adas() -> pd.DataFrame:
    df = _read("ADAS_17Sep2026.csv", ["RID", "VISCODE", "VISDATE", "DONE", "TOTAL13", "TOTSCORE"])
    df = _num(df, ["DONE", "TOTAL13", "TOTSCORE"])
    df = _dated(df, "VISDATE")
    df = df[df["DONE"].isna() | (df["DONE"] != 0)]  # DONE == 0 -> explicitly not administered
    # TOTAL13 is the real ADAS-Cog 13 (0-85); TOTSCORE is the classic 70-pt scale
    df["adas_cog_13"] = df["TOTAL13"].where(df["TOTAL13"] >= 0)
    df = df[df["adas_cog_13"].notna()]
    df = df[df["RID"].notna()].copy()
    df["RID"] = df["RID"].astype(int)
    return df[["RID", "date", "adas_cog_13"]].sort_values(["RID", "date"])


def load_cdr() -> pd.DataFrame:
    """CDR is a LABEL PROXY (DIAGNOSIS is derived from it) -- never a feature.

    Loaded only for provenance/concordance reporting.
    """
    df = _read("CDR_17Sep2026.csv", ["RID", "VISCODE", "VISDATE", "CDGLOBAL", "CDRSB"])
    df = _num(df, ["CDGLOBAL", "CDRSB"])
    df = _dated(df, "VISDATE")
    df = df[df["RID"].notna()].copy()
    df["RID"] = df["RID"].astype(int)
    df["cdr_global"] = df["CDGLOBAL"].where(df["CDGLOBAL"] >= 0)
    df["cdr_sb"] = df["CDRSB"].where(df["CDRSB"] >= 0)
    return df[["RID", "date", "cdr_global", "cdr_sb"]].sort_values(["RID", "date"])


def load_faq() -> pd.DataFrame:
    df = _read("FAQ_17Sep2026.csv", ["RID", "VISCODE", "VISDATE", "FAQTOTAL"])
    df = _num(df, ["FAQTOTAL"])
    df = _dated(df, "VISDATE")
    df = df[df["RID"].notna()].copy()
    df["RID"] = df["RID"].astype(int)
    df["faq_total"] = df["FAQTOTAL"].where(df["FAQTOTAL"] >= 0)  # -1 = not done
    df = df[df["faq_total"].notna()]
    return df[["RID", "date", "faq_total"]].sort_values(["RID", "date"])


def load_apoe() -> pd.DataFrame:
    df = _read("APOERES_17Sep2026.csv", ["RID", "GENOTYPE"])
    df = df[df["RID"].notna()].copy()
    df["RID"] = df["RID"].astype(int)
    df["GENOTYPE"] = df["GENOTYPE"].astype("string").str.strip()
    df = df[df["GENOTYPE"].notna() & (df["GENOTYPE"] != "")]
    # e4 carrier = any allele 4 (2/4, 3/4, 4/4) -- the Alzheimer's risk allele
    df["apoe_e4"] = df["GENOTYPE"].str.contains("4", na=False).astype(float)
    df = df.drop_duplicates(subset=["RID"], keep="first")
    return df[["RID", "GENOTYPE", "apoe_e4"]]


# --------------------------------------------------------------------------- #
# The join: every scored MMSE visit + nearest co-visit value per modality
# --------------------------------------------------------------------------- #
def _attach(base: pd.DataFrame, other: pd.DataFrame, cols: list[str],
            tolerance: int) -> pd.DataFrame:
    """Nearest-in-time attach of `cols` from `other` onto every base visit."""
    if other.empty:
        for c in cols:
            base[c] = np.nan
        return base
    o = other[["RID", "date"] + [c for c in cols if c in other.columns]].copy()
    o = o.drop_duplicates(subset=["RID", "date"], keep="last")
    # merge_asof requires BOTH frames sorted on the `on` key (date), globally
    o = o.sort_values("date", kind="mergesort")
    b = base.sort_values("date", kind="mergesort")
    merged = pd.merge_asof(
        b, o, on="date", by="RID", direction="nearest",
        tolerance=pd.Timedelta(days=tolerance),
    )
    return merged.sort_values(["RID", "date"])


def build_visits() -> pd.DataFrame:
    cog = load_cognition()
    base = cog.rename(columns={"MMSCORE": "mmse"})

    for other, cols, tol in [
        (load_blood(), ["ptau217", "abeta4240", "nfl", "gfap", "abeta42", "abeta40"], TOLERANCE_DAYS),
        (load_mri(), ["icv_cm3", "hippocampus_left_cm3", "hippocampus_right_cm3",
                      "hippocampal_volume", "hippocampal_icv_ratio", "STATUS", "OVERALLQC"],
         TOLERANCE_DAYS),
        (load_pet_amyloid(), ["centiloids", "amyloid_status", "amyloid_suvr", "amyloid_tracer"],
         TOLERANCE_DAYS),
        (load_pet_tau(), ["tau_meta_temporal", "tau_entorhinal", "tau_tracer"], TOLERANCE_DAYS),
        (load_adas(), ["adas_cog_13"], TOLERANCE_DAYS),
        (load_faq(), ["faq_total"], TOLERANCE_DAYS),
        (load_cdr(), ["cdr_global", "cdr_sb"], TOLERANCE_DAYS),
        (load_diagnosis(), ["DIAGNOSIS"], DIAGNOSIS_TOLERANCE_DAYS),
    ]:
        base = _attach(base, other, cols, tol)

    base = base.rename(columns={"DIAGNOSIS": "diagnosis"})

    # subject-level demographics + genotype
    demo = load_demographics()
    base = base.merge(demo, on="RID", how="left")
    base["age"] = base["date"].dt.year - base["birth_year"]
    base["sex_m"] = base["sex"].map({"M": 1.0, "F": 0.0})
    base = base.merge(load_apoe(), on="RID", how="left")

    # longitudinal context: prior scored MMSE + elapsed months
    base = base.sort_values(["RID", "date"])
    base["mmse_prior"] = base.groupby("RID")["mmse"].shift(1)
    base["prior_date"] = base.groupby("RID")["date"].shift(1)
    base["months_since_prior"] = (base["date"] - base["prior_date"]).dt.days / 30.44
    base["visit_no"] = base.groupby("RID").cumcount() + 1
    base["n_visits"] = base.groupby("RID")["RID"].transform("size")
    base["mmse_change"] = base["mmse"] - base["mmse_prior"]
    return base


def add_stage(df: pd.DataFrame) -> pd.DataFrame:
    """Pipeline stage = length of the COMPLETE PREFIX of the ordered pathway.

    Stage N means "stages 1..N were all measured", which is what the escalation
    engine and the stepper mean by a stage. ADNI is a real research cohort, so
    modalities genuinely arrive out of order: 965 subjects have MRI but no
    plasma panel, 365 have MRI+PET and no plasma, 129 have PET only. Marking
    those "Stage 3/4" (as a highest-completed rule would) claims a blood draw
    that never happened -- so the stage stops at the first gap, and the rule
    engine correctly recommends ordering the missing test. The data already on
    file is NOT discarded: later-stage values still feed the model.
    """
    have_blood = df["ptau217"].notna() | df["nfl"].notna() | df["gfap"].notna()
    have_mri = df["hippocampal_volume"].notna()
    have_pet = df["centiloids"].notna() | df["tau_meta_temporal"].notna()

    stage = pd.Series(1, index=df.index, dtype=int)
    stage = stage.mask(have_blood, 2)
    stage = stage.mask(have_blood & have_mri, 3)
    stage = stage.mask(have_blood & have_mri & have_pet, 4)
    df["stage"] = stage
    # A result is "beyond the stage" when more modalities are on file than the
    # contiguous prefix accounts for (measured count vs stage-1 completed steps)
    measured = have_blood.astype(int) + have_mri.astype(int) + have_pet.astype(int)
    df["beyond_stage"] = measured > (stage - 1)
    return df


# --------------------------------------------------------------------------- #
# Serving record (internal API shape -- see backend/app/storage.py)
# --------------------------------------------------------------------------- #
def _f(v, digits: int = 3):
    if v is None or (isinstance(v, float) and (np.isnan(v) or pd.isna(v))):
        return None
    return round(float(v), digits)


def _content_digest(records: list[dict]) -> str:
    """Short content hash of the cohort records (used for store re-seeding)."""
    payload = [
        {k: v for k, v in sorted(r.items())
         if k not in {"score", "factors", "updated_at", "cohort_version"}}
        for r in records
    ]
    blob = json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha1(blob).hexdigest()[:12]


def _stage_lines(row: pd.Series) -> list[dict]:
    at = row["date"].strftime("%Y-%m-%d")
    out = []
    out.append({"at": at, "text": f"Cognitive assessment — MMSE {int(row['mmse'])} (real ADNI visit)"})
    if pd.notna(row.get("adas_cog_13")):
        out.append({"at": at, "text": f"ADAS-Cog 13 recorded — {row['adas_cog_13']:.1f} points"})
    if pd.notna(row.get("faq_total")):
        out.append({"at": at, "text": f"Functional status (FAQ) recorded — {row['faq_total']:.0f}/30"})
    if pd.notna(row.get("ptau217")):
        out.append({"at": at, "text": f"Blood panel recorded — p-tau217 {row['ptau217']:.3f} pg/mL"})
    if pd.notna(row.get("hippocampal_volume")):
        out.append({"at": at, "text": f"MRI volumetrics recorded — hippocampus "
                                       f"{row['hippocampal_volume']:.2f} cm³"})
    if pd.notna(row.get("centiloids")):
        out.append({"at": at, "text": f"Amyloid PET recorded — {row['centiloids']:.1f} Centiloids"})
    if pd.notna(row.get("tau_meta_temporal")):
        out.append({"at": at, "text": f"Tau PET recorded — temporal meta SUVR "
                                       f"{row['tau_meta_temporal']:.3f}"})
    return out


def to_record(row: pd.Series) -> dict:
    sid = f"ADNI-{int(row['RID']):04d}"
    mmse_latest = _f(row["mmse"], 1)
    mmse_prior = _f(row.get("mmse_prior"), 1)
    months = int(round(row["months_since_prior"])) if pd.notna(row.get("months_since_prior")) else None

    blood = None
    if pd.notna(row.get("ptau217")) or pd.notna(row.get("nfl")):
        notes = []
        if pd.notna(row.get("ptau217")):
            notes.append(f"p-tau217 {row['ptau217']:.3f} pg/mL")
        if pd.notna(row.get("abeta4240")):
            notes.append(f"Aβ42/40 {row['abeta4240']:.4f}")
        if pd.notna(row.get("nfl")):
            notes.append(f"NfL {row['nfl']:.2f} pg/mL")
        if pd.notna(row.get("gfap")):
            notes.append(f"GFAP {row['gfap']:.2f} pg/mL")
        blood = {
            "status": "completed",
            "outcome": _blood_outcome(row),
            "pTau217": _f(row.get("ptau217"), 3),
            "abeta4240": _f(row.get("abeta4240"), 4),
            "nfl": _f(row.get("nfl"), 2),
            "gfap": _f(row.get("gfap"), 2),
            "note": "Plasma panel (Fujirebio/Quanterix) — " + "; ".join(notes),
        }

    imaging = None
    if pd.notna(row.get("hippocampal_volume")):
        imaging = {
            "status": "completed",
            "outcome": _imaging_outcome(row),
            "hippocampalVolumeCm3": _f(row.get("hippocampal_volume"), 2),
            "hippocampusLeftCm3": _f(row.get("hippocampus_left_cm3"), 2),
            "hippocampusRightCm3": _f(row.get("hippocampus_right_cm3"), 2),
            "icvCm3": _f(row.get("icv_cm3"), 0),
            "hippocampalIcvRatio": _f(row.get("hippocampal_icv_ratio"), 5),
            "note": f"FreeSurfer 7 (UCSF) — hippocampus {row['hippocampal_volume']:.2f} cm³, "
                    f"ICV-normalized ratio {row['hippocampal_icv_ratio']:.5f}",
        }

    pet = None
    if pd.notna(row.get("centiloids")) or pd.notna(row.get("tau_meta_temporal")):
        pet = {
            "status": "completed",
            "amyloid": None if pd.isna(row.get("amyloid_status"))
                       else ("Positive" if row["amyloid_status"] >= 1 else "Negative"),
            "tau": _tau_status(row.get("tau_meta_temporal")),
            "centiloids": _f(row.get("centiloids"), 1),
            "amyloidSuvr": _f(row.get("amyloid_suvr"), 3),
            "tauMetaTemporalSuvr": _f(row.get("tau_meta_temporal"), 3),
            "note": _pet_note(row),
        }

    return {
        "id": sid,
        "age": _f(row["age"], 0),
        "sex": row["sex"] if isinstance(row.get("sex"), str) else None,
        "education_years": _f(row.get("education_years"), 0),
        "apoe_genotype": row.get("GENOTYPE") if pd.notna(row.get("GENOTYPE")) else None,
        "apoe_e4": None if pd.isna(row.get("apoe_e4")) else bool(row["apoe_e4"] >= 0.5),
        "real_diagnosis": _diagnosis_label(row.get("diagnosis")),
        "diagnosis_code": None if pd.isna(row.get("diagnosis")) else int(row["diagnosis"]),
        "cdr_sb": _f(row.get("cdr_sb"), 1),
        "visit_date": row["date"].strftime("%Y-%m-%d"),
        "n_visits": int(row["n_visits"]) if pd.notna(row.get("n_visits")) else 1,
        "cognitive": {
            "scale": "MMSE",
            "latest": mmse_latest,
            "prior": mmse_prior,
            "months": months if months is not None else 6,
        },
        "adas_cog_13": _f(row.get("adas_cog_13"), 1),
        "faq_total": _f(row.get("faq_total"), 0),
        "blood": blood,
        "imaging": imaging,
        "pet": pet,
        "score": None,          # filled by the served model at API startup
        "factors": [],
        "stage": int(row["stage"]),
        # True when a LATER-stage result is already on file (ordering gap)
        "beyond_stage": bool(row.get("beyond_stage", False)),
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "history": _stage_lines(row),
        "data_source_tag": "real_adni_17sep2026",
    }


# Reference cut-offs taken from THIS drop's own distribution (ADNI 17 Sep 2026),
# not from memory: pTau217 p75 = 0.415 pg/mL, AB42/40 p25 = 0.075,
# NfL p75 = 24.4 pg/mL, GFAP p75 = 217 pg/mL, hippocampal/ICV p25 = 0.0020.
PTAU217_HIGH = 0.40
ABETA4240_LOW = 0.075
NFL_HIGH = 24.4
GFAP_HIGH = 217.0
HIPPO_ICV_LOW = 0.0020
TAU_SUVR_POS = 1.30


def _blood_outcome(row: pd.Series) -> str:
    flags = []
    if pd.notna(row.get("ptau217")) and row["ptau217"] > PTAU217_HIGH:
        flags.append("p-tau217 elevated")
    if pd.notna(row.get("abeta4240")) and row["abeta4240"] < ABETA4240_LOW:
        flags.append("Aβ42/40 reduced")
    if pd.notna(row.get("nfl")) and row["nfl"] > NFL_HIGH:
        flags.append("NfL elevated")
    if pd.notna(row.get("gfap")) and row["gfap"] > GFAP_HIGH:
        flags.append("GFAP elevated")
    return "abnormal" if flags else "normal"


def _imaging_outcome(row: pd.Series) -> str:
    """Uses the APP's outcome vocabulary (normal | abnormal | inconclusive).

    The clinical word ("atrophy") belongs in the note; the `outcome` field is a
    contract the API and the UI colour-code, so a novel value would render as an
    unstyled chip and break any future rule that gates on outcome.
    """
    r = row.get("hippocampal_icv_ratio")
    if pd.isna(r):
        return "completed"
    # ICV-normalized hippocampal fraction below the cohort's lower quartile
    return "abnormal" if r < HIPPO_ICV_LOW else "normal"


def _tau_status(suvr) -> str | None:
    if suvr is None or pd.isna(suvr):
        return None
    # META_TEMPORAL_SUVR: cohort median 1.21 (CN 1.18 / Dementia 1.65),
    # 1.30 = upper quartile -> tau-positive call
    return "Positive" if float(suvr) >= TAU_SUVR_POS else "Negative"


def _pet_note(row: pd.Series) -> str:
    bits = []
    if pd.notna(row.get("centiloids")):
        bits.append(f"{row['centiloids']:.1f} Centiloids")
    if pd.notna(row.get("amyloid_suvr")):
        bits.append(f"amyloid SUVR {row['amyloid_suvr']:.3f}")
    if pd.notna(row.get("tau_meta_temporal")):
        bits.append(f"tau temporal-meta SUVR {row['tau_meta_temporal']:.3f}")
    return "PET (UC Berkeley 6mm) — " + "; ".join(bits)


def _diagnosis_label(code) -> str | None:
    if code is None or pd.isna(code):
        return None
    return {1: "CN", 2: "MCI", 3: "Dementia"}.get(int(code))


def main() -> int:
    if not ADNI_DIR.exists():
        print(f"[fail] no ADNI folder at {ADNI_DIR}")
        return 1

    print("=" * 72)
    print("Real ADNI ingestion")
    print("=" * 72)
    visits = build_visits()
    visits = add_stage(visits)
    print(f"[join]   {len(visits):,} scored MMSE visits · {visits['RID'].nunique():,} subjects")

    labeled = visits[visits["diagnosis"].notna()].copy()
    print(f"[label]  {len(labeled):,} visits carry a real DIAGNOSIS")

    # one row per subject: latest visit that has both a scored MMSE and a label
    snap = (labeled.sort_values(["RID", "date"])
            .groupby("RID", as_index=False).tail(1)
            .sort_values("RID").reset_index(drop=True))
    snap["label"] = (snap["diagnosis"] >= 2).astype(int)   # MCI or Dementia = impaired
    print(f"[snap]   {len(snap):,} subjects (latest labeled visit each)")

    print(f"\n[labels] 1 = MCI/Dementia, 0 = CN")
    for code, name in [(1, "CN"), (2, "MCI"), (3, "Dementia")]:
        n = int((snap["diagnosis"] == code).sum())
        print(f"  {name:<10}: {n:>5,}  ({100 * n / len(snap):.1f}%)")
    print(f"  impaired   : {int(snap['label'].sum()):>5,}  "
          f"({100 * snap['label'].mean():.1f}%)")

    print(f"\n[coverage] feature population across the {len(snap):,} training subjects")
    print(f"  {'feature':<24}{'stage':>6}{'present':>10}{'%':>8}")
    for f in FEATURES:
        col = "sex" if f == "sex" else ("apoe_e4" if f == "apoe_e4" else f)
        present = int(snap[col].notna().sum()) if col in snap.columns else 0
        print(f"  {f:<24}{STAGE_OF[f]:>6}{present:>10,}{100 * present / len(snap):>7.1f}%")

    print("\n[stage] stage = completed prefix of the ordered pathway (cog -> blood -> MRI -> PET)")
    for s in (1, 2, 3, 4):
        n = int((snap["stage"] == s).sum())
        print(f"  Stage {s}: {n:>5,}  ({100 * n / len(snap):.1f}%)")
    extra = int(snap["beyond_stage"].sum())
    print(f"  of the Stage-1/2/3 subjects, {extra:,} already have a LATER-stage result"
          f" on file (real ADNI ordering gaps) — the model still uses it, and the"
          f" escalation engine recommends the missing test without overwriting it")

    complete = snap[[f for f in FEATURES if f != "sex"]].notna().all(axis=1) & snap["sex"].notna()
    print(f"\n[vectors] complete 16-feature vectors: {int(complete.sum()):,} subjects")
    print(f"[longitudinal] subjects with >=2 scored visits: "
          f"{int((visits.groupby('RID').size() >= 2).sum()):,}")

    # ---- write ------------------------------------------------------------- #
    PROCESSED.mkdir(parents=True, exist_ok=True)
    visit_cols = ["RID", "date", "VISCODE", "mmse", "mmse_prior", "mmse_change",
                  "months_since_prior", "visit_no", "n_visits", "stage", "diagnosis",
                  "sex", "education_years", "age", "apoe_e4", "adas_cog_13", "faq_total",
                  "cdr_sb", "ptau217", "abeta4240", "nfl", "gfap", "hippocampal_volume",
                  "hippocampal_icv_ratio", "centiloids", "tau_meta_temporal"]
    visit_cols = [c for c in visit_cols if c in visits.columns]
    visits[visit_cols].to_csv(PROCESSED / "adni_visits.csv", index=False)

    # The training matrix uses the SERVED feature names/encodings, so `sex` here
    # is numeric (1 = male, 0 = female) even though the record keeps "M"/"F"
    # for display. Keeping them identical is what makes train/serve consistent.
    feat = pd.DataFrame({
        "subject_rid": snap["RID"].to_numpy(),
        "visit_date": snap["date"].to_numpy(),
        "diagnosis": snap["diagnosis"].to_numpy(),
        "label": snap["label"].to_numpy(),
        "stage": snap["stage"].to_numpy(),
        "n_visits": snap["n_visits"].to_numpy(),
    })
    for f in FEATURES:
        col = "sex_m" if f == "sex" else f
        feat[f] = snap[col].to_numpy() if col in snap.columns else np.nan
    feat["subject_id"] = feat["subject_rid"].apply(lambda r: f"ADNI-{int(r):04d}")
    feat.to_csv(PROCESSED / "adni_features.csv", index=False)

    records = [to_record(row) for _, row in snap.iterrows()]
    # Content version over EVERYTHING except the fields the API recomputes
    # (score/factors) and the timestamp -- so correcting any value (a stage, an
    # outcome, a biomarker) changes the digest and the API store re-seeds
    # instead of serving the previous cohort out of Postgres/SQLite.
    digest = _content_digest(records)
    for r in records:
        r["cohort_version"] = digest
    (PROCESSED / "adni_cohort.json").write_text(
        json.dumps(records, indent=2, default=str), encoding="utf-8")
    print(f"\n[version] cohort_version={digest}")

    print("\n[done] wrote:")
    for p in ("adni_visits.csv", "adni_features.csv", "adni_cohort.json"):
        print(f"  data/processed/{p}")
    print("\nNext:  python scripts/train_model.py --data adni")
    return 0


if __name__ == "__main__":
    sys.exit(main())
