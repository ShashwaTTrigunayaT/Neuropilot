"""REST endpoints (blueprint section 4.6)."""
from __future__ import annotations

from fastapi import APIRouter, Body, Header, HTTPException, Query, Response

from . import abdm
from . import fhir
from . import fhir_ingest
from . import service
from .schemas import (
    AdvanceRequest,
    AbdmConsentRequest,
    AdvanceResponse,
    AutoWorkupResponse,
    CompareRequest,
    CompareResponse,
    ExplainResponse,
    RefinedOutlookResponse,
    WorkupExecuteRequest,
    WorkupExecuteResponse,
    WorkupNextResponse,
    WorkupPlanRequest,
    WorkupPlanResponse,
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
    return {"status": "ok", "data_source": service.DATA_SOURCE,
            "patients": len(service.PATIENTS)}


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


@router.get("/patients/{patient_id}/refined", response_model=RefinedOutlookResponse, tags=["model"])
def get_refined_outlook(patient_id: str) -> dict:
    """Outlook for one patient: observed + projected MMSE trajectory with an
    uncertainty band, top SHAP drivers, and the projected score/tier produced by
    re-scoring the served model on the projected feature vector."""
    payload = service.refined_outlook(patient_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="Patient not found")
    return payload


@router.post("/patients/compare", response_model=CompareResponse, tags=["patients"])
def compare_patients(body: CompareRequest) -> dict:
    """Rank 2..6 selected patients with an EXPLICIT tiebreak ladder.

    Answers "these two display the same score at the same stage — who is more
    priority?": re-ranks on the full-precision score, then stage, then a
    stable ID fallback, and returns a
    human-readable reason for every adjacent pair.
    """
    payload = service.compare_patients(body.patient_ids)
    if payload is None:
        raise HTTPException(status_code=422, detail="Select at least two patients to compare")
    if payload.get("error") == "not_found":
        raise HTTPException(status_code=404, detail=f"Patient(s) not found: {', '.join(payload['missing'])}")
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
    remaining = sum(1 for r in service.PATIENTS.values() if r["stage"] < 4 and (service.can_advance(r) or service.pending_evidence_beyond(r)))
    # (see /workup/plan + /workup/execute for the approval-gated variant)
    return {
        "applied": len(steps) > 0,
        "steps": steps,
        "steps_run": len(steps),
        "done": done or remaining == 0,
        "remaining": remaining,
        "total": len(service.PATIENTS),
    }


@router.post("/workup/plan", response_model=WorkupPlanResponse, tags=["autonomous"])
def workup_plan(body: WorkupPlanRequest) -> dict:
    """**Read-only proposal.** The model walks the live priority queue and
    returns the next batch of indicated tests, each with its reasoning — why
    this subject, why this test, what is expected to move.

    Nothing is ordered and no score changes here: the projections are computed on
    copies. Approve a subset via `POST /workup/execute` to actually run it.
    """
    return service.propose_workup(limit=body.limit)


@router.post("/workup/execute", response_model=WorkupExecuteResponse, tags=["autonomous"])
def workup_execute(body: WorkupExecuteRequest) -> dict:
    """Execute the **approved** subset of a proposed plan.

    Only the listed subjects are touched. Each is re-checked against its live
    state first: one whose pathway moved between proposal and approval is
    skipped with the reason rather than advanced on a stale plan. Every executed
    step records the approval in the audit trail.
    """
    if not body.patient_ids:
        raise HTTPException(status_code=422, detail="patient_ids must name at least one approved subject.")
    return service.execute_workup(body.patient_ids, plan_id=body.plan_id, note=body.note)


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


# --------------------------------------------------------------------------- #
# FHIR R4 export surface (Phase 1 of FHIR_INTEGRATION.md -- read-only)
#
# Content type is application/fhir+json per the FHIR spec. Model output is
# carried as RiskAssessment (decision support), NEVER as Condition/diagnosis
# -- the API-wide no-diagnosis contract survives the interoperability layer.
# --------------------------------------------------------------------------- #
def _json_fhir(payload: dict) -> Response:
    from fastapi.responses import JSONResponse

    return JSONResponse(content=payload, media_type=fhir.FHIR_JSON)


@router.get("/fhir/metadata", tags=["fhir"])
def fhir_metadata() -> Response:
    """FHIR CapabilityStatement: what this export surface serves (R4 4.0.1)."""
    return _json_fhir(fhir.capability_statement())


@router.get("/fhir/Patient", tags=["fhir"])
def fhir_patient_search(count: int = Query(default=50, ge=1, le=200), page: int = Query(default=1, ge=1)) -> Response:
    """Whole-cohort Patient searchset (ranked by risk score, NeuroPilot's view)."""
    return _json_fhir(fhir.search_patients(count=count, page=page))


@router.get("/fhir/Patient/{patient_id}/$everything", tags=["fhir"])
def fhir_patient_everything(patient_id: str) -> Response:
    """Patient/$everything: complete export (demographics, Observations,
    RiskAssessment, AuditEvents) as one collection Bundle."""
    record = service.PATIENTS.get(patient_id)
    if record is None:
        return _json_fhir(
            fhir._operation_outcome("error", "not-found", f"Patient/{patient_id} is not served by NeuroPilot")
        )
    return _json_fhir(fhir.everything_bundle(record))


@router.get("/fhir/Patient/{patient_id}", tags=["fhir"])
def fhir_patient_read(patient_id: str) -> Response:
    record = service.PATIENTS.get(patient_id)
    if record is None:
        return _json_fhir(fhir._operation_outcome("error", "not-found", f"Patient/{patient_id} not found"))
    return _json_fhir(fhir.patient_resource(record))


@router.get("/fhir/Observation", tags=["fhir"])
def fhir_observation_search(patient: str | None = Query(default=None), count: int = Query(default=200, ge=1, le=500)) -> Response:
    """Observation searchset (MMSE 72106-8, p-tau181, Aβ42/40 41027-4, imaging/PET)."""
    pid = patient.rsplit("/", 1)[-1] if patient else None  # accepts 'Patient/ADNI-0001' or bare id
    if pid and service.PATIENTS.get(pid) is None:
        return _json_fhir(fhir._operation_outcome("error", "not-found", f"Patient/{pid} not found"))
    return _json_fhir(fhir.search_observations(patient_id=pid, count=count))


@router.get("/fhir/RiskAssessment", tags=["fhir"])
def fhir_risk_assessment_search(patient: str | None = Query(default=None), count: int = Query(default=100, ge=1, le=500)) -> Response:
    """RiskAssessment searchset: score + tier + SHAP rationale per patient.

    This is the standards-native home for NeuroPilot's output -- decision
    support by definition, never a Condition."""
    pid = patient.rsplit("/", 1)[-1] if patient else None
    if pid and service.PATIENTS.get(pid) is None:
        return _json_fhir(fhir._operation_outcome("error", "not-found", f"Patient/{pid} not found"))
    return _json_fhir(fhir.search_risk_assessments(patient_id=pid, count=count))


# --------------------------------------------------------------------------- #
# FHIR R4 inbound ingestion (Phase 2 of FHIR_INTEGRATION.md).
#
# A hospital FHIR server (or HAPI fixture) POSTs a transaction Bundle; the
# mapper in fhir_ingest.py turns it into internal records and writing goes
# through service.ingest_record, so the served model re-scores along the SAME
# path as a result entered in the UI. Atomic: any unmappable resource, unknown
# unit or structural problem rejects the whole bundle with a 422
# OperationOutcome listing every offender -- partial writes are the failure
# mode that destroys clinical trust.
# --------------------------------------------------------------------------- #
@router.post(
    "/fhir/Bundle",
    tags=["fhir"],
    responses={
        422: {"description": "Bundle rejected — OperationOutcome lists every offending resource"},
    },
)
def fhir_ingest_bundle(bundle: dict = Body(..., description="FHIR R4 transaction/collection Bundle")):
    """Inbound ingestion: FHIR Bundle in, re-scored NeuroPilot patients out."""
    from fastapi.responses import JSONResponse

    try:
        receipt = fhir_ingest.ingest_bundle(bundle)
    except fhir_ingest.IngestError as exc:
        return JSONResponse(
            status_code=422,
            content=fhir_ingest.operation_outcome(exc.issues),
            media_type=fhir.FHIR_JSON,
        )
    return _json_fhir(receipt)


# --------------------------------------------------------------------------- #
# Phase 3 — bidirectional workflow
#
# Orders leave as ServiceRequest (intent=order) and completed panels as
# DiagnosticReport; a hospital result returns through POST /fhir/Bundle and is
# re-scored by the served model. This makes NeuroPilot a participant in the
# hospital's workflow rather than a reader of its exports.
# --------------------------------------------------------------------------- #
@router.get("/fhir/ServiceRequest", tags=["fhir"])
def fhir_service_request_search(
    patient: str | None = Query(default=None),
    status: str | None = Query(default=None, description="active (still owed) | completed"),
    count: int = Query(default=200, ge=1, le=500),
) -> Response:
    """Placed orders. `status=active` is what the hospital still owes us."""
    pid = patient.rsplit("/", 1)[-1] if patient else None
    if pid and service.PATIENTS.get(pid) is None:
        return _json_fhir(fhir._operation_outcome("error", "not-found", f"Patient/{pid} not found"))
    return _json_fhir(fhir.search_service_requests(patient_id=pid, count=count, status=status))


@router.get("/fhir/DiagnosticReport", tags=["fhir"])
def fhir_diagnostic_report_search(
    patient: str | None = Query(default=None),
    count: int = Query(default=200, ge=1, le=500),
) -> Response:
    """Completed panels: the report we can hand a clinician, with LOINC/custom codes."""
    pid = patient.rsplit("/", 1)[-1] if patient else None
    if pid and service.PATIENTS.get(pid) is None:
        return _json_fhir(fhir._operation_outcome("error", "not-found", f"Patient/{pid} not found"))
    return _json_fhir(fhir.search_diagnostic_reports(patient_id=pid, count=count))


@router.get("/fhir/status", tags=["fhir"])
def fhir_status() -> dict:
    """Integration status: outbound server reachability + SMART session + surface counts."""
    from . import config, fhir_client, smart

    open_orders = len(fhir.search_service_requests(status="active")["entry"])
    completed_orders = len(fhir.search_service_requests(status="completed")["entry"])
    observations = sum(len(fhir.observation_resources(r)) for r in service.PATIENTS.values())

    return {
        "phases": {
            "1_export": {"implemented": True,
                         "detail": "Patient, Observation, RiskAssessment, AuditEvent + $everything"},
            "2_inbound": {"implemented": True,
                          "detail": "POST /fhir/Bundle, atomic, re-scored by the served model"},
            "3_bidirectional": {"implemented": True,
                                "detail": "ServiceRequest orders + DiagnosticReport results, outbound push"},
            "4_smart": {"implemented": True,
                        "detail": "SMART launch (OAuth2 + PKCE), patient context held server-side"},
        },
        "outbound_server": fhir_client.probe(),
        "smart": smart.status(),
        "push_orders_on_order": config.FHIR_PUSH_ORDERS,
        "surface": {
            "patients": len(service.PATIENTS),
            "risk_assessments": len(service.PATIENTS),
            "open_orders": open_orders,
            "completed_orders": completed_orders,
            "observations": observations,
        },
        "note": (
            "FHIR is the border, not the engine: the triage loop runs on the internal "
            "store (limitation L8). Data served here is a synthetic cohort — not real PHI."
        ),
    }


@router.post("/fhir/push/{patient_id}", tags=["fhir"])
def fhir_push_patient(patient_id: str) -> Response:
    """Push one patient's record (orders + results + RiskAssessment) to the hospital server.

    A transaction Bundle: the server applies it atomically, so a hospital never
    receives half an updated record.
    """
    from . import fhir_client

    if service.PATIENTS.get(patient_id) is None:
        return _json_fhir(fhir._operation_outcome("error", "not-found", f"Patient/{patient_id} not found"))
    try:
        receipt = fhir_client.push_patient(patient_id)
    except fhir_client.FHIRClientError as exc:
        return _json_fhir(fhir._operation_outcome("error", "exception", exc.message))
    return _json_fhir(receipt)


# --------------------------------------------------------------------------- #
# Phase 4 — SMART on FHIR launch (OAuth 2.0 authorization-code + PKCE)
#
# The EHR opens /fhir/smart/launch?iss=…&launch=… ; this server builds the
# authorize URL, exchanges the code on /fhir/smart/callback, and keeps the
# token server-side — the browser never receives it.
# --------------------------------------------------------------------------- #
@router.get("/fhir/smart/status", tags=["fhir"])
def fhir_smart_status() -> dict:
    """SMART client registration + current session (no token material)."""
    from . import smart

    return smart.status()


@router.get("/fhir/smart/context", tags=["fhir"])
def fhir_smart_context() -> dict:
    """The patient-in-context the launch bound, if any."""
    from . import smart

    return smart.context()


@router.get("/fhir/smart/launch", tags=["fhir"])
def fhir_smart_launch(
    iss: str | None = Query(default=None, description="FHIR server base URL (from the EHR launch)"),
    launch: str | None = Query(default=None, description="Opaque EHR launch token"),
    patient: str | None = Query(default=None, description="Patient context for a standalone launch"),
    format: str = Query(default="redirect", description="redirect (browser) | json (API client)"),
):
    """Begin a SMART launch. `iss` defaults to the configured FHIR_BASE_URL."""
    from fastapi.responses import RedirectResponse

    from . import config, smart

    target = iss or config.FHIR_BASE_URL
    # Standalone website launches use an id from the external SMART simulator or
    # EHR, not the local ADNI selector. The env default keeps that identity out
    # of the application code and lets the operator change simulations safely.
    launch_patient = patient or config.SMART_LAUNCH_PATIENT_ID or None
    try:
        started = smart.begin_launch(target, launch=launch, patient=launch_patient)
    except smart.SmartError as exc:
        return _json_fhir(fhir._operation_outcome("error", "login", exc.message))
    if format == "json":
        return started
    return RedirectResponse(started["authorization_url"], status_code=302)


@router.get("/fhir/smart/callback", tags=["fhir"])
def fhir_smart_callback(
    code: str | None = Query(default=None),
    state: str | None = Query(default=None),
    error: str | None = Query(default=None),
    error_description: str | None = Query(default=None),
    format: str = Query(default="redirect", description="redirect (browser) | json (API client)"),
):
    """Complete the launch: exchange the code, then hand the browser to the dashboard."""
    from fastapi.responses import RedirectResponse

    from . import smart

    if error:
        return _json_fhir(
            fhir._operation_outcome("error", "login", f"EHR returned {error}: {error_description or ''}")
        )
    try:
        session = smart.handle_callback(code or "", state or "")
    except smart.SmartError as exc:
        return _json_fhir(fhir._operation_outcome("error", "login", exc.message))
    if format == "json":
        return smart.context()
    from urllib.parse import urlencode

    params = {"smart": "connected"}
    if session.get("patient"):
        params["patient"] = session["patient"]
    if session.get("iss"):
        params["iss"] = session["iss"]
    separator = "&" if "?" in smart.frontend_redirect_uri() else "?"
    return RedirectResponse(f"{smart.frontend_redirect_uri()}{separator}{urlencode(params)}",
                            status_code=302)


@router.post("/fhir/smart/refresh", tags=["fhir"])
def fhir_smart_refresh() -> dict:
    """Renew the session using the refresh_token the EHR issued."""
    from . import smart

    try:
        smart.refresh()
    except smart.SmartError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc
    return smart.context()


@router.post("/fhir/smart/logout", tags=["fhir"])
def fhir_smart_logout() -> dict:
    """Drop the server-side session (a relaunch from the EHR is required)."""
    from . import smart

    return smart.logout()


# --------------------------------------------------------------------------- #
# ABDM (Ayushman Bharat Digital Mission) — HIU consent flow (FHIR plan.md 4-5)
#
# NeuroPilot is the HIU: it asks a Consent Manager for permission, then for the
# records that consent covers. Records arrive Fidelius-encrypted at
# /abdm/health-information/transfer, are decrypted, and run through the SAME
# scoring path as a result typed into the UI.
#
# The two callbacks (/abdm/consents/notify, /abdm/health-information/on-request)
# are driven BY the Consent Manager, so their shape is dictated by ABDM rather
# than by this API's conventions — they acknowledge and never error out on an
# unknown id, because a retrying CM must not be able to wedge.
# --------------------------------------------------------------------------- #
@router.get("/abdm/status", tags=["abdm"])
def abdm_status() -> dict:
    return abdm.status()


@router.post("/abdm/consent", tags=["abdm"], responses={503: {"description": "No Consent Manager configured/reachable"}})
def abdm_start_consent(body: AbdmConsentRequest) -> dict:
    """Open a consent request for a patient's ABHA address.

    Returns the session immediately — consent is asynchronous, so the grant
    arrives later (poll GET /abdm/consent/{session_id}). Nothing polls on your
    behalf inside this request.
    """
    try:
        return abdm.initiate_consent(
            body.abha_address, hi_types=body.hi_types, days=body.days, purpose_code=body.purpose
        )
    except abdm.AbdmError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc


@router.get("/abdm/sessions", tags=["abdm"])
def abdm_sessions(limit: int = Query(default=25, ge=1, le=200)) -> dict:
    return abdm.list_sessions(limit=limit)


@router.get("/abdm/consent/{session_id}", tags=["abdm"])
def abdm_consent_session(session_id: str) -> dict:
    try:
        return abdm.get_session(session_id)
    except abdm.AbdmError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc


@router.post(
    "/abdm/consent/{session_id}/records",
    tags=["abdm"],
    responses={409: {"description": "Consent is not GRANTED yet"}},
)
def abdm_request_records(session_id: str) -> dict:
    """Ask the CM for the records the consent covers.

    This is where the HIU's ephemeral DH public key + nonce travel; the private
    half never leaves the process. The encrypted push lands at
    /abdm/health-information/transfer shortly afterwards.
    """
    try:
        return abdm.request_health_information(session_id)
    except abdm.AbdmError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc


@router.post("/abdm/consents/notify", tags=["abdm"], include_in_schema=True)
def abdm_consent_notify(bundle: dict = Body(..., description="ABDM consent notification")) -> dict:
    """CM -> HIU: the patient granted, denied, revoked or expired the consent."""
    return abdm.handle_consent_notify(bundle)


@router.post("/abdm/health-information/on-request", tags=["abdm"])
def abdm_on_request(bundle: dict = Body(..., description="ABDM HI-request acknowledgement")) -> dict:
    """CM -> HIU: the health-information request was accepted (transaction id issued)."""
    return abdm.handle_on_request(bundle)


@router.post(
    "/abdm/health-information/transfer",
    tags=["abdm"],
    responses={
        401: {"description": "Bearer token does not match the issued session token"},
        409: {"description": "Transaction already received (replay refused)"},
        422: {"description": "Decryption, checksum or mapping failure"},
    },
)
def abdm_transfer(
    bundle: dict = Body(..., description="ABDM data push with Fidelius-encrypted entries"),
    authorization: str | None = Header(default=None),
) -> dict:
    """HIP -> HIU: Fidelius-encrypted records. Decrypted, then ingested and re-scored."""
    try:
        return abdm.receive_transfer(bundle, authorization=authorization or "")
    except abdm.AbdmError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc


@router.post("/abdm/reset", tags=["abdm"])
def abdm_reset() -> dict:
    """Drop all consent sessions (demo reset)."""
    return abdm.reset()


@router.post(
    "/ingest/fhir",
    tags=["abdm"],
    responses={422: {"description": "Bundle rejected — OperationOutcome lists every offending resource"}},
)
def ingest_fhir(bundle: dict = Body(..., description="FHIR R4 Bundle (NRCES document bundle)")):
    """Direct FHIR ingestion for an ABDM HIP that pushes without a consent exchange.

    Same mapper and same scoring path as POST /fhir/Bundle; exposed under /ingest
    because that is the path the ABDM plan names, and a HIP integration should not
    have to know about the R4 export surface to send records in.
    """
    from fastapi.responses import JSONResponse

    try:
        receipt = fhir_ingest.ingest_bundle(bundle)
    except fhir_ingest.IngestError as exc:
        return JSONResponse(
            status_code=422,
            content=fhir_ingest.operation_outcome(exc.issues),
            media_type=fhir.FHIR_JSON,
        )
    return _json_fhir(receipt)