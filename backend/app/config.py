"""Runtime settings for the API.

Thresholds are configurable (not hardcoded) because a real deployment would tune
them against local clinical validation data, per the blueprint.
"""
from __future__ import annotations

import os
from pathlib import Path

# backend/app/config.py -> project root is three levels up (override inside Docker)
PROJECT_ROOT = Path(os.getenv("PROJECT_ROOT", Path(__file__).resolve().parents[2]))

# Auto-load .env from PROJECT_ROOT if it exists
_env_file = PROJECT_ROOT / ".env"
if _env_file.exists():
    try:
        for line in _env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except Exception:
        pass

HIGH_THRESHOLD = float(os.getenv("HIGH_RISK_THRESHOLD", "0.7"))
MEDIUM_THRESHOLD = float(os.getenv("MEDIUM_RISK_THRESHOLD", "0.4"))

# Where the ML pipeline (scripts/) drops its artifacts
RISK_SCORES_PATH = Path(
    os.getenv("RISK_SCORES_PATH", PROJECT_ROOT / "data" / "processed" / "risk_scores.json")
)
GLOBAL_IMPORTANCE_PATH = Path(
    os.getenv("GLOBAL_IMPORTANCE_PATH", PROJECT_ROOT / "artifacts" / "global_importance.csv")
)
# Trained preprocessing + classifier pipeline (scripts/train_model.py)
MODEL_PATH = Path(os.getenv("MODEL_PATH", PROJECT_ROOT / "artifacts" / "pipeline.joblib"))
MODEL_META_PATH = Path(os.getenv("MODEL_META_PATH", PROJECT_ROOT / "artifacts" / "model_meta.json"))


def risk_tier(score: float) -> str:
    """Bucket a 0-1 risk score into high / medium / low."""
    if score > HIGH_THRESHOLD:
        return "high"
    if score >= MEDIUM_THRESHOLD:
        return "medium"
    return "low"