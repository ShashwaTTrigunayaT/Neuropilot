#!/usr/bin/env python3
"""Audit the real ADNI data drop in "ADNI DATA/".

Answers one question: do we actually have all four measure families
(cognition, blood, MRI, PET) for enough subjects to build the NeuroPilot
feature vector?

Read-only. Prints a coverage report, writes nothing.

Usage:  python scripts/inspect_adni_coverage.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
ADNI_DIR = ROOT / "ADNI DATA"

# name -> (filename, columns, the real date column for temporal alignment)
FILES = {
    "diagnosis": ("DXSUM_17Sep2026.csv",
                  ["RID", "PTID", "VISCODE", "EXAMDATE", "DIAGNOSIS"], "EXAMDATE"),
    "cognition": ("MMSE_17Sep2026.csv",
                  ["RID", "PTID", "VISCODE", "VISDATE", "MMSCORE"], "VISDATE"),
    "demographics": ("PTDEMOG_17Sep2026.csv",
                     ["RID", "PTID", "PTGENDER", "PTDOBYY", "PTEDUCAT"], None),
    "blood": ("UPENN_PLASMA_FUJIREBIO_QUANTERIX_17Sep2026.csv",
              ["RID", "PTID", "VISCODE", "EXAMDATE", "pT217_F", "AB42_F", "AB40_F",
               "AB42_AB40_F", "NfL_Q", "GFAP_Q"], "EXAMDATE"),
    "mri": ("UCSFFSX7_17Sep2026.csv",
            ["RID", "PTID", "VISCODE", "EXAMDATE", "STATUS", "OVERALLQC",
             "ST10CV", "ST29SV", "ST88SV"],
            "EXAMDATE"),
    "pet_amyloid": ("UCBERKELEY_AMY_6MM_17Sep2026.csv",
                    ["RID", "PTID", "VISCODE", "SCANDATE", "qc_flag", "TRACER",
                     "AMYLOID_STATUS", "CENTILOIDS", "SUMMARY_SUVR"], "SCANDATE"),
    "pet_tau": ("UCBERKELEY_TAU_6MM_17Sep2026.csv",
                ["RID", "PTID", "VISCODE", "SCANDATE", "qc_flag", "TRACER",
                 "META_TEMPORAL_SUVR"], "SCANDATE"),
}

# modalities we try to co-locate around a cognitive visit
ALIGN = ["blood", "mri", "pet_amyloid", "pet_tau"]
TOLERANCE_DAYS = 183  # +/- 6 months


def load(fname: str, cols: list[str]) -> tuple[pd.DataFrame, list[str]]:
    path = ADNI_DIR / fname
    if not path.exists():
        return pd.DataFrame(), []
    head = pd.read_csv(path, nrows=0)
    present = [c for c in cols if c in head.columns]
    missing = [c for c in cols if c not in head.columns]
    df = pd.read_csv(path, usecols=present, low_memory=False)
    return df, missing


def nearest_match(subject_df: pd.DataFrame, cog: pd.DataFrame, tol: int) -> pd.DataFrame:
    """For each cognitive visit, find the nearest measure of another modality.

    Returns cognitive rows with <modality>_date / <modality>_gap_days columns; rows
    without a match inside `tol` get NaN and are dropped by the caller.
    """
    if subject_df.empty or cog.empty:
        return cog.assign(match_date=pd.NaT, gap_days=pd.NA)
    other = subject_df["date"].dropna().sort_values()
    if other.empty:
        return cog.assign(match_date=pd.NaT, gap_days=pd.NA)
    matches, gaps = [], []
    for d in cog["date"]:
        if pd.isna(d):
            matches.append(pd.NaT)
            gaps.append(pd.NA)
            continue
        deltas = (other - d).abs()
        best = deltas.idxmin()
        gap = int(deltas.loc[best].days)
        if gap <= tol:
            matches.append(other.loc[best])
            gaps.append(gap)
        else:
            matches.append(pd.NaT)
            gaps.append(pd.NA)
    return cog.assign(match_date=matches, gap_days=gaps)


# model feature -> (modality, source column)
FEATURE_SPEC = [
    ("mmse", "cognition", "MMSCORE"),
    ("mmse_prior", "cognition", "__prev__"),
    ("age", "demographics", "age"),
    ("sex", "demographics", "PTGENDER"),
    ("education_years", "demographics", "PTEDUCAT"),
    ("hippocampus_left", "mri", "ST29SV"),
    ("hippocampus_right", "mri", "ST88SV"),
    ("icv", "mri", "ST10CV"),
    ("ptau217", "blood", "pT217_F"),
    ("abeta42_ab40", "blood", "AB42_AB40_F"),
    ("nfl", "blood", "NfL_Q"),
    ("gfap", "blood", "GFAP_Q"),
    ("centiloids", "pet_amyloid", "CENTILOIDS"),
    ("amyloid_status", "pet_amyloid", "AMYLOID_STATUS"),
    ("tau_meta_temporal", "pet_tau", "META_TEMPORAL_SUVR"),
    ("diagnosis", "diagnosis", "DIAGNOSIS"),
]

MEASURE_MODS = [
    ("blood", ["pT217_F", "AB42_AB40_F", "NfL_Q", "GFAP_Q"]),
    ("mri", ["ST10CV", "ST29SV", "ST88SV"]),
    ("pet_amyloid", ["CENTILOIDS", "AMYLOID_STATUS", "SUMMARY_SUVR"]),
    ("pet_tau", ["META_TEMPORAL_SUVR"]),
    ("diagnosis", ["DIAGNOSIS"]),
]


def build_wide(frames: dict[str, pd.DataFrame], tol: int = TOLERANCE_DAYS) -> pd.DataFrame:
    """One row per scored MMSE visit, with the nearest value of every other
    modality attached (NaN when nothing falls inside `tol`)."""
    cog = frames["cognition"].copy()
    cog["date"] = pd.to_datetime(cog["VISDATE"], errors="coerce")
    cog["MMSCORE"] = pd.to_numeric(cog["MMSCORE"], errors="coerce")
    cog = cog[cog["MMSCORE"].notna() & (cog["MMSCORE"] >= 0) & cog["date"].notna()]
    cog = cog[["RID", "date", "MMSCORE"]].sort_values(["RID", "date"])
    cog["year"] = cog["date"].dt.year

    for mod, cols in MEASURE_MODS:
        raw = frames.get(mod)
        if raw is None or raw.empty:
            continue
        o = raw.copy()
        o["date"] = pd.to_datetime(o[FILES[mod][2]], errors="coerce")
        o = o[o["date"].notna() & o["RID"].notna()]
        cols = [c for c in cols if c in o.columns]
        if not cols:
            continue
        o = o[["RID", "date"] + cols].sort_values("date")
        for c in cols:
            o[c] = pd.to_numeric(o[c], errors="coerce")
        by_rid = {int(r): g for r, g in o.groupby("RID")}
        collected = {c: [] for c in cols}
        for rid, d in zip(cog["RID"], cog["date"]):
            g = by_rid.get(int(rid))
            if g is None or g.empty:
                for c in cols:
                    collected[c].append(pd.NA)
                continue
            idx = (g["date"] - d).abs().idxmin()
            in_window = abs((g.loc[idx, "date"] - d).days) <= tol
            for c in cols:
                collected[c].append(g.loc[idx, c] if in_window else pd.NA)
        for c in cols:
            cog[c] = pd.Series(collected[c], index=cog.index)

    # subject-level demographics
    demo = frames.get("demographics")
    if demo is not None and not demo.empty:
        d = demo.drop_duplicates(subset=["RID"]).set_index("RID")
        cog["PTGENDER"] = cog["RID"].map(d.get("PTGENDER"))
        cog["PTEDUCAT"] = pd.to_numeric(cog["RID"].map(d.get("PTEDUCAT")), errors="coerce")
        # PTDOBYY is a date string (e.g. "1931-01-01"), not an integer year.
        dob = pd.to_datetime(cog["RID"].map(d.get("PTDOBYY")), errors="coerce")
        cog["age"] = pd.to_numeric(cog["year"], errors="coerce") - dob.dt.year

    cog["__prev__"] = cog.groupby("RID")["MMSCORE"].shift(1)
    return cog


def main() -> int:
    if not ADNI_DIR.exists():
        print(f"[fail] no ADNI folder at {ADNI_DIR}")
        return 1

    frames: dict[str, pd.DataFrame] = {}
    print("=" * 72)
    print("ADNI drop -- per-file audit")
    print("=" * 72)
    for name, (fname, cols, _datecol) in FILES.items():
        df, missing = load(fname, cols)
        frames[name] = df
        if df.empty:
            print(f"\n[{name}] MISSING FILE: {fname}")
            continue
        print(f"\n[{name}] {fname}")
        print(f"  rows                 : {len(df):,}")
        print(f"  unique RID           : {df['RID'].nunique():,}")
        print(f"  unique PTID          : {df['PTID'].nunique():,}")
        if "VISCODE" in df.columns:
            top = df["VISCODE"].value_counts().head(6)
            print(f"  visits (top)         : {dict(top)}")
        if missing:
            print(f"  [!] missing columns  : {missing}")
        if name == "cognition":
            s = pd.to_numeric(df["MMSCORE"], errors="coerce")
            print(f"  MMSCORE non-null     : {s.notna().sum():,} "
                  f"(mean {s.mean():.1f}, range {s.min():.0f}-{s.max():.0f})")
        if name == "diagnosis":
            print(f"  DIAGNOSIS values     : {dict(df['DIAGNOSIS'].value_counts(dropna=False))}")
        if name == "blood":
            for c in ("pT217_F", "AB42_AB40_F", "NfL_Q", "GFAP_Q"):
                v = pd.to_numeric(df[c], errors="coerce")
                print(f"  {c:<14} non-null: {v.notna().sum():,}  mean {v.mean():.3f}")
        if name == "mri":
            v = pd.to_numeric(df["ST29SV"], errors="coerce")
            print(f"  ST29SV (hippo) meas. : {v.notna().sum():,}")
            print(f"  OVERALLQC values     : {dict(df['OVERALLQC'].value_counts(dropna=False).head(5))}")
        if name in ("pet_amyloid", "pet_tau"):
            print(f"  TRACER values        : {dict(df['TRACER'].value_counts(dropna=False))}")
            if "AMYLOID_STATUS" in df.columns:
                print(f"  AMYLOID_STATUS       : {dict(df['AMYLOID_STATUS'].value_counts(dropna=False))}")

    # ---- cross-modal coverage on RID ----
    print("\n" + "=" * 72)
    print("Cross-modal coverage (unique RID with >=1 measurement)")
    print("=" * 72)
    sets = {k: set(v["RID"].dropna().astype(int)) for k, v in frames.items() if not v.empty}
    for k, s in sets.items():
        print(f"  {k:<14}: {len(s):>6,} subjects")

    # ---- temporal alignment feasibility ----
    print("\n" + "=" * 72)
    print(f"Temporal alignment (+/- {TOLERANCE_DAYS} days of a scored MMSE visit)")
    print("=" * 72)
    cog_raw = frames.get("cognition", pd.DataFrame())
    aligned: dict[str, pd.DataFrame] = {}
    if not cog_raw.empty and "VISDATE" in cog_raw.columns:
        cog = cog_raw.copy()
        cog["date"] = pd.to_datetime(cog["VISDATE"], errors="coerce")
        cog["MMSCORE"] = pd.to_numeric(cog["MMSCORE"], errors="coerce")
        # -1 is ADNI's "not administered" sentinel
        cog = cog[cog["MMSCORE"].notna() & (cog["MMSCORE"] >= 0) & cog["date"].notna()]
        cog = cog.sort_values(["RID", "date"])

        for mod in ALIGN:
            raw = frames.get(mod, pd.DataFrame())
            datecol = FILES[mod][2]
            if raw.empty or datecol not in raw.columns:
                continue
            other = raw.copy()
            other["date"] = pd.to_datetime(other[datecol], errors="coerce")
            other = other[other["date"].notna()]

            pairs = []
            other_by_rid = {rid: g for rid, g in other.groupby("RID")}
            for rid, g in cog.groupby("RID"):
                o = other_by_rid.get(rid)
                if o is None or o.empty:
                    continue
                m = nearest_match(o, g[["date"]], TOLERANCE_DAYS).dropna(subset=["match_date"])
                if not m.empty:
                    pairs.append((rid, g.index, m))
            matched_visits = sum(len(m) for _, _, m in pairs)
            matched_subjects = len(pairs)
            aligned[mod] = pd.DataFrame({"RID": [r for r, _, _ in pairs]})
            print(f"  {mod:<14}: {matched_subjects:>5,} subjects  {matched_visits:>6,} aligned visits")

        common = None
        for mod in ALIGN:
            if mod in aligned:
                s = set(aligned[mod]["RID"].dropna().astype(int))
                common = s if common is None else (common & s)
        if common is not None:
            print(f"\n  all four aligned to a scored MMSE visit  : {len(common):,} subjects")

    def n(label: str, combo: list[str]) -> None:
        if not all(c in sets for c in combo):
            return
        inter = set.intersection(*(sets[c] for c in combo))
        print(f"  {label:<42}: {len(inter):>6,}")

    print()
    n("cognition only", ["cognition"])
    n("cognition + diagnosis", ["cognition", "diagnosis"])
    n("cognition + blood", ["cognition", "blood"])
    n("cognition + MRI", ["cognition", "mri"])
    n("cognition + amyloid PET", ["cognition", "pet_amyloid"])
    n("cognition + tau PET", ["cognition", "pet_tau"])
    n("cognition + blood + MRI", ["cognition", "blood", "mri"])
    n("cognition + blood + MRI + amyloid", ["cognition", "blood", "mri", "pet_amyloid"])
    n("ALL FOUR (cog+blood+mri+amy) + dx", ["cognition", "blood", "mri", "pet_amyloid", "diagnosis"])
    n("ALL FIVE incl. tau PET", ["cognition", "blood", "mri", "pet_amyloid", "pet_tau"])
    n("ALL FIVE incl. tau + dx + demog",
      ["cognition", "blood", "mri", "pet_amyloid", "pet_tau", "diagnosis", "demographics"])

    all_four = set.intersection(sets["cognition"], sets["blood"], sets["mri"], sets["pet_amyloid"])
    if all_four:
        # how many are longitudinally repeated (>=2 MMSE visits)?
        cog = frames["cognition"]
        cog = cog[pd.to_numeric(cog["MMSCORE"], errors="coerce").notna()]
        reps = cog[cog["RID"].isin(all_four)].groupby("RID").size()
        print(f"\n  of those {len(all_four):,}, with >=2 scored MMSE visits: "
              f"{int((reps >= 2).sum()):,}")
        print(f"  mean scored visits per such subject: {reps.mean():.1f}")

    # ---- are the data points we actually serve populated? ----
    print("\n" + "=" * 72)
    print("Feature completeness on aligned, scored MMSE visits")
    print("=" * 72)
    wide = build_wide(frames)
    total = len(wide)
    print(f"  rows (scored MMSE visits): {total:,} across {wide['RID'].nunique():,} subjects\n")
    print(f"  {'feature':<20}{'source':<14}{'present':>10}{'%':>8}")
    for feat, mod, col in FEATURE_SPEC:
        if col not in wide.columns:
            print(f"  {feat:<20}{mod:<14}{'MISSING':>10}{'-':>8}")
            continue
        present = int(wide[col].notna().sum())
        print(f"  {feat:<20}{mod:<14}{present:>10,}{100 * present / total:>7.1f}%")

    have_core = wide[["MMSCORE", "age", "PTGENDER"]].notna().all(axis=1)
    have_all_mri = wide[["ST29SV", "ST88SV", "ST10CV"]].notna().all(axis=1)
    have_blood = wide[["pT217_F", "AB42_AB40_F", "NfL_Q", "GFAP_Q"]].notna().all(axis=1)
    have_all_four = (have_all_mri & have_blood & wide["CENTILOIDS"].notna()
                     & wide[["DIAGNOSIS", "age", "PTGENDER"]].notna().all(axis=1))
    print(f"\n  rows with cognition + age + sex            : {int(have_core.sum()):,}")
    print(f"  rows with full MRI (hippo + ICV)           : {int(have_all_mri.sum()):,}")
    print(f"  rows with full blood panel                 : {int(have_blood.sum()):,}")
    print(f"  rows with ALL FOUR + label + age + sex     : {int(have_all_four.sum()):,}")
    print(f"  such subjects                              : "
          f"{wide.loc[have_all_four, 'RID'].nunique():,}")
    if have_all_four.any():
        lbl = wide.loc[have_all_four, "DIAGNOSIS"].value_counts()
        print(f"  their label mix (1=CN, 2=MCI, 3=Dementia)  : "
              f"{ {int(k): int(v) for k, v in lbl.items()} }")
        sub = wide.loc[have_all_four]
        print(f"  of those rows, tau PET also present        : "
              f"{int(sub['META_TEMPORAL_SUVR'].notna().sum()):,}"
              f"  ({sub.loc[sub['META_TEMPORAL_SUVR'].notna(), 'RID'].nunique():,} subjects)")
        print(f"  rows usable for mmse_change (prior visit)  : "
              f"{int((have_all_four & wide['__prev__'].notna()).sum()):,}")

    print("\n[done] ADNI data copy is read-only; nothing written.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
