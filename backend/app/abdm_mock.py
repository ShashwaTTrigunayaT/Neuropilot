"""Mock ABDM Consent Manager + mock HIP (Phase 4 of FHIR plan.md).

Two things a real ABDM integration cannot be built against without a sandbox
account, both provided here so the consent-flow client in ``abdm.py`` is exercised
over real HTTP against real contracts rather than being described in a README:

  * **HIE-CM**: accepts a consent request, decides it (as a patient would), then
    accepts a health-information request and acks it.
  * **HIP**: holds a patient's records and, when the CM tells it an exchange is
    authorised, encrypts them with Fidelius using the REQUESTER's public key and
    pushes them to the HIU's ``dataPushUrl``.

What is faithful: endpoint paths, request/response bodies, header names
(``REQUEST-ID``/``TIMESTAMP``/``X-CM-ID``), the direction of every call, the fact
that the CM is asynchronous, and — most importantly — the Fidelius payload, which
is encrypted by ``fidelius.py`` and therefore uses the same BouncyCastle curve the
real network uses.

What is NOT faithful, and is stated so nobody mistakes this for a sandbox pass:
  * a **static bearer token** instead of a signed request exchanged for a token
    (no ABDM key pair / no client registration);
  * the CM resolves ABHA -> subject by reading the local part of the address
    (``ADNI-0006@sbx`` -> ``ADNI-0006``) instead of resolving a real health
    address registry entry;
  * callbacks fire from a timer a few milliseconds after the response, where the
    real network takes seconds and can reorder;
  * consent decisions are granted automatically for the demo. A real patient can
    deny, revoke, or ignore — and ``abdm.py`` handles all of those states, but the
    mock only ever produces GRANTED unless you post a decision yourself.

Run standalone (``python -m app.abdm_mock``, port 8600) or let the main app mount
it at ``/mock-abdm`` (see api.py).
"""
from __future__ import annotations

import copy
import threading
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import numpy as np
from fastapi import FastAPI, Header, HTTPException, Request

from . import abdm, config, fhir, fidelius, service

CM_API = abdm.CM_API

# mock CM -> HIU delay. Short enough that a demo does not stall, long enough that
# the HIU's own request has provably finished before we call back — the real
# network takes seconds, and pretending the callback is synchronous would let a
# client with an ordering bug pass here and fail against a sandbox.
_CALLBACK_DELAY_SECONDS = 0.25

_lock = threading.RLock()
_CONSENTS: dict[str, dict] = {}
_TRANSACTIONS: dict[str, dict] = {}
_DECISIONS: dict[str, str] = {}  # consent request id -> GRANTED | DENIED
_DEFAULT_DECISION = "GRANTED"  # what the "patient" decides unless told otherwise


def _iso(moment: datetime | None = None) -> str:
    return (moment or datetime.now(timezone.utc)).isoformat()


def _new_id() -> str:
    return str(uuid.uuid4())


def _require_auth(authorization: str | None) -> None:
    """The CM checks its bearer, like the real one checks the token it issued.

    A static value is a mock-level shortcut (see the module docstring) — but it
    still means the HIU client has to send the header, so the client is not
    accidentally written to work without one.
    """
    token = (authorization or "").removeprefix("Bearer ").strip()
    if token != config.ABDM_CM_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid CM access token")


# --------------------------------------------------------------------------- #
# mock HIP — resolve the subject and build the records
# --------------------------------------------------------------------------- #
def resolve_subject(abha_address: str) -> str | None:
    """ABHA address -> NeuroPilot subject.

    The mock CM reads the local part of the address (``ADNI-0006@sbx``). A real CM
    resolves this in the health-address registry, which is exactly the piece that
    cannot be faked — and exactly why this function is one line long and says so.
    """
    local = (abha_address or "").split("@")[0].strip()
    if local in service.PATIENTS:
        return local
    # No match: fall back to a subject whose FILE already holds records the
    # pathway has not reached. That is the case worth demonstrating — the hospital
    # has a result the clinic has not seen.
    gapped = [r for r in service.PATIENTS.values() if config.pending_evidence_beyond(r)]
    pool = gapped or list(service.PATIENTS.values())
    if not pool:
        return None
    return max(pool, key=lambda r: r["score"])["id"]


# Model feature -> the Observation id fhir.observation_resources derives from it.
# Used only to annotate the simulated observations, so a reader can tell which
# values the simulator stood in for.
_OBS_ID_BY_FEATURE = {
    "ptau217": "ptau217",
    "abeta4240": "abeta4240",
    "nfl": "nfl",
    "gfap": "gfap",
    "hippocampal_volume": "hippocampal-volume",
    "hippocampal_icv_ratio": "hippocampal-icv-ratio",
    "centiloids": "centiloids",
    "tau_meta_temporal": "tau-meta-temporal-suvr",
}
_MOCK_TAG = {
    "system": "urn:neuropilot:mock-abdm",
    "code": "simulator-records",
    "display": "Mock HIP — simulated records, not a real measurement",
}
_MOCK_NOTE = (
    "MOCK HIP SIMULATOR: this value was drawn from the empirical ADNI cohort distribution, "
    "not measured for this subject. A real HIP sends records it actually holds; the "
    "simulator stands in where the served cohort has no value, so the encrypted pull can be "
    "exercised without an ABDM account."
)
_POOLS: dict | None = None


def _pools() -> dict:
    """Empirical per-feature value distribution, reused from the estimate engine."""
    global _POOLS
    if _POOLS is None:
        _POOLS = service._build_estimate_pools()
    return _POOLS


def _inject_next_stage(temp: dict, record: dict) -> list[str]:
    """Fill the pathway's NEXT missing stage from the empirical cohort.

    This is the difference between a demo that shows nothing and one that shows the
    point. The served cohort already holds every value it is going to hold, so a HIP
    faithfully returning "what it has" is idempotent — the pull changes nothing, and
    that is a true but uninformative result. A real hospital visit produces a NEW
    measurement, so the mock HIP produces one too: the median of the empirical ADNI
    distribution for each feature in the stage the pathway is waiting on, tagged and
    annotated as simulator output.
    """
    stage = int(record.get("stage") or 1)
    if stage >= 4:
        return []
    wanted = stage + 1
    injected: list[str] = []
    for feature, feature_stage in service._ESTIMATE_STAGE.items():
        if feature_stage != wanted:
            continue
        slot, key = service._ESTIMATE_DISPLAY_KEYS[feature]
        payload = temp.get(slot)
        if isinstance(payload, dict) and payload.get(key) is not None:
            continue  # the HIP genuinely holds this one; send it as-is
        if not isinstance(payload, dict):
            # The slot is absent or explicitly null on this record.
            payload = {}
            temp[slot] = payload
        pool = _pools().get(feature)
        if pool is None or len(pool) == 0:
            continue
        median = float(np.median(pool))
        payload[key] = round(median, 4)
        injected.append(feature)
    return injected


def build_records_bundle(patient_id: str) -> dict:
    """The FHIR bundle the mock HIP sends: demographics + measured values.

    Uses the same resource builders as the outbound export, so the payload is
    genuinely FHIR R4 and genuinely round-trips back through ``fhir_ingest``.
    It deliberately excludes RiskAssessment / AuditEvent / ServiceRequest — a
    hospital does not send our own decision support back to us.
    """
    record = service.PATIENTS.get(patient_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Mock HIP has no records for {patient_id}")

    temp = copy.deepcopy(record)
    injected = _inject_next_stage(temp, record)
    resources = [fhir.patient_resource(temp)] + fhir.observation_resources(temp)

    if injected:
        # Mark exactly which observations the simulator stood in for. An unlabelled
        # synthesised result is the one thing this must never produce.
        simulated_ids = {
            f"obs-{patient_id}-{_OBS_ID_BY_FEATURE[f]}" for f in injected if f in _OBS_ID_BY_FEATURE
        }
        for resource in resources:
            if resource.get("id") in simulated_ids:
                resource.setdefault("meta", {}).setdefault("tag", []).append(_MOCK_TAG)
                resource.setdefault("note", []).append({"text": _MOCK_NOTE})

    bundle = {
        "resourceType": "Bundle",
        "id": f"bundle-hip-{patient_id}",
        "type": "collection",
        "timestamp": _iso(),
        "entry": [
            {"fullUrl": f"{r['resourceType']}/{r['id']}", "resource": r} for r in resources
        ],
    }
    if injected:
        bundle["meta"] = {"tag": [_MOCK_TAG]}
    return bundle


# --------------------------------------------------------------------------- #
# mock CM -> HIU callbacks
# --------------------------------------------------------------------------- #
def _post_callback(url: str, body: dict, bearer: str = "mock-cm-token") -> None:
    try:
        httpx.post(url, json=body, timeout=config.ABDM_TIMEOUT_SECONDS,
                   headers={"Content-Type": "application/json", "Accept": "application/json",
                            "REQUEST-ID": _new_id(), "TIMESTAMP": _iso(),
                            "Authorization": f"Bearer {bearer}"})
    except httpx.HTTPError:
        # A mock must never crash the app it is serving; a failed callback shows up
        # as a stuck session, which is the honest symptom.
        pass


def _later(fn, *args, delay: float = _CALLBACK_DELAY_SECONDS) -> None:
    threading.Timer(delay, fn, args=args).start()


def _notify_grant(consent_request_id: str) -> None:
    """CM -> HIU: the patient decided. Deliberately a separate call, not a return value."""
    decision = _DECISIONS.get(consent_request_id, _DEFAULT_DECISION)
    consent_id = f"consent-{consent_request_id[:8]}"
    with _lock:
        consent = _CONSENTS.get(consent_request_id)
        if consent is not None and decision == "GRANTED":
            consent["status"] = "GRANTED"
            consent["consent_id"] = consent_id
    body = {
        "requestId": _new_id(),
        "timestamp": _iso(),
        "consentRequest": {"id": consent_request_id},
        "event": {"type": decision, "grantAcknowledgement": False},
        "consentArtefacts": [{"id": consent_id}] if decision == "GRANTED" else [],
    }
    _post_callback(f"{config.ABDM_CALLBACK_BASE_URL}{abdm.NOTIFY_PATH}", body)


def _serve_transaction(transaction_id: str) -> None:
    """CM -> HIU ack, then HIP -> HIU encrypted push. Two distinct calls on purpose."""
    with _lock:
        transaction = _TRANSACTIONS.get(transaction_id)
    if transaction is None:
        return
    _post_callback(
        f"{config.ABDM_CALLBACK_BASE_URL}{abdm.ON_REQUEST_PATH}",
        {
            "requestId": _new_id(),
            "timestamp": _iso(),
            "hiRequest": {
                "transactionId": transaction_id,
                "sessionStatus": "ACKNOWLEDGED",
                "accessToken": transaction["access_token"],
            },
        },
    )
    _push_records(transaction_id)


def _push_records(transaction_id: str) -> None:
    """The HIP half: encrypt with Fidelius, then POST to the HIU's dataPushUrl.

    Note which key material goes in the body — the HIP's OWN public key and nonce.
    Sending the requester's key material back is the single most common ABDM bugs
    (the HIU then cannot derive a shared secret with itself), and ``abdm.py``
    rejects a payload shaped that way, so this mock has to produce the correct
    shape to get through.
    """
    with _lock:
        transaction = _TRANSACTIONS.get(transaction_id)
    if transaction is None:
        return
    patient_id = transaction["patient_id"]
    try:
        bundle = build_records_bundle(patient_id)
    except HTTPException:
        return
    hip_material = fidelius.KeyMaterial.generate()
    ciphertext = fidelius.encrypt_fhir_bundle(
        bundle,
        own_private_key=hip_material.private_key,
        own_nonce=hip_material.nonce,
        peer_public_key=transaction["key_material"]["DHPublicKey"]["keyValue"],
        peer_nonce=transaction["key_material"]["nonce"],
    )
    body = {
        "pageNumber": 1,
        "pageCount": 1,
        "transactionId": transaction_id,
        "entries": [
            {
                "content": ciphertext,
                "media": "application/fhir+json",
                "checksum": abdm._md5_hex(ciphertext),
                "careContextReference": f"visit-{patient_id}-1",
            }
        ],
        "keyMaterial": {
            "cryptoAlg": "ECDH",
            "curve": "Curve25519",
            "params": "Curve25519",
            "DHPublicKey": {
                "expiry": _iso(datetime.now(timezone.utc) + timedelta(minutes=30)),
                "parameters": "Curve25519",
                # X.509 DER form — the raw uncompressed point is rejected by real
                # consumers, and accepted here only because our decoder is lenient.
                "keyValue": hip_material.x509_public_key,
            },
            "nonce": hip_material.nonce,
        },
    }
    # Only Authorization + Content-Type go to a dataPushUrl — adding REQUEST-ID or
    # X-CM-ID here is a documented ABDM mistake.
    _post_callback(transaction["data_push_url"], body, bearer=transaction["access_token"])


# --------------------------------------------------------------------------- #
# the mock CM/HIP API
# --------------------------------------------------------------------------- #
def create_app() -> FastAPI:
    app = FastAPI(title="Mock ABDM Consent Manager + HIP", docs_url="/docs")

    @app.get("/state")
    def state() -> dict:
        with _lock:
            consents = [
                {"consent_request_id": k, "status": v["status"], "patient_abha": v["abha"],
                 "consent_id": v.get("consent_id")}
                for k, v in _CONSENTS.items()
            ]
            transactions = [
                {
                    "transaction_id": k,
                    "consent_id": v["consent_id"],
                    "patient_id": v["patient_id"],
                    # A simulator convenience: this is the token the mock CM issued
                    # to the HIU. Exposed so the admin surface can show what the
                    # exchange looks like end to end — a real CM never publishes it.
                    "access_token": v["access_token"],
                }
                for k, v in _TRANSACTIONS.items()
            ]
        return {
            "role": "mock HIE-CM + mock HIP",
            "api_version": CM_API,
            "default_decision": _DEFAULT_DECISION,
            "consents": consents,
            "transactions": transactions,
            "note": "Mock decisions are automatic; see abdm_mock.py docstring for what is not faithful.",
        }

    @app.post("/reset")
    def reset() -> dict:
        with _lock:
            count = len(_CONSENTS) + len(_TRANSACTIONS)
            _CONSENTS.clear()
            _TRANSACTIONS.clear()
            _DECISIONS.clear()
        return {"cleared": count}

    @app.post("/decision/{decision}")
    def set_decision(decision: str) -> dict:
        """How the mock patient will decide the next consent request.

        Exists so the DENIED / revoked path is demonstrable and testable — a demo
        that can only ever produce GRANTED is a demo of the happy path, not of the
        integration.
        """
        global _DEFAULT_DECISION
        decision = decision.upper()
        if decision not in ("GRANTED", "DENIED"):
            raise HTTPException(status_code=422, detail="decision must be GRANTED or DENIED")
        with _lock:
            _DEFAULT_DECISION = decision
            _DECISIONS.clear()
        return {"default_decision": decision}

    # ---- consent request -------------------------------------------------- #
    @app.post(f"/api/{CM_API}/consent-requests/init")
    async def consent_init(request: Request, authorization: str | None = Header(default=None)) -> dict:
        _require_auth(authorization)
        body = await request.json()
        consent_request_id = _new_id()
        consent = {
            "id": consent_request_id,
            "abha": str(((body.get("consent") or {}).get("patient") or {}).get("id") or ""),
            "status": "REQUESTED",
            "hiu_id": str(((body.get("consent") or {}).get("hiu") or {}).get("id") or ""),
            "hi_types": (body.get("consent") or {}).get("hiTypes") or [],
            "created_at": _iso(),
        }
        with _lock:
            _CONSENTS[consent_request_id] = consent
        # The patient cannot decide inside this HTTP call — so the notification is a
        # separate, later request, exactly as the real network behaves.
        _later(_notify_grant, consent_request_id)
        return {"consentRequest": {"id": consent_request_id, "status": "REQUESTED"}}

    @app.get(f"/api/{CM_API}/consent-requests/status/{{consent_request_id}}")
    def consent_status(consent_request_id: str, authorization: str | None = Header(default=None)) -> dict:
        _require_auth(authorization)
        with _lock:
            consent = _CONSENTS.get(consent_request_id)
        if consent is None:
            raise HTTPException(status_code=404, detail="Unknown consent request")
        return {"consentRequest": {"id": consent_request_id, "status": consent["status"]}}

    # ---- health information request --------------------------------------- #
    @app.post(f"/api/{CM_API}/health-information/hiu/request")
    async def hi_request(request: Request, authorization: str | None = Header(default=None)) -> dict:
        _require_auth(authorization)
        body = await request.json()
        hi = body.get("hiRequest") or {}
        consent_id = str((hi.get("consent") or {}).get("id") or "")
        key_material = hi.get("keyMaterial") or {}
        public_key = (key_material.get("DHPublicKey") or {}).get("keyValue")
        nonce = key_material.get("nonce")
        if not public_key or not nonce:
            raise HTTPException(
                status_code=422,
                detail="hiRequest.keyMaterial must carry DHPublicKey.keyValue and nonce",
            )
        # Verify the requester's key is usable before acknowledging — a real CM
        # would reject a malformed public key here rather than mid-transfer.
        try:
            fidelius.decode_public_key(str(public_key))
            fidelius._unb64(str(nonce), "nonce")
        except fidelius.FideliusError as exc:
            raise HTTPException(status_code=422, detail=f"unusable key material: {exc}") from exc

        abha = ""
        with _lock:
            for consent in _CONSENTS.values():
                if consent.get("consent_id") == consent_id:
                    abha = consent["abha"]
        patient_id = resolve_subject(abha)
        if patient_id is None:
            raise HTTPException(status_code=404, detail="Mock HIP holds no records for that subject")

        transaction_id = _new_id()
        with _lock:
            _TRANSACTIONS[transaction_id] = {
                "consent_id": consent_id,
                "patient_id": patient_id,
                "key_material": key_material,
                "data_push_url": str(hi.get("dataPushUrl") or ""),
                "access_token": f"mock-session-{transaction_id[:8]}",
            }
        if not _TRANSACTIONS[transaction_id]["data_push_url"]:
            raise HTTPException(status_code=422, detail="hiRequest.dataPushUrl is required")
        _later(_serve_transaction, transaction_id)
        return {"hiRequest": {"transactionId": transaction_id, "sessionStatus": "ACKNOWLEDGED"}}

    @app.get(f"/api/{CM_API}/health-information/status/{{transaction_id}}")
    def hi_status(transaction_id: str, authorization: str | None = Header(default=None)) -> dict:
        _require_auth(authorization)
        with _lock:
            transaction = _TRANSACTIONS.get(transaction_id)
        if transaction is None:
            raise HTTPException(status_code=404, detail="Unknown transaction")
        return {"hiRequest": {"transactionId": transaction_id,
                              "sessionStatus": "TRANSFERRED",
                              "patient_id": transaction["patient_id"]}}

    return app


# Mounted by the main app at /mock-abdm; also runnable on its own for a two-process
# demo (start this on :8600 and point ABDM_CALLBACK_BASE_URL at the API).
app = create_app()


if __name__ == "__main__":  # pragma: no cover - manual demo entry point
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8600)
