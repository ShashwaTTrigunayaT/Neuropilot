"""API schemas.

Contract (blueprint section 6): no endpoint ever returns a diagnosis field --
only risk_tier, reasoning, and recommended_next_test.
"""
from __future__ import annotations

from typing import Any, List, Optional

from pydantic import BaseModel


class Factor(BaseModel):
    """Per-patient attribution factor.

    `feature` is the raw model feature key (used by the UI to group factors by
    pipeline stage) and `value` the patient's measured value (rendered next to
    the label). Both must survive serialization.
    """

    feature: Optional[str] = None
    text: str
    value: Optional[float] = None
    effect: float


class HistoryEntry(BaseModel):
    at: str
    text: str


class PatientSummary(BaseModel):
    id: str
    age: Optional[int] = None
    sex: Optional[str] = None
    education_years: Optional[int] = None
    cognitive: Optional[dict] = None
    score: float
    risk_tier: str
    stage: int
    stage_name: str
    recommended_next: Optional[str] = None
    updated_at: str


class PatientDetail(PatientSummary):
    cognitive: Optional[dict] = None
    comorbidities: List[str] = []
    family_history: bool = False
    blood: Optional[dict] = None
    imaging: Optional[dict] = None
    pet: Optional[dict] = None
    factors: List[Factor] = []
    history: List[HistoryEntry] = []


class ExplainFactor(BaseModel):
    feature: Optional[str] = None
    text: str
    value: Optional[float] = None
    contribution: float


class GlobalImportance(BaseModel):
    feature: str
    mean_abs_shap: float


class ExplainResponse(BaseModel):
    id: str
    score: float
    risk_tier: str
    factors: List[ExplainFactor]
    global_importance: List[GlobalImportance]


class RecommendedNext(BaseModel):
    summary: str
    button: str


class PipelineResponse(BaseModel):
    id: str
    current_stage: int
    stage_name: str
    stages: List[str]
    history: List[HistoryEntry]
    recommended_next: Optional[RecommendedNext] = None


class AdvanceRequest(BaseModel):
    override: bool = False  # clinician-in-the-loop: force escalation even if the engine declines
    note: Optional[str] = None


class OrderResultInfo(BaseModel):
    """Simulated lab result attached when a test is ordered (auto-populated)."""

    slot: str
    outcome: str
    note: str = ""


class AdvanceResponse(BaseModel):
    applied: bool
    event: Optional[str] = None
    result: Optional[OrderResultInfo] = None  # populated: result arrives with the order
    rescored: bool = False  # trained model re-ran on the new values
    new_score: Optional[float] = None
    new_tier: Optional[str] = None
    pipeline: PipelineResponse


class AutoWorkupStep(BaseModel):
    action: str  # test | stop | complete
    stage: Optional[int] = None
    slot: Optional[str] = None
    button: Optional[str] = None
    summary: Optional[str] = None
    outcome: Optional[str] = None
    note: Optional[str] = None
    score_after: Optional[float] = None
    tier_after: Optional[str] = None


class AutoWorkupResponse(BaseModel):
    applied: bool
    steps: List[AutoWorkupStep]
    tests_run: List[str]
    score_start: float
    final_score: float
    final_tier: str
    final_stage: int
    recommended_next: Optional[RecommendedNext] = None
    pipeline: PipelineResponse


class WorkupSubject(BaseModel):
    id: str
    stage_before: int
    stage_after: int
    slot: str
    outcome: str
    score_before: float
    score_after: float
    tier_after: str
    rank_before: Optional[int] = None
    rank_after: Optional[int] = None


class WorkupNextResponse(BaseModel):
    applied: bool
    done: bool = False
    reason: Optional[str] = None
    subject: Optional[WorkupSubject] = None
    queue_remaining: Optional[int] = None
    total: Optional[int] = None


class WorkupRunRequest(BaseModel):
    max_steps: int = 25


class WorkupRunResponse(BaseModel):
    applied: bool
    steps: List[WorkupSubject]
    steps_run: int
    done: bool
    remaining: int
    total: int


class ResultRequest(BaseModel):
    """Record the outcome of an ordered (pending) diagnostic test.

    Clinicians close the loop: a pending slot becomes `completed` with the
    outcome + any structured values, and the event is logged to the audit trail.
    """

    slot: str  # blood | imaging | pet
    outcome: str = "normal"  # normal | abnormal | inconclusive
    values: dict[str, object] = {}
    note: Optional[str] = None


class ResultResponse(BaseModel):
    applied: bool
    event: Optional[str] = None
    slot: str
    outcome: str
    patient_id: str
    new_score: Optional[float] = None
    new_tier: Optional[str] = None


class PatientListResponse(BaseModel):
    items: List[PatientSummary]
    total: int
    page: int
    limit: int


class HealthResponse(BaseModel):
    status: str
    data_source: str


class CompareRequest(BaseModel):
    patient_ids: List[str]


class ScoreRequest(BaseModel):
    features: dict[str, Any]


class ScoreFactor(BaseModel):
    feature: str
    value: Optional[float] = None
    contribution: float


class ScoreResponse(BaseModel):
    score: float
    risk_tier: str
    factors: List[ScoreFactor]
    model_type: Optional[str] = None


class CompareResponse(BaseModel):
    count: int
    patients: List[dict]
    reasons: List[dict]
    ladder: List[str]
    disclaimer: str
    error: Optional[str] = None
    missing: Optional[List[str]] = None


class ModelInfoResponse(BaseModel):
    available: bool
    model_type: Optional[str] = None
    features: List[str] = []
    trained_at: Optional[str] = None
    thresholds: Optional[dict] = None
    test_auc: Optional[float] = None
    cv_auc_mean: Optional[float] = None
    global_importance: List[GlobalImportance] = []


class TrajectoryPoint(BaseModel):
    t: int  # months relative to today (negative = observed past)
    mmse: Optional[float] = None
    kind: str  # observed | predicted
    stage: Optional[int] = None
    stage_label: Optional[str] = None
    lo: Optional[int] = None  # uncertainty band (predicted points only)
    hi: Optional[int] = None


class ProgressionDriver(BaseModel):
    feature: str
    contribution: float


class ProgressionResponse(BaseModel):
    id: str
    horizon_months: int
    model_available: bool
    current: dict
    projected: dict
    trajectory: List[TrajectoryPoint]
    # Risk score at the moment each stage test completed (chart annotations)
    score_checkpoints: List[dict] = []
    drivers: List[ProgressionDriver]
    disclaimer: str
