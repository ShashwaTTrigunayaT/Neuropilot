#!/usr/bin/env python3
"""HAPI FHIR validation gate (Phase 1 acceptance, FHIR_INTEGRATION.md section 3).

Exports NeuroPilot's FHIR resources and validates them against a real FHIR
server's $validate operation, then POSTs a full Patient/$everything bundle to
prove the round-trip. This is the free conformance checker the doc relies on.

Prereqs:
  1. Start Docker Desktop, then:  docker run -d --name neuropilot-hapi -p 8090:8080 hapiproject/hapi:latest
  2. Start the API (any port), e.g.:  cd backend && python -m uvicorn app.main:app --port 8000

Usage:
  python scripts/validate_fhir.py [--api http://127.0.0.1:8000] [--hapi http://localhost:8090/fhir]

Exit code 0 only if every resource passes server-side validation.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

FHIR_JSON = {"Content-Type": "application/fhir+json", "Accept": "application/fhir+json"}


def _get(url: str) -> dict:
    req = urllib.request.Request(url, headers=FHIR_JSON)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def _post(url: str, payload: dict) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers=FHIR_JSON, method="POST"
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


def _wait_for_hapi(base: str, timeout_s: int = 120) -> None:
    print(f"[hapi] waiting for {base} (first boot loads ~1-2 min) ...")
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            _get(f"{base}/metadata")
            print("[hapi] server ready")
            return
        except Exception:  # noqa: BLE001
            time.sleep(3)
    raise SystemExit(f"[hapi] not reachable after {timeout_s}s -- is the container running?")


def _flatten(bundle: dict) -> list[dict]:
    return [e["resource"] for e in bundle.get("entry", []) if "resource" in e]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:8000")
    ap.add_argument("--hapi", default="http://localhost:8090/fhir")
    ap.add_argument("--patients", type=int, default=5, help="how many cohort patients to validate")
    args = ap.parse_args()

    # ---- 1. CapabilityStatement check (spec-level handshake)
    meta = _get(f"{args.hapi}/metadata")
    print(f"[hapi] server: {meta.get('software', {}).get('name', '?')} FHIR {meta.get('fhirVersion')}")
    cap = _get(f"{args.api}/fhir/metadata")
    print(f"[np]   NeuroPilot CapabilityStatement: FHIR {cap['fhirVersion']}, "
          f"{[r['type'] for r in cap['rest'][0]['resource']]}")

    ids = [i["id"] for i in _get(f"{args.api}/patients?limit={args.patients}")["items"]]
    if not ids:
        raise SystemExit("[np] cohort is empty")

    failures: list[str] = []
    checked = 0
    condition_seen = False

    for pid in ids:
        bundle = _get(f"{args.api}/fhir/Patient/{pid}/$everything")
        resources = _flatten(bundle)
        condition_seen |= any(r["resourceType"] == "Condition" for r in resources)

        for res in resources:
            rtype = res["resourceType"]
            # $validate against the live HAPI server (server-side schema + profile check)
            outcome = _post(f"{args.hapi}/{rtype}/$validate", res)
            issues = [
                i for i in outcome.get("issue", [])
                if i.get("severity") in ("error", "fatal")
            ]
            checked += 1
            if issues:
                for i in issues:
                    failures.append(
                        f"{rtype}/{res.get('id', '?')} [{pid}] {i.get('severity')}: "
                        f"{i.get('diagnostics', '?')[:160]}"
                    )

        # ---- 2. Round-trip: store the whole bundle on the server
        bundle["type"] = "transaction"  # collection -> transaction (entries carry request urls)
        for e in bundle.get("entry", []):
            r = e["resource"]
            e["request"] = {"method": "PUT", "url": f"{r['resourceType']}/{r['id']}"}
        _post(args.hapi, bundle)
        print(f"[np]   {pid}: {len(resources)} resources validated + stored")

    print()
    if condition_seen:
        failures.append("CONTRACT VIOLATION: a Condition resource was emitted from model output")
    print(f"[gate] {checked} resources validated, {len(failures)} failures")
    for f in failures[:20]:
        print("  -", f)
    if failures:
        print("[gate] FAIL")
        return 1
    print("[gate] PASS -- NeuroPilot FHIR export validates against HAPI FHIR R4")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
