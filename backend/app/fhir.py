"""FHIR R4 export layer (Phase 1 of FHIR_INTEGRATION.md).

Read-only conversion of NeuroPilot patient records into FHIR R4 resources so a
hospital FHIR server (or a local HAPI server) can consume NeuroPilot's
decision-support output:

  Patient.identifier   <- record id (system: urn:neuropilot:subject-id)
  Observation (LOINC)  <- MMSE 72106-8, p-tau181 (part code LP157017-7),
                          Aβ42/40 ratio 41027-4, hippocampal volume + PET
                          (no standard LOINC exists -> urn:neuropilot:codes)
  RiskAssessment       <- risk score (probabilityDecimal), tier
                          (qualitativeRisk H/M/L from HL7 v3 ObservationValue),
                          SHAP factors (rationale + extensions), basis -> Observations
  AuditEvent           <- the patient's event & reasoning trail (append-only log)

HARD RULE (blueprint contract): model output NEVER becomes a Condition or a
diagnostic conclusion -- a RiskAssessment is explicitly decision support, not a
diagnosis. backend/tests/test_fhir.py enforces that invariant over the exported
bundles.

Coding honesty: where a verified standard code exists it is used (MMSE 72106-8);
where none exists (hippocampal volume, SUVR, PET binary status) we use
urn:neuropilot:codes rather than borrowing a wrong code. Aβ42/40 reuses LOINC
41027-4 by convention (CSF-origin code -- documented limitation L1).
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from . import service

FHIR_JSON = "application/fhir+json"

LOINC = "http://loinc.org"
SNOMED = "http://snomed.info/sct"
UCUM = "http://unitsofmeasure.org"
V3_OBS_INTERPRETATION = "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation"
V3_OBSERVATION_VALUE = "http://terminology.hl7.org/CodeSystem/v3-ObservationValue"
AUDIT_OUTCOME = "http://terminology.hl7.org/CodeSystem/audit-event-outcome"
NP_SYSTEM = "urn:neuropilot:codes"
ID_SYSTEM = "urn:neuropilot:subject-id"
SHAP_EXT = "urn:neuropilot:fhir:shap-factor"
AGE_EXT = "urn:neuropilot:fhir:age-years"

_TIER_TO_V3 = {"high": "H", "medium": "M", "low": "L"}


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #
def _iso(dt: Optional[str]) -> Optional[str]:
    """'%Y-%m-%d %H:%M' audit timestamps -> FHIR dateTime (timezone optional in R4)."""
    if not dt:
        return None
    try:
        return datetime.strptime(dt, "%Y-%m-%d %H:%M").isoformat(timespec="seconds")
    except ValueError:
        return dt


def _operation_outcome(severity: str, code: str, diagnostics: str) -> dict:
    return {
        "resourceType": "OperationOutcome",
        "issue": [{"severity": severity, "code": code, "diagnostics": diagnostics}],
    }


def _interpretation(outcome: Optional[str]) -> list[dict]:
    """normal/abnormal -> HL7 v3 ObservationInterpretation; inconclusive -> omitted."""
    mapping = {"normal": "N", "abnormal": "A"}
    code = mapping.get((outcome or "").lower())
    if code is None:
        return []
    return [{"coding": [{"system": V3_OBS_INTERPRETATION, "code": code}]}]


def _quantity(value: float, unit: str, ucum: str) -> dict:
    return {"value": float(value), "unit": unit, "system": UCUM, "code": ucum}


def _record(patient_id: str) -> Optional[dict]:
    return service.PATIENTS.get(patient_id)


def _sorted_records() -> list[dict]:
    return sorted(service.PATIENTS.values(), key=lambda r: r["score"], reverse=True)


# --------------------------------------------------------------------------- #
# resource builders
# --------------------------------------------------------------------------- #
def patient_resource(record: dict) -> dict:
    """Patient demographics. FHIR stores birthDate, not age -- we hold only
    age, so we emit a year-only birthDate (YYYY precision is valid FHIR,
    +-1 year honest) plus an explicit age extension (limitation L2)."""
    pid = record["id"]
    age = record.get("age")
    sex = {"M": "male", "F": "female"}.get(record.get("sex"), "unknown")
    res: dict[str, Any] = {
        "resourceType": "Patient",
        "id": pid,
        "identifier": [{"system": ID_SYSTEM, "value": pid}],
        "gender": sex,
    }
    if isinstance(age, (int, float)) and age:
        birth_year = datetime.now().year - int(age)
        res["birthDate"] = f"{birth_year:04d}"
        res.setdefault("extension", []).append(
            {"url": AGE_EXT, "valueInteger": int(age)}
        )
    return res


def observation_resources(record: dict) -> list[dict]:
    """All measured values as LOINC/custom-coded Observations (status 'final').

    Deterministic ids so RiskAssessment.basis can reference them. Prior MMSE is
    exported separately (mmse_change itself is derived, never stored)."""
    pid = record["id"]
    issued = _iso(record.get("updated_at"))
    obs: list[dict] = []

    def _obs(obs_id: str, code: dict, value: dict, category: str, note: Optional[str] = None,
             outcome: Optional[str] = None) -> None:
        entry: dict[str, Any] = {
            "resourceType": "Observation",
            "id": f"obs-{pid}-{obs_id}",
            "status": "final",
            "category": [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/observation-category",
                                      "code": category}]}],
            "code": code,
            "subject": {"reference": f"Patient/{pid}"},
            "valueQuantity": value,
        }
        if issued:
            entry["issued"] = issued
        interp = _interpretation(outcome)
        if interp:
            entry["interpretation"] = interp
        if note:
            entry["note"] = [{"text": note}]
        obs.append(entry)

    # ---- cognitive stage: MMSE (LOINC 72106-8) or MoCA (custom -- no verified mapping)
    cog = record.get("cognitive") or {}
    scale = (cog.get("scale") or "MMSE").upper()
    latest, prior = cog.get("latest"), cog.get("prior")
    if latest is not None:
        code = (
            {"coding": [{"system": LOINC, "code": "72106-8", "display": "Total score [MMSE]"}],
             "text": "MMSE total score"}
            if scale == "MMSE"
            else {"coding": [{"system": NP_SYSTEM, "code": "moca-total-score",
                              "display": "MoCA total score (no verified LOINC mapping)"}],
                  "text": f"{scale} total score"}
        )
        _obs("mmse-latest", code, _quantity(latest, "score", "{score}"), "survey")
    if prior is not None and prior != latest:
        _obs(
            "mmse-prior",
            {"coding": [{"system": LOINC, "code": "72106-8", "display": "Total score [MMSE]"}],
             "text": "MMSE total score (prior)"},
            _quantity(prior, "score", "{score}"),
            "survey",
            note="Prior assessment -- the source value for the derived mmse_change feature.",
        )

    # ---- blood stage
    blood = record.get("blood") or {}
    if isinstance(blood, dict):
        if blood.get("pTau181") is not None:
            _obs(
                "ptau181",
                {
                    "coding": [
                        # LOINC part code: no single plasma mass-concentration code exists (L1)
                        {"system": LOINC, "code": "LP157017-7",
                         "display": "Tau protein.phosphorylated 181"},
                        {"system": NP_SYSTEM, "code": "ptau181-plasma",
                         "display": "p-tau181, plasma"},
                    ],
                    "text": "p-tau181 (plasma)",
                },
                _quantity(blood["pTau181"], "pg/mL", "pg/mL"),
                "laboratory",
                note=blood.get("note"),
                outcome=blood.get("outcome"),
            )
        if blood.get("abeta4240") is not None:
            _obs(
                "abeta4240",
                {
                    "coding": [
                        {"system": LOINC, "code": "41027-4",
                         "display": "Tau protein/Amyloid beta 42 peptide [Ratio]"},
                    ],
                    "text": "Aβ42/40 ratio (41027-4 reused by convention from CSF)",
                },
                _quantity(blood["abeta4240"], "ratio", "1"),
                "laboratory",
                outcome=blood.get("outcome"),
            )

    # ---- imaging stage (no standard LOINC for hippocampal volume -> custom)
    imaging = record.get("imaging") or {}
    if isinstance(imaging, dict) and imaging.get("hippocampalVolumeCm3") is not None:
        _obs(
            "hippocampal-volume",
            {
                "coding": [{"system": NP_SYSTEM, "code": "hippocampal-volume",
                            "display": "Hippocampal volume, MRI-derived (cm3)"}],
                "text": imaging.get("note", "Hippocampal volume (MRI)"),
            },
            _quantity(imaging["hippocampalVolumeCm3"], "cm3", "cm3"),
            "imaging",
            note=imaging.get("note"),
            outcome=imaging.get("outcome"),
        )

    # ---- PET stage (SNOMED positive/negative; SUVR custom)
    pet = record.get("pet") or {}
    if isinstance(pet, dict):
        snomed = {"positive": ("10828004", "Positive"), "negative": ("260373001", "Negative")}
        for slot_id, key, label in (("amyloid-pet", "amyloid", "Amyloid PET status"),
                                    ("tau-pet", "tau", "Tau PET status")):
            raw = pet.get(key)
            if raw is None:
                continue
            sct = snomed.get(str(raw).lower())
            coding: list[dict] = []
            if sct:
                coding.append({"system": SNOMED, "code": sct[0], "display": sct[1]})
            _obs(
                slot_id,
                {"coding": coding, "text": f"{label}: {raw}"},
                # valueCodeableConcept, not valueQuantity -- injected below
                _quantity(1, "1", "1"),  # placeholder replaced right after
                "imaging",
                outcome=pet.get("outcome") if key == "amyloid" else None,
            )
            obs[-1].pop("valueQuantity")
            obs[-1]["valueCodeableConcept"] = {"coding": coding, "text": str(raw)}

        if pet.get("amyloidSUVr") is not None:
            _obs(
                "amyloid-suvr",
                {"coding": [{"system": NP_SYSTEM, "code": "amyloid-suvr",
                             "display": "Neocortical amyloid SUVR"}],
                 "text": "Amyloid PET SUVR"},
                _quantity(pet["amyloidSUVr"], "SUVR", "{SUVR}"),
                "imaging",
            )

    return obs


def risk_assessment_resource(record: dict) -> dict:
    """Risk score + tier + SHAP attribution as RiskAssessment.

    This is the deliberate FHIR home for model output: a RiskAssessment is
    decision support BY DEFINITION -- we never emit a Condition (the
    no-diagnosis contract survives the standard, limitation L4)."""
    pid = record["id"]
    tier = record.get("risk_tier") or service.risk_tier(record["score"])
    factors = sorted(
        record.get("factors", []), key=lambda f: abs(f.get("effect", 0.0)), reverse=True
    )[:3]
    obs_ids = [o["id"] for o in observation_resources(record)]
    rationale = "Top SHAP drivers: " + ", ".join(
        f"{f.get('feature')} {f.get('effect', 0.0):+.4f}" for f in factors
    ) if factors else "Attribution factors unavailable for this record."
    return {
        "resourceType": "RiskAssessment",
        "id": f"risk-{pid}",
        "status": "final",
        "subject": {"reference": f"Patient/{pid}"},
        "occurrenceDateTime": _iso(record.get("updated_at")),
        "basis": [{"reference": f"Observation/{oid}"} for oid in obs_ids],
        "prediction": [
            {
                "outcome": {"text": f"{tier} priority tier"},
                "probabilityDecimal": float(record["score"]),
                "qualitativeRisk": {"coding": [{"system": V3_OBSERVATION_VALUE,
                                                "code": _TIER_TO_V3.get(tier, "M")}]},
            }
        ],
        "rationale": rationale,
        "note": [
            {
                "text": (
                    "NeuroPilot priority decision-support output -- allocation guidance "
                    "only, never a diagnosis. Thresholds: high >0.7, medium >=0.4."
                )
            }
        ],
        "extension": [
            {"url": SHAP_EXT, "valueString": f"{f.get('feature')}={f.get('effect', 0.0):+.4f}"}
            for f in factors
        ],
    }


def audit_event_resources(record: dict, limit: int = 20) -> list[dict]:
    """Event & reasoning trail -> AuditEvent (text carried in entity.detail)."""
    pid = record["id"]
    events = (record.get("history") or [])[-limit:]
    out = []
    for i, entry in enumerate(events):
        out.append(
            {
                "resourceType": "AuditEvent",
                "id": f"audit-{pid}-{i}",
                "type": {"system": NP_SYSTEM, "code": "neuropilot-event",
                         "display": "NeuroPilot decision event"},
                "recorded": _iso(entry.get("at")),
                "agent": [{"who": {"display": "NeuroPilot decision engine"}, "requestor": False}],
                "source": {"observer": {"display": "NeuroPilot"}},
                "outcome": {"system": AUDIT_OUTCOME, "code": "0", "display": "Success"},
                "entity": [
                    {
                        "what": {"reference": f"Patient/{pid}"},
                        "detail": [{"type": "event-text", "valueString": entry.get("text", "")}],
                    }
                ],
            }
        )
    return out


def everything_bundle(record: dict) -> dict:
    """Patient/$everything: one collection Bundle with the complete export."""
    pid = record["id"]
    resources = (
        [patient_resource(record)]
        + observation_resources(record)
        + [risk_assessment_resource(record)]
        + audit_event_resources(record)
    )
    return {
        "resourceType": "Bundle",
        "id": f"bundle-everything-{pid}",
        "type": "collection",
        "timestamp": _iso(record.get("updated_at")),
        "entry": [
            {"fullUrl": f"{r['resourceType']}/{r['id']}", "resource": r} for r in resources
        ],
    }


def capability_statement() -> dict:
    """Static conformance statement for the Phase 1 export surface."""
    return {
        "resourceType": "CapabilityStatement",
        "status": "active",
        "date": datetime.now().strftime("%Y-%m-%d"),
        "kind": "instance",
        "software": {"name": "NeuroPilot", "version": "0.1.0"},
        "implementation": {"description": "NeuroPilot FHIR R4 export (Phase 1: read-only)"},
        "fhirVersion": "4.0.1",
        "format": ["json", FHIR_JSON],
        "rest": [
            {
                "mode": "server",
                "documentation": (
                    "Read-only export of priority decision support. Model output is "
                    "carried as RiskAssessment, never as Condition or diagnosis. "
                    "SMART on FHIR (OAuth 2.0) is the Phase 4 auth layer; this surface "
                    "serves synthetic cohort data for interoperability demonstration."
                ),
                "resource": [
                    {
                        "type": "Patient",
                        "interaction": [{"code": "read"}, {"code": "search-type"}],
                        "operation": [
                            {"name": "everything",
                             "definition": "http://hl7.org/fhir/OperationDefinition/Patient-everything"}
                        ],
                    },
                    {
                        "type": "Observation",
                        "interaction": [{"code": "search-type"}],
                        "searchParam": [{"name": "patient", "type": "reference"}],
                    },
                    {
                        "type": "RiskAssessment",
                        "interaction": [{"code": "search-type"}],
                        "searchParam": [{"name": "patient", "type": "reference"}],
                    },
                ],
            }
        ],
    }


# --------------------------------------------------------------------------- #
# search helpers (used by the API routes)
# --------------------------------------------------------------------------- #
def search_patients(count: int = 50, page: int = 1) -> dict:
    """Whole-cohort Patient searchset, ranked by score desc (NeuroPilot's view).
    Paging is a plain page/_count pair -- FHIR page-tokens are a Phase 2 nicety."""
    records = _sorted_records()
    start = (max(page, 1) - 1) * max(min(count, 200), 1)
    window = records[start : start + min(count, 200)]
    return {
        "resourceType": "Bundle",
        "id": f"patient-search-p{page}-c{count}",
        "type": "searchset",
        "total": len(records),
        "entry": [
            {"fullUrl": f"Patient/{r['id']}", "resource": patient_resource(r)} for r in window
        ],
    }


def search_observations(patient_id: Optional[str] = None, count: int = 200) -> dict:
    records = [_record(patient_id)] if patient_id else _sorted_records()
    records = [r for r in records if r is not None][: max(min(count, 500), 1)]
    flat = []
    for r in records:
        flat.extend(observation_resources(r))
    return {
        "resourceType": "Bundle",
        "id": "observation-search",
        "type": "searchset",
        "total": len(flat),
        "entry": [{"fullUrl": f"Observation/{o['id']}", "resource": o} for o in flat],
    }


def search_risk_assessments(patient_id: Optional[str] = None, count: int = 100) -> dict:
    records = [_record(patient_id)] if patient_id else _sorted_records()
    records = [r for r in records if r is not None][: max(min(count, 500), 1)]
    ras = [risk_assessment_resource(r) for r in records]
    return {
        "resourceType": "Bundle",
        "id": "riskassessment-search",
        "type": "searchset",
        "total": len(ras),
        "entry": [{"fullUrl": f"RiskAssessment/{ra['id']}", "resource": ra} for ra in ras],
    }
