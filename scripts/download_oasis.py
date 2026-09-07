#!/usr/bin/env python3
"""Download the OASIS-1 longitudinal CSV into data/raw/oasis_longitudinal.csv.

This is OPTIONAL -- if you already have the file, just drop it at
data/raw/oasis_longitudinal.csv and skip this script.

The canonical source is the OASIS project (https://sites.wustl.edu/oasisbrains/).
The raw CSV is widely mirrored (Kaggle etc.); this script tries several public
mirrors and verifies the result looks like the real file (known header + ~373 rows).
"""
from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

DEST = Path("data/raw/oasis_longitudinal.csv")

MIRRORS = [
    # Verified reachable mirror (public GitHub dataset repo)
    "https://raw.githubusercontent.com/MainakRepositor/Datasets/master/oasis_longitudinal.csv",
    # Alternate forks of the same mini-kaggle repo (master / main branches)
    "https://raw.githubusercontent.com/MainakVerse/Datasets/master/oasis_longitudinal.csv",
    "https://raw.githubusercontent.com/MainakVerse/Datasets/main/oasis_longitudinal.csv",
    # Historic OASIS-1 hosting location (may or may not still serve the file)
    "https://www.oasis-brains.org/files/oasis_longitudinal.csv",
]

HEADER_HINT = b"Subject ID,MRI ID,Group,Visit,MR Delay"


def main() -> int:
    if DEST.exists():
        print(f"[skip] {DEST} already exists ({DEST.stat().st_size:,} bytes).")
        return 0

    DEST.parent.mkdir(parents=True, exist_ok=True)

    for url in MIRRORS:
        print(f"[try]  {url}")
        try:
            with urllib.request.urlopen(url, timeout=30) as resp:
                data = resp.read()
        except Exception as exc:  # noqa: BLE001 -- any network error -> next mirror
            print(f"       failed: {exc}")
            continue

        if HEADER_HINT not in data[:2000]:
            print("       downloaded, but does not look like oasis_longitudinal.csv; trying next mirror")
            continue

        DEST.write_bytes(data)
        n_rows = data.count(b"\n")
        print(f"[ok]   saved {DEST} ({len(data):,} bytes, {n_rows} lines)")
        if n_rows < 350:
            print("       WARNING: expected ~373 data rows; file looks short -- inspect before using.")
        return 0

    print(
        "\nCould not download from any mirror. Place the file manually at:\n"
        f"  {DEST}\n"
        "Sources: OASIS project (sites.wustl.edu/oasisbrains) or Kaggle "
        "('oasis_longitudinal.csv'). Then run: python scripts/ingest.py"
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
