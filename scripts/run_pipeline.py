#!/usr/bin/env python3
"""One-command pipeline runner (blueprint section 3, Scheduling row).

Trains on the REAL ADNI drop in "ADNI DATA/": scripts/ingest_adni.py, then
scripts/train_model.py --data adni, then the progression forecaster off the same
ingestion. Real clinician labels, all four stages, no simulation.

Safe to put on a cron schedule (the pragmatic hackathon answer to "repeatable,
auditable ingestion" -- Airflow is the production answer).

Usage:
    python scripts/run_pipeline.py [--model xgb|rf|auto]
    python scripts/run_pipeline.py --refresh-railway

`--refresh-railway` is opt-in. After the local ADNI ingestion and both model
training steps succeed, it opens a temporary Railway tunnel, refreshes the
persistent database, retries resumable batches if needed, and closes the tunnel.
It never runs during API startup or FHIR ingestion.

Cron example (weekly, Mondays 02:00):
    0 2 * * 1 cd /path/to/project && python scripts/run_pipeline.py >> data/pipeline.log 2>&1
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ADNI_DIR = ROOT / "ADNI DATA"


def run(script: Path, *args: str) -> None:
    print(f"\n===== {script.name} {' '.join(args)} ===== ".rstrip())
    subprocess.run([sys.executable, str(script), *args], cwd=ROOT, check=True)


def _explicit_data_mode(argv: list[str]) -> str | None:
    for i, a in enumerate(argv):
        if a in ("--data",) and i + 1 < len(argv):
            return argv[i + 1]
        if a.startswith("--data="):
            return a.split("=", 1)[1]
    return None


def main() -> int:
    raw_args = sys.argv[1:]
    refresh_railway = "--refresh-railway" in raw_args
    args = [a for a in raw_args if a != "--refresh-railway"]
    data_mode = _explicit_data_mode(args)

    has_adni_tables = ADNI_DIR.exists() and any(ADNI_DIR.glob("*.csv"))

    if data_mode not in (None, "adni"):
        print(f"[run_pipeline] --data {data_mode} is no longer a supported mode; "
              "the pipeline trains on the real ADNI drop only")
        return 1
    if not has_adni_tables:
        print(f"[run_pipeline] no CSVs in {ADNI_DIR} — place the real ADNI drop there "
              "(MMSE, plasma panel, FreeSurfer MRI, amyloid/tau PET, ADAS-Cog, APOE, DXSUM)")
        return 1

    n = len(list(ADNI_DIR.glob("*.csv")))
    print(f"[run_pipeline] real ADNI drop detected ({n} CSV tables) — real data path")
    run(ROOT / "scripts" / "ingest_adni.py")
    # pin --data adni unless the caller chose a mode explicitly
    train_args = args if data_mode is not None else ["--data", "adni", *args]
    run(ROOT / "scripts" / "train_model.py", *train_args)
    # The progression forecaster trains off the same ingestion
    # (data/processed/adni_progression.csv). Keeping it in the pipeline is
    # what stops the served forecast from silently drifting behind a retrain.
    run(ROOT / "scripts" / "train_progression_model.py", "--data", "adni")
    served = "adni"

    print(
        f"\n[done] pipeline finished. The API now serves the {served} cohort "
        f"(check GET /health -> data_source/patients) and POST /patients/score uses "
        "artifacts/pipeline.joblib."
    )
    if refresh_railway:
        print("\n[run_pipeline] --refresh-railway requested; refreshing Railway now")
        run(ROOT / "scripts" / "refresh_railway.py")
    else:
        print(
            "\nRailway was not refreshed. Use --refresh-railway after a successful "
            "retrain to update the deployed database."
        )

    print(
        "\nTo schedule weekly: add this to crontab:\n"
        '  0 2 * * 1 cd ' + str(ROOT) + ' && python scripts/run_pipeline.py --refresh-railway >> data/pipeline.log 2>&1'
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
