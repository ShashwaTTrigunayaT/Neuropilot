"""Runtime settings for the API.

Thresholds are configurable (not hardcoded) because a real deployment would tune
them against local clinical validation data, per the blueprint.
"""
from __future__ import annotations

import os
from pathlib import Path

# backend/app/config.py -> project root is three levels up (override inside Docker)
PROJECT_ROOT = Path(os.getenv("PROJECT_ROOT", Path(__file__).resolve().parents[2]))

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