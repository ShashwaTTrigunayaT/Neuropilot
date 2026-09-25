"""Rebuild the progression index from the processed visits artifact.

`ingest_adni.py` writes data/processed/adni_progression.csv during a full ingest,
which needs the raw ADNI exports. A deployment that carries only the processed
visits table (this repo) can still regenerate the SAME index -- same baseline
rule, same window, same +/-6-month tolerance -- which is what this script does.
It is now the only way to add the per-attribute projection targets
(PROJECTION_FEATURES in ingest_adni.py) without the raw data.

This file is the training input for the SERVED model, so the write is refused
whenever the rebuild disagrees with the index it would replace: every shared
column must reproduce exactly. A silent drift here would retrain the served
model on different targets than the ones its metrics were measured against.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ingest_adni import (  # noqa: E402
    PROCESSED,
    PROGRESSION_HORIZON_MONTHS,
    PROJECTION_FEATURES,
    build_progression_index,
)

INDEX = PROCESSED / "adni_progression.csv"
VISITS = PROCESSED / "adni_visits.csv"


def _same(x: pd.Series, y: pd.Series) -> bool:
    """Value equality across dtypes: numbers by value, dates by parse."""
    if x.dtype.kind in "fi" and y.dtype.kind in "fi":
        return bool(np.allclose(x.to_numpy(float), y.to_numpy(float), equal_nan=True))
    xs = x.astype(str).str.strip()
    ys = y.astype(str).str.strip()
    if xs.equals(ys):
        return True
    dx = pd.to_datetime(xs, errors="coerce")
    dy = pd.to_datetime(ys, errors="coerce")
    return bool(dx.notna().all() and dx.equals(dy))


def main() -> int:
    if not VISITS.exists():
        print(f"[fail] {VISITS} missing -- run scripts/ingest_adni.py first")
        return 1

    visits = pd.read_csv(VISITS, parse_dates=["date"])
    # build_progression_index expects the ingest frame, which carries sex as the
    # 0/1 `sex_m` column (ingest_adni.py maps M/F at ingest time).
    visits["sex_m"] = visits["sex"].map({"M": 1.0, "F": 0.0})
    index = build_progression_index(visits, horizon_months=PROGRESSION_HORIZON_MONTHS)
    print(f"[index] rebuilt {len(index)} subjects at a {PROGRESSION_HORIZON_MONTHS}-month horizon")

    if INDEX.exists():
        old = pd.read_csv(INDEX)
        if len(old) != len(index):
            print(f"[fail] row count changed {len(old)} -> {len(index)}; not writing")
            return 1
        a = old.sort_values("subject_rid").reset_index(drop=True)
        b = index.sort_values("subject_rid").reset_index(drop=True)
        if not a["subject_rid"].equals(b["subject_rid"]):
            print("[fail] the subject set changed; not writing")
            return 1
        shared = [c for c in old.columns if c in index.columns and c != "subject_rid"]
        for col in shared:
            if not _same(a[col], b[col]):
                print(f"[fail] column '{col}' differs from the existing index; not writing")
                return 1
        print(f"[check] all {len(shared)} shared columns reproduce the existing index exactly")

    index.to_csv(INDEX, index=False)
    print(f"[write] {INDEX}")
    for f in PROJECTION_FEATURES:
        col = f"{f}_delta"
        n = int(index[col].notna().sum()) if col in index.columns else 0
        print(f"[target] {col:30s} measured on {n:5d} subjects")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
