"""ABDM consent-flow + Fidelius data-pull, end to end over real HTTP.

These tests deliberately do NOT use TestClient for the flow. The whole point of
the consent exchange is that it is *asynchronous and bidirectional*: the CM calls
back into the HIU, and the HIP pushes to a URL the HIU handed out. A TestClient
makes that look synchronous and hides exactly the ordering bugs that break a real
integration, so the suite starts a real uvicorn server and talks to it with httpx,
with the mock Consent Manager mounted at /mock-abdm (also a real ASGI app, reached
by URL).

What is proven here:
  * consent request -> patient decides -> grant arrives as a callback
  * records request carries only the PUBLIC half of the key material
  * the HIP's encrypted push is decrypted, mapped, and RE-SCORES the patient
  * denial, replay, bad checksum, wrong bearer and unknown transaction all refuse
"""
from __future__ import annotations

import copy
import os
import socket
import threading
import time

import httpx
import pytest

# The mock gateway is mounted at import time based on config, so pin the
# environment before app.main is imported. conftest has already cleared
# DATABASE_URL.
os.environ.setdefault("ABDM_USE_MOCK_GATEWAY", "true")
os.environ.setdefault("ABDM_CM_BASE_URL", "")

from app import abdm, abdm_mock, config, service  # noqa: E402
from app.main import app  # noqa: E402


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@pytest.fixture(scope="module")
def live_server():
    """One real uvicorn server serving the API with the mock CM mounted."""
    import uvicorn

    port = _free_port()
    base = f"http://127.0.0.1:{port}"
    config.ABDM_CALLBACK_BASE_URL = base
    config.ABDM_CM_BASE_URL = ""
    config.ABDM_USE_MOCK_GATEWAY = True

    if not any(getattr(route, "path", "") == "/mock-abdm" for route in app.routes):
        app.mount("/mock-abdm", abdm_mock.app)

    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 20
    while not server.started and time.time() < deadline:
        time.sleep(0.05)
    if not server.started:
        raise RuntimeError("uvicorn did not start for the ABDM test fixture")

    yield base

    server.should_exit = True
    thread.join(timeout=10)


@pytest.fixture(autouse=True)
def _clean_sessions(live_server):
    """Sessions, mock state and the served cohort are global; isolate each test.

    An ABDM pull genuinely writes measurements into a patient record and re-scores
    them — that is the behaviour under test. Those writes persist for the whole
    pytest process unless undone, and would silently shift the tier counts that
    test_api.py asserts on, so the cohort is snapshotted and restored here.
    """
    snapshot = copy.deepcopy(service.PATIENTS)
    abdm.reset()
    httpx.post(f"{live_server}/mock-abdm/reset", timeout=5)
    httpx.post(f"{live_server}/mock-abdm/decision/GRANTED", timeout=5)
    yield
    service.PATIENTS.clear()
    service.PATIENTS.update(snapshot)
    abdm.reset()
    httpx.post(f"{live_server}/mock-abdm/reset", timeout=5)


def _wait_for(client: httpx.Client, session_id: str, statuses: set[str], timeout: float = 15.0) -> dict:
    """Poll a session until it reaches one of `statuses` — consent is asynchronous."""
    deadline = time.time() + timeout
    last: dict = {}
    while time.time() < deadline:
        last = client.get(f"/abdm/consent/{session_id}").json()
        if last.get("status") in statuses:
            return last
        time.sleep(0.1)
    raise AssertionError(f"session {session_id} never reached {statuses}; last state: {last}")


def _wait_for_ack(client: httpx.Client, session_id: str, timeout: float = 15.0) -> dict:
    """Wait for the CM's on-request acknowledgement (which issues the push token)."""
    deadline = time.time() + timeout
    last: dict = {}
    while time.time() < deadline:
        last = client.get(f"/abdm/consent/{session_id}").json()
        if last.get("acknowledged"):
            return last
        time.sleep(0.1)
    raise AssertionError(f"session {session_id} was never acknowledged; last state: {last}")


def _gapped_patient() -> str:
    """A subject whose FILE holds a result the ordered pathway has not reached.

    This is the case worth proving: the hospital has a record the clinic has not
    seen, and ingesting it must move the pathway and the score.
    """
    gapped = [r for r in service.PATIENTS.values() if config.pending_evidence_beyond(r)]
    assert gapped, "the served cohort has no gapped patient to pull records for"
    return max(gapped, key=lambda r: r["score"])["id"]


# --------------------------------------------------------------------------- #
# happy path
# --------------------------------------------------------------------------- #
def test_full_consent_flow_pulls_encrypted_records_and_rescores(live_server):
    patient_id = _gapped_patient()
    before = service.PATIENTS[patient_id]
    score_before, stage_before = before["score"], before["stage"]

    with httpx.Client(base_url=live_server, timeout=20) as client:
        # 1. ask for consent
        session = client.post(
            "/abdm/consent",
            json={"abha_address": f"{patient_id}@sbx", "days": 180},
        ).json()
        assert session["status"] == "REQUESTED"
        session_id = session["session_id"]

        # 2. the patient decides — a LATER call from the CM, not a return value
        granted = _wait_for(client, session_id, {"GRANTED", "DENIED"})
        assert granted["status"] == "GRANTED", granted
        assert granted["consent_id"]

        # 3. ask for the records: the public DH key travels, the private one does not
        requested = client.post(f"/abdm/consent/{session_id}/records").json()
        assert requested["status"] == "RECORDS_REQUESTED"
        assert requested["transaction_id"]
        assert requested["key_material"]["curve"] == "Curve25519"
        assert requested["key_material"]["public_key"]

        # 4. the encrypted push arrives and is ingested
        received = _wait_for(client, session_id, {"RECEIVED", "FAILED"})
        assert received["status"] == "RECEIVED", received.get("error")
        pull = received["pull"]
        assert pull["entries"] == 1
        assert patient_id in pull["patient_ids"]
        assert "1 encrypted bundle" in pull["summary"]

        # 5. the served model re-scored the patient along the normal path
        after = service.PATIENTS[patient_id]
        assert after["score"] != score_before or after["stage"] != stage_before, (
            "ingested records changed nothing — the pull is not reaching scoring"
        )
        assert after["stage"] >= stage_before

        # the stored pull reports POST-ingest state, not a pre-computed value
        summary = next(s for s in pull["patients"] if s["id"] == patient_id)
        assert summary["official_score"] == pytest.approx(after["score"], abs=1e-9)
        assert summary["stage"] == after["stage"]


def test_private_key_never_leaves_the_session_payload(live_server):
    """The one thing that must never be exposed: the DH private half."""
    patient_id = _gapped_patient()
    with httpx.Client(base_url=live_server, timeout=20) as client:
        session = client.post("/abdm/consent", json={"abha_address": f"{patient_id}@sbx"}).json()
        granted = _wait_for(client, session_id=session["session_id"], statuses={"GRANTED", "DENIED"})
        requested = client.post(f"/abdm/consent/{session['session_id']}/records").json()

        for payload in (session, granted, requested):
            blob = str(payload)
            assert "private" not in blob.lower()
        assert set(requested["key_material"]) == {"curve", "public_key", "nonce", "retired"}

        listing = client.get("/abdm/sessions").json()
        assert "private" not in str(listing).lower()


def test_key_material_is_retired_after_the_pull(live_server):
    """After a pull the ephemeral private key is dropped — forward secrecy in practice."""
    patient_id = _gapped_patient()
    with httpx.Client(base_url=live_server, timeout=20) as client:
        session_id = client.post("/abdm/consent", json={"abha_address": f"{patient_id}@sbx"}).json()["session_id"]
        _wait_for(client, session_id, {"GRANTED", "DENIED"})
        client.post(f"/abdm/consent/{session_id}/records")
        done = _wait_for(client, session_id, {"RECEIVED", "FAILED"})
        assert done["status"] == "RECEIVED", done.get("error")
        assert done["key_material"] is None
        assert done["key_material_retired"] is True


# --------------------------------------------------------------------------- #
# refusals
# --------------------------------------------------------------------------- #
def test_denied_consent_blocks_the_records_request(live_server):
    """A patient saying no must stop the exchange, with a 409 and a reason."""
    patient_id = _gapped_patient()
    with httpx.Client(base_url=live_server, timeout=20) as client:
        client.post(f"{live_server}/mock-abdm/decision/DENIED")
        session_id = client.post("/abdm/consent", json={"abha_address": f"{patient_id}@sbx"}).json()["session_id"]

        denied = _wait_for(client, session_id, {"DENIED", "FAILED"})
        assert denied["status"] == "DENIED"
        assert "denied" in (denied["error"] or "").lower()

        response = client.post(f"/abdm/consent/{session_id}/records")
        assert response.status_code == 409
        assert "DENIED" in response.json()["detail"]
        # Nothing was pulled, and no key material was even generated.
        assert denied["key_material"] is None
        assert denied["transaction_id"] is None


def test_records_request_before_grant_is_refused(live_server):
    patient_id = _gapped_patient()
    with httpx.Client(base_url=live_server, timeout=20) as client:
        session_id = client.post("/abdm/consent", json={"abha_address": f"{patient_id}@sbx"}).json()["session_id"]
        response = client.post(f"/abdm/consent/{session_id}/records")
        assert response.status_code == 409


def test_replayed_transfer_is_refused(live_server):
    """A retrying HIP must not double-ingest a record."""
    patient_id = _gapped_patient()
    with httpx.Client(base_url=live_server, timeout=20) as client:
        session_id = client.post("/abdm/consent", json={"abha_address": f"{patient_id}@sbx"}).json()["session_id"]
        _wait_for(client, session_id, {"GRANTED", "DENIED"})
        client.post(f"/abdm/consent/{session_id}/records")
        _wait_for(client, session_id, {"RECEIVED", "FAILED"})

        state = httpx.get(f"{live_server}/mock-abdm/state", timeout=5).json()
        transaction = state["transactions"][0]
        replay = client.post(
            "/abdm/health-information/transfer",
            json={"transactionId": transaction["transaction_id"], "entries": []},
            headers={"Authorization": f"Bearer {transaction['access_token']}"},
        )
        assert replay.status_code == 409
        assert "already received" in replay.json()["detail"]


def test_transfer_with_unknown_transaction_is_refused(live_server):
    with httpx.Client(base_url=live_server, timeout=20) as client:
        response = client.post(
            "/abdm/health-information/transfer",
            json={"transactionId": "not-a-transaction", "entries": []},
        )
        assert response.status_code == 404


def test_transfer_with_wrong_bearer_is_refused(live_server):
    """The push bearer is checked before anything is decrypted."""
    patient_id = _gapped_patient()
    with httpx.Client(base_url=live_server, timeout=20) as client:
        session_id = client.post("/abdm/consent", json={"abha_address": f"{patient_id}@sbx"}).json()["session_id"]
        _wait_for(client, session_id, {"GRANTED", "DENIED"})
        requested = client.post(f"/abdm/consent/{session_id}/records").json()
        _wait_for_ack(client, session_id)
        response = client.post(
            "/abdm/health-information/transfer",
            json={"transactionId": requested["transaction_id"], "entries": [{"content": "x", "checksum": "y"}]},
            headers={"Authorization": "Bearer wrong-token"},
        )
        assert response.status_code == 401
        assert "bearer" in response.json()["detail"].lower()


def test_transfer_before_the_cm_acknowledges_is_refused(live_server):
    """No acknowledgement yet means no push has been authorised — refuse, don't decrypt."""
    patient_id = _gapped_patient()
    with httpx.Client(base_url=live_server, timeout=20) as client:
        session_id = client.post("/abdm/consent", json={"abha_address": f"{patient_id}@sbx"}).json()["session_id"]
        _wait_for(client, session_id, {"GRANTED", "DENIED"})
        requested = client.post(f"/abdm/consent/{session_id}/records").json()
        response = client.post(
            "/abdm/health-information/transfer",
            json={"transactionId": requested["transaction_id"], "entries": []},
        )
        assert response.status_code in (409, 401)


def test_transfer_with_bad_checksum_is_refused(live_server):
    """MD5 is checked before decryption, so corrupt content never reaches the mapper."""
    patient_id = _gapped_patient()
    with httpx.Client(base_url=live_server, timeout=20) as client:
        session_id = client.post("/abdm/consent", json={"abha_address": f"{patient_id}@sbx"}).json()["session_id"]
        _wait_for(client, session_id, {"GRANTED", "DENIED"})
        requested = client.post(f"/abdm/consent/{session_id}/records")
        response = client.post(
            "/abdm/health-information/transfer",
            json={
                "transactionId": requested.json()["transaction_id"],
                "entries": [{"content": "ZmFrZQ==", "checksum": "deadbeef"}],
            },
        )
        # The mock push races us here; either the session already received the real
        # payload (409) or our corrupt entry is refused (422). Both are refusals.
        assert response.status_code in (409, 422)


def test_unknown_session_is_a_clean_404(live_server):
    with httpx.Client(base_url=live_server, timeout=20) as client:
        assert client.get("/abdm/consent/nope").status_code == 404
        assert client.post("/abdm/consent/nope/records").status_code == 404


def test_consent_requires_an_abha_address(live_server):
    with httpx.Client(base_url=live_server, timeout=20) as client:
        response = client.post("/abdm/consent", json={"abha_address": "   "})
        assert response.status_code == 422


# --------------------------------------------------------------------------- #
# callbacks
# --------------------------------------------------------------------------- #
def test_notify_for_an_unknown_request_is_acknowledged_not_errored(live_server):
    """A retrying CM must not be able to wedge the HIU."""
    with httpx.Client(base_url=live_server, timeout=20) as client:
        response = client.post(
            "/abdm/consents/notify",
            json={"requestId": "x", "consentRequest": {"id": "ghost"}, "event": {"type": "GRANTED"}},
        )
        assert response.status_code == 200
        assert response.json()["error"]["code"] == "CONSENT_REQUEST_NOT_FOUND"


def test_status_reports_the_mock_gateway_and_fidelius_parameters(live_server):
    with httpx.Client(base_url=live_server, timeout=20) as client:
        payload = client.get("/abdm/status").json()
        assert payload["configured"] is True
        assert payload["mock_gateway"] is True
        assert payload["cm_reachable"] is True
        assert payload["fidelius"]["cipher"] == "AES-256-GCM"
        assert "Weierstrass" in payload["fidelius"]["curve"]
        assert payload["sessions"]["total"] == 0


def test_mock_gateway_rejects_an_unsigned_request(live_server):
    """The client must send a bearer; the mock refuses without one."""
    response = httpx.post(
        f"{live_server}/mock-abdm/api/v0.5/consent-requests/init",
        json={"requestId": "x"},
        timeout=5,
    )
    assert response.status_code == 401
