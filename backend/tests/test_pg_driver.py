"""The served Postgres driver must be the one this project installs.

Written after a Railway deploy booted with

    [storage] Database unavailable (No module named 'psycopg'); using in-memory store
    [api] data source: adni-missing (0 patients loaded)

from a database that was seeded and healthy. SQLAlchemy 2.1.0 (released
2026-09-24) changed the default DBAPI for a driver-less `postgresql://` URL from
psycopg2 to psycopg (v3); requirements.txt asked for `sqlalchemy>=2.0`, so the
rebuilt image resolved a driver that is not declared anywhere in this project.
The local environment never reproduced it because it still holds SQLAlchemy 2.0,
where the bare URL means psycopg2.

db._pin_postgres_driver() writes the driver into the URL so the dialect is a
decision this repository makes, not a default a library can change. These tests
pin the two halves together: the URL names a driver, and requirements.txt
installs that driver's distribution.
"""
from __future__ import annotations

import importlib.util

import pytest

from app import db
from app.db import POSTGRES_DRIVER

# dialect driver -> (importable module, distribution declared in requirements.txt)
_DRIVERS = {
    "psycopg2": ("psycopg2", "psycopg2-binary"),
    "psycopg": ("psycopg", "psycopg"),
}


@pytest.fixture()
def _no_pg_env(monkeypatch):
    """A bare postgres URL must not be outranked by stray PG* variables.

    db.get_database_url() prefers PGHOST/PGDATABASE when the DATABASE_URL it sees
    came from .env, so the tests below have to remove them to test the URL path.
    """
    monkeypatch.delenv("PGHOST", raising=False)
    monkeypatch.delenv("PGDATABASE", raising=False)


@pytest.mark.parametrize("scheme", ["postgresql", "postgres"])
def test_driverless_postgres_url_is_pinned(_no_pg_env, monkeypatch, scheme):
    monkeypatch.setenv("DATABASE_URL", f"{scheme}://u:p@db.host:5432/railway")
    assert db.get_database_url() == (
        f"postgresql+{POSTGRES_DRIVER}://u:p@db.host:5432/railway"
    )


def test_explicit_driver_is_left_alone(_no_pg_env, monkeypatch):
    """An operator who names a driver outranks our default -- both directions."""
    for url in ("postgresql+psycopg://u:p@h:5432/db", "postgresql+psycopg2://u:p@h:5432/db"):
        monkeypatch.setenv("DATABASE_URL", url)
        assert db.get_database_url() == url


def test_pg_variable_assembly_is_pinned_too(_no_pg_env, monkeypatch):
    """The PG* path (what a managed Postgres hands out) builds a URL as well."""
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("PGHOST", "containers-us-west.railway.app")
    monkeypatch.setenv("PGPORT", "5678")
    monkeypatch.setenv("PGDATABASE", "railway")
    monkeypatch.setenv("PGUSER", "postgres")
    monkeypatch.setenv("PGPASSWORD", "p ss:word")
    assert db.get_database_url() == (
        f"postgresql+{POSTGRES_DRIVER}://postgres:p%20ss%3Aword"
        "@containers-us-west.railway.app:5678/railway"
    )


def test_sqlite_url_is_untouched(_no_pg_env, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "sqlite:///./neuropilot.db")
    url = db.get_database_url() or ""
    assert url.startswith("sqlite:///") and "+" not in url


def test_pinned_driver_is_declared_and_installed(_no_pg_env, monkeypatch):
    """The regression itself: URL driver and requirements.txt must agree.

    A driver that is pinned in code but absent from requirements.txt is the
    deploy-time `ModuleNotFoundError` above; a package that is installed but no
    longer the one the URL names is the same failure wearing the other hat.
    """
    from tests.test_declared_dependencies import _declared_packages

    module, distribution = _DRIVERS[POSTGRES_DRIVER]
    assert distribution in _declared_packages(), (
        f"db.py pins the '{POSTGRES_DRIVER}' driver, but backend/requirements.txt "
        f"does not declare '{distribution}' -- the container will fail to import it."
    )
    assert importlib.util.find_spec(module) is not None, (
        f"the pinned Postgres driver '{POSTGRES_DRIVER}' ({module}) is not "
        "installed in this environment"
    )
