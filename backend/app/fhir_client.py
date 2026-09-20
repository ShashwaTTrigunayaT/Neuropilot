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
* **Nothing is pushed anywhere until FHIR_BASE_URL is set.** Pointing this at a
  system is a deliberate act, not a default.

Limitations worth knowing (documented in FHIR_INTEGRATION.md):
transport is synchronous HTTP (no queue/retry), so a slow server delays the
caller; `AuditEvent` search is not implemented on most servers; and a real
deployment needs a durable outbox rather than a best-effort push.
"""
from __future__ import annotations

import httpx

from . import config


class FHIRClientError(Exception):
    """Raised when an outbound call cannot be completed or is rejected."""

    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def configured() -> bool:
    """True when an outbound hospital server is configured."""
    return bool(config.FHIR_BASE_URL)


def _auth_headers() -> dict:
    """SMART token first (it is the scoped one), then the static token."""
    from . import smart

    token = smart.access_token() or config.FHIR_AUTH_TOKEN
    return {"Authorization": f"Bearer {token}"} if token else {}


def _client(client: httpx.Client | None) -> httpx.Client:
    return client or httpx.Client(timeout=config.FHIR_TIMEOUT_SECONDS)


def _base_url(base_url: str | None = None) -> str:
    base = (base_url or config.FHIR_BASE_URL).rstrip("/")
    if not base:
        raise FHIRClientError(
            "No outbound FHIR server configured — set FHIR_BASE_URL (e.g. "
            "http://localhost:8090/fhir for a local HAPI server).",
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
    except httpx.HTTPError as exc:  # timeouts, DNS, connection refused
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
    """Connection report for the status endpoint. Never raises."""
    if not (base_url or config.FHIR_BASE_URL):
        return {
            "configured": False,
            "base_url": None,
            "reachable": False,
            "detail": "Set FHIR_BASE_URL to enable outbound order/result exchange.",
        }
    base = (base_url or config.FHIR_BASE_URL).rstrip("/")
    try:
        cap = fetch_capability_statement(base, client=client)
    except FHIRClientError as exc:
        return {"configured": True, "base_url": base, "reachable": False,
                "detail": exc.message}
    return {
        "configured": True,
        "base_url": base,
        "reachable": True,
        "detail": "CapabilityStatement retrieved",
        "fhir_version": cap.get("fhirVersion"),
        "software": (cap.get("software") or {}).get("name"),
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
    except httpx.HTTPError as exc:
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
    accepted = len(receipt.get("entry") or []) if isinstance(receipt, dict) else 0
    return {"pushed": True, "resources": accepted,
            "detail": f"{accepted} order resource(s) accepted by the hospital server"}
