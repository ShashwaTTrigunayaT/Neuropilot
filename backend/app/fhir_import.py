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

from typing import Any, Optional

import httpx

from . import config, fhir_ingest, service, smart

# Search results are paged and capped. A chart with thousands of Observations
# (a research export re-used as a clinical record) must not turn one clinician
# click into an unbounded walk of a hospital server; `_count` is a hint, and the
# cap is on pages, so the limit holds whether or not the server honours it.
_MAX_SEARCH_PAGES = 5


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
    iss = str(ctx.get("iss") or "").rstrip("/")
    if not iss:
        raise FhirImportError(
            "The SMART session has no `iss`, so there is no server to read the chart "
            "from. Relaunch from the EHR.",
            status_code=401,
        )
    return iss, token, _bare_patient_id(str(patient))


def _headers(token: str) -> dict[str, str]:
    return {"Accept": fhir_ingest.FHIR_JSON, "Authorization": f"Bearer {token}"}


# --------------------------------------------------------------------------- #
# read-side: three real HTTP reads against the hospital
# --------------------------------------------------------------------------- #
def _get(http: httpx.Client, url: str, token: str) -> dict:
    """GET one FHIR URL, translating its failures into something actionable."""
    try:
        resp = http.get(url, headers=_headers(token))
    except httpx.HTTPError as exc:
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
                "`next` link still offered — the import is capped, and the receipt says "
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
    base = iss.rstrip("/")
    with _client(client) as http:
        patient = _get(http, f"{base}/Patient/{patient_id}", token)
        observations = _search(http, f"{base}/Observation",
                               {"patient": patient_id, "_count": "200"}, token)
        reports = _search(http, f"{base}/DiagnosticReport",
                          {"patient": patient_id, "_count": "100"}, token)
    return {"Patient": [patient], "Observation": observations, "DiagnosticReport": reports}


# --------------------------------------------------------------------------- #
# assemble + ingest
# --------------------------------------------------------------------------- #
def collection_bundle(fetched: dict) -> dict:
    """The fetched resources as the Bundle shape `fhir_ingest` already accepts.

    Deliberately carries NO `Bundle.identifier` and NO `Bundle.timestamp`. The
    ingester's document key falls back to a fingerprint of the measurements
    themselves when the header is absent, so importing the same chart twice is
    recognised as the same document: nothing is written, nothing is re-scored,
    and no duplicate line appears in the patient's audit history for what is
    clinically the same set of results.
    """
    resources: list[dict] = []
    for rtype in ("Patient", "Observation", "DiagnosticReport"):
        resources.extend(r for r in fetched.get(rtype) or [] if isinstance(r, dict))
    return {
        "resourceType": "Bundle",
        "type": "collection",
        "entry": [{"resource": resource} for resource in resources],
    }


def _session_subject_note(parsed_id: str, claim: str) -> Optional[str]:
    """Flag the (rare) case where the served subject id is not the session claim.

    The subject id is what the parser derives from the `Patient` resource — an
    ABHA when the chart carries one, else the EHR's resource id. The session
    claim is whatever the token response said. They agree in normal use; when
    they do not, the difference is worth naming out loud rather than hiding,
    because it is exactly how one human becomes two records (L9).
    """
    if _bare_patient_id(claim) == parsed_id:
        return None
    return (
        f"the EHR returned a Patient resource identified as '{parsed_id}' while the "
        f"session context claims '{claim}' — the record was filed under '{parsed_id}', "
        "which is the id its Observations reference"
    )


def import_from_smart_session(client: httpx.Client | None = None) -> dict:
    """Fetch the patient in context and run it through the existing ingest path.

    Raises `FhirImportError` (401/404/502) when the session or the hospital is the
    problem, and `fhir_ingest.IngestError` (-> 422) when the chart is readable but
    unmappable — the same two failure shapes the paste flow produces, so the UI
    has one rejection rendering to maintain.
    """
    iss, token, patient_id = session_target()
    fetched = fetch_patient_resources(iss, token, patient_id, client=client)
    bundle = collection_bundle(fetched)

    # Parsed once here for the identity and the fetch report, and again inside
    # ingest_bundle — which is intentional: the WRITE goes through the same public
    # entry point the paste flow uses, so there is exactly one write path and one
    # place scoring can happen. A bundle this size costs nothing to map twice.
    parsed = fhir_ingest.parse_bundle(bundle)
    receipt = fhir_ingest.ingest_bundle(bundle)

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
    flaw = _session_subject_note(subject_id, patient_id)
    if flaw:
        result["identity_note"] = flaw
    return result
