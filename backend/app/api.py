"""REST endpoints (blueprint section 4.6)."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from . import service
from .schemas import (
    AdvanceRequest,
    AdvanceResponse,
    AutoWorkupResponse,
    ExplainResponse,
    ProgressionResponse,
    WorkupNextResponse,
    WorkupRunRequest,
    WorkupRunResponse,
    HealthResponse,
    ModelInfoResponse,
    PatientDetail,
    PatientListResponse,
    PipelineResponse,
    ResultRequest,
    ResultResponse,
    ScoreRequest,
    ScoreResponse,
)

router = APIRouter()


@router.get("/health", response_model=HealthResponse, tags=["system"])
def health() -> dict:
    return {"status": "ok", "data_source": service.DATA_SOURCE}


@router.get("/debug/env", tags=["system"])
def debug_env() -> dict:
    """Deploy diagnostics: is DATABASE_URL reaching this process? (no secret values)."""
    from . import db
    url = db.get_database_url() or ""
    return {
        "database_url_present": bool(url),
        "database_url_scheme": url.split("://")[0] if url else None,
        "database_url_is_railway_internal": ".railway.internal" in url,
        "db_layer_enabled": db.enabled(),
    }


@router.get("/patients", response_model=PatientListResponse, tags=["patients"])
def list_patients(
    tier: str | None = Query(default=None, description="Filter by risk tier: high, medium, low"),
    q: str | None = Query(default=None, description="Search patient ID substring"),
    sort: str = Query(default="risk-desc", description="risk-desc | risk-asc | stage"),
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=50, ge=1, le=200),
) -> dict:
    return service.list_patients(tier=tier, q=q, sort=sort, page=page, limit=limit)


@router.get("/patients/{patient_id}", response_model=PatientDetail, tags=["patients"])
def get_patient(patient_id: str) -> dict:
    detail = service.get_patient(patient_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="Patient not found")
    return detail


@router.get("/patients/{patient_id}/explain", response_model=ExplainResponse, tags=["patients"])
def explain_patient(patient_id: str) -> dict:
    payload = service.explain(patient_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="Patient not found")
    return payload


@router.get("/patients/{patient_id}/pipeline", response_model=PipelineResponse, tags=["patients"])
def get_pipeline(patient_id: str) -> dict:
    payload = service.pipeline(patient_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="Patient not found")
    return payload


@router.get("/patients/{patient_id}/progression", response_model=ProgressionResponse, tags=["model"])
def get_progression(patient_id: str) -> dict:
    """12-month progression forecast: MMSE trajectory (observed + predicted with
    uncertainty band), conversion probability with top drivers, and the projected
    risk tier from re-scoring the current risk model on the projected vector."""
    payload = service.progression(patient_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="Patient not found")
    return payload


@router.post("/patients/score", response_model=ScoreResponse, tags=["model"])
def score_patient(body: ScoreRequest) -> dict:
    """Score a fresh feature vector with the trained model (model serving)."""
    result = service.score_patient(body.features)
    if result is None:
        raise HTTPException(
            status_code=503,
            detail="No trained model artifact found — run scripts/train_model.py first.",
        )
    return result


@router.get("/model/info", response_model=ModelInfoResponse, tags=["model"])
def model_info() -> dict:
    return service.model_info()


@router.post(
    "/patients/{patient_id}/advance-stage",
    response_model=AdvanceResponse,
    tags=["patients"],
    responses={409: {"description": "Escalation not recommended by the rule engine (use override=true)"}},
)
def advance_stage(patient_id: str, body: AdvanceRequest) -> dict:
    payload, error = service.advance_stage(patient_id, override=body.override, note=body.note)
    if payload is None:
        if error is None:
            raise HTTPException(status_code=404, detail="Patient not found")
        raise HTTPException(status_code=409, detail=error)
    return payload


@router.post(
    "/patients/{patient_id}/auto-workup",
    response_model=AutoWorkupResponse,
    tags=["patients"],
    responses={
        409: {"description": "Cascade stops here — current tier indicates no further testing"},
    },
)
def auto_workup(patient_id: str) -> dict:
    """Model-driven diagnostic cascade: each completed test re-scores the
    patient and the updated tier decides whether the next stage runs.
    409 when the pathway stops (no test indicated) with the reason attached.
    """
    payload, error = service.auto_workup(patient_id)
    if payload is None:
        if error is None:
            raise HTTPException(status_code=404, detail="Patient not found")
        raise HTTPException(status_code=409, detail=error)
    if not payload["tests_run"]:
        raise HTTPException(status_code=409, detail=payload["steps"][0]["summary"] if payload["steps"] else "No test indicated")
    return payload


@router.post("/workup/next", response_model=WorkupNextResponse, tags=["autonomous"])
def workup_next() -> dict:
    """One autonomous triage step: the model picks the highest-priority subject
    by CURRENT rank, performs its next indicated test, re-scores, and returns
    the before/after ranking impact."""
    return service.workup_next()


@router.post("/workup/run", response_model=WorkupRunResponse, tags=["autonomous"])
def workup_run(body: WorkupRunRequest) -> dict:
    """Run up to `max_steps` autonomous triage steps in one call."""
    steps = []
    done = False
    for _ in range(max(1, min(body.max_steps, 2000))):
        step = service.workup_next()
        if not step.get("applied"):
            done = bool(step.get("done"))
            if done:
                break
            continue
        steps.append(step["subject"])
    remaining = sum(1 for r in service.PATIENTS.values() if r["stage"] < 4 and service.can_advance(r))
    return {
        "applied": len(steps) > 0,
        "steps": steps,
        "steps_run": len(steps),
        "done": done or remaining == 0,
        "remaining": remaining,
        "total": len(service.PATIENTS),
    }


@router.post(
    "/patients/{patient_id}/results",
    response_model=ResultResponse,
    tags=["patients"],
    responses={
        409: {"description": "No pending test at that slot (nothing to record results for)"},
        422: {"description": "Unknown slot (must be blood, imaging or pet)"},
    },
)
def record_result(patient_id: str, body: ResultRequest) -> dict:
    if body.slot not in ("blood", "imaging", "pet"):
        raise HTTPException(status_code=422, detail="slot must be one of: blood, imaging, pet")
    payload, error = service.record_result(
        patient_id, slot=body.slot, outcome=body.outcome, values=body.values, note=body.note
    )
    if payload is None:
        if error is None:
            raise HTTPException(status_code=404, detail="Patient not found")
        raise HTTPException(status_code=409, detail=error)
    return payload