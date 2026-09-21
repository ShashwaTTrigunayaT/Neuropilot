"""NeuroPilot backend package.

Importing this package is the earliest point every entrypoint passes through --
the API (``app.main``), the scripts that put ``backend/`` on ``sys.path``, and
the test suite -- so it is the right place for process-wide setup.
"""
from __future__ import annotations

import sys


def _force_utf8_console() -> None:
    """Make console output impossible to fail on.

    A log line must never be able to kill an operation, and on Windows it could.
    ``sys.stdout`` defaults to a legacy code page (cp1252), while every log
    string in this codebase uses an em-dash or an arrow. ``print()`` then raises
    ``UnicodeEncodeError`` -- and inside the database seeding path that exception
    was caught by the broad ``except Exception`` and reported as "Database
    unavailable", silently downgrading the app to the in-memory store and losing
    persistence. That was observed, not theorized.

    Reconciling the stream once, here, covers every existing print and every
    future one, whether output goes to a console, a pipe, or a redirected file.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError, OSError):
            # Test-capture objects and exotic streams need not support this;
            # their encoding is already controlled.
            pass


_force_utf8_console()
