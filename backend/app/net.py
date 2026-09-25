"""Shared outbound-HTTP facts.

One thing learned from a real deployment going red:

**Not every transport failure is an `httpx.HTTPError`.** A URL that cannot be
parsed at all raises `httpx.InvalidURL`, which inherits straight from
`Exception` -- so it slips past every `except httpx.HTTPError` and reaches the
caller as a raw 500. `/fhir/status` is where that surfaced: it is the one route
that probes the configured server, so it 500'd while `/patients`,
`/fhir/smart/status` and every other route stayed healthy on the same container.

`clean_base` guards the same failure one step earlier. A base URL copied into a
deployment's environment very often arrives with a trailing newline, and
`https://host/fhir\\n` is not a reachable server with a typo -- it is an *invalid
URL*. `rstrip("/")` never removed it; trimming does, and trimming is what the
operator meant.
"""
from __future__ import annotations

import httpx

# Use this everywhere the intent is "the call could not be made". `InvalidURL`
# is not an `HTTPError`, and catching only the latter is the bug described above.
TRANSPORT_FAILURES = (httpx.HTTPError, httpx.InvalidURL)


def clean_base(value: str | None) -> str:
    """A base URL with the whitespace and trailing slashes an env var picks up.

    Returns "" for None, so callers keep their existing "not configured" check.
    """
    return (value or "").strip().rstrip("/")
