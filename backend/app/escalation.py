"""Deterministic escalation rule engine (blueprint section 4.5).

Plain if/else stage-gating logic -- auditable and defensible in a clinical
context. The system recommends the next test; the clinician decides (the API
enforces that via POST /patients/{id}/advance-stage).
"""
from __future__ import annotations

from typing import Optional, TypedDict

from .config import risk_tier

STAGES_SHORT = ["Cognitive", "Blood", "MRI", "PET"]
STAGES_FULL = ["Cognitive screening", "Blood biomarkers", "MRI volumetrics", "PET imaging"]

# Advancing to stage N attaches a pending result to this slot
RESULT_SLOT = {2: "blood", 3: "imaging", 4: "pet"}
RESULT_SLOT_LABEL = {"blood": "Blood biomarkers", "imaging": "MRI volumetrics", "pet": "PET imaging"}


class Action(TypedDict):
    summary: str
    button: str


def next_action_for(patient: dict) -> Optional[Action]:
    """(stage, risk tier) -> recommended next step; None when the pipeline is complete."""
    tier = risk_tier(patient["score"])
    stage = patient["stage"]

    if stage == 1:
        if tier == "low":
            return {"summary": "Routine follow-up — re-screen cognition in 12 months.", "button": "Schedule 12-month re-screen"}
        return {"summary": "Blood biomarker panel (p-tau181, Aβ42/40) to refine risk.", "button": "Order blood biomarker panel"}
    if stage == 2:
        if tier == "low":
            return {"summary": "Routine follow-up — re-screen cognition in 12 months.", "button": "Schedule 12-month re-screen"}
        return {"summary": "MRI with volumetric analysis (hippocampal volume).", "button": "Order MRI"}
    if stage == 3:
        if tier == "high":
            return {"summary": "Amyloid / tau PET to confirm pathology before specialist referral.", "button": "Order PET scan"}
        if tier == "medium":
            return {"summary": "Monitor — repeat MRI volumetrics in 12 months.", "button": "Schedule follow-up MRI"}
        return {"summary": "No structural concern — return to routine screening.", "button": "Return to routine screening"}
    return None  # stage 4: pipeline complete


def can_advance(patient: dict) -> bool:
    """Only test-ordering escalations are auto-confirmable; routine follow-ups keep the clinician in the loop."""
    action = next_action_for(patient)
    return bool(action) and not action["button"].startswith(("Schedule", "Return"))