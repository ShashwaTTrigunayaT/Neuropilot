"""ABDM HIU consent-flow client (Phase 4) + Fidelius data pull (Phase 5).

NeuroPilot participates as a **HIU** (Health Information User): it asks a Consent
Manager for permission to read a patient's records, and when consent is granted
it asks for the data. The records arrive Fidelius-encrypted and are decrypted in
``fidelius.py``; the resulting FHIR bundles go through ``fhir_ingest`` so scoring
happens on exactly the same path as a result typed into the UI.

Flow, in the order ABDM actually runs it — every arrow labelled with who starts
it, because the asynchrony is the whole reason this is a state machine and not a
function call:

    HIU -> CM   POST /v0.5/consent-requests/init          (we ask)
    CM  -> HIU  POST /abdm/consents/notify                (patient decided)
    HIU -> CM   POST /v0.5/health-information/hiu/request (we ask for records;
                                                           our DHPublicKey goes here)
    CM  -> HIU  POST /abdm/health-information/on-request  (transaction ack)
    HIP -> HIU  POST /abdm/health-information/transfer    (encrypted FHIR lands)

Design choices worth stating:

* **The private key never leaves this process.** The session's public half and
  nonce are the only key material that travels; ``Session.public()`` is what every
  endpoint returns, and it omits the private key outright rather than relying on
  callers to be careful.
* **Grants are not guessed at.** Nothing polls or sleeps in a request handler —
  the session carries its own status and the caller asks. A real CM is
  asynchronous, and pretending otherwise is how demos work and integrations fail.
* **A pull is idempotent per transaction.** A replayed data push is rejected, so
  a retrying HIP cannot double-ingest a record.

Honest limitations (see ABDM_INTEGRATION.md for the full list):
    * Sessions and key material are **in memory** — a restart drops an in-flight
      consent. A real deployment persists them (L10).
    * Requests are **not digitally signed** with an ABDM key pair; this uses a
      bearer token. Signing is the one thing a real CM will insist on (L11).
    * The consent artefact is **not stored as the legal record** — only the ids
      and the outcome are kept (L12).
"""
from __future__ import annotations

import hashlib
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import httpx

from . import config, fhir_ingest, fidelius

CM_API = "v0.5"
DATA_PUSH_PATH = "/abdm/health-information/transfer"
NOTIFY_PATH = "/abdm/consents/notify"
ON_REQUEST_PATH = "/abdm/health-information/on-request"

# Consent lifecycle. REQUESTED -> GRANTED|DENIED -> RECORDS_REQUESTED -> RECEIVED
# (or FAILED at any point, with the reason kept on the session).
STATUS_REQUESTED = "REQUESTED"
STATUS_GRANTED = "GRANTED"
STATUS_DENIED = "DENIED"
STATUS_RECORDS_REQUESTED = "RECORDS_REQUESTED"
STATUS_RECEIVED = "RECEIVED"
STATUS_FAILED = "FAILED"

DEFAULT_HI_TYPES = ["DiagnosticReport", "OPConsultation", "DischargeSummary", "WellnessRecord"]

_lock = threading.RLock()
_SESSIONS: dict[str, "Session"] = {}
# transaction id -> session id, so a data push can be attributed without trusting
# a caller-supplied session id.
_TRANSACTIONS: dict[str, str] = {}


class AbdmError(Exception):
    """Raised on a protocol-level failure (maps to a 4xx/5xx HTTP response)."""

    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: datetime | None = None) -> str:
    return (moment or _now()).isoformat()


def _new_id() -> str:
    return str(uuid.uuid4())


def cm_base_url() -> str:
    """The Consent Manager endpoint. Configured value wins; else the in-process mock."""
    if config.ABDM_CM_BASE_URL:
        return config.ABDM_CM_BASE_URL
    if config.ABDM_USE_MOCK_GATEWAY:
        return f"{config.ABDM_CALLBACK_BASE_URL}/mock-abdm"
    return ""


def data_push_url() -> str:
    return f"{config.ABDM_CALLBACK_BASE_URL}{DATA_PUSH_PATH}"


def is_mock() -> bool:
    return not config.ABDM_CM_BASE_URL and config.ABDM_USE_MOCK_GATEWAY


# --------------------------------------------------------------------------- #
# session
# --------------------------------------------------------------------------- #
@dataclass
class Session:
    """One consent exchange, from request to ingested records."""

    id: str
    abha_address: str
    purpose_code: str
    hi_types: list[str]
    date_from: str
    date_to: str
    status: str = STATUS_REQUESTED
    consent_request_id: str | None = None
    consent_id: str | None = None
    transaction_id: str | None = None
    # Set when the CM acknowledges the HI request (and issues the push token).
    acknowledged: bool = False
    key_material: fidelius.KeyMaterial | None = None
    # Bearer the CM hands back for the data push; validated on transfer.
    access_token: str | None = None
    # True once the pull is done and the ephemeral private key has been dropped.
    key_material_retired: bool = False
    events: list[dict] = field(default_factory=list)
    pull: dict | None = None
    error: str | None = None
    created_at: str = field(default_factory=_iso)

    def note(self, event: str, detail: str = "") -> None:
        self.events.append({"at": _iso(), "event": event, "detail": detail})

    def public(self) -> dict:
        """Serialisable view. Never includes the DH private key."""
        return {
            "session_id": self.id,
            "abha_address": self.abha_address,
            "status": self.status,
            "purpose": self.purpose_code,
            "hi_types": self.hi_types,
            "date_range": {"from": self.date_from, "to": self.date_to},
            "consent_request_id": self.consent_request_id,
            "consent_id": self.consent_id,
            "transaction_id": self.transaction_id,
            "acknowledged": self.acknowledged,
            "data_push_url": data_push_url(),
            "key_material": (
                None if self.key_material is None
                else {
                    "curve": "Curve25519",
                    # Only the public half is exposed; the private key stays in
                    # this process for the whole exchange.
                    "public_key": self.key_material.public_key,
                    "nonce": self.key_material.nonce,
                    "retired": False,
                }
            ),
            "key_material_retired": self.key_material_retired,
            "events": list(self.events),
            "pull": self.pull,
            "error": self.error,
            "created_at": self.created_at,
        }


def _session(session_id: str) -> Session:
    with _lock:
        session = _SESSIONS.get(session_id)
    if session is None:
        raise AbdmError(f"Unknown consent session '{session_id}'", status_code=404)
    return session


# --------------------------------------------------------------------------- #
# CM call helper
# --------------------------------------------------------------------------- #
def _headers(request_id: str) -> dict:
    return {
        "REQUEST-ID": request_id,
        "TIMESTAMP": _iso(),
        "X-CM-ID": config.ABDM_CM_ID,
        "Authorization": f"Bearer {config.ABDM_CM_TOKEN}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def _post_to_cm(path: str, body: dict) -> dict:
    base = cm_base_url()
    if not base:
        raise AbdmError(
            "No Consent Manager configured. Set ABDM_CM_BASE_URL, or enable the "
            "in-process mock gateway with ABDM_USE_MOCK_GATEWAY=true.",
            status_code=503,
        )
    url = f"{base}/api/{CM_API}/{path}"
    request_id = body.get("requestId") or _new_id()
    try:
        response = httpx.post(url, json=body, headers=_headers(request_id),
                              timeout=config.ABDM_TIMEOUT_SECONDS)
    except httpx.HTTPError as exc:
        raise AbdmError(f"Consent Manager unreachable at {url}: {exc}", status_code=502) from exc
    if response.status_code >= 400:
        raise AbdmError(
            f"Consent Manager rejected {path} ({response.status_code}): {response.text[:300]}",
            status_code=502,
        )
    try:
        return response.json()
    except ValueError as exc:
        raise AbdmError(f"Consent Manager returned a non-JSON body for {path}", status_code=502) from exc


# --------------------------------------------------------------------------- #
# step 1 — ask for consent
# --------------------------------------------------------------------------- #
def initiate_consent(
    abha_address: str,
    hi_types: list[str] | None = None,
    days: int = 180,
    purpose_code: str = "CAREMGT",
) -> dict:
    """Open a consent request. Returns the session (status REQUESTED).

    Note what is NOT here: no patient id, no score, no tier. What we ask for is a
    time-bounded, purpose-bound read of a named patient's records. The patient's
    ABHA address is the only identifier that leaves this system.
    """
    abha_address = (abha_address or "").strip()
    if not abha_address:
        raise AbdmError("abha_address is required (e.g. 'ADNI-0006@sbx')", status_code=422)

    now = _now()
    date_from = (now - timedelta(days=max(1, days))).date().isoformat()
    date_to = now.date().isoformat()
    session = Session(
        id=_new_id(),
        abha_address=abha_address,
        purpose_code=purpose_code,
        hi_types=list(hi_types or DEFAULT_HI_TYPES),
        date_from=date_from,
        date_to=date_to,
    )
    with _lock:
        _SESSIONS[session.id] = session

    request_id = _new_id()
    session.consent_request_id = request_id
    body = {
        "requestId": request_id,
        "timestamp": _iso(),
        "consent": {
            "purpose": {"code": purpose_code, "text": "Care Management"},
            "patient": {"id": abha_address},
            "hiu": {"id": config.ABDM_HIU_ID},
            "requester": {
                "name": config.ABDM_REQUESTER_NAME,
                "identifier": {
                    "type": "REGNO",
                    "value": config.ABDM_REQUESTER_REGNO,
                    "system": f"{cm_base_url()}/hiu",
                },
            },
            "hiTypes": session.hi_types,
            "permission": {
                "accessMode": "VIEW",
                "dateRange": {"from": date_from, "to": date_to},
                # We ask for the minimum that is useful and commit to erasing it.
                "dataEraseAt": _iso(now + timedelta(days=30)),
                "frequency": {"unit": "HOUR", "value": 1, "repeats": 0},
            },
            "expiryAt": _iso(now + timedelta(days=30)),
        },
    }
    try:
        response = _post_to_cm("consent-requests/init", body)
    except AbdmError as exc:
        session.status = STATUS_FAILED
        session.error = exc.message
        session.note("FAILED", exc.message)
        return session.public()

    consent_request_id = ((response.get("consentRequest") or {}).get("id")
                          or response.get("id"))
    if consent_request_id:
        session.consent_request_id = str(consent_request_id)
    session.note("CONSENT_REQUESTED",
                 f"consent request {session.consent_request_id} sent to consent manager")
    return session.public()


# --------------------------------------------------------------------------- #
# step 2 — the CM tells us the patient decided
# --------------------------------------------------------------------------- #
def handle_consent_notify(body: dict) -> dict:
    """Apply a consent notification (GRANTED / DENIED / REVOKED / EXPIRED).

    Returns the acknowledgement ABDM expects from the HIU. An unknown consent
    request is acknowledged rather than 404'd — a retrying CM must not be able to
    wedge, and there is nothing to change anyway.
    """
    event = (body.get("event") or {}).get("type") or ""
    consent_request_id = str((body.get("consentRequest") or {}).get("id") or "")
    artefacts = body.get("consentArtefacts") or []
    consent_id = str((artefacts[0] or {}).get("id")) if artefacts and isinstance(artefacts[0], dict) else None
    request_id = body.get("requestId") or _new_id()

    with _lock:
        session = next(
            (s for s in _SESSIONS.values() if s.consent_request_id == consent_request_id),
            None,
        )
    if session is None:
        return {"requestId": request_id, "timestamp": _iso(),
                "error": {"code": "CONSENT_REQUEST_NOT_FOUND",
                          "message": f"no session for consent request {consent_request_id}"}}

    with _lock:
        if event == "GRANTED":
            session.status = STATUS_GRANTED
            session.consent_id = consent_id or session.consent_request_id
        elif event in ("DENIED", "REVOKED", "EXPIRED"):
            session.status = STATUS_DENIED if event == "DENIED" else STATUS_FAILED
            session.error = f"consent {event.lower()}"
        session.note(event or "CONSENT_NOTIFY", f"consent artefact {session.consent_id or '-'}")
    return {"requestId": request_id, "timestamp": _iso()}


# --------------------------------------------------------------------------- #
# step 3 — ask for the records (our DH public key travels here)
# --------------------------------------------------------------------------- #
def request_health_information(session_id: str) -> dict:
    session = _session(session_id)
    if session.status not in (STATUS_GRANTED, STATUS_RECORDS_REQUESTED):
        raise AbdmError(
            f"Cannot request records while the session is {session.status}"
            + (f" ({session.error})" if session.error else " — consent must be GRANTED first"),
            status_code=409,
        )
    # Fresh ephemeral key pair for THIS exchange: perfect forward secrecy means a
    # compromised key cannot decrypt an older pull.
    session.key_material = fidelius.KeyMaterial.generate()
    request_id = _new_id()
    body = {
        "requestId": request_id,
        "timestamp": _iso(),
        "hiRequest": {
            "consent": {"id": session.consent_id or session.consent_request_id},
            "dateRange": {"from": session.date_from, "to": session.date_to},
            "dataPushUrl": data_push_url(),
            "keyMaterial": session.key_material.request_block(),
        },
    }
    response = _post_to_cm("health-information/hiu/request", body)
    hi = response.get("hiRequest") or {}
    session.transaction_id = str(hi.get("transactionId") or "") or None
    if session.transaction_id:
        with _lock:
            _TRANSACTIONS[session.transaction_id] = session.id
    session.status = STATUS_RECORDS_REQUESTED
    session.note("RECORDS_REQUESTED",
                 f"transaction {session.transaction_id or '-'} · "
                 f"session {hi.get('sessionStatus') or 'ACKNOWLEDGED'}")
    return session.public()


def handle_on_request(body: dict) -> dict:
    """CM acknowledges the HI request and issues the push bearer token."""
    hi = body.get("hiRequest") or {}
    transaction_id = str(hi.get("transactionId") or "")
    with _lock:
        session_id = _TRANSACTIONS.get(transaction_id)
        session = _SESSIONS.get(session_id) if session_id else None
    if session is None:
        return {"error": {"code": "TRANSACTION_NOT_FOUND", "message": transaction_id}}
    with _lock:
        session.transaction_id = transaction_id or session.transaction_id
        session.access_token = str(hi.get("accessToken") or "") or session.access_token
        session.acknowledged = True
        session.note("TRANSACTION_ACK", f"session status {hi.get('sessionStatus') or 'ACKNOWLEDGED'}")
    return {"requestId": body.get("requestId") or _new_id(), "timestamp": _iso()}


# --------------------------------------------------------------------------- #
# step 4 — the encrypted records arrive
# --------------------------------------------------------------------------- #
def _md5_hex(text: str) -> str:
    return hashlib.md5(text.encode("utf-8")).hexdigest()


def receive_transfer(body: dict, authorization: str = "") -> dict:
    """Decrypt an incoming ABDM data push and ingest the FHIR it carries.

    Validation is deliberately uncompromising — this endpoint is reachable and the
    payload is about to change a patient's risk score:
      * the bearer must match the token this session was issued;
      * the transaction id must belong to a session;
      * per-entry checksums must match (ABDM specifies MD5);
      * a replay of an already-received transaction is refused, so a retrying HIP
        cannot double-ingest.
    """
    transaction_id = str(body.get("transactionId") or "")
    with _lock:
        session_id = _TRANSACTIONS.get(transaction_id)
    if not session_id:
        raise AbdmError(f"Unknown transaction '{transaction_id}' — no HIU session matches it",
                        status_code=404)
    session = _session(session_id)

    # A push before the CM has acknowledged the request cannot be legitimate: the
    # session has not been issued a token yet. Refuse rather than fall through to
    # decryption with nothing to check against.
    if not session.access_token:
        raise AbdmError(
            "This session has not been acknowledged by the Consent Manager yet — "
            "no data push has been authorised",
            status_code=409,
        )
    token = (authorization or "").removeprefix("Bearer ").strip()
    if token != session.access_token:
        raise AbdmError("Data push bearer token does not match the issued session token",
                        status_code=401)
    if session.pull is not None:
        raise AbdmError(
            f"Transaction '{transaction_id}' was already received — refusing to re-ingest",
            status_code=409,
        )

    pull = body.get("keyMaterial") or {}
    hip_key = ((pull.get("DHPublicKey") or {}).get("keyValue")
               or (pull.get("dhPublicKey") or {}).get("keyValue"))
    hip_nonce = pull.get("nonce")
    if not hip_key or not hip_nonce:
        raise AbdmError(
            "Data push is missing the SENDER's keyMaterial (DHPublicKey.keyValue + nonce). "
            "Returning the requester's own key material here is a common integration bug.",
            status_code=422,
        )
    if session.key_material is None:
        raise AbdmError("This session has no HIU key material — it never requested records",
                        status_code=409)

    entries = body.get("entries")
    if not isinstance(entries, list) or not entries:
        raise AbdmError("Data push contains no entries", status_code=422)

    bundles: list[dict] = []
    ingested_patients: list[str] = []
    receipts: list[dict] = []
    failures: list[str] = []

    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            failures.append(f"entry {index}: not an object")
            continue
        content = entry.get("content")
        if not isinstance(content, str) or not content:
            failures.append(f"entry {index}: missing encrypted content")
            continue
        checksum = str(entry.get("checksum") or "")
        if checksum and checksum.lower() != _md5_hex(content):
            failures.append(f"entry {index}: MD5 checksum mismatch — refusing encrypted content")
            continue
        try:
            bundle = fidelius.decrypt_fhir_bundle(
                content,
                own_private_key=session.key_material.private_key,
                own_nonce=session.key_material.nonce,
                peer_public_key=str(hip_key),
                peer_nonce=str(hip_nonce),
            )
        except fidelius.FideliusError as exc:
            failures.append(f"entry {index}: {exc}")
            continue
        bundles.append(bundle)

    if failures:
        session.status = STATUS_FAILED
        session.error = "; ".join(failures)
        session.note("TRANSFER_REJECTED", session.error)
        raise AbdmError(f"Data push rejected — {session.error}", status_code=422)

    for bundle in bundles:
        try:
            receipt = fhir_ingest.ingest_bundle(bundle)
        except fhir_ingest.IngestError as exc:
            # The records arrived intact but do not map onto our feature set; the
            # decryption succeeded and that fact is worth reporting separately.
            session.status = STATUS_FAILED
            session.error = "decrypted records did not map to NeuroPilot features: " + "; ".join(
                issue.get("diagnostics", "") for issue in exc.issues
            )
            session.note("INGEST_REJECTED", session.error)
            raise AbdmError(session.error, status_code=422) from exc
        receipts.append(receipt)
        for out_entry in receipt.get("entry", []):
            location = (out_entry.get("response") or {}).get("location", "")
            if location.startswith("Patient/"):
                ingested_patients.append(location.split("/", 1)[1])

    from . import service  # local import: avoids a cycle at module load

    patient_ids = sorted(set(ingested_patients))
    session.pull = {
        "transaction_id": transaction_id,
        "received_at": _iso(),
        "entries": len(entries),
        "patient_ids": patient_ids,
        # Post-ingest summaries, so a caller sees what the records did to the score.
        "patients": service.patient_summaries(patient_ids),
        "receipts": receipts,
        "summary": (
            f"{len(bundles)} encrypted bundle(s) decrypted and ingested across "
            f"{len(patient_ids)} patient(s)"
        ),
    }
    session.status = STATUS_RECEIVED
    session.note("RECORDS_RECEIVED", session.pull["summary"])

    # The key material has done its job. Dropping the private half means a leaked
    # session record cannot decrypt anything afterwards (forward secrecy is the
    # point of a per-exchange keypair), and `public()` already hides it.
    session.key_material = None
    session.key_material_retired = True

    return {
        "resourceType": "Bundle",
        "type": "transaction-response",
        "timestamp": _iso(),
        "session_id": session.id,
        "summary": session.pull["summary"],
        "patient_ids": session.pull["patient_ids"],
        "patients": session.pull["patients"],
        "receipts": session.pull["receipts"],
    }


# --------------------------------------------------------------------------- #
# read-only views
# --------------------------------------------------------------------------- #
def get_session(session_id: str) -> dict:
    return _session(session_id).public()


def list_sessions(limit: int = 25) -> dict:
    with _lock:
        sessions = sorted(_SESSIONS.values(), key=lambda s: s.created_at, reverse=True)
    return {"count": len(sessions), "sessions": [s.public() for s in sessions[:limit]]}


def status() -> dict:
    """Integration status for the dashboard: configured? reachable? what ran?"""
    base = cm_base_url()
    reachable: bool | str = False
    if base:
        try:
            probe = httpx.get(f"{base}/api/{CM_API}/consent-requests/status/{_new_id()}",
                              headers=_headers(_new_id()), timeout=3)
            reachable = probe.status_code < 500
        except httpx.HTTPError as exc:
            reachable = f"unreachable: {exc}"
    with _lock:
        sessions = list(_SESSIONS.values())
    return {
        "configured": bool(base),
        "cm_base_url": base or None,
        "mock_gateway": is_mock(),
        "hiu_id": config.ABDM_HIU_ID,
        "data_push_url": data_push_url(),
        "cm_reachable": reachable,
        "fidelius": {
            "curve": "Curve25519 (BouncyCastle short-Weierstrass)",
            "kdf": "HKDF-SHA256",
            "cipher": "AES-256-GCM",
            "reference_vectors": "verified against fidelius-cli / pyfidelius fixtures",
        },
        "sessions": {
            "total": len(sessions),
            "granted": sum(1 for s in sessions if s.status == STATUS_GRANTED),
            "received": sum(1 for s in sessions if s.status == STATUS_RECEIVED),
            "failed": sum(1 for s in sessions if s.status == STATUS_FAILED),
        },
        "note": (
            "Records are pulled from the Consent Manager and decrypted here; scoring then "
            "runs through the same path as a result entered in the UI."
        ),
    }


def reset() -> dict:
    """Drop all sessions (tests / demo reset)."""
    with _lock:
        count = len(_SESSIONS)
        _SESSIONS.clear()
        _TRANSACTIONS.clear()
    return {"cleared": count}
