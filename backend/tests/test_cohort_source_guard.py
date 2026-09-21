"""Deployment data-path safety: real patients are never replaced by stubs.

conftest.py disables the database for the whole session on purpose (tests mutate
subjects, and persisted mutations would leak into the real app). These tests opt a
single test back in against a throwaway SQLite file, then tear the engine down so
the rest of the suite stays memory-only.
"""
from __future__ import annotations

import pytest

from app import db, storage
from app.config import MISSING_DATA_SOURCE, STUB_DATA_SOURCE


def _record(pid: str, *, biomarker: bool = True, score: float = 0.5, stage: int = 2) -> dict:
    """A served-cohort record, with or without a measurable biomarker."""
    return {
        "id": pid,
        "age": 74,
        "sex": "F",
        "education_years": 14,
        "family_history": False,
        "comorbidities": [],
        "cognitive": {"scale": "MMSE", "latest": 24.0, "prior": 26.0, "months": 6},
        "blood": {"pTau181": 1.31} if biomarker else None,
        "imaging": None,
        "pet": None,
        "factors": [],
        "score": score,
        "stage": stage,
        "updated_at": "2026-01-01T00:00:00Z",
        "history": [],
    }


@pytest.fixture
def sqlite_store(tmp_path, monkeypatch):
    """A throwaway SQLite store, enabled for one test only."""
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'cohort_guard.db'}")
    monkeypatch.setattr(db, "_engine", None, raising=False)
    monkeypatch.setattr(db, "_Session", None, raising=False)
    db.init_db()
    yield db
    # Leave no engine behind for the next test (monkeypatch restores the
    # attributes, but the connection must be dropped explicitly).
    if db._engine is not None:
        db._engine.dispose()
    monkeypatch.setattr(db, "_engine", None, raising=False)
    monkeypatch.setattr(db, "_Session", None, raising=False)


def test_relative_sqlite_path_is_pinned_to_the_project_root(monkeypatch, tmp_path):
    """The same DB URL must address one file from any working directory.

    A CWD-relative sqlite path would otherwise give `uvicorn app.main:app` (run
    from backend/) and `uvicorn backend.app.main:app` (run from the root, as the
    Dockerfile does) two different databases.
    """
    from app.config import PROJECT_ROOT

    monkeypatch.setenv("DATABASE_URL", "sqlite:///./neuropilot.db")
    assert db.get_database_url() == f"sqlite:///{(PROJECT_ROOT / 'neuropilot.db').as_posix()}"

    # Absolute and in-memory URLs are left exactly as written.
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'abs.db'}")
    assert db.get_database_url() == f"sqlite:///{(tmp_path / 'abs.db').as_posix()}"
    monkeypatch.setenv("DATABASE_URL", "sqlite:///:memory:")
    assert db.get_database_url() == "sqlite:///:memory:"

    # Postgres URLs are untouched (only the scheme alias is normalised).
    monkeypatch.setenv("DATABASE_URL", "postgres://u:p@host:5432/db")
    assert db.get_database_url() == "postgresql://u:p@host:5432/db"


def test_pg_env_vars_build_a_connection_string(monkeypatch):
    """A managed Postgres describes itself with PG* vars, not a URL.

    Seeding a deployment is exactly this case: Railway's Postgres exposes
    PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE, and a generated password
    containing URL-significant characters must be encoded rather than pasted.
    """
    for key in ("DATABASE_URL", "DATABASE_PRIVATE_URL", "DATABASE_PUBLIC_URL",
                "POSTGRES_URL", "POSTGRESQL_URL"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("PGHOST", "turntable.proxy.rlwy.net")
    monkeypatch.setenv("PGPORT", "41234")
    monkeypatch.setenv("PGUSER", "postgres")
    monkeypatch.setenv("PGPASSWORD", "p@ss:word/with#chars")
    monkeypatch.setenv("PGDATABASE", "railway")

    url = db.get_database_url()

    assert url == (
        "postgresql://postgres:p%40ss%3Aword%2Fwith%23chars"
        "@turntable.proxy.rlwy.net:41234/railway"
    )


def test_pg_vars_override_a_dotenv_database_url(monkeypatch):
    """A `.env` convenience URL must not outrank connection details typed on the
    command line -- otherwise seeding a deployment silently hits the local store."""
    from app import config

    monkeypatch.setenv("DATABASE_URL", "sqlite:///./neuropilot.db")
    monkeypatch.setattr(config, "FROM_ENV_FILE", {"DATABASE_URL"}, raising=False)
    monkeypatch.setenv("PGHOST", "proxy.example.net")
    monkeypatch.setenv("PGPORT", "41234")
    monkeypatch.setenv("PGUSER", "postgres")
    monkeypatch.setenv("PGPASSWORD", "pw")
    monkeypatch.setenv("PGDATABASE", "railway")

    assert db.get_database_url() == (
        "postgresql://postgres:pw@proxy.example.net:41234/railway"
    )


def test_exported_database_url_still_wins_over_pg_vars(monkeypatch):
    """An explicit shell DATABASE_URL keeps precedence, env file or not."""
    from app import config

    monkeypatch.setattr(config, "FROM_ENV_FILE", set(), raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@exported:5432/db")
    monkeypatch.setenv("PGHOST", "proxy.example.net")
    monkeypatch.setenv("PGDATABASE", "railway")

    assert db.get_database_url() == "postgresql://u:p@exported:5432/db"


def test_stub_cohort_cannot_replace_a_stored_real_cohort(sqlite_store):
    """The failure this guards: a container with no cohort file seeds stubs."""
    real = [_record("ADNI-0001"), _record("ADNI-0002"), _record("ADNI-0003")]
    db.seed_if_empty(real, "adni")
    assert len(db.load_all() or []) == 3

    stubs = [_record(f"PTID-{i}", biomarker=False, stage=1) for i in range(4)]
    db.seed_if_empty(stubs, STUB_DATA_SOURCE)          # the degraded-boot path

    stored = db.load_all() or []
    assert len(stored) == 3, "stubs overwrote real patients"
    assert {r["id"] for r in stored} == {"ADNI-0001", "ADNI-0002", "ADNI-0003"}


def test_stub_cohort_seeds_when_the_database_is_empty(sqlite_store):
    """Stubs stay usable for a bare local demo -- last resort, not banned."""
    stubs = [_record("PTID-1024", biomarker=False, stage=1)]
    db.seed_if_empty(stubs, STUB_DATA_SOURCE)
    assert [r["id"] for r in db.load_all() or []] == ["PTID-1024"]


def test_empty_cohort_never_wipes_stored_patients(sqlite_store):
    db.seed_if_empty([_record("ADNI-0001")], "adni")
    db.seed_if_empty([], "adni")                       # degraded boot
    assert len(db.load_all() or []) == 1


def test_real_cohort_change_reseeds(sqlite_store):
    db.seed_if_empty([_record("ADNI-0001")], "adni")
    db.seed_if_empty([_record("ADNI-0001"), _record("ADNI-0002")], "adni")
    assert len(db.load_all() or []) == 2


def test_force_reseeds_even_when_the_fingerprint_matches(sqlite_store):
    """The post-retrain / repair path: same cohort, recomputed derived fields."""
    db.seed_if_empty([_record("ADNI-0001", score=0.20)], "adni")
    db.seed_if_empty([_record("ADNI-0001", score=0.90)], "adni")   # no force: no-op
    assert (db.load_all() or [])[0]["score"] == pytest.approx(0.20)

    db.seed_if_empty([_record("ADNI-0001", score=0.90)], "adni", force=True)
    assert (db.load_all() or [])[0]["score"] == pytest.approx(0.90)


def test_stub_cohort_in_the_database_is_never_served(sqlite_store, monkeypatch):
    """A deployment that once wrote the stubs into Postgres must not keep serving
    them: four carry illustrative lab values, so they pass the cohort filter."""
    stubs = [_record("PTID-1102", score=0.9), _record("PTID-1190", score=0.8)]
    db.seed_if_empty(stubs, STUB_DATA_SOURCE)
    assert db.stored_cohort_source() == STUB_DATA_SOURCE

    monkeypatch.setattr(storage, "load_cohort_file", lambda: ([], MISSING_DATA_SOURCE))
    patients, source = storage.load_patients()

    assert patients == {}, "placeholder stubs were served as if they were patients"
    assert source == "stub-cohort"


def test_stub_cohort_in_the_database_is_repaired_from_a_real_file(sqlite_store, monkeypatch):
    db.seed_if_empty([_record("PTID-1102")], STUB_DATA_SOURCE)
    fresh = [_record("ADNI-0001"), _record("ADNI-0002")]
    monkeypatch.setattr(storage, "load_cohort_file", lambda: (fresh, "adni"))

    patients, source = storage.load_patients()

    assert sorted(patients) == ["ADNI-0001", "ADNI-0002"]
    assert source == "adni+sqlite", "the label must come from the stored fingerprint"
    assert db.stored_cohort_source() == "adni"


def test_serves_a_seeded_database_when_the_cohort_file_is_absent(sqlite_store, monkeypatch):
    """A container has no cohort file; the database must carry the cohort."""
    db.seed_if_empty([_record("ADNI-0001"), _record("ADNI-0002")], "adni")
    monkeypatch.setattr(storage, "load_cohort_file", lambda: ([], MISSING_DATA_SOURCE))

    patients, source = storage.load_patients()

    assert sorted(patients) == ["ADNI-0001", "ADNI-0002"]
    # The source describes the STORED cohort (read from the fingerprint), so the
    # UI can say "ADNI cohort - database" rather than guessing from the file path.
    assert source == "adni+sqlite"


def test_stubs_in_the_file_do_not_mislabel_a_real_database(sqlite_store, monkeypatch):
    """Auto mode with no cohort file falls back to stubs -- but serves the DB."""
    db.seed_if_empty([_record("ADNI-0001")], "adni")
    monkeypatch.setattr(
        storage, "load_cohort_file",
        lambda: ([_record("PTID-1024", biomarker=False, stage=1)], STUB_DATA_SOURCE),
    )

    patients, source = storage.load_patients()

    assert list(patients) == ["ADNI-0001"], "stubs were served over the stored cohort"
    assert "mock" not in source


def test_unusable_stored_cohort_is_repaired_from_the_file(sqlite_store, monkeypatch):
    """Rows that filter to zero are a broken state, not an empty dashboard."""
    # Seeded the way an older ingester did it: slots without the value keys the
    # current cohort filter reads.
    db.seed_if_empty([_record(f"ADNI-{i:04d}", biomarker=False, stage=2) for i in range(1, 4)], "adni")
    assert storage._only_patients_with_real_results(db.load_all() or []) == []

    fresh = [_record("ADNI-0001"), _record("ADNI-0002")]
    monkeypatch.setattr(storage, "load_cohort_file", lambda: (fresh, "adni"))

    patients, source = storage.load_patients()

    assert sorted(patients) == ["ADNI-0001", "ADNI-0002"]
    assert source == "adni+sqlite"
    # and the repair is durable, not in-memory only
    assert len(storage._only_patients_with_real_results(db.load_all() or [])) == 2
