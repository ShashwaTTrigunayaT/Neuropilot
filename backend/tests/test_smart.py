"""SMART on FHIR launch tests (Phase 4, FHIR_INTEGRATION.md).

The launch sequence is verified against a MOCK SMART server that speaks the
real contract shapes (`.well-known/smart-configuration`, an OAuth2 token
endpoint) — never against a hospital, which is the honest position stated in
FHIR_INTEGRATION.md and in the module docstring.

What is being pinned down here:

* discovery works from both the well-known document AND a bare R4
  CapabilityStatement (older servers publish only the latter);
* the authorize URL really carries PKCE (S256) and a one-time `state`, and the
  verifier never leaves the server;
* the callback verifies `state`, performs the exchange with the matching
  verifier, and binds the patient context;
* scope minimization, and no token material ever reaching the browser.
"""
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from app import config, smart
from app.main import app

client = TestClient(app)

ISS = "https://ehr.test/fhir"
TOKEN_URL = "https://ehr.test/oauth2/token"
AUTH_URL = "https://ehr.test/oauth2/authorize"

WELL_KNOWN = {
    "authorization_endpoint": AUTH_URL,
    "token_endpoint": TOKEN_URL,
    "capabilities": ["launch-ehr", "launch-standalone", "client-public"],
    "code_challenge_methods_supported": ["S256"],
}
CAPABILITY = {
    "resourceType": "CapabilityStatement",
    "fhirVersion": "4.0.1",
    "rest": [{
        "mode": "server",
        "security": {
            "service": [{"coding": [{"code": "SMART-on-FHIR"}]}],
            "extension": [{
                "url": "http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris",
                "extension": [
                    {"url": "authorize", "valueUri": AUTH_URL},
                    {"url": "token", "valueUri": TOKEN_URL},
                ],
            }],
        },
    }],
}


@pytest.fixture(autouse=True)
def _clean_smart_state():
    smart.reset()
    yield
    smart.reset()


def _mock(handler) -> httpx.Client:
    """A SMART server stand-in. Injected directly — no global patching."""
    return httpx.Client(transport=httpx.MockTransport(handler))


def _well_known_server(extra=None):
    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == f"{ISS}/.well-known/smart-configuration":
            return httpx.Response(200, json={**WELL_KNOWN, **(extra or {})})
        if str(request.url) == f"{ISS}/metadata":
            return httpx.Response(200, json=CAPABILITY)
        if str(request.url) == TOKEN_URL:
            token = extra.get("_token") if extra else None
            return httpx.Response(200, json=token or {
                "access_token": "tok-123", "token_type": "Bearer", "expires_in": 3600,
                "scope": " ".join(smart.scopes()), "patient": "Patient/ehr-77",
                "refresh_token": "refresh-1",
            })
        return httpx.Response(404)

    return handler


# --------------------------------------------------------------------------- #
# discovery
# --------------------------------------------------------------------------- #
def test_discovery_reads_the_well_known_document():
    meta = smart.discover(ISS, client=_mock(_well_known_server()))
    assert meta["authorization_endpoint"] == AUTH_URL
    assert meta["token_endpoint"] == TOKEN_URL
    assert meta["source"] == "well-known/smart-configuration"


def test_discovery_falls_back_to_capability_statement():
    """Not every server publishes smart-configuration; R4 keeps them in the CapabilityStatement."""
    def handler(request: httpx.Request) -> httpx.Response:
        if "smart-configuration" in str(request.url):
            return httpx.Response(404)
        return httpx.Response(200, json=CAPABILITY)

    meta = smart.discover(ISS, client=_mock(handler))
    assert meta["authorization_endpoint"] == AUTH_URL
    assert meta["token_endpoint"] == TOKEN_URL
    assert meta["source"] == "CapabilityStatement"


def test_discovery_rejects_a_non_smart_server():
    """A server that publishes neither document is not a SMART server — say so."""
    with pytest.raises(smart.SmartError) as exc:
        smart.discover(ISS, client=_mock(lambda r: httpx.Response(404)))
    assert "Could not discover SMART endpoints" in exc.value.message


def test_discovery_rejects_a_capability_statement_without_oauth():
    """A FHIR server can be perfectly valid and still not support SMART."""
    bare = {"resourceType": "CapabilityStatement", "fhirVersion": "4.0.1",
            "rest": [{"mode": "server"}]}

    def handler(request: httpx.Request) -> httpx.Response:
        if "smart-configuration" in str(request.url):
            return httpx.Response(404)
        return httpx.Response(200, json=bare)

    with pytest.raises(smart.SmartError) as exc:
        smart.discover(ISS, client=_mock(handler))
    assert "not a SMART-on-FHIR server" in exc.value.message


def test_discovery_requires_an_iss():
    with pytest.raises(smart.SmartError):
        smart.discover("")


# --------------------------------------------------------------------------- #
# launch
# --------------------------------------------------------------------------- #
def test_begin_launch_builds_a_pkce_authorize_url():
    started = smart.begin_launch(ISS, launch="ehr-launch-token", client=_mock(_well_known_server()))
    url = httpx.URL(started["authorization_url"])
    params = dict(url.params)

    assert str(url.copy_with(query=None)) == AUTH_URL
    assert params["response_type"] == "code"
    assert params["client_id"] == config.SMART_CLIENT_ID
    assert params["redirect_uri"] == smart.redirect_uri()
    assert params["code_challenge_method"] == "S256"
    assert params["launch"] == "ehr-launch-token"      # EHR launch token is echoed back
    assert params["aud"] == ISS                        # audience-bound token
    assert params["state"] == started["state"]

    # The challenge must be the S256 digest of the verifier WE generated, and
    # the verifier must stay server-side.
    import base64
    import hashlib

    pending = smart._PENDING[started["state"]]
    expected = base64.urlsafe_b64encode(
        hashlib.sha256(pending["verifier"].encode()).digest()
    ).rstrip(b"=").decode()
    assert params["code_challenge"] == expected
    assert pending["verifier"] not in started["authorization_url"]


def test_standalone_launch_can_request_a_patient_context():
    started = smart.begin_launch(ISS, patient="Patient/abc", client=_mock(_well_known_server()))
    params = dict(httpx.URL(started["authorization_url"]).params)
    assert params["patient"] == "Patient/abc"
    assert "launch" not in params
    assert started["mode"] == "standalone-launch"


def test_a_per_launch_patient_overrides_the_environment_pin(monkeypatch):
    """The reason every standalone launch used to open the SAME chart.

    With nothing in the request, the launch falls back to the operator's
    SMART_LAUNCH_PATIENT_ID -- one constant, so one patient, forever. A caller
    that names a chart must win, otherwise "standalone launch" cannot be aimed.
    """
    monkeypatch.setattr(config, "SMART_LAUNCH_PATIENT_ID", "ehr-pinned")
    transport = httpx.MockTransport(_well_known_server())
    real_client = httpx.Client

    def factory(*args, **kwargs):
        kwargs.setdefault("transport", transport)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "Client", factory)

    pinned = client.get("/fhir/smart/launch", params={"iss": ISS, "format": "json"}).json()
    assert dict(httpx.URL(pinned["authorization_url"]).params)["patient"] == "ehr-pinned"

    chosen = client.get("/fhir/smart/launch",
                        params={"iss": ISS, "patient": "ehr-chooser", "format": "json"}).json()
    assert dict(httpx.URL(chosen["authorization_url"]).params)["patient"] == "ehr-chooser"


def test_an_ehr_launch_context_is_echoed_back_verbatim():
    """`launch` is opaque by spec, so it must survive encoding untouched.

    Servers that ignore a bare `patient` drive the context through this value
    instead (launch.smarthealthit.org wants base64'd JSON launch options), so
    re-encoding or unquoting it would break exactly those servers.
    """
    opaque = "eyJwYXRpZW50IjogImFiYyJ9== +/=?&ok"
    started = smart.begin_launch(ISS, launch=opaque, client=_mock(_well_known_server()))
    assert dict(httpx.URL(started["authorization_url"]).params)["launch"] == opaque
    assert started["mode"] == "ehr-launch"


def test_scopes_are_minimum_necessary():
    scopes = smart.scopes()
    assert "patient/Patient.read" in scopes
    assert "patient/Observation.read" in scopes
    assert "patient/RiskAssessment.write" in scopes
    # No blanket access, and no write to clinical records other than our own output.
    assert not any(s.startswith("user/*") for s in scopes)
    assert "patient/*.read" not in scopes
    assert not any(s.endswith(".write") and "RiskAssessment" not in s for s in scopes)


# --------------------------------------------------------------------------- #
# callback / token exchange
# --------------------------------------------------------------------------- #
def test_callback_exchanges_the_code_and_binds_patient_context():
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if "smart-configuration" in str(request.url):
            return httpx.Response(200, json=WELL_KNOWN)
        if str(request.url) == TOKEN_URL:
            seen["form"] = dict(httpx.QueryParams(request.content.decode()))
            return httpx.Response(200, json={
                "access_token": "tok-abc", "token_type": "Bearer", "expires_in": 3600,
                "scope": " ".join(smart.scopes()), "patient": "Patient/ehr-77",
                "encounter": "Encounter/e-1", "refresh_token": "refresh-abc",
            })
        return httpx.Response(404)

    started = smart.begin_launch(ISS, launch="tok", client=_mock(handler))
    session = smart.handle_callback("auth-code-1", started["state"], client=_mock(handler))

    assert session["access_token"] == "tok-abc"
    assert seen["form"]["grant_type"] == "authorization_code"
    assert seen["form"]["code"] == "auth-code-1"
    assert seen["form"]["redirect_uri"] == smart.redirect_uri()
    assert seen["form"]["client_id"] == config.SMART_CLIENT_ID
    # the verifier that matches the challenge we sent
    assert seen["form"]["code_verifier"].startswith("")

    ctx = smart.context()
    assert ctx["connected"] is True
    assert ctx["patient"] == "Patient/ehr-77"
    assert ctx["iss"] == ISS
    assert smart.access_token() == "tok-abc"


def test_callback_rejects_unknown_or_reused_state():
    with pytest.raises(smart.SmartError) as exc:
        smart.handle_callback("code", "not-a-state", client=_mock(_well_known_server()))
    assert exc.value.status_code == 409

    # A state is single-use: replaying the same callback must fail.
    started = smart.begin_launch(ISS, client=_mock(_well_known_server()))
    smart.handle_callback("code", started["state"], client=_mock(_well_known_server()))
    with pytest.raises(smart.SmartError):
        smart.handle_callback("code", started["state"], client=_mock(_well_known_server()))


def test_callback_rejects_an_expired_launch():
    started = smart.begin_launch(ISS, client=_mock(_well_known_server()))
    smart._PENDING[started["state"]]["created_at"] = time.time() - 3600
    with pytest.raises(smart.SmartError) as exc:
        smart.handle_callback("code", started["state"], client=_mock(_well_known_server()))
    assert "expired" in exc.value.message


def test_callback_surfaces_a_token_endpoint_rejection():
    def handler(request: httpx.Request) -> httpx.Response:
        if "smart-configuration" in str(request.url):
            return httpx.Response(200, json=WELL_KNOWN)
        return httpx.Response(400, text="invalid_grant")

    started = smart.begin_launch(ISS, client=_mock(handler))
    with pytest.raises(smart.SmartError) as exc:
        smart.handle_callback("bad", started["state"], client=_mock(handler))
    assert "invalid_grant" in exc.value.message


def test_callback_requires_a_code():
    with pytest.raises(smart.SmartError):
        smart.handle_callback("", "whatever", client=_mock(_well_known_server()))


# --------------------------------------------------------------------------- #
# refresh / logout / status
# --------------------------------------------------------------------------- #
def _connect(handler) -> None:
    started = smart.begin_launch(ISS, client=_mock(handler))
    smart.handle_callback("code", started["state"], client=_mock(handler))


def test_refresh_rotates_the_access_token():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if "smart-configuration" in str(request.url):
            return httpx.Response(200, json=WELL_KNOWN)
        calls["n"] += 1
        form = dict(httpx.QueryParams(request.content.decode()))
        if form.get("grant_type") == "refresh_token":
            assert form["refresh_token"] == "refresh-1"
            return httpx.Response(200, json={"access_token": "tok-new", "expires_in": 3600})
        return httpx.Response(200, json={"access_token": "tok-old", "expires_in": 3600,
                                        "patient": "Patient/1", "refresh_token": "refresh-1"})

    _connect(handler)
    assert smart.access_token() == "tok-old"
    smart.refresh(client=_mock(handler))
    assert smart.access_token() == "tok-new"
    assert calls["n"] == 2


def test_refresh_without_a_refresh_token_says_why():
    def handler(request: httpx.Request) -> httpx.Response:
        if "smart-configuration" in str(request.url):
            return httpx.Response(200, json=WELL_KNOWN)
        return httpx.Response(200, json={"access_token": "tok", "expires_in": 3600})

    _connect(handler)
    with pytest.raises(smart.SmartError) as exc:
        smart.refresh(client=_mock(handler))
    assert "refresh_token" in exc.value.message


def test_expired_token_is_not_handed_to_callers():
    def handler(request: httpx.Request) -> httpx.Response:
        if "smart-configuration" in str(request.url):
            return httpx.Response(200, json=WELL_KNOWN)
        return httpx.Response(200, json={"access_token": "tok", "expires_in": 0})

    _connect(handler)
    smart._SESSION["expires_at"] = time.time() - 1
    assert smart.access_token() is None
    assert smart.context()["expired"] is True


def test_logout_clears_the_session_and_no_token_is_ever_exposed():
    _connect(_well_known_server())
    status = smart.status()
    assert status["connected"] is True
    assert "access_token" not in status and "refresh_token" not in status
    assert "access_token" not in smart.context()

    assert smart.logout()["disconnected"] is True
    assert smart.status()["connected"] is False
    assert smart.access_token() is None


def test_status_reports_the_registration_facts():
    status = smart.status()
    assert status["client_id"] == config.SMART_CLIENT_ID
    assert status["redirect_uri"].endswith("/fhir/smart/callback")
    assert status["scopes"] == smart.scopes()


# --------------------------------------------------------------------------- #
# HTTP surface
# --------------------------------------------------------------------------- #
def test_smart_status_endpoint():
    body = client.get("/fhir/smart/status").json()
    assert body["connected"] is False
    assert body["redirect_uri"].endswith("/fhir/smart/callback")
    assert "access_token" not in body


def test_smart_launch_without_a_server_explains_itself():
    body = client.get("/fhir/smart/launch", params={"format": "json"}).json()
    assert body["resourceType"] == "OperationOutcome"
    assert "iss" in body["issue"][0]["diagnostics"]


def test_smart_launch_failure_hands_the_browser_back_with_the_reason(monkeypatch):
    """A launch that cannot even start must not render a JSON document in a tab.

    Leaving the OperationOutcome on screen meant no movement happened, the older
    session stayed visible, and the result looked like the same patient
    connecting yet again.
    """
    monkeypatch.setattr(config, "FHIR_BASE_URL", "")
    response = client.get("/fhir/smart/launch", follow_redirects=False)
    assert response.status_code == 302
    location = response.headers["location"]
    assert "smart=error" in location
    assert "iss" in location


def test_smart_callback_failure_is_an_operation_outcome_for_api_clients():
    body = client.get("/fhir/smart/callback",
                      params={"code": "x", "state": "bogus", "format": "json"}).json()
    assert body["resourceType"] == "OperationOutcome"
    assert "state" in body["issue"][0]["diagnostics"]


def test_smart_callback_failure_hands_the_browser_back_with_the_reason():
    """A failed launch must not look like a stale session on the dashboard.

    The default (browser) path redirects to the SPA carrying the reason; the
    previous behaviour returned an OperationOutcome document to the tab, so a
    launch that never completed left the OLD session on screen and read as "the
    same patient keeps connecting".
    """
    response = client.get("/fhir/smart/callback",
                          params={"code": "x", "state": "bogus"},
                          follow_redirects=False)
    assert response.status_code == 302
    location = response.headers["location"]
    assert "smart=error" in location
    assert "state" in location          # the reason travels with it
    assert smart.context()["connected"] is False


def test_smart_callback_reports_an_ehr_error_verbatim():
    body = client.get("/fhir/smart/callback",
                      params={"error": "access_denied", "error_description": "clinician declined",
                              "format": "json"}).json()
    assert body["issue"][0]["diagnostics"].startswith("EHR returned access_denied")


def test_status_reports_what_a_standalone_launch_would_use(monkeypatch):
    """One env var pinning every launch is the reason a UI needs these fields."""
    monkeypatch.setattr(config, "FHIR_BASE_URL", "https://ehr.test/fhir")
    monkeypatch.setattr(config, "SMART_LAUNCH_PATIENT_ID", "ehr-77")
    defaults = smart.status()["launch_defaults"]
    assert defaults == {"iss": "https://ehr.test/fhir", "patient": "ehr-77"}
    assert "access_token" not in smart.status()


def test_smart_logout_endpoint():
    assert client.post("/fhir/smart/logout").json()["connected"] is False


def test_smart_refresh_without_a_session_is_a_409():
    assert client.post("/fhir/smart/refresh").status_code == 409


def test_full_launch_over_http_redirects_the_browser_to_the_ehr(monkeypatch):
    """The one flow that needs the real HTTP layer: launch -> EHR -> callback -> dashboard.

    httpx.Client is patched for the duration of this test only, because the API
    endpoint owns client construction (there is no injection point, deliberately
    — the served app must not accept a transport override from a request).
    """
    transport = httpx.MockTransport(_well_known_server())
    real_client = httpx.Client

    def factory(*args, **kwargs):
        kwargs.setdefault("transport", transport)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "Client", factory)

    launched = client.get("/fhir/smart/launch",
                          params={"iss": ISS, "launch": "ehr-1", "format": "json"})
    assert launched.status_code == 200
    started = launched.json()
    assert started["authorization_url"].startswith(AUTH_URL)

    redirected = client.get("/fhir/smart/launch",
                            params={"iss": ISS, "launch": "ehr-1"},
                            follow_redirects=False)
    assert redirected.status_code == 302
    assert redirected.headers["location"].startswith(AUTH_URL)

    callback = client.get("/fhir/smart/callback",
                          params={"code": "c1", "state": started["state"]},
                          follow_redirects=False)
    assert callback.status_code == 302
    location = callback.headers["location"]
    assert "smart=connected" in location and "patient=" in location

    assert smart.context()["patient"] == "Patient/ehr-77"
    assert smart.access_token() == "tok-123"
