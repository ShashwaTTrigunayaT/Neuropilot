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
SMART_OAUTH_EXT = "http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris"

_TIER_TO_V3 = {"high": "H", "medium": "M", "low": "L"}

# The three orderable tests, as the code a ServiceRequest/DiagnosticReport
# carries. No verified LOINC panel code exists for a plasma AD panel bundle or
# for an MRI volumetrics study, so these are urn:neuropilot:codes -- the same
# honesty rule the Observation layer follows (limitation L1).
SLOT_PANEL = {
    "blood": ("panel-blood-plasma-ad", "Blood biomarker panel (plasma p-tau, Aβ42/40, NfL, GFAP)"),
    "imaging": ("panel-mri-volumetrics", "MRI hippocampal volumetrics"),
    "pet": ("panel-amyloid-tau-pet", "Amyloid / tau PET"),
}

# ServiceRequest.status for each internal slot status. An order placed with no
# result on file is `active` (the hospital still owes a result); a slot holding
# a real measured value is `completed`. That is the whole bidirectional
# contract, and it is derived from the record -- never invented here.
_ORDER_STATUS = {"ordered": "active", "completed": "completed"}

_DR_OUTCOME = {"normal": "normal", "abnormal": "abnormal", "inconclusive": "inconclusive"}


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #
def _iso(dt: Optional[str]) -> Optional[str]:
    """'%Y-%m-%d %H:%M' audit timestamps -> FHIR dateTime (timezone optional in R4)."""
    if not dt:
        return None
    try:
        value = datetime.strptime(dt, "%Y-%m-%d %H:%M").isoformat(timespec="seconds")
    except ValueError:
        value = dt
    # FHIR instant/dateTime values with a time require a timezone. The internal
    # audit timestamps are deliberately timezone-free local values, so publish
    # them as UTC with an explicit Z rather than emitting invalid R4 JSON.
    if "T" in value and not value.endswith("Z") and "+" not in value[10:]:
        value += "Z"
    return value


def _instant(dt: Optional[str]) -> Optional[str]:
    """Convert an internal timestamp to an R4 instant with timezone."""
    value = _iso(dt)
    if value and "T" not in value:
        return f"{value}T00:00:00Z"
    return value


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
                        {"system": NP_SYSTEM, "code": "abeta4240-ratio",
                         "display": "Aβ42/40 ratio, plasma"},
                    ],
                    "text": "Aβ42/40 ratio (41027-4 reused by convention from CSF)",
                },
                _quantity(blood["abeta4240"], "ratio", "1"),
                "laboratory",
                outcome=blood.get("outcome"),
            )
        # The remaining plasma panel the refined model actually consumes. No
        # verified LOINC mass-concentration codes exist for these yet (L1), so
        # they travel as urn:neuropilot:codes -- the same codes the inbound
        # mapper accepts, which is what makes the round-trip work.
        for slot_id, key, label, unit in (
            ("ptau217", "pTau217", "p-tau217 (plasma)", "pg/mL"),
            ("nfl", "nfl", "Neurofilament light (plasma)", "pg/mL"),
            ("gfap", "gfap", "GFAP (plasma)", "pg/mL"),
        ):
            if blood.get(key) is None:
                continue
            _obs(
                slot_id,
                {"coding": [{"system": NP_SYSTEM, "code": f"{slot_id}-plasma",
                             "display": label}], "text": label},
                _quantity(blood[key], unit, unit),
                "laboratory",
                note=blood.get("note"),
                outcome=blood.get("outcome"),
            )

    # ---- imaging stage (no standard LOINC for hippocampal volume -> custom)
    imaging = record.get("imaging") or {}
    if isinstance(imaging, dict):
        if imaging.get("hippocampalVolumeCm3") is not None:
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
        if imaging.get("hippocampalIcvRatio") is not None:
            _obs(
                "hippocampal-icv-ratio",
                {"coding": [{"system": NP_SYSTEM, "code": "hippocampal-icv-ratio",
                             "display": "Hippocampal volume / ICV ratio"}],
                 "text": "Hippocampal/ICV ratio (MRI)"},
                _quantity(imaging["hippocampalIcvRatio"], "ratio", "1"),
                "imaging",
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

        for slot_id, key, label in (
            ("amyloid-suvr", "amyloidSUVr", "Neocortical amyloid SUVR"),
            ("tau-meta-temporal-suvr", "tauMetaTemporalSuvr", "Tau meta-temporal SUVR"),
        ):
            if pet.get(key) is None:
                continue
            _obs(
                slot_id,
                {"coding": [{"system": NP_SYSTEM, "code": slot_id, "display": label}],
                 "text": label},
                _quantity(pet[key], "SUVR", "{SUVR}"),
                "imaging",
            )
        if pet.get("centiloids") is not None:
            _obs(
                "centiloids",
                {"coding": [{"system": NP_SYSTEM, "code": "centiloids",
                             "display": "Amyloid PET Centiloids"}],
                 "text": "Amyloid PET (Centiloids)"},
                _quantity(pet["centiloids"], "Centiloid", "1"),
                "imaging",
                outcome=pet.get("outcome"),
            )

    return obs


def risk_assessment_resource(record: dict) -> dict:
    """Risk score + tier + SHAP attribution as RiskAssessment.

    This is the deliberate FHIR home for model output: a RiskAssessment is
    decision support BY DEFINITION -- we never emit a Condition (the
    no-diagnosis contract survives the standard, limitation L4)."""
    pid = record["id"]
    # Evidence-gated, like the served tier: a High RiskAssessment asserts an
    # actionable finding, so it needs a biomarker result behind it.
    tier = record.get("risk_tier") or service.risk_tier(
        record["score"], service.has_biomarker_evidence(record)
    )
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
        # R4 has no `rationale` element. Carry the explanation in the standard
        # note field and keep each SHAP driver as a typed extension.
        "note": [
            {
                "text": (
                    f"{rationale}. NeuroPilot priority decision-support output -- "
                    "allocation guidance only, never a diagnosis. Thresholds: "
                    "high >0.7, medium >=0.4."
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
                "recorded": _instant(entry.get("at")),
                "agent": [{"who": {"display": "NeuroPilot decision engine"}, "requestor": False}],
                "source": {"observer": {"display": "NeuroPilot"}},
                # AuditEvent.outcome is an R4 code, not a Coding object.
                "outcome": "0",
                "entity": [
                    {
                        "what": {"reference": f"Patient/{pid}"},
                        "detail": [{"type": "event-text", "valueString": entry.get("text", "")}],
                    }
                ],
            }
        )
    return out


def service_request_resources(record: dict) -> list[dict]:
    """Placed orders as ServiceRequest (Phase 3, outbound order entry).

    Derived from the record's slot payloads rather than a parallel order table,
    so an order can never exist in FHIR but not in the pathway (or the reverse).
    A slot that only says `ordered` is `active` -- the hospital still owes a
    result; a slot carrying a real measured value is `completed`. Ordering with
    no result on file therefore exports a genuine open order, which is exactly
    the state the dashboard shows.
    """
    pid = record["id"]
    out: list[dict] = []
    for slot, (code, label) in SLOT_PANEL.items():
        payload = record.get(slot)
        if not isinstance(payload, dict):
            continue
        status = _ORDER_STATUS.get(str(payload.get("status")))
        if status is None:
            continue
        authored = _iso(payload.get("ordered_at") or record.get("updated_at"))
        res: dict[str, Any] = {
            "resourceType": "ServiceRequest",
            "id": f"order-{pid}-{slot}",
            "status": status,
            "intent": "order",
            "priority": "routine",
            "category": [{"coding": [{"system": "http://snomed.info/sct",
                                      "code": "108252007",
                                      "display": "Laboratory procedure"}]}],
            "code": {"coding": [{"system": NP_SYSTEM, "code": code, "display": label}],
                     "text": label},
            "subject": {"reference": f"Patient/{pid}"},
            "requester": {"display": "NeuroPilot autonomous triage loop"},
            # FHIR R4's reasonReference is restricted to Condition, Observation,
            # DiagnosticReport and DocumentReference; RiskAssessment is not valid
            # there. supportingInfo accepts Reference(Any) and preserves the
            # auditable link to NeuroPilot's decision-support output.
            "supportingInfo": [{"reference": f"RiskAssessment/risk-{pid}"}],
            "reasonCode": [{"text": "NeuroPilot priority decision-support order"}],
            "note": [{
                "text": (
                    "Placed by NeuroPilot priority decision support. The patient's "
                    "result is recorded through POST /fhir/Bundle (Observation or "
                    "DiagnosticReport) and re-scored by the served model."
                )
            }],
        }
        if authored:
            res["authoredOn"] = authored
        if payload.get("outcome"):
            res["note"].append({"text": f"Result outcome: {payload['outcome']}"})
        out.append(res)
    return out


def diagnostic_report_resources(record: dict) -> list[dict]:
    """Completed panels as DiagnosticReport (Phase 3, outbound results).

    The report's `conclusion` carries NeuroPilot's normal/abnormal/inconclusive
    read of the panel; its `result` references point at the Observations the
    export already emits. A DiagnosticReport is a report about a test -- never a
    diagnosis of Alzheimer's, so the no-Condition rule holds here too.
    """
    pid = record["id"]
    observations = {o["id"]: o for o in observation_resources(record)}
    slot_prefix = {
        "blood": ("ptau181", "abeta4240", "ptau217", "nfl", "gfap"),
        "imaging": ("hippocampal-volume", "hippocampal-icv-ratio"),
        "pet": ("amyloid-pet", "tau-pet", "amyloid-suvr", "tau-meta-temporal-suvr", "centiloids"),
    }
    out: list[dict] = []
    for slot, (code, label) in SLOT_PANEL.items():
        payload = record.get(slot)
        if not isinstance(payload, dict) or payload.get("status") != "completed":
            continue
        result_refs = [
            {"reference": f"Observation/{observations[f'obs-{pid}-{name}']['id']}"}
            for name in slot_prefix.get(slot, ())
            if f"obs-{pid}-{name}" in observations
        ]
        res: dict[str, Any] = {
            "resourceType": "DiagnosticReport",
            "id": f"report-{pid}-{slot}",
            "status": "final",
            "category": [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/v2-0074",
                                      "code": "LAB" if slot == "blood" else "RAD"}]}],
            "code": {"coding": [{"system": NP_SYSTEM, "code": code, "display": label}],
                     "text": label},
            "subject": {"reference": f"Patient/{pid}"},
            "result": result_refs,
        }
        issued = _iso(payload.get("ordered_at") or record.get("updated_at"))
        if issued:
            res["issued"] = issued
        outcome = _DR_OUTCOME.get(str(payload.get("outcome")))
        if outcome:
            res["conclusion"] = f"{label}: {outcome}"
            interpretation = _interpretation(outcome)
            if interpretation:
                res["conclusionCode"] = interpretation
        if payload.get("note"):
            # DiagnosticReport.note is not an R4 element. Preserve the source
            # note as a namespaced extension instead of emitting invalid JSON.
            res.setdefault("extension", []).append({
                "url": "urn:neuropilot:fhir:report-note",
                "valueString": str(payload["note"]),
            })
        out.append(res)
    return out


def everything_bundle(record: dict) -> dict:
    """Patient/$everything: one collection Bundle with the complete export."""
    pid = record["id"]
    resources = (
        [patient_resource(record)]
        + observation_resources(record)
        + [risk_assessment_resource(record)]
        + service_request_resources(record)
        + diagnostic_report_resources(record)
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
    """Conformance statement for the full surface (Phases 1-4)."""
    from . import config

    security: dict[str, Any] = {
        "cors": True,
        "service": [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/restful-security-service",
                                 "code": "SMART-on-FHIR", "display": "SMART-on-FHIR"}]}],
        "description": (
            "SMART on FHIR (OAuth 2.0, authorization-code + PKCE) with a "
            "minimum-necessary scope set. Launches are handled by "
            "GET /fhir/smart/launch; tokens are held server-side, never in the browser."
        ),
    }
    if config.SMART_CLIENT_ID:
        security["extension"] = [{
            "url": SMART_OAUTH_EXT,
            "extension": [
                {"url": "authorize",
                 "valueUri": config.SMART_REDIRECT_URI or "/fhir/smart/launch"},
            ],
        }]

    return {
        "resourceType": "CapabilityStatement",
        "status": "active",
        "date": datetime.now().strftime("%Y-%m-%d"),
        "kind": "instance",
        "software": {"name": "NeuroPilot", "version": "0.2.0"},
        "implementation": {
            "description": (
                "NeuroPilot FHIR R4 — export (Phase 1), inbound ingestion (Phase 2), "
                "bidirectional orders/results (Phase 3), SMART on FHIR launch (Phase 4)"
            )
        },
        "fhirVersion": "4.0.1",
        "format": ["json", FHIR_JSON],
        "rest": [
            {
                "mode": "server",
                "interaction": [{"code": "transaction"}],
                "security": security,
                "documentation": (
                    "Export of priority decision support plus inbound ingestion "
                    "(POST /fhir/Bundle, transaction). Orders leave as ServiceRequest "
                    "(intent=order) and completed panels as DiagnosticReport; a "
                    "hospital result returns as Observation/DiagnosticReport and is "
                    "re-scored by the served model. Model output is carried as "
                    "RiskAssessment, never as Condition or diagnosis, in both "
                    "directions. This instance serves a synthetic cohort for "
                    "interoperability demonstration — not real PHI."
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
                    {
                        "type": "ServiceRequest",
                        "interaction": [{"code": "read"}, {"code": "search-type"}],
                        "searchParam": [
                            {"name": "patient", "type": "reference"},
                            {"name": "status", "type": "token"},
                        ],
                    },
                    {
                        "type": "DiagnosticReport",
                        "interaction": [{"code": "read"}, {"code": "search-type"}],
                        "searchParam": [{"name": "patient", "type": "reference"}],
                    },
                    {
                        "type": "AuditEvent",
                        "interaction": [{"code": "search-type"}],
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


def transaction_bundle(record: dict, orders_only: bool = False) -> dict:
    """The export shaped as a FHIR *transaction* (Phase 3 outbound push).

    A `collection` Bundle is a document; a transaction is a set of writes, and
    only a transaction may carry `request` entries. The server applies it
    atomically, so a hospital either receives the whole updated record or
    nothing -- a half-written clinical record is the failure mode worth
    designing against.

    Patient/Observation/RiskAssessment/ServiceRequest/DiagnosticReport use PUT
    against a deterministic id, which makes the push idempotent (re-pushing the
    same patient updates rather than duplicates). AuditEvents use POST because
    the audit trail is append-only by definition.
    """
    records = [record]
    entries: list[dict] = []

    def _add(resource: dict, method: str, url: str) -> None:
        entries.append({
            "fullUrl": f"{resource['resourceType']}/{resource['id']}",
            "resource": resource,
            "request": {"method": method, "url": url},
        })

    for r in records:
        pid = r["id"]
        _add(patient_resource(r), "PUT", f"Patient/{pid}")
        if not orders_only:
            for obs in observation_resources(r):
                _add(obs, "PUT", f"Observation/{obs['id']}")
            _add(risk_assessment_resource(r), "PUT", f"RiskAssessment/risk-{pid}")
        for order in service_request_resources(r):
            _add(order, "PUT", f"ServiceRequest/{order['id']}")
        if not orders_only:
            for report in diagnostic_report_resources(r):
                _add(report, "PUT", f"DiagnosticReport/{report['id']}")
            for event in audit_event_resources(r):
                _add(event, "POST", "AuditEvent")

    return {
        "resourceType": "Bundle",
        "id": f"bundle-transaction-{record['id']}" + ("-orders" if orders_only else ""),
        "type": "transaction",
        "timestamp": _iso(record.get("updated_at")),
        "entry": entries,
    }


def search_service_requests(patient_id: Optional[str] = None, count: int = 200,
                            status: Optional[str] = None) -> dict:
    """ServiceRequest searchset -- NeuroPilot's placed orders (Phase 3).
    `status=active` returns what the hospital still owes; `completed` what has
    come back."""
    records = [_record(patient_id)] if patient_id else _sorted_records()
    records = [r for r in records if r is not None][: max(min(count, 500), 1)]
    flat: list[dict] = []
    for r in records:
        flat.extend(service_request_resources(r))
    if status:
        flat = [s for s in flat if s.get("status") == status]
    return {
        "resourceType": "Bundle",
        "id": "servicerequest-search",
        "type": "searchset",
        "total": len(flat),
        "entry": [{"fullUrl": f"ServiceRequest/{s['id']}", "resource": s} for s in flat],
    }


def search_diagnostic_reports(patient_id: Optional[str] = None, count: int = 200) -> dict:
    records = [_record(patient_id)] if patient_id else _sorted_records()
    records = [r for r in records if r is not None][: max(min(count, 500), 1)]
    flat: list[dict] = []
    for r in records:
        flat.extend(diagnostic_report_resources(r))
    return {
        "resourceType": "Bundle",
        "id": "diagnosticreport-search",
        "type": "searchset",
        "total": len(flat),
        "entry": [{"fullUrl": f"DiagnosticReport/{d['id']}", "resource": d} for d in flat],
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
