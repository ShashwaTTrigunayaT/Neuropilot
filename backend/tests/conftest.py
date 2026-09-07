"""Test isolation: force the in-memory store.

The optional SQLite/Postgres layer activates whenever DATABASE_URL is set
(config.py auto-loads the project .env). Tests must never touch the persistent
demo database — they mutate subjects (advances, results, workups), and with the
DB enabled those mutations would be persisted and served to the real app on
next start. Setting DATABASE_URL to empty here (before app modules import)
disables db.enabled() for the whole test session.
"""
import os

os.environ["DATABASE_URL"] = ""
