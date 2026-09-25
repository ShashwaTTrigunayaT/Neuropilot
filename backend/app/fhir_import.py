"""Import the patient in the active SMART session, straight from the EHR.

Phase 4 gave NeuroPilot a bound session: an `iss` (the hospital's FHIR base
URL), a patient in context, and a scoped access token held server-side. Until
now the only way to get a patient *in* was a manually pasted Bundle, so the
clinician had to leave the chart they were already looking at and go find the
JSON. This module closes that loop: it reads the patient in context over the
session's own credentials, assembles what it read into the same Bundle shape the
paste flow sends, and hands that to the **existing** ingester.

What it deliberately does NOT do:

* **It does not parse or score anything itself.** `fhir_ingest.parse_bundle` maps
  the resources and `fhir_ingest.ingest_bundle` writes them through
  `service.ingest_record`, which is the same scoring path as a result typed into
  the UI. A second mapper here would be a second set of mapping rules, and the
  two would drift.
* **It does not invent identity.** The subject id is whatever the same parser
  derives from the EHR's `Patient` resource (an ABHA if the chart carries one,
  otherwise the EHR's own resource id — which is the id the `Observation`s
  reference). Nothing is fabricated from the session claim; see
  `_session_subject_note`.
* **It does not fetch `Condition`.** The inbound mapper has no path that can
  create a Condition (limitation L4 — model output must never become a
  diagnosis), so pulling diagnoses in would add noise to the `ignored` list and
  nothing else. Only the three resource types this model actually reads are
  requested: `Patient`, `Observation`, `DiagnosticReport`.

The one thing it adds beyond the paste flow is the *fetch*: three real HTTP reads
against the hospital, paginated, with the session token as the bearer.
"""
from __future__ import annotations

import re
import threading
from typing import Optional

import httpx

from . import config, fhir_ingest, service, smart
from .net import TRANSPORT_FAILURES, clean_base

# Search results are paged and capped. A chart with thousands of Observations
# (a research export re-used as a clinical record) must not turn one clinician
# click into an unbounded walk of a hospital server; `_count` is a hint, and the
# cap is on pages, so the limit holds whether or not the server honours it.
_MAX_SEARCH_PAGES = 5

# How an imported chart is named in NeuroPilot: FHIR-0001, FHIR-0002, …
#
# An EHR's `Patient.id` is local to that server — an Epic GUID or a sandbox's
# `smart-43` — which is a poor subject key to read on a worklist and a worse one
# to hand a clinician. So an imported chart is FILED under a NeuroPilot number,
# and the EHR's own id is kept on the record as provenance and shown in the UI
# (see `external_ids` below): renamed for readability, never disguised.
#
# A chart that arrives carrying its own cross-system identity — an ABHA address,
# or a `urn:neuropilot:subject-id` we (or another NeuroPilot node) assigned —
# keeps it. NeuroPilot does not rename an identity the source asserts, and the
# ABHA is the crosswalk that keeps one human one patient (L9).
_SUBJECT_PREFIX = "FHIR"
_SUBJECT_RE = re.compile(rf"^{_SUBJECT_PREFIX}-(\d+)$")
# Two imports landing at once must not both take FHIR-0007 and have the second
# overwrite the first as the same patient.
_ID_LOCK = threading.Lock()


class FhirImportError(Exception):
    """A failed import. `status_code` maps to the HTTP response."""


    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def operation_outcome(message: str, code: str = "invalid") -> dict:
    """Single-issue OperationOutcome — the FHIR surface's error shape."""
    return {
        "resourceType": "OperationOutcome",
        "issue": [{"severity": "error", "code": code, "diagnostics": message}],
    }


def _client(client: httpx.Client | None) -> httpx.Client:
    return client or httpx.Client(timeout=config.FHIR_TIMEOUT_SECONDS)


def _bare_patient_id(value: str) -> str:
    """`Patient/abc` and `abc` name the same patient; we address the id itself."""
    return value.rsplit("/", 1)[-1] if "/" in value else value


# --------------------------------------------------------------------------- #
# identity: a filing number for the chart, the EHR's own id as provenance
# --------------------------------------------------------------------------- #
def _next_subject_id() -> str:
    """The next free filing number, DERIVED from the served cohort.

    Derived rather than kept in a counter, for the same reason the ABHA crosswalk
    lives on the records: a counter is a second source of truth, and a restart, a
    re-seed or a database round-trip that resets it hands two different humans
    the same `FHIR-0001`. The cohort is its own register, and it persists wherever
    the records do (Postgres on Railway).
    """
    highest = 0
    for pid in service.PATIENTS:
        match = _SUBJECT_RE.match(str(pid))
        if match:
            highest = max(highest, int(match.group(1)))
    return f"{_SUBJECT_PREFIX}-{highest + 1:04d}"


def _subject_for_ehr(iss: str, patient_id: str) -> Optional[str]:
    """Which served subject is this chart already filed under?

    Re-importing a chart must find the SAME number. Without this lookup the
    second import mints a new filing number, and one human becomes two records
    with split history and split priority rank — the failure L9 describes, in a
    new place.

    The second pass adopts a record that was filed before this module recorded
    provenance at all (a chart imported while the subject id WAS the raw EHR id).
    It is not renamed — the key is already referenced by history, orders and URLs —
    but the ingest that follows stamps `external_ids` onto it, so from then on the
    record is findable by provenance like any other and no duplicate is created.
    """
    base = clean_base(iss)
    legacy: Optional[str] = None
    for pid, record in service.PATIENTS.items():
        if not isinstance(record, dict):
            continue
        ids = record.get("external_ids") or {}
        if ids.get("ehr_patient_id") == patient_id and clean_base(str(ids.get("ehr_iss") or "")) == base:
            return pid
        if legacy is None and not ids and str(pid) == patient_id:
            legacy = str(pid)
    return legacy


def _filing_identity(iss: str, patient_id: str,
                     patient_resource: dict) -> tuple[Optional[str], Optional[str]]:
    """(subject id to declare on the chart, a note when we declined to rename).

    Precedence, mirroring `fhir_ingest._patient_identity`: an identity the chart
    itself asserts (ABHA, or our own subject-id system) wins and is used as-is;
    otherwise the chart is filed under the next free number and the EHR id is
    recorded as provenance.
    """
    existing = _subject_for_ehr(iss, patient_id)
    if existing:
        return existing, None  # the same chart, the same number
    declared = fhir_ingest._declared_subject_id(patient_resource)
    abha = fhir_ingest._abha_address(patient_resource)
    if declared or abha:
        return None, (
            f"the chart declares its own cross-system identity ({declared or abha}), so it "
            "keeps it — an asserted identity is not renamed, and the ABHA is what keeps "
            "one human one record"
        )
    with _ID_LOCK:
        return _next_subject_id(), None


# --------------------------------------------------------------------------- #
# the session
# --------------------------------------------------------------------------- #
def session_target() -> tuple[str, str, str]:
    """(iss, access_token, patient_id) for the connected session.

    Every way this can be missing produces its own 401 with the fix in it, rather
    than a generic \"unauthorized\": an operator reading the log must be able to
    tell \"nobody launched\" from \"the token expired\" from \"this launch had no
    patient scope\". Those three look identical from status_code alone.
    """
    ctx = smart.context()
    if not ctx.get("connected"):
        raise FhirImportError(
            "No SMART session is active, so there is no chart to import from. Launch "
            "NeuroPilot from the EHR — or GET /fhir/smart/launch?iss=<FHIR base URL>"
            "&format=json to bind a session — then try again.",
            status_code=401,
        )
    token = smart.access_token()
    if not token:
        raise FhirImportError(
            "The SMART access token has expired, so the EHR would reject the read. "
            "Renew it (POST /fhir/smart/refresh) or relaunch from the chart.",
            status_code=401,
        )
    patient = ctx.get("patient")
    if not patient:
        raise FhirImportError(
            "This SMART session carries no patient context, so there is no chart to "
            "import. A `launch/patient` scope (or `patient` on a standalone launch) is "
            "what binds one — relaunch with it.",
            status_code=401,
        )
    iss = clean_base(str(ctx.get("iss") or ""))
    if not iss:
        raise FhirImportError(
            "The SMART session has no `iss`, so there is no server to read the chart "
            "from. Relaunch from the EHR.",
            status_code=401,
        )
    return iss, token, _bare_patient_id(str(patient))


def _headers(token: str) -> dict[str, str]:
    """Bearer auth, or none at all.

    Sending `Authorization: Bearer ` with an empty value is not "no credential" —
    servers answer 401 to it, which would make an OPEN server look locked simply
    because no session is bound yet.
    """
    headers = {"Accept": fhir_ingest.FHIR_JSON}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


# --------------------------------------------------------------------------- #
# read-side: three real HTTP reads against the hospital
# --------------------------------------------------------------------------- #
def _get(http: httpx.Client, url: str, token: str) -> dict:
    """GET one FHIR URL, translating its failures into something actionable."""
    try:
        resp = http.get(url, headers=_headers(token))
    # `InvalidURL` (a malformed `iss`, e.g. one pasted with a newline) is not an
    # `HTTPError`; catching only that turned a bad base URL into a 500.
    except TRANSPORT_FAILURES as exc:
        raise FhirImportError(f"GET {url} failed: {exc}") from exc

    if resp.status_code in (401, 403):
        # The most likely real cause is scope, not a bad token: the default scope
        # set is minimum-necessary, and an EHR is free to narrow it further.
        raise FhirImportError(
            f"The EHR refused to read {url} (HTTP {resp.status_code}). Either the "
            "session's scopes do not cover that resource or the token is no longer "
            "valid for it — a relaunch from the chart is the fix for both.",
            status_code=401,
        )
    if resp.status_code == 404:
        raise FhirImportError(
            f"{url} returned HTTP 404 — the EHR has no such record for this patient.",
            status_code=404,
        )
    if resp.status_code >= 400:
        raise FhirImportError(
            f"{url} returned HTTP {resp.status_code}: {resp.text[:300]}", status_code=502
        )
    try:
        return resp.json()
    except ValueError as exc:
        raise FhirImportError(f"{url} did not return JSON (not a FHIR endpoint?)") from exc


def _search(http: httpx.Client, base: str, params: dict, token: str) -> list[dict]:
    """Every resource a FHIR searchset holds, following `next` links (bounded).

    A single request is not a complete answer on a real server — a chart with
    more Observations than one page silently loses the rest, and the score would
    then be computed from a fragment of the record. Paging is therefore part of
    correctness here, not an optimisation.
    """
    url = f"{base}?{httpx.QueryParams(params)}"
    resources: list[dict] = []
    for page in range(_MAX_SEARCH_PAGES):
        body = _get(http, url, token)
        for entry in body.get("entry") or []:
            resource = entry.get("resource") if isinstance(entry, dict) else None
            if isinstance(resource, dict):
                resources.append(resource)
        next_url = None
        for link in body.get("link") or []:
            if isinstance(link, dict) and link.get("relation") == "next" and link.get("url"):
                next_url = str(link["url"])
                break
        if not next_url:
            return resources
        if page == _MAX_SEARCH_PAGES - 1:
            print(
                f"[fhir_import] {base}: stopped after {_MAX_SEARCH_PAGES} pages with a "
                "`next` link still offered — this read is capped, and the caller reports "
                "how much was read"
            )
            break
        url = next_url
    return resources


def fetch_patient_resources(iss: str, token: str, patient_id: str,
                            client: httpx.Client | None = None) -> dict:
    """Read the patient's chart: the Patient, its Observations and reports.

    Ordered deliberately: the `Patient` resource is read FIRST, because without it
    the Observations have no subject to resolve against and the ingester refuses
    references it cannot place (correctly — a dangling reference must never
    conjure a patient).
    """
    base = clean_base(iss)
    with _client(client) as http:
        patient = _get(http, f"{base}/Patient/{patient_id}", token)
        observations = _search(http, f"{base}/Observation",
                               {"patient": patient_id, "_count": "200"}, token)
        reports = _search(http, f"{base}/DiagnosticReport",
                          {"patient": patient_id, "_count": "100"}, token)
    return {"Patient": [patient], "Observation": observations, "DiagnosticReport": reports}


# --------------------------------------------------------------------------- #
# browse: which charts does the EHR itself hold?
#
# A standalone launch must name a patient that EXISTS ON THAT SERVER. The served
# cohort is no use for this: `ADNI-0016` is NeuroPilot's own key and means nothing
# to an EHR, so naming it at the authorize endpoint either fails or binds nothing.
# The only truthful list is the server's own `Patient` search.
# --------------------------------------------------------------------------- #
_MAX_CHART_RESULTS = 25


def _human_name(resource: dict) -> Optional[str]:
    """FHIR HumanName -> one line. `text` when the server supplies it."""
    for name in resource.get("name") or []:
        if not isinstance(name, dict):
            continue
        if name.get("text"):
            return str(name["text"])
        parts = [*(name.get("given") or []), name.get("family")]
        joined = " ".join(str(p) for p in parts if p)
        if joined:
            return joined
    return None


def _server_for_browse(iss: Optional[str]) -> tuple[str, str, str]:
    """(iss, token, provenance) for listing a server's charts.

    The token is attached ONLY when the bound session belongs to the same server.
    A token minted for server A must never be replayed at server B — that leaks a
    live credential to a third party and is not something a browse convenience is
    allowed to do.
    """
    ctx = smart.context()
    session_iss = clean_base(str(ctx.get("iss") or "")) if ctx.get("connected") else ""
    target = clean_base(iss or session_iss or config.FHIR_BASE_URL or "")
    if not target:
        raise FhirImportError(
            "No FHIR server to browse. Pass ?iss=<FHIR base URL>, set FHIR_BASE_URL, "
            "or bind a SMART session first.",
            status_code=422,
        )
    if session_iss and session_iss == target:
        token = smart.access_token() or ""
        if token:
            return target, token, "smart-session"
        return target, "", "no-token (the session token expired; an open server still reads)"
    if session_iss:
        return target, "", "unauthenticated (the bound session belongs to a different server)"
    return target, "", "unauthenticated (no session bound — only an open server will answer)"


def list_charts(iss: Optional[str] = None, name: Optional[str] = None,
                client: httpx.Client | None = None) -> dict:
    """The patients the EHR holds, so a standalone launch can name a real one.

    Read with the session token when it is the session's own server, and without
    a token otherwise. A secured server answers 401 in that case, which is the
    honest outcome — the fix is written into the message rather than faked.
    """
    base, token, provenance = _server_for_browse(iss)
    params = {"_count": str(_MAX_CHART_RESULTS), "_elements": "id,name,gender,birthDate"}
    if name and name.strip():
        params["name"] = name.strip()
    with _client(client) as http:
        resources = _search(http, f"{base}/Patient", params, token)

    charts: list[dict] = []
    for resource in resources:
        chart_id = resource.get("id")
        if not chart_id:
            continue
        charts.append({
            "patient_id": str(chart_id),
            "name": _human_name(resource),
            "gender": resource.get("gender"),
            "birthDate": resource.get("birthDate"),
            # Already pulled into NeuroPilot? Then say which filing number it took,
            # so re-selecting it re-opens one record instead of filing a second.
            "subject_id": _subject_for_ehr(base, str(chart_id)),
        })

    # The search cap is on pages, so a full window means the server was still
    # offering more. Say so rather than presenting a truncated list as complete.
    ceiling = _MAX_CHART_RESULTS * _MAX_SEARCH_PAGES
    return {
        "iss": base,
        "authenticated": bool(token),
        "provenance": provenance,
        "count": len(charts),
        "capped": len(resources) >= ceiling,
        "charts": charts,
        "note": (
            "These are the EHR's own patients — the only ids a launch can name. A "
            "NeuroPilot subject id means nothing to an EHR."
        ),
    }


# --------------------------------------------------------------------------- #
# assemble + ingest
# --------------------------------------------------------------------------- #
def _declare_subject(resource: dict, subject_id: str) -> dict:
    """A copy of the Patient with our subject id declared on it.

    Declaring it as `urn:neuropilot:subject-id` is how the EXISTING mapper learns
    the identity — `fhir_ingest` prefers a declared subject id over the resource
    id, so the filing number needs no change to the parser at all.
    """
    declared = {k: v for k, v in resource.items() if k != "identifier"}
    identifiers = [i for i in (resource.get("identifier") or []) if isinstance(i, dict)]
    identifiers.append({"system": fhir_ingest.ID_SYSTEM, "value": subject_id})
    declared["identifier"] = identifiers
    return declared


def collection_bundle(fetched: dict, subject_id: Optional[str] = None) -> dict:
    """The fetched resources as the Bundle shape `fhir_ingest` already accepts.

    Deliberately carries NO `Bundle.identifier` and NO `Bundle.timestamp`. The
    ingester's document key falls back to a fingerprint of the measurements
    themselves when the header is absent, so importing the same chart twice is
    recognised as the same document: nothing is written, nothing is re-scored,
    and no duplicate line appears in the patient's audit history for what is
    clinically the same set of results.

    `subject_id` is the filing number to declare on the Patient (see
    `_filing_identity`); passing None leaves the chart's declared identity alone.
    """
    patients = [r for r in fetched.get("Patient") or [] if isinstance(r, dict)]
    if subject_id:
        patients = [_declare_subject(r, subject_id) for r in patients]
    resources: list[dict] = list(patients)
    for rtype in ("Observation", "DiagnosticReport"):
        resources.extend(r for r in fetched.get(rtype) or [] if isinstance(r, dict))
    return {
        "resourceType": "Bundle",
        "type": "collection",
        "entry": [{"resource": resource} for resource in resources],
    }


def import_from_smart_session(client: httpx.Client | None = None) -> dict:
    """Fetch the patient in context and run it through the existing ingest path.

    Raises `FhirImportError` (401/404/502) when the session or the hospital is the
    problem, and `fhir_ingest.IngestError` (-> 422) when the chart is readable but
    unmappable — the same two failure shapes the paste flow produces, so the UI
    has one rejection rendering to maintain.
    """
    iss, token, patient_id = session_target()
    fetched = fetch_patient_resources(iss, token, patient_id, client=client)
    filing, identity_note = _filing_identity(iss, patient_id, fetched["Patient"][0])
    bundle = collection_bundle(fetched, subject_id=filing)

    # Parsed once here for the identity and the fetch report, and again inside
    # ingest_bundle — which is intentional: the WRITE goes through the same public
    # entry point the paste flow uses, so there is exactly one write path and one
    # place scoring can happen. A bundle this size costs nothing to map twice.
    parsed = fhir_ingest.parse_bundle(bundle)
    receipt = fhir_ingest.ingest_bundle(
        bundle,
        # Provenance, not a second identity: the record stays keyed by its
        # NeuroPilot subject id and carries the EHR's own handle beside it, so the
        # UI can show which chart this came from without the id being a GUID.
        external_ids={"ehr_patient_id": patient_id, "ehr_iss": iss},
    )

    subject_id = next(iter(parsed["patients"]))
    entry = (receipt.get("entry") or [{}])[0]
    status = str((entry.get("response") or {}).get("status") or "")
    extensions = receipt.get("extension") or []
    notes = {
        "summary": next((e.get("valueString") for e in extensions
                         if e.get("url") == fhir_ingest.SUMMARY_EXT), ""),
        "ignored": [e.get("valueString") for e in extensions
                    if e.get("url") == fhir_ingest.IGNORED_EXT],
        "duplicate": [e.get("valueString") for e in extensions
                      if e.get("url") == fhir_ingest.DUPLICATE_EXT],
    }

    # The score reported is the SERVED score after the same re-score the UI runs.
    detail = service.get_patient(subject_id) or {}
    result = {
        "subject_id": subject_id,
        "ehr_patient_id": patient_id,
        "ehr_iss": iss,
        "created": status.startswith("201"),
        "duplicate": bool(notes["duplicate"]),
        "score": detail.get("official_score"),
        "risk_tier": detail.get("risk_tier"),
        "stage": detail.get("stage"),
        "stage_name": detail.get("stage_name"),
        "session": {"iss": iss, "patient": patient_id},
        "fetched": {rtype: len(fetched.get(rtype) or []) for rtype in
                    ("Patient", "Observation", "DiagnosticReport")},
        "mapped": {
            "observations": parsed["patients"][subject_id]["observation_count"],
            "reports": len(parsed["patients"][subject_id]["reports"]),
            "slots": sorted(parsed["patients"][subject_id]["slots"]),
        },
        "ignored": notes["ignored"],
        "summary": notes["summary"],
        "receipt": receipt,
    }
    if identity_note:
        result["identity_note"] = identity_note
    return result
