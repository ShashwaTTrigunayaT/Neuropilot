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
    # Official measured score. Ranking uses final_score instead.
    score: float
    official_score: Optional[float] = None
    provisional_score: Optional[float] = None
    final_score: Optional[float] = None
    estimate_confidence: Optional[float] = None
    estimated_stages: List[int] = []
    estimated_values: dict = {}
    risk_tier: str
    stage: int
    stage_name: str
    # True when a LATER-stage result is already on file while the ordered pathway
    # stops at the first missing test. Declared here (not only on PatientDetail)
    # so the LIST carries it -- the cohort table needs it to avoid labelling a
    # scanned patient as cognition-only.
    beyond_stage: bool = False
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
    # Real-ADNI cohort measures (None for synthetic/OASIS cohorts). These are
    # model INPUTS, so exposing them is required for the workbench to show the
    # patient's real profile. The cohort's DIAGNOSIS / CDR-SB are intentionally
    # absent: this service never surfaces a diagnosis.
    adas_cog_13: Optional[float] = None
    # faq_total: REMOVED from model (label leakage — part of ADNI diagnostic algorithm)
    apoe_genotype: Optional[str] = None
    apoe_e4: Optional[bool] = None
    visit_date: Optional[str] = None
    n_visits: Optional[int] = None
    # Slots measured outside the ordered pathway (real-cohort ordering gaps)
    slots_on_file: List[str] = []


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
    official_score: Optional[float] = None
    provisional_score: Optional[float] = None
    final_score: Optional[float] = None
    estimate_confidence: Optional[float] = None
    risk_tier: str
    factors: List[ExplainFactor]
    global_importance: List[GlobalImportance]


class RecommendedNext(BaseModel):
    summary: str
    button: str


class PathwaySlot(BaseModel):
    """State of one pathway step.

    `status` is None before the step is ordered, "ordered" when the order was
    placed with nothing on file to return, "completed" when a real measurement
    is in the record. `measured` distinguishes a real value from a bare order.
    """

    slot: str
    label: str
    stage: int
    status: Optional[str] = None
    measured: bool = False


class PipelineResponse(BaseModel):
    id: str
    current_stage: int
    stage_name: str
    stages: List[str]
    slots: List[PathwaySlot] = []
    estimated_values: dict = {}
    history: List[HistoryEntry]
    recommended_next: Optional[RecommendedNext] = None


class AdvanceRequest(BaseModel):
    override: bool = False  # clinician-in-the-loop: force escalation even if the engine declines
    note: Optional[str] = None


class OrderResultInfo(BaseModel):
    carried_forward: bool = False
    """Outcome of ordering a test.

    `status` is "completed" when a real measurement was already on file and got
    incorporated, or "ordered" when this cohort holds no result for that slot.
    `outcome` is None in the latter case -- nothing is fabricated to fill it.
    """

    slot: str
    status: Optional[str] = None
    outcome: Optional[str] = None
    note: str = ""


class AdvanceResponse(BaseModel):
    applied: bool
    event: Optional[str] = None
    result: Optional[OrderResultInfo] = None  # populated: result arrives with the order
    rescored: bool = False  # trained model re-ran on the new values
    # new_score is the official measured score; new_priority_score is the
    # confidence-weighted score used for ranking.
    new_score: Optional[float] = None
    official_score: Optional[float] = None
    new_priority_score: Optional[float] = None
    priority_changed: bool = False
    new_tier: Optional[str] = None
    pipeline: PipelineResponse


class AutoWorkupStep(BaseModel):
    carried_forward: bool = False
    action: str  # test | stop | complete | awaiting
    stage: Optional[int] = None
    slot: Optional[str] = None
    status: Optional[str] = None
    result_on_file: Optional[bool] = None
    button: Optional[str] = None
    summary: Optional[str] = None
    outcome: Optional[str] = None
    note: Optional[str] = None
    score_after: Optional[float] = None
    priority_score_before: Optional[float] = None
    priority_score_after: Optional[float] = None
    priority_changed: bool = False
    official_score_before: Optional[float] = None
    official_score_after: Optional[float] = None
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
    """One step the live loop took, with the reasoning behind it.

    `rationale` and `expected` are the same shape the approvable batch proposal
    uses, so an unattended step can be read back with the same questions answered
    — the loop is not a black box just because nobody clicks between ticks.
    """

    id: str
    stage_before: int
    stage_after: int
    stage_before_name: Optional[str] = None
    stage_after_name: Optional[str] = None
    slot: str
    # Human label for the slot ("Blood biomarkers", "MRI volumetrics", …).
    test: Optional[str] = None
    # The rule engine's own recommendation text + button, verbatim.
    summary: Optional[str] = None
    button: Optional[str] = None
    tier_before: Optional[str] = None
    # Why this subject / why this test / cost to the patient / expected effect.
    rationale: List[dict] = []
    # What the model projected BEFORE acting, so a row can compare expectation
    # against outcome rather than only narrating that something ran.
    expected: dict = {}
    status: Optional[str] = None
    result_on_file: Optional[bool] = None
    outcome: Optional[str] = None
    # score_before/after are retained for compatibility and represent priority.
    score_before: float
    score_after: float
    priority_score_before: Optional[float] = None
    priority_score_after: Optional[float] = None
    priority_changed: bool = False
    official_score_before: Optional[float] = None
    official_score_after: Optional[float] = None
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


class WorkupPlanRequest(BaseModel):
    """How many actions the model should propose in one plan."""

    limit: int = 8


class WorkupPlanAction(BaseModel):
    """One proposed action, with the reasoning that justifies it.

    `projected_*` are SIMULATED values computed on a copy of the record: they are
    what the model expects, not what happened. Nothing here is written to the
    served store until the action is approved and executed.
    """

    patient_id: str
    rank: Optional[int] = None
    stage_before: int
    stage_after: int
    stage_name: Optional[str] = None
    slot: str
    test: str
    summary: str
    button: Optional[str] = None
    priority_score: Optional[float] = None
    official_score: Optional[float] = None
    tier_before: Optional[str] = None
    tier_after: Optional[str] = None
    projected_priority_score: Optional[float] = None
    projected_official_score: Optional[float] = None
    priority_delta: Optional[float] = None
    projected_rank: Optional[int] = None
    rank_delta: Optional[int] = None
    result_on_file: bool = False
    # order-only | none | marginal | material | reclassifies
    impact: str = "order-only"
    estimate_confidence: Optional[float] = None
    rationale: List[dict] = []


class WorkupPlanResponse(BaseModel):
    plan_id: str
    generated_at: str
    actions: List[WorkupPlanAction]
    summary: dict
    cohort: dict
    queue_remaining: int = 0
    total: int = 0
    reason: Optional[str] = None


class WorkupExecuteRequest(BaseModel):
    """The APPROVED subset of a plan. Only these subjects are touched."""

    patient_ids: List[str]
    plan_id: Optional[str] = None
    note: Optional[str] = None


class WorkupExecuteResponse(BaseModel):
    applied: bool
    plan_id: Optional[str] = None
    approved_count: int
    executed: List[dict]
    skipped: List[dict]
    executed_count: int
    skipped_count: int
    queue_remaining: int
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
    # Exposed so a deploy can be verified at a glance (which cohort is the API
    # actually serving, and how many patients did the DB hand back).
    patients: int = 0


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
    # Which model family is being served (config.PRIMARY_MODEL) and its label.
    name: Optional[str] = None
    label: Optional[str] = None
    model_type: Optional[str] = None
    features: List[str] = []
    trained_at: Optional[str] = None
    thresholds: Optional[dict] = None
    test_auc: Optional[float] = None
    cv_auc_mean: Optional[float] = None
    cv_auc_std: Optional[float] = None
    # Held-out AUC split by what was actually measured (Stage 1 only vs any
    # biomarker), so the "does it work before any test is ordered?" question is
    # answerable from the API rather than only from the training report.
    test_auc_stage1_only: Optional[float] = None
    test_auc_biomarker_measured: Optional[float] = None
    baseline_accuracy: Optional[float] = None
    n_train: Optional[int] = None
    n_subgroup: Optional[dict] = None
    stage_importance: Optional[dict] = None
    ablations: List[dict] = []
    caveats: List[str] = []
    global_importance: List[GlobalImportance] = []
    # The model family NOT being served, retained and still loadable — this is
    # what makes the switch inspectable rather than invisible.
    legacy: Optional[dict] = None


class TrajectoryPoint(BaseModel):
    """One point on the outlook chart.

    Observed points are real ADNI follow-up visits: `date` and the visit's other
    instruments travel with them so the chart's hover readout can show the visit
    itself, not just its MMSE. `t` is a float because month offsets are measured
    from the subject's own first visit (30.44 days per month), not rounded to a
    calendar grid.
    """

    t: float  # months relative to today (negative = observed past)
    mmse: Optional[float] = None
    kind: str  # observed | predicted
    stage: Optional[int] = None
    stage_label: Optional[str] = None
    lo: Optional[int] = None  # uncertainty band (predicted points only)
    hi: Optional[int] = None
    date: Optional[str] = None  # ISO date of the visit (observed only)
    adas: Optional[float] = None  # ADAS-Cog 13 at that visit
    cdr: Optional[float] = None  # CDR-SB at that visit
    visit_no: Optional[int] = None  # 1-based visit index
    n_visits: Optional[int] = None  # size of the subject's series


class OutlookDriver(BaseModel):
    feature: str
    contribution: float


class AbdmConsentRequest(BaseModel):
    """Open a consent request with the ABDM Consent Manager.

    Only the ABHA address identifies the patient — no patient id, no score, no
    tier leaves this system when asking for consent.
    """

    abha_address: str
    hi_types: Optional[List[str]] = None
    days: int = 180
    purpose: str = "CAREMGT"


class RefinedOutlookResponse(BaseModel):
    id: str
    model_available: bool
    current: dict
    projected: dict
    trajectory: List[TrajectoryPoint]
    # How much observed history the trajectory is drawn from: visit count, the
    # span covered, and the fitted MMSE slope. None when the visits artifact is
    # absent and the chart fell back to the record's two cognitive scores.
    history: Optional[dict] = None
    # Risk score at the moment each stage test completed (chart annotations)
    score_checkpoints: List[dict] = []
    # Risk score at every real visit: the main panel's series. Each point is the
    # served model run on THAT visit's measured values only, so the trajectory is a
    # real retrospective score rather than today's record drawn across history.
    risk_trajectory: List[dict] = []
    # What the projected vector is made of. `projected_attributes` holds the
    # attributes the model moved forward, each with the CV MAE that earned it a
    # place (and the no-change MAE it had to beat). `carried_attributes` holds the
    # ones kept at today's measured value with the reason its projection was
    # refused, so a consumer can tell a forecast from a carried value. Without
    # these declared, FastAPI would silently strip both from the response.
    projected_attributes: List[dict] = []
    carried_attributes: List[dict] = []
    projection: Optional[dict] = None
    drivers: List[OutlookDriver]
    disclaimer: str
