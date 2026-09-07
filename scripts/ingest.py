#!/usr/bin/env python3
"""ETL step (blueprint section 4.1 / 4.2).

Reads the raw OASIS-1 longitudinal CSV and writes a unified, patient-centric
schema to data/processed/:

  visits.csv    -- one row per (subject, visit): demographics, cognition, imaging
  patients.csv  -- one row per subject: their LATEST visit snapshot

No rows are silently dropped: missing values are kept as empty (NaN) and counted
in the summary below so downstream steps (and the audit trail) know about them.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

RAW = Path("data/raw/oasis_longitudinal.csv")
OUT_DIR = Path("data/processed")

REQUIRED_COLUMNS = [
    "Subject ID", "MRI ID", "Group", "Visit", "MR Delay",
    "M/F", "Age", "EDUC", "SES", "MMSE", "CDR", "eTIV", "nWBV", "ASF",
]

NUMERIC = {
    "visit_no": "Visit",
    "mr_delay_days": "MR Delay",
    "age": "Age",
    "education_years": "EDUC",
    "ses": "SES",
    "mmse": "MMSE",
    "cdr": "CDR",
    "etiv": "eTIV",
    "nwbv": "nWBV",
    "asf": "ASF",
}

HUMAN = {
    "age": "Age", "ses": "SES (socioeconomic status)", "mmse": "MMSE",
    "cdr": "CDR", "education_years": "EDUC", "etiv": "eTIV",
    "nwbv": "nWBV", "asf": "ASF", "mr_delay_days": "MR Delay",
}


def main() -> int:
    if not RAW.exists():
        print(
            f"ERROR: {RAW} not found.\n"
            "Add the OASIS-1 longitudinal CSV there first -- either run\n"
            "  python scripts/download_oasis.py\n"
            "or drop the file in manually (Kaggle / oasis-brains.org)."
        )
        return 1

    df = pd.read_csv(RAW)
    df.columns = [str(c).strip() for c in df.columns]
    missing_cols = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing_cols:
        print(f"ERROR: unexpected schema. Missing columns: {missing_cols}")
        print(f"Found columns: {list(df.columns)}")
        return 1

    print(f"[read]  {RAW} -> {len(df):,} rows")

    visits = pd.DataFrame({"subject_id": df["Subject ID"].astype(str).str.strip()})
    visits["mri_id"] = df["MRI ID"].astype(str).str.strip()
    visits["diagnosis_group"] = df["Group"].astype(str).str.strip()
    for out_col, src_col in NUMERIC.items():
        visits[out_col] = pd.to_numeric(df[src_col], errors="coerce")
    visits["sex"] = df["M/F"].astype(str).str.strip().str.upper()

    # Guard against duplicate visit rows for the same subject
    before = len(visits)
    visits = visits.drop_duplicates(subset=["subject_id", "visit_no"], keep="last")
    if len(visits) != before:
        print(f"[dedup] removed {before - len(visits)} duplicate subject/visit rows")

    visits = visits.sort_values(["subject_id", "visit_no"]).reset_index(drop=True)

    # Missing-value report (flag, never silently drop)
    print("\n[missing] per-field counts (kept as empty, reported for audit):")
    for col in HUMAN:
        n_missing = int(visits[col].isna().sum())
        if n_missing:
            print(f"  {HUMAN[col]:<28} {n_missing:>5} / {len(visits)} rows")

    # Latest-visit snapshot per subject (patients table)
    latest = (
        visits.sort_values("mr_delay_days", na_position="first")
        .drop_duplicates(subset="subject_id", keep="last")
        .sort_values("subject_id")
        .reset_index(drop=True)
    )

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    visits.to_csv(OUT_DIR / "visits.csv", index=False)
    latest.to_csv(OUT_DIR / "patients.csv", index=False)

    print("\n[summary]")
    print(f"  subjects            : {latest.subject_id.nunique()}")
    print(f"  total visits        : {len(visits)}")
    print(f"  visits per subject  : {visits.groupby('subject_id').size().mean():.1f} (mean)")
    print(f"  latest-visit labels : {latest.diagnosis_group.value_counts().to_dict()}")
    print("\n[done] wrote:")
    print(f"  {OUT_DIR / 'visits.csv'}")
    print(f"  {OUT_DIR / 'patients.csv'}")
    print("\nNext step:  python scripts/train_model.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
