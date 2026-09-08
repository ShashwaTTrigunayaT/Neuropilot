"""Runtime settings for the API.

Thresholds are configurable (not hardcoded) because a real deployment would tune
them against local clinical validation data, per the blueprint.
"""
from __future__ import annotations

import os
from pathlib import Path

# backend/app/config.py -> project root is three levels up (override inside Docker).
# An EMPTY override value (e.g. `PROJECT_ROOT=` in .env) falls back to the
# computed default instead of silently becoming the process working directory.
_project_root_env = os.getenv("PROJECT_ROOT", "").strip()
PROJECT_ROOT = Path(_project_root_env) if _project_root_env else Path(__file__).resolve().parents[2]

# Auto-load .env from PROJECT_ROOT if it exists
_env_file = PROJECT_ROOT / ".env"
if _env_file.exists():
    try:
        for line in _env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                v = v.strip().strip('"').strip("'")
                if not v:  # empty value = unset, never shadow the code default
                    continue
                os.environ.setdefault(k.strip(), v)
    except Exception:
        pass

HIGH_THRESHOLD = float(os.getenv("HIGH_RISK_THRESHOLD", "0.7"))
MEDIUM_THRESHOLD = float(os.getenv("MEDIUM_RISK_THRESHOLD", "0.4"))

def _env_path(name: str, default: Path) -> Path:
    """Resolve an optional path override from env/.env.

    Relative values (e.g. `artifacts/pipeline.joblib` in .env) are resolved
    against PROJECT_ROOT -- NOT the process working directory -- so the API
    behaves identically whether uvicorn is started from the project root or
    from backend/. Absolute values (Docker) pass through unchanged. An empty
    value counts as unset.
    """
    raw = os.getenv(name)
    p = Path(raw) if raw else default
    return p if p.is_absolute() else PROJECT_ROOT / p


# Where the ML pipeline (scripts/) drops its artifacts
RISK_SCORES_PATH = _env_path(
    "RISK_SCORES_PATH", PROJECT_ROOT / "data" / "processed" / "risk_scores.json"
)
GLOBAL_IMPORTANCE_PATH = _env_path(
    "GLOBAL_IMPORTANCE_PATH", PROJECT_ROOT / "artifacts" / "global_importance.csv"
)
# Trained preprocessing + classifier pipeline (scripts/train_model.py)
MODEL_PATH = _env_path("MODEL_PATH", PROJECT_ROOT / "artifacts" / "pipeline.joblib")
MODEL_META_PATH = _env_path("MODEL_META_PATH", PROJECT_ROOT / "artifacts" / "model_meta.json")


def risk_tier(score: float) -> str:
    """Bucket a 0-1 risk score into high / medium / low."""
    if score > HIGH_THRESHOLD:
        return "high"
    if score >= MEDIUM_THRESHOLD:
        return "medium"
    return "low"