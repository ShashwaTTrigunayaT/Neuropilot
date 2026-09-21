#!/usr/bin/env python3
"""Seed the DEPLOYMENT database from the local real-ADNI cohort.

Why this exists
---------------
The served cohort is derived from ADNI, which is access-controlled under a Data
Use Agreement: it is deliberately NOT committed to git, and therefore cannot be
`COPY`-ed into the image either (a build from the repository has no cohort file
to copy). So the deployment does not ship the dataset. Instead the database is
seeded ONCE from a machine that legitimately holds the data, and the container
reads the cohort back out of Postgres.

That is what turns this boot log line into the healthy state:

    [api] data source: postgres (2581 patients loaded)

Usage
-----
    # against the database the deployment uses
    DATABASE_URL='postgresql://user:pw@host:5432/railway' python scripts/seed_db.py

    # or, if the URL already sits in .env, simply
    python scripts/seed_db.py

Run it again after every retrain: the stored cohort fingerprint folds in the
served model's identity, and the derived fields (score, tier, risk factors) have
to be recomputed against the new model.

Safety
------
* Refuses to run without DATABASE_URL -- this never touches the local demo.
* Refuses to seed placeholder stubs; real data is never replaced by stubs.
* An empty cohort is a hard error, never a silent wipe.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app import db, storage  # noqa: E402
from app.config import MISSING_DATA_SOURCE, STUB_DATA_SOURCE  # noqa: E402


def _redacted(url: str) -> str:
    """Postgres URL safe to print: credentials stripped, host kept."""
    if "@" not in url:
        return url
    scheme, _, rest = url.partition("://")
    return f"{scheme or 'postgresql'}://***@{rest.split('@', 1)[1]}"


def main() -> int:
    if not db.enabled():
        print(
            "[seed_db] no DATABASE_URL is set, so there is nothing to seed.\n"
            "          Set it to the deployment database (Railway -> Postgres ->\n"
            "          Connect -> the public URL) and run again.\n"
            "          Without a URL the app simply serves the local cohort file."
        )
        return 1

    print(f"[seed_db] target database: {_redacted(db.get_database_url() or '')}")

    records, source = storage.load_cohort_file()
    if source == MISSING_DATA_SOURCE or not records:
        print(
            "[seed_db] the real cohort file is missing or empty "
            f"(data/processed/adni_cohort.json, source={source}).\n"
            "          Build it first:  python scripts/run_pipeline.py"
        )
        return 1
    if source == STUB_DATA_SOURCE:
        print(
            "[seed_db] refusing to seed: the only cohort available is the placeholder\n"
            "          stubs, and real data must never be replaced by stubs."
        )
        return 1

    print(f"[seed_db] local cohort file: {len(records)} patient(s) with a real result")

    # A connection failure is the most likely outcome here (wrong URL, database
    # asleep, network), and a raw SQLAlchemy traceback would bury the one line
    # that matters.
    try:
        db.init_db()
        before = len(db.load_all() or [])
        # force=True: an operator asked for this explicitly, so the command is
        # idempotent and also usable as the post-retrain refresh.
        db.seed_if_empty(records, source, force=True)
        after = db.load_all() or []
    except Exception as exc:  # noqa: BLE001 -- operator command: report, do not trace
        print(f"[seed_db] could not reach or write the database ({type(exc).__name__}): {exc}")
        print("          Check DATABASE_URL (Railway -> Postgres -> Connect -> public URL)"
              " and that the database is running.")
        return 1

    print(f"[seed_db] done: {before} -> {len(after)} patient(s) stored")
    if len(after) != len(records):
        print(
            f"[seed_db] WARNING: the database holds {len(after)} patients but the file\n"
            f"          has {len(records)} -- check the column widths and foreign keys."
        )
        return 1
    print("[seed_db] the deployment now serves this cohort from the database. A retrain "
          "changes the cohort fingerprint, so run this again afterwards.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
