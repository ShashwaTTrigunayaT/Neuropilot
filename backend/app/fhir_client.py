"""Outbound FHIR client (Phases 3-4 of FHIR_INTEGRATION.md).

The export layer (`fhir.py`) converts records to resources; this module is what
actually *sends* them to a hospital FHIR server and reports on that connection.
Kept deliberately small and side-effect free:

* **Never raises into a request path that places orders.** The triage loop calls
  `maybe_push_order`, which swallows transport failures — a hospital being down
  must not stop NeuroPilot from ranking patients. The failure is recorded on the
  record's history instead, so it is visible rather than silent.
* **Auth is explicit.** If a SMART session is connected its access token is
  used; otherwise the optional static `FHIR_AUTH_TOKEN`; otherwise no header.
  A server that rejects the call returns its own status code, which we surface
  verbatim rather than translating into a guess.
* **The destination follows the session.** A live SMART session's `iss` outranks
  `FHIR_BASE_URL` (see `_base_url`), so the base URL and the bearer token belong
  to the same hospital; the static config is the fallback when no session is
  bound. `probe()` reports which of the two won.
* **Nothing is pushed anywhere until FHIR_BASE_URL is set.** Pointing this at a
  system is a deliberate act, not a default.

Limitations worth knowing (documented in FHIR_INTEGRATION.md):
transport is synchronous HTTP (no queue/retry), so a slow server delays the
caller; `AuditEvent` search is not implemented on most servers; and a real
deployment needs a durable outbox rather than a best-effort push.
"""
from __future__ import annotations

from typing import Optional

import httpx

from . import config
from .net import TRANSPORT_FAILURES, clean_base


class FHIRClientError(Exception):
    """Raised when an outbound call cannot be completed or is rejected."""

    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def session_base_url() -> Optional[str]:
    """The connected SMART server (`iss`) when the session can authorise a write.

    A clinician working inside the chart means the hospital they are IN is the
    hospital that should receive the record — not whatever `FHIR_BASE_URL` was
    configured with at deploy time. The session's token is also the only
    credential scoped to that server (limitation L12), and `_auth_headers` already
    sends it first, so pairing the two keeps the base URL and its bearer together.

    Returns None when there is no usable session, which leaves the static
    configuration in charge exactly as before.
    """
    from . import smart

    if not smart.access_token():
        return None  # no session, or an expired one
    iss = (smart.context() or {}).get("iss")
    return clean_base(str(iss)) if iss else None


def configured() -> bool:
    """True when there is anywhere to push: a live SMART session or a configured server."""
    return bool(resolved_base()[0])


def resolved_base(base_url: str | None = None) -> tuple[str, str | None]:
    """(destination, which source won) — the same precedence a write uses, no I/O.

    Split out of `probe` so diagnostics can **name** the destination without
    calling it: an operator looking at a broken integration panel needs the URL
    it was trying, not another eight-second timeout.
    """
    session = session_base_url()
    chosen = base_url or session or config.FHIR_BASE_URL
    if base_url:
        source = "argument"
    elif session:
        source = "smart-session"
    elif config.FHIR_BASE_URL:
        source = "config"
    else:
        source = None
    return clean_base(chosen), source


def _auth_headers() -> dict:
    """SMART token first (it is the scoped one), then the static token."""
    from . import smart

    token = smart.access_token() or config.FHIR_AUTH_TOKEN
    return {"Authorization": f"Bearer {token}"} if token else {}


def _client(client: httpx.Client | None) -> httpx.Client:
    return client or httpx.Client(timeout=config.FHIR_TIMEOUT_SECONDS)


def _base_url(base_url: str | None = None) -> str:
    """Where a write goes: an explicit argument, then the SMART session, then config.

    The SMART session outranks `FHIR_BASE_URL` because it is the live, scoped one:
    the token in `_auth_headers` belongs to that server, and a hospital that a
    clinician is currently working inside is the hospital the record belongs in.
    """
    base = clean_base(base_url or session_base_url() or config.FHIR_BASE_URL)
    if not base:
        raise FHIRClientError(
            "No outbound FHIR server: no SMART session is bound and FHIR_BASE_URL is "
            "not set (e.g. http://localhost:8090/fhir for a local HAPI server). "
            "Launch NeuroPilot from the EHR to push to that hospital instead.",
            status_code=409,
        )
    return base


# --------------------------------------------------------------------------- #
# read-side: is the hospital there, and what does it claim to support?
# --------------------------------------------------------------------------- #
def fetch_capability_statement(base_url: str | None = None, client: httpx.Client | None = None) -> dict:
    """GET {base}/metadata — the server's own CapabilityStatement."""
    base = _base_url(base_url)
    try:
        with _client(client) as http:
            resp = http.get(f"{base}/metadata", headers={
                "Accept": "application/fhir+json", **_auth_headers(),
            })
    # timeouts, DNS, connection refused -- and `InvalidURL`, which is NOT an
    # `HTTPError` and would otherwise escape as a 500 (see app/net.py).
    except TRANSPORT_FAILURES as exc:
        raise FHIRClientError(f"{base}/metadata unreachable: {exc}") from exc
    if resp.status_code >= 400:
        raise FHIRClientError(
            f"{base}/metadata returned HTTP {resp.status_code}", status_code=resp.status_code
        )
    try:
        return resp.json()
    except ValueError as exc:
        raise FHIRClientError(f"{base}/metadata did not return JSON") from exc


def probe(base_url: str | None = None, client: httpx.Client | None = None) -> dict:
    """Connection report for the status endpoint. Never raises.

    Reads the same precedence a write uses (see `_base_url`) and names which
    source won, so the dashboard cannot report "no hospital connected" while a
    push to the session's server would in fact succeed.
    """
    base, source = resolved_base(base_url)
    if not base:
        return {
            "configured": False,
            "base_url": None,
            "source": None,
            "reachable": False,
            "detail": "No hospital server connected.",
        }
    try:
        cap = fetch_capability_statement(base, client=client)
    except FHIRClientError as exc:
        return {"configured": True, "base_url": base, "source": source,
                "reachable": False, "detail": exc.message}
    except Exception as exc:  # noqa: BLE001 -- "Never raises" is the contract
        # This is a *report about* a connection, and its whole job is to describe
        # a failure rather than become one: a status panel that 500s tells the
        # operator less than one that names what went wrong. Whatever an exotic
        # transport throws (a proxy, a malformed `iss`, a decoder), it is
        # reported here instead of turning /fhir/status into an error page.
        return {"configured": True, "base_url": base, "source": source,
                "reachable": False,
                "detail": f"{type(exc).__name__}: {exc}"}
    # The server answered -- now describe what it said. A CapabilityStatement
    # that is not a JSON object (an array, a bare string, a proxy's HTML turned
    # into JSON) must still be a report, not another exception escaping here.
    if not isinstance(cap, dict):
        return {"configured": True, "base_url": base, "source": source,
                "reachable": True,
                "detail": f"{base}/metadata returned JSON that is not a "
                          f"CapabilityStatement ({type(cap).__name__})"}
    software = cap.get("software")
    return {
        "configured": True,
        "base_url": base,
        "source": source,
        "reachable": True,
        "detail": "CapabilityStatement retrieved",
        "fhir_version": cap.get("fhirVersion"),
        "software": software.get("name") if isinstance(software, dict) else None,
        "kind": cap.get("kind"),
    }


# --------------------------------------------------------------------------- #
# write-side: push a patient's record as one FHIR transaction
# --------------------------------------------------------------------------- #
def push_bundle(bundle: dict, base_url: str | None = None, client: httpx.Client | None = None) -> dict:
    """POST a transaction Bundle to the server root. Returns its transaction-response.

    A transaction Bundle is all-or-nothing on the server side, which is the
    behaviour we want: a partial write of a clinical record is worse than a
    failed one.
    """
    base = _base_url(base_url)
    try:
        with _client(client) as http:
            resp = http.post(
                base,
                json=bundle,
                headers={
                    "Content-Type": "application/fhir+json",
                    "Accept": "application/fhir+json",
                    **_auth_headers(),
                },
            )
    except TRANSPORT_FAILURES as exc:
        raise FHIRClientError(f"POST {base} failed: {exc}") from exc
    if resp.status_code >= 400:
        raise FHIRClientError(
            f"POST {base} returned HTTP {resp.status_code}: {resp.text[:400]}",
            status_code=resp.status_code,
        )
    try:
        return resp.json()
    except ValueError:
        return {
            "resourceType": "Bundle",
            "type": "transaction-response",
            "extension": [{"url": "urn:neuropilot:fhir:push-note",
                           "valueString": "Server returned non-JSON body (write may still have applied)."}],
        }


def push_patient(patient_id: str, base_url: str | None = None,
                 client: httpx.Client | None = None) -> dict:
    """Push one patient's complete interoperable record (see fhir.transaction_bundle).

    Includes ServiceRequests (open orders) and DiagnosticReports (completed
    panels), so the hospital receives NeuroPilot's orders and results alongside
    the RiskAssessment — this is what makes the workflow bidirectional rather
    than export-only.
    """
    from . import fhir, service

    record = service.PATIENTS.get(patient_id)
    if record is None:
        raise FHIRClientError(f"Patient/{patient_id} is not served by NeuroPilot", status_code=404)
    receipt = push_bundle(fhir.transaction_bundle(record), base_url=base_url, client=client)
    return receipt


def maybe_push_order(record: dict) -> dict | None:
    """Best-effort order push, used by the triage loop. Never raises.

    Returns a small report for the audit trail, or None when pushing is off.
    """
    if not (config.FHIR_PUSH_ORDERS and configured()):
        return None
    from . import fhir

    try:
        receipt = push_bundle(fhir.transaction_bundle(record, orders_only=True))
    except FHIRClientError as exc:
        return {"pushed": False, "detail": exc.message}
    except TRANSPORT_FAILURES as exc:  # belt and braces: this must never raise
        return {"pushed": False, "detail": f"{type(exc).__name__}: {exc}"}
    accepted = len(receipt.get("entry") or []) if isinstance(receipt, dict) else 0
    return {"pushed": True, "resources": accepted,
            "detail": f"{accepted} order resource(s) accepted by the hospital server"}
