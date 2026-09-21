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

import argparse
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


def _preflight(url: str) -> str | None:
    """Explain a URL that cannot possibly work from this machine.

    Railway hands out two connection strings and they look alike. The private one
    is the right value for the deployed service, and guaranteed to fail here:
    `RAILWAY_PRIVATE_DOMAIN` resolves to `*.railway.internal`, which only exists
    inside the Railway project. The template form never worked either, because
    `${{...}}` is substituted by Railway, not by a shell.
    """
    if "${" in url:
        return (
            "this is a Railway template REFERENCE, not a connection string.\n"
            "          Railway substitutes ${{...}} inside its own services; a shell passes\n"
            "          it through literally, so it can never resolve. Copy the RESOLVED\n"
            "          value instead."
        )
    if "railway.internal" in url or "RAILWAY_PRIVATE_DOMAIN" in url:
        return (
            "this is the PRIVATE domain, which resolves only inside your Railway\n"
            "          project -- your machine cannot reach it, and neither can any client\n"
            "          outside Railway. Keep it for the deployed service; for seeding use\n"
            "          the PUBLIC one: Postgres service -> Settings -> Public Networking ->\n"
            "          TCP Proxy (then read DATABASE_PUBLIC_URL on the Variables tab)."
        )
    return None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Seed a deployment database from the local real-ADNI cohort."
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=db.SEED_CHUNK_PATIENTS,
        help=f"patients per committed batch (default {db.SEED_CHUNK_PATIENTS}). Lower "
             "it if the link to the database is slow or unstable; seeding is "
             "resumable, so a smaller batch just means less re-sent after a drop",
    )
    parser.add_argument(
        "--allow-local",
        action="store_true",
        help="permit a local sqlite target (this script targets a DEPLOYMENT database; "
             "without this flag a sqlite URL is refused, so a stray .env DATABASE_URL "
             "cannot silently re-seed your local demo store)",
    )
    args = parser.parse_args()

    if not db.enabled():
        print(
            "[seed_db] no DATABASE_URL is set, so there is nothing to seed.\n"
            "          Set it to the deployment database (Railway -> Postgres ->\n"
            "          Connect -> the public URL) and run again.\n"
            "          Without a URL the app simply serves the local cohort file."
        )
        return 1

    url = db.get_database_url() or ""
    problem = _preflight(url)
    if problem:
        print(f"[seed_db] refusing to run: {problem}")
        return 1

    print(f"[seed_db] target database: {_redacted(url)}")

    # A deployment database is reached over the network. A local sqlite file is
    # almost always an accident here: .env supplies DATABASE_URL automatically, so
    # `python scripts/seed_db.py` with no variables set would re-seed the LOCAL
    # demo store instead of the deployment. Require an explicit opt-in.
    if url.startswith("sqlite") and not args.allow_local:
        print(
            "[seed_db] refusing to run: that is a LOCAL sqlite file, which is not a\n"
            "          deployment database. This happens when .env supplies\n"
            "          DATABASE_URL and no connection details were passed to this\n"
            "          command. Pass a deployment database (or --allow-local to seed\n"
            "          the local store on purpose):\n"
            "            PGHOST=<proxy host> PGPORT=<proxy port> PGUSER=<user> \\\n"
            "              PGPASSWORD=<password> PGDATABASE=<db> python scripts/seed_db.py"
        )
        return 1

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
    print("[seed_db] writing in batches (patients + cognitive, lab, factor and history "
          "rows) -- a minute or two over a tunnel is normal; the progress line shows "
          "how far it got, and re-running is safe")

    # A connection failure is the most likely outcome here (wrong URL, database
    # asleep, network), and a raw SQLAlchemy traceback would bury the one line
    # that matters.
    try:
        db.init_db()
        # Do not call load_all() over the Railway tunnel: it assembles every
        # patient's child rows with N+1 queries and can drop the tunnel before
        # the actual seed starts. Counts are sufficient for this operator check.
        before = db.count_patients()
        # force=True: an operator asked for this explicitly, so the command is
        # idempotent and also usable as the post-retrain refresh.
        db.seed_if_empty(records, source, force=True, chunk_size=max(1, args.chunk_size))
        after = db.count_patients()
    except Exception as exc:  # noqa: BLE001 -- operator command: report, do not trace
        print(f"[seed_db] could not reach or write the database ({type(exc).__name__}): {exc}")
        print("          Check DATABASE_URL (Railway -> Postgres -> Connect -> public URL)"
              " and that the database is running.")
        return 1

    print(f"[seed_db] done: {before} -> {after} patient(s) stored")
    if after != len(records):
        print(
            f"[seed_db] WARNING: the database holds {after} patients but the file\n"
            f"          has {len(records)} -- check the column widths and foreign keys."
        )
        return 1
    print("[seed_db] the deployment now serves this cohort from the database. A retrain "
          "changes the cohort fingerprint, so run this again afterwards.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
