"""SMART on FHIR launch — OAuth 2.0 authorization-code + PKCE (Phase 4).

What this implements, and what it does not:

**Implemented** — the complete launch sequence an EHR performs when a clinician
opens NeuroPilot from inside it:

1. Discovery: `GET {iss}/.well-known/smart-configuration`, falling back to the
   server's own `CapabilityStatement` (R4 keeps OAuth endpoints in
   `rest.security.extension`), because not every server publishes the
   well-known document.
2. `authorization_code` + **PKCE** (S256) launch with `state` (CSRF) and the
   `launch` token echoed back, requesting a minimum-necessary scope set.
3. Token exchange, including **patient-scoped context** (`patient` claim) — the
   thing that makes "the chart you have open" addressable at all.
4. Token refresh, status, context and logout, held **server-side**.

**Not implemented** — and these are the real limitations:

* Tokens live in process memory, so a restart or a second replica loses the
  session, and nothing is encrypted at rest. A production deployment needs
  server-side encrypted storage keyed to the user session (see L5 in
  FHIR_INTEGRATION.md).
* No EHR registration is included: `SMART_CLIENT_ID` must be issued by the
  EHR sandbox (Epic App Orchard / Cerner code console) before a real server
  will accept the launch. An unregistered client id is rejected by the EHR, not
  by this code.
* Everything is verified against a mock SMART server in
  `backend/tests/test_smart.py` — the contracts are spec-shaped, but no real
  hospital network has been exercised.
"""
from __future__ import annotations

import base64
import hashlib
import secrets
import time
from typing import Any, Optional

import httpx

from . import config


class SmartError(Exception):
    """Launch/exchange failure. `status_code` maps to the HTTP response."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


# --------------------------------------------------------------------------- #
# state: one pending launch per `state`, one connected session at a time.
#
# Deliberately process-local and small (bounded dicts). This is the piece that
# a multi-user clinical deployment must replace with real session storage --
# see the module docstring and limitation L5.
# --------------------------------------------------------------------------- #
_STATE_TTL_SECONDS = 600
_MAX_PENDING = 32
_PENDING: dict[str, dict] = {}
_SESSION: Optional[dict] = None


def reset() -> None:
    """Forget all pending launches and the connected session (tests, logout)."""
    global _SESSION
    _PENDING.clear()
    _SESSION = None


def scopes() -> list[str]:
    return [s for s in config.SMART_SCOPES.split() if s]


def redirect_uri() -> str:
    """Registered redirect URI — configuration, never computed per-request.

    The EHR checks this byte-for-byte against the value registered when the app
    was created, so deriving it from the inbound request (scheme, host) would
    break the moment the app is reached through a different proxy or port.
    """
    if config.SMART_REDIRECT_URI:
        return config.SMART_REDIRECT_URI
    return "http://localhost:8000/fhir/smart/callback"


def frontend_redirect_uri() -> str:
    """Where the browser lands after the backend has exchanged the code."""
    base = config.FRONTEND_BASE_URL or "http://localhost:5173"
    return f"{base}/?smart=connected"


# --------------------------------------------------------------------------- #
# PKCE + discovery
# --------------------------------------------------------------------------- #
def _pkce_pair() -> tuple[str, str]:
    """(verifier, S256 challenge). The verifier never leaves this process."""
    verifier = secrets.token_urlsafe(64)[:96]
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


def _client(client: httpx.Client | None) -> httpx.Client:
    return client or httpx.Client(timeout=config.FHIR_TIMEOUT_SECONDS)


# SMART 1.x names the OAuth endpoints `authorize`/`token`; SMART 2.0's
# well-known document names the same things `authorization_endpoint`/
# `token_endpoint`. Normalising here means discovery has ONE shape downstream.
_OAUTH_KEY_ALIASES = {
    "authorize": "authorization_endpoint",
    "token": "token_endpoint",
    "register": "registration_endpoint",
    "manage": "management_endpoint",
    "introspect": "introspection_endpoint",
    "revoke": "revocation_endpoint",
}


def _oauth_servers_from_capability(cap: dict) -> dict[str, str]:
    """Pull OAuth endpoints out of an R4 CapabilityStatement (SMART 1.x style)."""
    endpoints: dict[str, str] = {}
    for rest in cap.get("rest") or []:
        for ext in ((rest.get("security") or {}).get("extension") or []):
            if not isinstance(ext, dict) or not str(ext.get("url", "")).endswith("oauth-uris"):
                continue
            for inner in ext.get("extension") or []:
                if isinstance(inner, dict) and inner.get("url") and inner.get("valueUri"):
                    key = str(inner["url"])
                    endpoints[_OAUTH_KEY_ALIASES.get(key, key)] = str(inner["valueUri"])
    return endpoints


def discover(iss: str, client: httpx.Client | None = None) -> dict:
    """Resolve a FHIR base URL to its SMART OAuth endpoints.

    Tries `.well-known/smart-configuration` first (SMART 2.0), then the
    CapabilityStatement (what older servers publish). Both are normal; that is
    why discovery falls back rather than failing.
    """
    if not iss:
        raise SmartError("An iss (FHIR server base URL) is required to launch.", status_code=422)
    base = iss.rstrip("/")
    endpoints: dict[str, str] = {}
    source = None
    with _client(client) as http:
        try:
            resp = http.get(f"{base}/.well-known/smart-configuration",
                            headers={"Accept": "application/json"})
            if resp.status_code < 400:
                body = resp.json()
                endpoints = {
                    "authorization_endpoint": body.get("authorization_endpoint", ""),
                    "token_endpoint": body.get("token_endpoint", ""),
                }
                source = "well-known/smart-configuration"
                for key in ("capabilities", "scopes_supported", "code_challenge_methods_supported"):
                    if body.get(key):
                        endpoints.setdefault(f"_{key}", body[key])
        except (httpx.HTTPError, ValueError):
            endpoints = {}

        if not endpoints.get("authorization_endpoint") or not endpoints.get("token_endpoint"):
            try:
                resp = http.get(f"{base}/metadata", headers={"Accept": "application/fhir+json"})
                resp.raise_for_status()
                from_cap = _oauth_servers_from_capability(resp.json())
            except (httpx.HTTPError, ValueError) as exc:
                raise SmartError(
                    f"Could not discover SMART endpoints at {base} "
                    f"(no smart-configuration and no usable CapabilityStatement): {exc}",
                    status_code=502,
                ) from exc
            endpoints.update({k: v for k, v in from_cap.items() if v})
            source = "CapabilityStatement"

    if not endpoints.get("authorization_endpoint") or not endpoints.get("token_endpoint"):
        raise SmartError(
            f"{base} advertises no OAuth2 endpoints — it is not a SMART-on-FHIR server.",
            status_code=502,
        )
    endpoints["source"] = source or "unknown"
    endpoints["iss"] = base
    return endpoints


# --------------------------------------------------------------------------- #
# launch + callback
# --------------------------------------------------------------------------- #
def begin_launch(iss: str, launch: Optional[str] = None, patient: Optional[str] = None,
                 client: httpx.Client | None = None) -> dict:
    """Start a launch: returns the EHR authorization URL to send the browser to.

    `launch` is set for an EHR launch (the token the EHR supplied); `patient` for
    a standalone launch where the app asks for a specific context.
    """
    meta = discover(iss, client=client)
    verifier, challenge = _pkce_pair()
    state = secrets.token_urlsafe(24)

    if len(_PENDING) >= _MAX_PENDING:  # bounded: drop the oldest pending launch
        oldest = min(_PENDING, key=lambda k: _PENDING[k]["created_at"])
        _PENDING.pop(oldest, None)
    _PENDING[state] = {
        "iss": meta["iss"],
        "token_endpoint": meta["token_endpoint"],
        "verifier": verifier,
        "created_at": time.time(),
    }

    params: dict[str, Any] = {
        "response_type": "code",
        "client_id": config.SMART_CLIENT_ID,
        "redirect_uri": redirect_uri(),
        "scope": " ".join(scopes()),
        "state": state,
        "aud": meta["iss"],
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    if launch:
        params["launch"] = launch
    if patient:
        params["patient"] = patient

    query = "&".join(f"{k}={httpx.QueryParams({k: v})[k]}" for k, v in params.items())
    return {
        "authorization_url": f"{meta['authorization_endpoint']}?{query}",
        "state": state,
        "scopes": scopes(),
        "redirect_uri": redirect_uri(),
        "iss": meta["iss"],
        "discovery_source": meta["source"],
        "mode": "ehr-launch" if launch else "standalone-launch",
    }


def handle_callback(code: str, state: str, client: httpx.Client | None = None) -> dict:
    """Exchange the authorization code for a server-side token session.

    The `state` is single-use and short-lived: it is both the CSRF check and the
    only thing tying this callback to the PKCE verifier that started the launch.
    """
    if not code:
        raise SmartError("Missing `code` on the SMART callback.")
    pending = _PENDING.pop(state, None)
    if pending is None:
        raise SmartError(
            "Unknown or already-used `state` — the launch was not started by this "
            "server, or it expired. Restart the launch from /fhir/smart/launch.",
            status_code=409,
        )
    if time.time() - pending["created_at"] > _STATE_TTL_SECONDS:
        raise SmartError("SMART launch expired before the callback arrived.", status_code=409)

    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri(),
        "client_id": config.SMART_CLIENT_ID,
        "code_verifier": pending["verifier"],
    }
    auth: tuple[str, str] | None = None
    if config.SMART_CLIENT_SECRET:
        auth = (config.SMART_CLIENT_ID, config.SMART_CLIENT_SECRET)

    with _client(client) as http:
        try:
            resp = http.post(
                pending["token_endpoint"],
                data=data,
                auth=auth,
                headers={"Accept": "application/json"},
            )
        except httpx.HTTPError as exc:
            raise SmartError(f"Token endpoint unreachable: {exc}", status_code=502) from exc

    if resp.status_code >= 400:
        raise SmartError(
            f"Token exchange rejected (HTTP {resp.status_code}): {resp.text[:300]}",
            status_code=502,
        )
    try:
        body = resp.json()
    except ValueError as exc:
        raise SmartError("Token endpoint did not return JSON.") from exc

    token = body.get("access_token")
    if not token:
        raise SmartError("Token response carried no access_token.")

    global _SESSION
    expires_in = body.get("expires_in")
    try:
        expires_at = time.time() + float(expires_in) if expires_in is not None else None
    except (TypeError, ValueError):
        expires_at = None

    _SESSION = {
        "iss": pending["iss"],
        "token_endpoint": pending["token_endpoint"],
        "access_token": token,
        "refresh_token": body.get("refresh_token"),
        "token_type": body.get("token_type", "Bearer"),
        "scope": body.get("scope") or " ".join(scopes()),
        "patient": body.get("patient"),
        "encounter": body.get("encounter"),
        "fhir_user": body.get("fhirUser"),
        "id_token": body.get("id_token"),
        "expires_at": expires_at,
        "connected_at": time.time(),
    }
    return _SESSION


def refresh(client: httpx.Client | None = None) -> dict:
    """Renew the connected session. Requires a refresh_token from the EHR."""
    if _SESSION is None:
        raise SmartError("No SMART session to refresh — launch from the EHR first.", status_code=409)
    refresh_token = _SESSION.get("refresh_token")
    if not refresh_token:
        raise SmartError(
            "The EHR issued no refresh_token, so the session cannot be renewed; "
            "the clinician must relaunch from the chart.",
            status_code=409,
        )
    data = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": config.SMART_CLIENT_ID,
    }
    auth = (config.SMART_CLIENT_ID, config.SMART_CLIENT_SECRET) if config.SMART_CLIENT_SECRET else None
    with _client(client) as http:
        try:
            resp = http.post(_SESSION["token_endpoint"], data=data, auth=auth,
                             headers={"Accept": "application/json"})
        except httpx.HTTPError as exc:
            raise SmartError(f"Token endpoint unreachable: {exc}", status_code=502) from exc
    if resp.status_code >= 400:
        raise SmartError(f"Token refresh rejected (HTTP {resp.status_code}): {resp.text[:300]}",
                         status_code=502)
    body = resp.json()
    if body.get("access_token"):
        _SESSION["access_token"] = body["access_token"]
    if body.get("refresh_token"):
        _SESSION["refresh_token"] = body["refresh_token"]
    if body.get("expires_in") is not None:
        try:
            _SESSION["expires_at"] = time.time() + float(body["expires_in"])
        except (TypeError, ValueError):
            pass
    _SESSION["refreshed_at"] = time.time()
    return _SESSION


def logout() -> dict:
    """Drop the server-side session. Tokens are never handed to the browser."""
    had = _SESSION is not None
    reset()
    return {"connected": False, "disconnected": had}


def access_token() -> Optional[str]:
    """The bearer token for outbound FHIR calls, or None when absent/expired."""
    if _SESSION is None:
        return None
    expires_at = _SESSION.get("expires_at")
    if expires_at is not None and time.time() >= float(expires_at):
        return None  # expired: callers fall back to the static token or no auth
    return _SESSION.get("access_token")


def context() -> dict:
    """The patient-in-context facts the dashboard needs, with no token material."""
    if _SESSION is None:
        return {
            "connected": False,
            "needed": (
                "Launch NeuroPilot from the EHR (or POST /fhir/smart/launch?iss=…) "
                "to bind a SMART session."
            ),
        }
    expires_at = _SESSION.get("expires_at")
    now = time.time()
    return {
        "connected": True,
        "iss": _SESSION["iss"],
        "patient": _SESSION.get("patient"),
        "encounter": _SESSION.get("encounter"),
        "scope": _SESSION.get("scope"),
        # `expires_at` is server-local wall clock with no offset, so a browser
        # cannot parse it reliably (the container is UTC, the clinician is not).
        # `expires_in` is the authoritative duration taken from the same epoch,
        # which is what a countdown should be built from.
        "expires_at": (time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(expires_at))
                       if expires_at else None),
        "expires_in": (max(0, int(float(expires_at) - now)) if expires_at else None),
        "expired": bool(expires_at and now >= float(expires_at)),
    }


def status() -> dict:
    """Connection report for the dashboard/status endpoint. Never raises."""
    return {
        "configured": True,
        "client_id": config.SMART_CLIENT_ID,
        "has_client_secret": bool(config.SMART_CLIENT_SECRET),
        "redirect_uri": redirect_uri(),
        "frontend_redirect_uri": frontend_redirect_uri(),
        "scopes": scopes(),
        "pending_launches": len(_PENDING),
        **context(),
    }
