#!/usr/bin/env python3
"""Refresh the Railway database through a temporary Railway SSH tunnel.

This is intentionally an operator command, not application startup logic. It is
used after a successful local ADNI/model retrain:

    python scripts/refresh_railway.py

The command never prints the tunnel URL or password. The seed is resumable, so a
Railway tunnel reset can be retried safely.
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
URL_RE = re.compile(r"URL:\s+(postgres(?:ql)?://\S+)")


def _open_tunnel(port: int) -> tuple[subprocess.Popen[str], str]:
    """Start Railway's tunnel and return its process plus private URL."""
    process = subprocess.Popen(
        ["railway", "connect", "Postgres", "--tunnel-only", "--port", str(port)],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    deadline = time.monotonic() + 60
    url = None
    assert process.stdout is not None
    while time.monotonic() < deadline:
        line = process.stdout.readline()
        if line:
            match = URL_RE.search(line.strip())
            if match:
                url = match.group(1)
                break
        elif process.poll() is not None:
            break
    if not url:
        process.terminate()
        raise RuntimeError(
            "Railway tunnel did not open. Confirm that `railway login` and "
            "`railway link` are complete, and that the Postgres service is named Postgres."
        )
    return process, url


def _stop_tunnel(process: subprocess.Popen[str]) -> None:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Refresh Railway from the local ADNI cohort through a temporary tunnel."
    )
    parser.add_argument("--port", type=int, default=15432, help="local tunnel port")
    parser.add_argument(
        "--chunk-size", type=int, default=10,
        help="patients per committed seed batch; lower values tolerate unstable tunnels",
    )
    parser.add_argument(
        "--retries", type=int, default=3,
        help="seed attempts; partial batches are resumed safely",
    )
    args = parser.parse_args()
    if args.chunk_size < 1 or args.retries < 1:
        parser.error("--chunk-size and --retries must be positive")

    tunnel = None
    try:
        for attempt in range(1, args.retries + 1):
            try:
                if tunnel is not None:
                    _stop_tunnel(tunnel)
                print(f"[refresh_railway] opening temporary Railway tunnel (attempt {attempt}/{args.retries})")
                tunnel, url = _open_tunnel(args.port)
                env = os.environ.copy()
                env["DATABASE_URL"] = url
                print("[refresh_railway] tunnel open; seeding resumable ADNI batches")
                result = subprocess.run(
                    [sys.executable, str(ROOT / "scripts" / "seed_db.py"),
                     "--chunk-size", str(args.chunk_size)],
                    cwd=ROOT,
                    env=env,
                    check=False,
                )
                if result.returncode == 0:
                    print("[refresh_railway] Railway refresh completed")
                    return 0
                if attempt < args.retries:
                    print("[refresh_railway] seed attempt failed; reopening tunnel and resuming")
            except (OSError, RuntimeError) as exc:
                print(f"[refresh_railway] {exc}")
                if attempt < args.retries:
                    print("[refresh_railway] retrying")
        print("[refresh_railway] refresh failed after all attempts")
        return 1
    finally:
        if tunnel is not None:
            _stop_tunnel(tunnel)
            print("[refresh_railway] tunnel closed")


if __name__ == "__main__":
    raise SystemExit(main())
