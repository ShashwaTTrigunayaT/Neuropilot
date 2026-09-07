#!/usr/bin/env python3
"""One-command pipeline runner (blueprint section 3, Scheduling row).

Downloads the raw OASIS CSV if missing, then runs ingest + train in order.
Safe to put on a cron schedule (hackathon answer to "repeatable, auditable
ingestion" -- Airflow is the production answer).

Usage:
    python scripts/run_pipeline.py [--model xgb|rf|auto]

Cron example (weekly, Mondays 02:00):
    0 2 * * 1 cd /path/to/project && python scripts/run_pipeline.py >> data/pipeline.log 2>&1
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "oasis_longitudinal.csv"


def run(script: Path, *args: str) -> None:
    print(f"\n===== {script.name} {' '.join(args)} =====")
    subprocess.run([sys.executable, str(script), *args], cwd=ROOT, check=True)


def main() -> int:
    if not RAW.exists():
        print("[run_pipeline] raw OASIS CSV missing — attempting download…")
        try:
            run(ROOT / "scripts" / "download_oasis.py")
        except subprocess.CalledProcessError:
            print(
                "Download failed. Place oasis_longitudinal.csv manually at:\n"
                f"  {RAW}\nThen re-run this script."
            )
            return 1
        if not RAW.exists():
            return 1

    run(ROOT / "scripts" / "ingest.py")
    run(ROOT / "scripts" / "train_model.py", *sys.argv[1:])

    print(
        "\n[done] pipeline finished. The API now serves the real scored subjects "
        "(check GET /health data_source='real') and POST /patients/score uses "
        "artifacts/pipeline.joblib."
    )
    print(
        "\nTo schedule weekly: add this to crontab:\n"
        '  0 2 * * 1 cd ' + str(ROOT) + ' && python scripts/run_pipeline.py >> data/pipeline.log 2>&1'
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())