"""The DB seed must satisfy FK constraints on FK-enforcing backends (Postgres).

SQLite leaves foreign keys OFF by default, which masked an insert-ordering bug:
child rows (cognitive_assessments etc.) were emitted before their parent
patients row, so the seed worked locally but failed on Railway Postgres with
ForeignKeyViolation. This test enables FK enforcement on a throwaway sqlite
file and exercises the real seed + upsert paths.
"""
import sqlite3

import pytest
from sqlalchemy import event
from sqlalchemy.engine import Engine

from app import db


RECORD = {
    "id": "T-0001",
    "age": 74,
    "sex": "M",
    "education_years": 14,
    "family_history": True,
    "comorbidities": ["hypertension"],
    "cognitive": {"scale": "MMSE", "latest": 22, "prior": 24, "months": 6},
    "blood": {"status": "completed", "outcome": "abnormal"},
    "imaging": None,
    "pet": None,
    "factors": [{"feature": "mmse", "text": "MMSE", "effect": 0.5, "value": 22}],
    "history": [{"at": "2026-09-07 10:00", "text": "Scored"}],
    "score": 0.81,
    "stage": 2,
    "updated_at": "2026-09-07 10:00",
}


@pytest.fixture()
def fk_sqlite(tmp_path, monkeypatch):
    """A throwaway sqlite DB with foreign_keys=ON, like Postgres enforces."""
    url = f"sqlite:///{(tmp_path / 'fk_test.db').as_posix()}"
    monkeypatch.setenv("DATABASE_URL", url)

    def _force_fks(dbapi_conn, _rec):
        if isinstance(dbapi_conn, sqlite3.Connection):
            dbapi_conn.execute("pragma foreign_keys=ON")

    event.listen(Engine, "connect", _force_fks)
    yield url
    event.remove(Engine, "connect", _force_fks)
    if db._engine is not None:
        db._engine.dispose()
        db._engine = None


def test_seed_and_upsert_respect_foreign_keys(fk_sqlite):
    db.init_db()
    db.seed_if_empty([dict(RECORD)])

    loaded = db.load_all()
    assert loaded is not None and len(loaded) == 1
    row = loaded[0]
    assert row["id"] == "T-0001" and row["stage"] == 2
    assert row["cognitive"]["latest"] == 22
    assert row["blood"]["outcome"] == "abnormal"
    assert row["factors"][0]["feature"] == "mmse"
    assert row["history"][0]["text"] == "Scored"

    # Upsert (the path persist() uses after a stage advance) must not
    # duplicate the parent row or violate FKs.
    mutated = dict(RECORD, stage=3, score=0.88, updated_at="2026-09-07 11:00")
    db.save_record(mutated)

    loaded = db.load_all()
    assert len(loaded) == 1  # no duplicate parent
    assert loaded[0]["stage"] == 3
    assert loaded[0]["cognitive"]["latest"] == 22  # children re-inserted
