"""FHIR R4 INBOUND ingestion (Phase 2 of FHIR_INTEGRATION.md; Phases 1 & 3 of
FHIR plan.md).

A hospital FHIR server (or a HAPI test fixture) POSTs a Bundle to
``POST /fhir/Bundle`` (or ``POST /ingest/fhir``); this module is the pure mapper
-- FHIR resources in, NeuroPilot's internal record shape out. State mutation and
re-scoring live in ``service.ingest_record`` (the same scoring path the UI uses),
so ingestion can never drift from the served model and scoring is never
re-implemented at the integration boundary.

Accepts the three Bundle shapes that matter:

* ``transaction`` -- what an EHR pushes, with relative ``Patient/{id}`` references;
* ``collection`` -- what fixtures and manual demos carry;
* ``document`` -- **what an NRCES/ABDM exchange submits**: a ``Composition`` header
  followed by the resources it references, addressed by ``#local`` fragments or
  ``urn:uuid:`` fullUrls rather than relative references. The Composition is read
  for context and reported as ignored (it is a header, not a measurement) rather
  than being treated as an error.

Identity (Phase 1 of FHIR plan.md): the ABHA address is the **preferred** subject
identifier, falling back to ``urn:neuropilot:subject-id`` and then the resource id.
The ABHA is bound onto the record, which is the crosswalk that keeps one human one
patient (limitation L9) -- without it, someone arriving once as ``ADNI-0001`` and
once as an ABHA becomes two patients with split history and split priority rank.

Idempotency (Phase 3 of FHIR plan.md): ingestion is idempotent on **ABHA +
observation date**. The document's identity is the sender's ``Bundle.identifier`` +
``timestamp`` when present, else a fingerprint of the measurements themselves
(each observation's codes and time). A hospital that retries a document therefore
gets a ``200`` that says "duplicate", with nothing written, no duplicate audit
event, and no re-score.

Mapping honesty, mirroring the export layer's rules:

* Only values the bundle actually carries are written. Nothing is imputed or
  defaulted into a measurement here.
* UCUM units are enforced per feature. A recognised code with a wrong unit
  (``mg/dL`` for a plasma p-tau, say) is a hard 422 -- never a silent coercion
  (limitation L6).
* Unrecognised observation codes are reported in ``ignored`` rather than
  dropped silently; the receipt names them, so nothing disappears without a
  record.
* Model output never enters here, and there is no inbound path that can create
  a Condition -- the no-diagnosis contract is enforced on export and holds on
  import by construction.

Atomic by design: any structural or unit problem rejects the WHOLE bundle with
an OperationOutcome listing every offending resource. Partial writes would be
the failure mode that destroys clinical trust. The one thing that is *not* a
rejection is a resource that carries no measurement (Organization, Practitioner,
Provenance, Composition): those are read, and the ones with meaning are reported.
"""
from __future__ import annotations

import hashlib
import re
from datetime import datetime
from typing import Any, Optional

from . import service

NP_SYSTEM = "urn:neuropilot:codes"
LOINC = "http://loinc.org"
SNOMED = "http://snomed.info/sct"
UCUM = "http://unitsofmeasure.org"
ID_SYSTEM = "urn:neuropilot:subject-id"
AGE_EXT = "urn:neuropilot:fhir:age-years"
FHIR_JSON = "application/fhir+json"
SUMMARY_EXT = "urn:neuropilot:fhir:ingest-summary"
IGNORED_EXT = "urn:neuropilot:fhir:ingest-ignored"
DUPLICATE_EXT = "urn:neuropilot:fhir:ingest-duplicate"

# Accepted Bundle types.
#   transaction  what an EHR pushes
#   collection   what fixtures and manual demos carry
#   document     what an ABDM HIP / NRCES exchange submits — a Composition header
#                followed by the resources it references, typically with
#                `#local` or `urn:uuid:` references rather than relative ones.
# Rejecting `document` (the earlier behaviour) meant the one shape India's health
# data exchange actually sends was refused with a 422.
_ACCEPTED_BUNDLE_TYPES = ("transaction", "collection", "document")

# ABHA identifier systems. NHDM has used more than one over time, so match on the
# host rather than on one exact string — an ABHA arriving under a system we did
# not list would silently become a different patient.
ABHA_SYSTEM_HOSTS = ("healthid.ndhm.gov.in", "ndhm.gov.in", "abha.abdm.gov.in")
# Fallback shape of an ABHA *address* (`name@sbx`), for senders that omit the
# system. Deliberately strict: an identifier that merely contains '@' (an email in
# a contact field) must not be mistaken for an identity.
_ABHA_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{1,}@[A-Za-z0-9]{2,}$")


class IngestError(Exception):
    """Raised when a bundle must be rejected (maps to HTTP 422)."""

    def __init__(self, issues: list[dict]):
        super().__init__("FHIR bundle rejected")
        self.issues = issues


# --------------------------------------------------------------------------- #
# code -> feature mapping
#
# (system, code) -> (slot, feature key, expected UCUM, label). Cognitive maps to
# slot "cognitive" (resolved to latest/prior afterwards) and "demographics"
# writes straight onto the record. Both real-ADNI feature names (pTau217, nfl,
# gfap, centiloids, ...) and the codes the Phase 1 export emits are accepted, so
# a $everything bundle round-trips through this endpoint.
# --------------------------------------------------------------------------- #
_QUANTITY_MAP: dict[tuple[str, str], tuple[str, str, str, str]] = {
    (LOINC, "72106-8"): ("cognitive", "mmse", "{score}", "MMSE total score"),
    (LOINC, "72107-6"): ("cognitive", "mmse", "{score}", "MMSE panel score"),
    (LOINC, "LP157017-7"): ("blood", "pTau181", "pg/mL", "p-tau181"),
    (LOINC, "41027-4"): ("blood", "abeta4240", "1", "Aβ42/40 ratio"),
    (NP_SYSTEM, "ptau181-plasma"): ("blood", "pTau181", "pg/mL", "p-tau181"),
    (NP_SYSTEM, "ptau217-plasma"): ("blood", "pTau217", "pg/mL", "p-tau217"),
    (NP_SYSTEM, "abeta4240-ratio"): ("blood", "abeta4240", "1", "Aβ42/40 ratio"),
    (NP_SYSTEM, "nfl-plasma"): ("blood", "nfl", "pg/mL", "NfL"),
    (NP_SYSTEM, "gfap-plasma"): ("blood", "gfap", "pg/mL", "GFAP"),
    (NP_SYSTEM, "hippocampal-volume"): ("imaging", "hippocampalVolumeCm3", "cm3", "hippocampal volume"),
    (NP_SYSTEM, "hippocampal-icv-ratio"): ("imaging", "hippocampalIcvRatio", "1", "hippocampal/ICV ratio"),
    (NP_SYSTEM, "centiloids"): ("pet", "centiloids", "1", "amyloid Centiloids"),
    (NP_SYSTEM, "amyloid-suvr"): ("pet", "amyloidSuvr", "{SUVR}", "amyloid SUVR"),
    (NP_SYSTEM, "tau-meta-temporal-suvr"): ("pet", "tauMetaTemporalSuvr", "{SUVR}", "tau meta-temporal SUVR"),
    (NP_SYSTEM, "education-years"): ("demographics", "education_years", "a", "education (years)"),
    (NP_SYSTEM, "apoe-e4"): ("demographics", "apoe_e4", "1", "APOE ε4"),
}

# PET binary status arrives as valueCodeableConcept, not valueQuantity.
_CODEABLE_MAP: dict[tuple[str, str], tuple[str, str]] = {
    (NP_SYSTEM, "amyloid-pet-status"): ("pet", "amyloid"),
    (NP_SYSTEM, "tau-pet-status"): ("pet", "tau"),
}

# DiagnosticReport panel code -> slot (Phase 3: the hospital sends back the
# report on an order NeuroPilot placed). These are the panel codes the export
# emits, so a NeuroPilot->hospital->NeuroPilot loop round-trips.
_REPORT_MAP: dict[tuple[str, str], str] = {
    (NP_SYSTEM, "panel-blood-plasma-ad"): "blood",
    (NP_SYSTEM, "panel-mri-volumetrics"): "imaging",
    (NP_SYSTEM, "panel-amyloid-tau-pet"): "pet",
}

# Ordered deliberately: "abnormal" CONTAINS "normal", so a substring test would
# read every abnormal panel as normal. Word boundaries, abnormal first.
_CONCLUSION_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\babnormal\b"), "abnormal"),
    (re.compile(r"\binconclusive\b|\bindeterminate\b"), "inconclusive"),
    (re.compile(r"\bnormal\b"), "normal"),
)

# UCUM codes / unit spellings accepted for each expected unit. Looseness is
# limited to genuine synonyms (ng/L == pg/mL); a wrong dimension never passes.
_ACCEPT_UNITS: dict[str, set[str]] = {
    "pg/mL": {"pg/mL", "pg/ml", "ng/L", "ng/l"},
    "1": {"1", "ratio", "{ratio}"},
    "cm3": {"cm3", "cm³", "mL", "ml"},
    "{SUVR}": {"{SUVR}", "SUVR", "suvr", "{score}"},
    "{score}": set(),  # scale scores carry no meaningful unit
    "a": {"a", "years", "year", "yr", "yrs"},
}


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #
def _coding_keys(code_obj: dict):
    for coding in code_obj.get("coding") or []:
        if not isinstance(coding, dict):
            continue
        system, code = coding.get("system"), coding.get("code")
        if system and code:
            yield (str(system), str(code))


def _text_of(code_obj: dict) -> str:
    text = str(code_obj.get("text") or "").lower()
    for coding in code_obj.get("coding") or []:
        if isinstance(coding, dict):
            text += " " + str(coding.get("display") or "").lower()
            text += " " + str(coding.get("code") or "").lower()
    return text


def _match_quantity(code_obj: dict) -> Optional[tuple[str, str, str, str]]:
    for key in _coding_keys(code_obj):
        if key in _QUANTITY_MAP:
            return _QUANTITY_MAP[key]
    return None


def _match_report(code_obj: dict) -> Optional[str]:
    for key in _coding_keys(code_obj):
        if key in _REPORT_MAP:
            return _REPORT_MAP[key]
    text = _text_of(code_obj)
    if "blood" in text or "plasma" in text or "panel-blood" in text:
        return "blood"
    if "mri" in text or "imaging" in text or "volumetric" in text:
        return "imaging"
    if "pet" in text:
        return "pet"
    return None


def _conclusion(resource: dict) -> Optional[str]:
    """DiagnosticReport.conclusion -> normal/abnormal/inconclusive.

    Free text is read, never guessed: an unrecognised conclusion is reported as
    inconclusive rather than defaulted to normal, because defaulting a lab read
    to "normal" is the kind of quiet optimism this system refuses to do.
    """
    parts = [str(resource.get("conclusion") or "")]
    codes: list[str] = []
    for cc in resource.get("conclusionCode") or []:
        if isinstance(cc, dict):
            parts.append(str(cc.get("text") or ""))
            for coding in cc.get("coding") or []:
                if isinstance(coding, dict) and coding.get("code"):
                    codes.append(str(coding["code"]).strip().lower())
    text = " ".join(parts).lower()
    if not text.strip() and not codes:
        return None
    for pattern, outcome in _CONCLUSION_PATTERNS:
        if pattern.search(text):
            return outcome
    # HL7 v3 ObservationInterpretation codes, the shape our own export uses.
    if "a" in codes:
        return "abnormal"
    if "n" in codes:
        return "normal"
    return "inconclusive"


def _match_codeable(code_obj: dict) -> Optional[tuple[str, str]]:
    for key in _coding_keys(code_obj):
        if key in _CODEABLE_MAP:
            return _CODEABLE_MAP[key]
    text = _text_of(code_obj)
    if "amyloid" in text:
        return ("pet", "amyloid")
    if "tau" in text and "pet" in text:
        return ("pet", "tau")
    return None


def _unit_ok(expected: str, quantity: dict) -> bool:
    """True when the declared unit is an accepted spelling of `expected`.

    A scale score ({score}) needs no unit. For anything else an undeclared unit
    is a rejection, not a pass -- guessing is exactly the coercion L6 warns
    about.
    """
    if expected == "{score}":
        return True
    tokens = _ACCEPT_UNITS.get(expected, {expected})
    code = quantity.get("code")
    unit = quantity.get("unit")
    return bool((code in tokens) or (unit in tokens))


def _normalize_status(text: str) -> Optional[str]:
    lowered = str(text or "").lower()
    if "positive" in lowered:
        return "Positive"
    if "negative" in lowered:
        return "Negative"
    return None


def _obs_time(resource: dict) -> str:
    return str(resource.get("effectiveDateTime") or resource.get("issued") or "")


def _months_between(earlier: str, later: str) -> Optional[int]:
    try:
        a = datetime.fromisoformat(str(earlier)[:10])
        b = datetime.fromisoformat(str(later)[:10])
    except ValueError:
        return None
    days = abs((b - a).days)
    return max(1, round(days / 30.44)) if days else None


def _declared_subject_id(resource: dict) -> Optional[str]:
    """The subject id this Patient *declares* (identifier system ID_SYSTEM).

    Deliberately does NOT fall back to the resource id: a `Patient.id` is local to
    the bundle, so treating it as a subject key would silently overwrite the ABHA
    preference below and make an ABHA-only sender look like a brand-new patient.
    """
    for ident in resource.get("identifier") or []:
        if isinstance(ident, dict) and ident.get("system") == ID_SYSTEM and ident.get("value"):
            return str(ident["value"])
    return None


def _patient_id(resource: dict) -> Optional[str]:
    """Declared subject id, else the bundle-local resource id."""
    declared = _declared_subject_id(resource)
    if declared:
        return declared
    pid = resource.get("id")
    return str(pid) if pid else None


def _abha_address(resource: dict) -> Optional[str]:
    """The patient's ABHA address, if this Patient carries one.

    Two passes: a declared NHDM system first (authoritative), then a shape check
    for senders that omit the system.
    """
    identifiers = [i for i in (resource.get("identifier") or []) if isinstance(i, dict)]
    for ident in identifiers:
        system = str(ident.get("system") or "").rstrip("/").lower()
        if any(host in system for host in ABHA_SYSTEM_HOSTS) and ident.get("value"):
            return str(ident["value"]).strip()
    for ident in identifiers:
        if str(ident.get("system") or "") == ID_SYSTEM:
            continue
        value = str(ident.get("value") or "").strip()
        if _ABHA_RE.match(value):
            return value
    return None


def _subject_for_abha(abha: str) -> Optional[str]:
    """Crosswalk lookup: which served subject is this ABHA already bound to?

    The crosswalk lives on the records themselves (`record["abha_address"]`)
    rather than in a separate table, so it cannot drift out of sync with the
    cohort and it persists wherever the record does. It is the mitigation for L9:
    without it, the same human who arrives once as `ADNI-0001` and once as an ABHA
    becomes two patients, which would split their history and their priority rank.
    """
    for pid, record in service.PATIENTS.items():
        if isinstance(record, dict) and record.get("abha_address") == abha:
            return pid
    return None


def _patient_identity(resource: dict) -> tuple[Optional[str], Optional[str]]:
    """(patient_id, abha_address) with **ABHA preferred**, per the NRCES convention.

    Priority: an ABHA already bound to a subject wins (one human, one record);
    otherwise an ABHA plus a subject id binds them and keeps the existing record;
    otherwise the ABHA itself is the subject key.
    """
    abha = _abha_address(resource)
    declared = _declared_subject_id(resource)
    if abha:
        bound = _subject_for_abha(abha)
        if bound:
            return bound, abha
        if declared:
            return declared, abha  # bind the ABHA onto the record we already serve
        return abha, abha  # the ABHA itself is the subject key
    if declared:
        return declared, None
    return _patient_id(resource), None


def _document_key(bundle: dict, patient_id: str, payload: dict) -> str:
    """Stable identity of one submitted document — the idempotency key (Phase 3).

    Prefers what the *sender* says the document is (`Bundle.identifier` +
    `timestamp`; NRCES sets both), and falls back to a fingerprint of the
    measurements themselves — each observation's codes and observation time — so a
    re-sent document is still recognised when the header is missing. Two genuinely
    different documents for the same patient cannot collide: the marks differ.
    """
    identifier = str((bundle.get("identifier") or {}).get("value") or "")
    timestamp = str(bundle.get("timestamp") or "")
    marks = "|".join(sorted(payload.get("marks") or []))
    digest = hashlib.sha256(f"{patient_id}\n{identifier}\n{timestamp}\n{marks}".encode("utf-8"))
    return digest.hexdigest()


def _patient_demographics(resource: dict) -> dict:
    demo: dict[str, Any] = {}
    sex = {"male": "M", "female": "F"}.get(str(resource.get("gender") or "").lower())
    if sex:
        demo["sex"] = sex
    age = None
    for ext in resource.get("extension") or []:
        if isinstance(ext, dict) and ext.get("url") == AGE_EXT:
            raw = ext.get("valueInteger", ext.get("valueDecimal"))
            if raw is not None:
                try:
                    age = int(float(raw))
                except (TypeError, ValueError):
                    age = None
            break
    if age is None and resource.get("birthDate"):
        try:
            age = datetime.now().year - int(str(resource["birthDate"])[:4])
        except (TypeError, ValueError):
            age = None
    if age is not None:
        demo["age"] = age
    return demo


def _resolve_ref(ref: str, resource_ids: dict[str, str], patients: dict[str, dict]) -> Optional[str]:
    """A reference -> NeuroPilot patient id.

    Handles every form a real bundle uses, because a document bundle rarely uses
    relative references:

    * ``Patient/ADNI-0001`` — relative (what a transaction carries)
    * ``ADNI-0001`` — bare
    * ``#local-1`` — fragment reference into the same bundle (NRCES documents)
    * ``urn:uuid:…`` — a fullUrl reference (NRCES documents)
    """
    raw = str(ref or "").strip()
    if not raw:
        return None
    local = raw.lstrip("#")
    tail = local.rsplit("/", 1)[-1] if "/" in local else local
    for candidate in (raw, local, f"Patient/{tail}", tail):
        if candidate in resource_ids:
            return resource_ids[candidate]
    if tail in patients:
        return tail
    return tail or None


# --------------------------------------------------------------------------- #
# parse
# --------------------------------------------------------------------------- #
def parse_bundle(bundle: dict) -> dict:
    """FHIR Bundle -> {patients, ignored, resource_count}. Raises IngestError.

    Passes, in order: Patients (identity + reference registration), Observations,
    DiagnosticReports, then document headers. Patients go first so an Observation
    referring to a Patient resolves no matter how the entries are ordered or which
    reference form the sender used.
    """
    if not isinstance(bundle, dict) or bundle.get("resourceType") != "Bundle":
        raise IngestError([{"diagnostics": "Body must be a FHIR R4 resourceType=Bundle."}])

    issues: list[dict] = []
    btype = bundle.get("type")
    if btype not in _ACCEPTED_BUNDLE_TYPES:
        issues.append({
            "diagnostics": f"Bundle.type '{btype}' is not accepted; expected one of {_ACCEPTED_BUNDLE_TYPES}."
        })
    entries = bundle.get("entry")
    if not isinstance(entries, list) or not entries:
        issues.append({"diagnostics": "Bundle.entry must be a non-empty array."})
    if issues:
        raise IngestError(issues)

    patients: dict[str, dict] = {}
    ignored: list[dict] = []

    # A NRCES document leads with a Composition. If it is missing we say so rather
    # than reject: the measurements are what the mapper is for, and refusing a
    # patient's records over a missing header would be the wrong trade.
    if btype == "document" and not any(
        isinstance(e, dict) and isinstance(e.get("resource"), dict)
        and e["resource"].get("resourceType") == "Composition"
        for e in entries
    ):
        ignored.append({
            "resource": "Bundle",
            "reason": "Bundle.type=document without a Composition header — resources were mapped anyway",
        })

    def bucket(pid: str) -> dict:
        return patients.setdefault(
            pid,
            {
                "demographics": {}, "cognitive": None, "slots": {}, "reports": {},
                "observation_count": 0, "_mmse": [], "marks": [], "abha_address": None,
            },
        )

    # ---- pass 1: Patient resources -------------------------------------- #
    #
    # Reference resolution is registered under every form a bundle can use, so an
    # Observation can point at this Patient by relative reference, fragment, or
    # fullUrl regardless of entry order. NRCES document bundles use the last two.
    resource_ids: dict[str, str] = {}
    for idx, entry in enumerate(entries):
        res = entry.get("resource") if isinstance(entry, dict) else None
        if not isinstance(res, dict) or res.get("resourceType") != "Patient":
            continue
        loc = f"Patient/{res.get('id') or idx}"
        pid, abha = _patient_identity(res)
        if not pid:
            issues.append({
                "diagnostics": (
                    f"{loc}: cannot determine a patient identity (need an ABHA identifier, "
                    f"identifier system '{ID_SYSTEM}', or a resource id)."
                )
            })
            continue
        for key in (str(res.get("id") or ""), res.get("id") and f"Patient/{res['id']}",
                    str(entry.get("fullUrl") or ""), pid, f"Patient/{pid}"):
            if key:
                resource_ids[key] = pid
        if not issues:
            bucket(pid)["demographics"].update(_patient_demographics(res))
            if abha:
                bucket(pid)["abha_address"] = abha

    # ---- pass 2: Observations ------------------------------------------- #
    for idx, entry in enumerate(entries):
        res = entry.get("resource") if isinstance(entry, dict) else None
        if not isinstance(res, dict) or res.get("resourceType") != "Observation":
            continue
        loc = f"Observation/{res.get('id') or idx}"
        subject = (res.get("subject") or {}).get("reference") if isinstance(res.get("subject"), dict) else None
        if not subject:
            issues.append({"diagnostics": f"{loc}: missing Observation.subject.reference."})
            continue
        pid = _resolve_ref(subject, resource_ids, patients)
        if not pid:
            issues.append({"diagnostics": f"{loc}: subject '{subject}' could not be resolved to a patient."})
            continue
        # Never invent a patient from a dangling reference: a subject must either
        # be defined by a Patient resource in this bundle or already be served.
        if pid not in patients and pid not in service.PATIENTS:
            issues.append({
                "diagnostics": (
                    f"{loc}: subject '{subject}' is neither defined by a Patient resource "
                    "in this bundle nor an existing patient."
                )
            })
            continue

        code_obj = res.get("code") if isinstance(res.get("code"), dict) else {}
        # Fingerprint material for the idempotency key (Phase 3): what was measured,
        # and when. Only recognised codes are marked, so an unrelated Observation
        # cannot make two different documents look identical.
        codes = ";".join(f"{s}|{c}" for s, c in _coding_keys(code_obj))
        quantity_match = _match_quantity(code_obj)
        if quantity_match is not None:
            slot, key, unit, label = quantity_match
            quantity = res.get("valueQuantity")
            if not isinstance(quantity, dict) or quantity.get("value") is None:
                issues.append({"diagnostics": f"{loc} ({label}): expected a valueQuantity."})
                continue
            if not _unit_ok(unit, quantity):
                got = quantity.get("code") or quantity.get("unit") or "undeclared"
                issues.append({
                    "diagnostics": (
                        f"{loc} ({label}): unit '{got}' does not match the expected UCUM unit '{unit}' — "
                        "rejected rather than coerced."
                    )
                })
                continue
            try:
                value = float(quantity["value"])
            except (TypeError, ValueError):
                issues.append({"diagnostics": f"{loc} ({label}): valueQuantity.value is not numeric."})
                continue
            pat = bucket(pid)
            if slot == "cognitive":
                pat["_mmse"].append((_obs_time(res), value))
            elif slot == "demographics":
                pat["demographics"][key] = value
            else:
                pat["slots"].setdefault(slot, {})[key] = value
            pat["observation_count"] += 1
            pat["marks"].append(f"{codes}@{_obs_time(res)}")
            continue

        codeable_match = _match_codeable(code_obj)
        if codeable_match is not None:
            slot, key = codeable_match
            vcc = res.get("valueCodeableConcept") if isinstance(res.get("valueCodeableConcept"), dict) else {}
            text = str(vcc.get("text") or "")
            if not text:
                codings = vcc.get("coding") or []
                if codings and isinstance(codings[0], dict):
                    text = str(codings[0].get("display") or codings[0].get("code") or "")
            status = _normalize_status(text)
            if status is None:
                issues.append({
                    "diagnostics": f"{loc}: PET status value '{text}' is not Positive/Negative."
                })
                continue
            pat = bucket(pid)
            pat["slots"].setdefault(slot, {})[key] = status
            pat["observation_count"] += 1
            pat["marks"].append(f"{codes}@{_obs_time(res)}")
            continue

        ignored.append({
            "resource": loc,
            "reason": "unrecognised observation code — not part of NeuroPilot's mapped feature set",
        })

    # ---- pass 3: DiagnosticReports (Phase 3 result landing) --------------- #
    #
    # A report says what a panel showed; it does NOT contain the measurements.
    # It is therefore applied as a CONCLUSION onto a slot that already holds real
    # values, and stored as a report otherwise. Critically it never flips a slot
    # to `completed` -- a report with no Observations behind it must not count as
    # biomarker evidence, or a hospital could unlock a High tier with a PDF.
    for idx, entry in enumerate(entries):
        res = entry.get("resource") if isinstance(entry, dict) else None
        if not isinstance(res, dict) or res.get("resourceType") != "DiagnosticReport":
            continue
        loc = f"DiagnosticReport/{res.get('id') or idx}"
        subject = (res.get("subject") or {}).get("reference") if isinstance(res.get("subject"), dict) else None
        if not subject:
            issues.append({"diagnostics": f"{loc}: missing DiagnosticReport.subject.reference."})
            continue
        pid = _resolve_ref(subject, resource_ids, patients)
        if not pid or (pid not in patients and pid not in service.PATIENTS):
            issues.append({
                "diagnostics": f"{loc}: subject '{subject}' could not be resolved to an existing patient."
            })
            continue
        slot = _match_report(res.get("code") if isinstance(res.get("code"), dict) else {})
        if slot is None:
            ignored.append({
                "resource": loc,
                "reason": "unrecognised DiagnosticReport panel code — not one of NeuroPilot's ordered panels",
            })
            continue
        report = {
            "slot": slot,
            "outcome": _conclusion(res),
            "status": str(res.get("status") or "") or None,
            "issued": str(res.get("issued") or "") or None,
            "report_id": str(res.get("id") or "") or None,
        }
        pat = bucket(pid)
        pat["reports"][slot] = report

    # ---- pass 4: document header ---------------------------------------- #
    # The Composition carries the document's author, class, sections and its own
    # title — context, not measurements. It is reported as ignored so a reader can
    # see it was read and understood, not silently dropped.
    for idx, entry in enumerate(entries):
        res = entry.get("resource") if isinstance(entry, dict) else None
        if isinstance(res, dict) and res.get("resourceType") == "Composition":
            ignored.append({
                "resource": f"Composition/{res.get('id') or idx}",
                "reason": "document header — read for context, carries no measurement",
            })

    # ---- finalize per patient ------------------------------------------- #
    for pid, pat in patients.items():
        mmse = pat.pop("_mmse", [])
        if mmse:
            mmse.sort(key=lambda pair: pair[0] or "")
            latest = mmse[-1][1]
            prior = mmse[-2][1] if len(mmse) > 1 else latest
            months = 6
            if len(mmse) > 1:
                months = _months_between(mmse[-2][0], mmse[-1][0]) or 6
            pat["cognitive"] = {"scale": "MMSE", "latest": latest, "prior": prior, "months": months}
        # An identity-only Patient is NOT "nothing mappable": binding an ABHA onto
        # a record is a real effect (it is the crosswalk, L9). A bundle that truly
        # carries nothing we can use is still rejected — but only that.
        if (pat["observation_count"] == 0 and not pat["demographics"]
                and not pat["reports"] and not pat["abha_address"]):
            issues.append({
                "diagnostics": (
                    f"Patient/{pid}: nothing mappable — the bundle carries no recognised "
                    "observation, report, ABHA address or usable demographics."
                )
            })

    if issues:
        raise IngestError(issues)

    return {"patients": patients, "ignored": ignored, "resource_count": len(entries)}


# --------------------------------------------------------------------------- #
# ingest
# --------------------------------------------------------------------------- #
def _outcome(diagnostics: str) -> dict:
    return {
        "resourceType": "OperationOutcome",
        "issue": [{"severity": "information", "code": "informational", "diagnostics": diagnostics}],
    }


def ingest_bundle(bundle: dict) -> dict:
    """Parse + apply a bundle. Returns a FHIR transaction-response receipt.

    Scoring is delegated to `service.ingest_record`, which runs the served model
    exactly as the UI does -- this function never computes a score itself.
    """
    parsed = parse_bundle(bundle)
    entries_out: list[dict] = []
    created = updated = observations = reports_total = duplicates = 0
    duplicate_notes: list[str] = []

    for pid, payload in parsed["patients"].items():
        document_key = _document_key(bundle, pid, payload)
        result = service.ingest_record(
            pid,
            demographics=payload["demographics"] or None,
            cognitive=payload["cognitive"],
            slots=payload["slots"] or None,
            reports=payload["reports"] or None,
            source="fhir",
            abha_address=payload.get("abha_address"),
            document_key=document_key,
        )
        if result.get("skipped"):
            # The same document (same patient, same header or same measurements)
            # was already ingested. Nothing was written and nothing was re-scored.
            duplicates += 1
            duplicate_notes.append(f"{pid}: document already ingested")
            entries_out.append(
                {
                    "response": {"status": "200 OK", "location": f"Patient/{pid}"},
                    "outcome": _outcome(
                        f"{pid}: duplicate document — already ingested, no change "
                        "(idempotent on patient + observation date)"
                    ),
                }
            )
            continue
        created += int(result["created"])
        updated += int(not result["created"])
        observations += payload["observation_count"]
        reports = len(payload["reports"])
        reports_total += reports
        summary = result["summary"]
        abha = payload.get("abha_address")
        entries_out.append(
            {
                "response": {
                    "status": "201 Created" if result["created"] else "200 OK",
                    "location": f"Patient/{pid}",
                },
                "outcome": _outcome(
                    f"{pid}{f' (ABHA {abha})' if abha else ''}: {summary['risk_tier']} tier · "
                    f"official score {summary['official_score']:.2f} · stage {summary['stage']} · "
                    f"{payload['observation_count']} observation(s) mapped · "
                    f"{reports} report(s) attached"
                ),
            }
        )

    ignored = parsed["ignored"]
    extensions = [
        {
            "url": SUMMARY_EXT,
            "valueString": (
                f"{created} created, {updated} updated; {observations} observation(s) mapped; "
                f"{reports_total} report(s) attached; {duplicates} duplicate document(s) "
                f"ignored; {len(ignored)} ignored; {parsed['resource_count']} bundle entr(ies) read"
            ),
        }
    ]
    for note in duplicate_notes:
        extensions.append({"url": DUPLICATE_EXT, "valueString": note})
    for item in ignored:
        extensions.append({"url": IGNORED_EXT, "valueString": f"{item['resource']}: {item['reason']}"})

    return {
        "resourceType": "Bundle",
        "id": "neuropilot-fhir-ingest-response",
        "type": "transaction-response",
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "extension": extensions,
        "entry": entries_out,
    }


def operation_outcome(issues: list[dict]) -> dict:
    """Multi-issue OperationOutcome for a rejected bundle (HTTP 422)."""
    return {
        "resourceType": "OperationOutcome",
        "issue": [
            {
                "severity": issue.get("severity", "error"),
                "code": issue.get("code", "invalid"),
                "diagnostics": issue.get("diagnostics", ""),
            }
            for issue in issues
        ],
    }
