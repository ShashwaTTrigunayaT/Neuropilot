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

# Auto-load .env from PROJECT_ROOT if it exists.
#
# FROM_ENV_FILE records which keys only exist because of that file (a real
# environment variable always wins, via setdefault). It matters for one decision:
# a `.env` convenience value must not outrank connection details the operator
# typed on the command line. See db.get_database_url().
FROM_ENV_FILE: set[str] = set()
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
                key = k.strip()
                if key not in os.environ:
                    FROM_ENV_FILE.add(key)
                os.environ.setdefault(key, v)
    except Exception:
        pass

HIGH_THRESHOLD = float(os.getenv("HIGH_RISK_THRESHOLD", "0.7"))
MEDIUM_THRESHOLD = float(os.getenv("MEDIUM_RISK_THRESHOLD", "0.4"))

# --------------------------------------------------------------------------- #
# Cohort-source vocabulary (storage.load_patients -> /health -> UI).
#
# Written down as constants because the distinction carries a safety rule: a
# STUB cohort is placeholder text, and it must never be allowed to replace real
# patient data that is already stored. -- see db.seed_if_empty.
# --------------------------------------------------------------------------- #
# The placeholder stubs in seed_data.py. Never carries measurements.
STUB_DATA_SOURCE = "mock"
# PATIENT_DATA=adni was requested but data/processed/adni_cohort.json is absent
# (the normal state inside a container: the cohort is DUA-restricted, so it is
# neither committed nor baked into the image and is seeded into the database
# once instead -- see scripts/seed_db.py).
MISSING_DATA_SOURCE = "adni-missing"

# --------------------------------------------------------------------------- #
# FHIR integration settings (Phases 3-4 of FHIR_INTEGRATION.md).
#
# FHIR_BASE_URL is the OUTBOUND hospital FHIR server: orders (ServiceRequest),
# results (DiagnosticReport), the RiskAssessment export and AuditEvents are
# pushed there. Empty means "not configured" -- every outbound call then reports
# that honestly instead of pretending a hospital is connected.
# --------------------------------------------------------------------------- #
FHIR_BASE_URL = os.getenv("FHIR_BASE_URL", "").rstrip("/")
# Optional static bearer token for servers that do not use SMART (a HAPI test
# server usually runs open; a real one never does -- see SMART below).
FHIR_AUTH_TOKEN = os.getenv("FHIR_AUTH_TOKEN", "")
FHIR_TIMEOUT_SECONDS = float(os.getenv("FHIR_TIMEOUT_SECONDS", "8"))
# Push each newly placed order to the hospital server as a ServiceRequest.
# Off by default: the triage loop must never block on a network call, and a
# demo should not depend on a hospital being up. Turn it on for a live demo
# against HAPI (`FHIR_PUSH_ORDERS=true`).
FHIR_PUSH_ORDERS = os.getenv("FHIR_PUSH_ORDERS", "").strip().lower() in ("1", "true", "yes")

# SMART on FHIR (OAuth 2.0) client registration. Client id is issued by the EHR
# sandbox (Epic App Orchard / Cerner code console) when NeuroPilot is registered
# as a SMART app; a public client has no secret (PKCE is what protects it).
SMART_CLIENT_ID = os.getenv("SMART_CLIENT_ID", "neuropilot-demo")
SMART_CLIENT_SECRET = os.getenv("SMART_CLIENT_SECRET", "")
# Where the EHR sends the browser back to. Must match the registered redirect
# URI byte-for-byte, which is why it is configuration and not a computed value.
SMART_REDIRECT_URI = os.getenv("SMART_REDIRECT_URI", "")
# Patient id in the selected SMART simulator/EHR for a standalone website launch.
# This is intentionally separate from the local ADNI patient selector: an
# external FHIR server cannot resolve identifiers such as ADNI-6891.
SMART_LAUNCH_PATIENT_ID = os.getenv("SMART_LAUNCH_PATIENT_ID", "").strip()
# The SPA the backend hands the browser back to once the token exchange is done.
FRONTEND_BASE_URL = os.getenv("FRONTEND_BASE_URL", "").rstrip("/")
# Minimum-necessary scope set: read the patient in context and their results,
# write the risk assessment back. `launch/patient` is what makes context
# selection possible at all; no encounter read, no write to clinical records.
SMART_SCOPES = os.getenv(
    "SMART_SCOPES",
    "launch/patient openid fhirUser "
    "patient/Patient.read patient/Observation.read patient/DiagnosticReport.read "
    "patient/RiskAssessment.read patient/RiskAssessment.write",
).strip()

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


# --------------------------------------------------------------------------- #
# Which model the running system serves.
#
#   "refined"          the model in production. It is what the API, dashboard,
#                      escalation engine, ranking and simulator all use.
#   "cross_sectional"  the earlier snapshot classifier. KEPT FULLY FUNCTIONAL --
#                      same code path, same contract -- so it can be switched
#                      back on with one env var and no code change.
#
# Both families expose an identical contract (predict_proba over a feature
# vector + SHAP attributions), which is what makes the swap a configuration
# change rather than a rewrite. Set PRIMARY_MODEL in the environment/.env to
# flip between them.
# --------------------------------------------------------------------------- #
PRIMARY_MODEL = os.getenv("PRIMARY_MODEL", "refined").strip().lower()
if PRIMARY_MODEL not in ("refined", "cross_sectional"):
    PRIMARY_MODEL = "refined"

MODEL_VARIANTS: dict[str, dict] = {
    "refined": {
        "name": "refined",
        "label": "Refined model",
        "model_path": _env_path(
            "REFINED_MODEL_PATH", PROJECT_ROOT / "artifacts" / "progression_conversion.joblib"
        ),
        "meta_path": _env_path(
            "REFINED_META_PATH", PROJECT_ROOT / "artifacts" / "progression_meta.json"
        ),
        "importance_path": _env_path(
            "REFINED_IMPORTANCE_PATH", PROJECT_ROOT / "artifacts" / "progression_importance.csv"
        ),
    },
    "cross_sectional": {
        "name": "cross_sectional",
        "label": "Cross-sectional model",
        "model_path": MODEL_PATH,
        "meta_path": MODEL_META_PATH,
        "importance_path": GLOBAL_IMPORTANCE_PATH,
    },
}


# --------------------------------------------------------------------------- #
# ABDM (Ayushman Bharat Digital Mission) HIU settings -- Phases 4-5 of FHIR plan.md.
#
# NeuroPilot acts as the Health Information USER: it requests a patient's consent,
# then asks the Consent Manager for the records that consent covers. The records
# arrive Fidelius-encrypted at ABDM_DATA_PUSH_PATH.
#
# Nothing here requires an ABDM account. With no CM configured the in-process mock
# Gateway is used (ABDM_USE_MOCK_GATEWAY), so the consent -> grant -> encrypted
# pull -> re-score loop is demonstrable today; pointing ABDM_CM_BASE_URL at a real
# sandbox CM switches to the real network with no code change.
# --------------------------------------------------------------------------- #
ABDM_CM_BASE_URL = os.getenv("ABDM_CM_BASE_URL", "").rstrip("/")
ABDM_CM_ID = os.getenv("ABDM_CM_ID", "sbx")
ABDM_HIU_ID = os.getenv("ABDM_HIU_ID", "neuropilot-demo-hiu")
# Bearer the HIU presents to the CM. A real deployment signs each request with
# the HIU's ABDM key pair and exchanges it for a token; the mock accepts a static
# value, which is a mock-level simplification and not a security design.
ABDM_CM_TOKEN = os.getenv("ABDM_CM_TOKEN", "mock-cm-token")
ABDM_REQUESTER_NAME = os.getenv("ABDM_REQUESTER_NAME", "NeuroPilot Memory Clinic")
ABDM_REQUESTER_REGNO = os.getenv("ABDM_REQUESTER_REGNO", "NEUROPILOT-0001")
# Where the CM reaches us: callbacks (/abdm/consents/notify,
# /abdm/health-information/on-request) the CM drives, and the data push URL the
# HIU hands out in the HI request. Must be reachable FROM the CM in real use.
ABDM_CALLBACK_BASE_URL = os.getenv("ABDM_CALLBACK_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
ABDM_TIMEOUT_SECONDS = float(os.getenv("ABDM_TIMEOUT_SECONDS", "10"))
# Run the in-process mock Consent Manager + mock HIP (abdm_mock.py). On by default
# so the demo is self-contained; it is bypassed the moment ABDM_CM_BASE_URL is set.
ABDM_USE_MOCK_GATEWAY = os.getenv("ABDM_USE_MOCK_GATEWAY", "true").strip().lower() not in (
    "0", "false", "no", ""
)

# Features that count as CORROBORATING EVIDENCE for a High tier. These are the
# results that are not already in front of the clinician: the four biomarker
# families across stages 2-4. Cognition (MMSE / ADAS-Cog 13 / mmse_change) and
# demographics are deliberately absent -- they are the assessment the referral
# was based on, so they cannot corroborate themselves.
BIOMARKER_FEATURES = (
    "ptau217", "abeta4240", "nfl", "gfap",                     # stage 2 blood
    "hippocampal_volume", "hippocampal_icv_ratio",               # stage 3 MRI
    "centiloids", "tau_meta_temporal",                           # stage 4 PET
)

# The ordered workflow pathway: slot -> the stage at which it joins the record.
# Stage N means "stages 1..N have been ordered". Cognition (stage 1) is the
# referral assessment and is always present.
SLOT_STAGE = {"blood": 2, "imaging": 3, "pet": 4}


def slot_visible(record: dict, slot: str) -> bool:
    """True when `slot` sits inside the patient's ordered pathway.

    A result does NOT count toward the score or the tier until the pathway has
    reached its stage. Real cohorts arrive with ordering gaps -- 955 ADNI
    subjects hold an MRI and no plasma panel -- and scoring those measurements
    at Stage 1 would mean the "cognitive-only" score silently knows the scan,
    so ordering the intervening test could never add information. Gating is what
    makes each order mean something: the value enters the record exactly when
    the pathway reaches it, and never before.

    Non-record input (a bare feature vector with no `stage`) has nothing to
    gate against and passes through.
    """
    stage = record.get("stage") if isinstance(record, dict) else None
    if stage is None:
        return True
    return SLOT_STAGE.get(slot, 1) <= int(stage)


def has_biomarker_evidence(values) -> bool:
    """True when at least one biomarker result is inside the ordered pathway.

    Accepts either shape the codebase passes around:
      * a flat feature vector (model_service) -- any biomarker key non-null
      * a served record (storage/service/escalation) -- any of the blood /
        imaging / pet payloads marked completed AND inside the ordered prefix

    The prefix check matters: a completed payload sitting beyond the pathway is
    deliberately hidden from the model (see slot_visible), so counting it here
    would let data the score cannot see decide the tier.
    """
    if not values:
        return False
    for key in BIOMARKER_FEATURES:
        if values.get(key) is not None:
            return True
    for slot in ("blood", "imaging", "pet"):
        payload = values.get(slot)
        if not isinstance(payload, dict) or payload.get("status") != "completed":
            continue
        if not slot_visible(values, slot):
            continue
        return True
    return False


# The value keys each slot carries in a served record. Used to answer "does the
# FILE hold a real measurement for this modality?" -- a question that must be
# answered INDEPENDENTLY of the pathway stage, because a patient sitting at
# Stage 1 can still hold a real MRI on file.
RESULT_VALUE_KEYS = {
    "blood": ("pTau181", "abeta4240", "pTau217", "nfl", "gfap"),
    "imaging": ("hippocampalVolumeCm3", "hippocampalIcvRatio", "icvCm3"),
    "pet": ("centiloids", "amyloidSuvr", "tauMetaTemporalSuvr"),
}


def real_result_slots(record) -> list[str]:
    """Slots carrying an actual measured value -- STAGE-INDEPENDENT.

    Deliberately ignores `stage`: the cohort keeps every patient who has a real
    result anywhere in the file, including the ones who read as "cognitive" in
    the UI because ADNI's modalities arrive out of order. Gating decides what
    the SCORE may see; this decides whether there is anything worth serving.
    """
    if not isinstance(record, dict):
        return []
    found = []
    for slot, keys in RESULT_VALUE_KEYS.items():
        payload = record.get(slot)
        if isinstance(payload, dict) and any(payload.get(k) is not None for k in keys):
            found.append(slot)
    return found


def pending_evidence_beyond(record: dict) -> bool:
    """True when a REAL result is on file for a slot the pathway has not reached.

    This is the zero-cost case: the measurement already exists, so incorporating
    it costs the patient nothing. The escalation engine uses it to keep ordering
    through a gap even when the current score is low -- refusing to look at a
    test result you already paid for would be indefensible, and it would strand
    the 1,215 gap patients whose gated score lands them at Low.
    """
    for slot in ("blood", "imaging", "pet"):
        payload = record.get(slot)
        if isinstance(payload, dict) and payload.get("status") == "completed" \
                and not slot_visible(record, slot):
            return True
    return False


def risk_tier(score: float, evidence: bool | None = None) -> str:
    """Bucket a 0-1 risk score into high / medium / low.

    A High tier is a claim that something actionable has been found, so it
    requires corroboration: at least one biomarker result on file. A patient
    whose only measurement is a cognitive scale is capped at Medium --
    "elevated on cognition, awaiting confirmation" -- because cognition is the
    test the clinician already ran, and on its own it cannot establish what the
    underlying pathology is. They rise to High the moment a biomarker lands.

    `evidence=None` means the caller has no record to judge (a bare score), and
    keeps the plain threshold bucket. Record-shaped callers must pass the flag.
    """
    if score > HIGH_THRESHOLD:
        return "medium" if evidence is False else "high"
    if score >= MEDIUM_THRESHOLD:
        return "medium"
    return "low"