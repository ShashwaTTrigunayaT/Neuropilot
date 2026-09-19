"""Optional PostgreSQL store (blueprint sections 4.2 / 3).

Active only when DATABASE_URL is set (e.g. via docker-compose). The API keeps
its in-memory view for speed and mirrors every write to Postgres so the audit
trail survives restarts. All calls are best-effort -- if the database is
unreachable the API logs and keeps serving from memory.
"""
from __future__ import annotations

import hashlib
import json
import os
from typing import List, Optional

from sqlalchemy import (
    Column,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    create_engine,
    inspect,
    text,
)
from sqlalchemy.orm import declarative_base, sessionmaker

DATABASE_URL = os.getenv("DATABASE_URL")
if DATABASE_URL and DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

Base = declarative_base()


class Patient(Base):
    __tablename__ = "patients"
    id = Column(String(64), primary_key=True)
    age = Column(Integer, nullable=True)
    sex = Column(String(8), nullable=True)
    education_years = Column(Integer, nullable=True)
    family_history = Column(Integer, default=0)
    score = Column(Float)
    stage = Column(Integer)
    updated_at = Column(String(32))
    # Any record field without its own column (ADAS-Cog 13, FAQ, APOE, the real
    # ADNI diagnosis, visit date...). Stored as JSON so adding a cohort field
    # never requires a schema change -- and never silently vanishes on the
    # Postgres round-trip, which would turn those features into permanent NaN.
    extra = Column(Text, nullable=True)


class AppMeta(Base):
    """Small key/value table: which cohort is loaded (drives re-seeding)."""

    __tablename__ = "app_meta"
    key = Column(String(64), primary_key=True)
    value = Column(Text)


class CognitiveAssessment(Base):
    __tablename__ = "cognitive_assessments"
    id = Column(Integer, primary_key=True, autoincrement=True)
    patient_id = Column(String(64), ForeignKey("patients.id"))
    scale = Column(String(16))
    latest = Column(Float, nullable=True)
    prior = Column(Float, nullable=True)
    months = Column(Integer, nullable=True)


class Comorbidity(Base):
    __tablename__ = "comorbidities"
    id = Column(Integer, primary_key=True, autoincrement=True)
    patient_id = Column(String(64), ForeignKey("patients.id"))
    name = Column(String(64))


class LabResult(Base):
    __tablename__ = "lab_results"
    id = Column(Integer, primary_key=True, autoincrement=True)
    patient_id = Column(String(64), ForeignKey("patients.id"))
    slot = Column(String(16))  # blood | imaging | pet
    payload = Column(Text)     # JSON


class RiskFactor(Base):
    __tablename__ = "risk_factors"
    id = Column(Integer, primary_key=True, autoincrement=True)
    patient_id = Column(String(64), ForeignKey("patients.id"))
    position = Column(Integer)
    feature = Column(String(64), nullable=True)
    text = Column(Text)
    effect = Column(Float)
    value = Column(Float, nullable=True)


class PipelineHistory(Base):
    __tablename__ = "pipeline_history"
    id = Column(Integer, primary_key=True, autoincrement=True)
    patient_id = Column(String(64), ForeignKey("patients.id"))
    at = Column(String(32))
    text = Column(Text)


_engine = None
_Session = None


def get_database_url() -> Optional[str]:
    url = (
        os.getenv("DATABASE_URL")
        or os.getenv("DATABASE_PRIVATE_URL")
        or os.getenv("DATABASE_PUBLIC_URL")
        or os.getenv("POSTGRES_URL")
        or os.getenv("POSTGRESQL_URL")
    )
    if not url and os.getenv("PGHOST") and os.getenv("PGDATABASE"):
        user = os.getenv("PGUSER", "postgres")
        pw = os.getenv("PGPASSWORD", "")
        host = os.getenv("PGHOST")
        port = os.getenv("PGPORT", "5432")
        db = os.getenv("PGDATABASE")
        url = f"postgresql://{user}:{pw}@{host}:{port}/{db}"

    if url and url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql://", 1)
    return url


def _connect() -> None:
    global _engine, _Session
    url = get_database_url()
    if _engine is None and url:
        if url.startswith("sqlite"):
            _engine = create_engine(url, connect_args={"check_same_thread": False})
        else:
            _engine = create_engine(url, pool_pre_ping=True)
        _Session = sessionmaker(bind=_engine)


def _session():
    _connect()
    if _Session is None:
        raise RuntimeError("DATABASE_URL not configured")
    return _Session()


def init_db() -> None:
    if not enabled():
        return
    _connect()
    Base.metadata.create_all(_engine)
    # create_all() never ALTERs an existing table, so additive columns need an
    # explicit migration. Idempotent: only runs when the column is missing.
    try:
        existing = {c["name"] for c in inspect(_engine).get_columns("patients")}
        if "extra" not in existing:
            with _engine.begin() as conn:
                conn.execute(text("ALTER TABLE patients ADD COLUMN extra TEXT"))
            print("[db] migrated: added patients.extra")
    except Exception as exc:  # noqa: BLE001 -- non-fatal; API keeps serving
        print(f"[db] schema check skipped ({type(exc).__name__})")


def enabled() -> bool:
    return bool(get_database_url())


# Top-level record fields carried in Patient.extra (anything not a column)
_COLUMN_KEYS = {"id", "age", "sex", "education_years", "family_history", "score",
                "stage", "updated_at"}
_CHILD_KEYS = {"cognitive", "comorbidities", "blood", "imaging", "pet", "factors", "history"}


def _extra_json(record: dict) -> str:
    payload = {k: v for k, v in record.items() if k not in _COLUMN_KEYS and k not in _CHILD_KEYS}
    return json.dumps(payload)


def _make_patient(record: dict) -> Patient:
    return Patient(
        id=record["id"],
        age=record.get("age"),
        sex=record.get("sex"),
        education_years=record.get("education_years"),
        family_history=1 if record.get("family_history") else 0,
        score=record["score"],
        stage=record["stage"],
        updated_at=record["updated_at"],
        extra=_extra_json(record),
    )


def _insert_patient(s, record: dict) -> None:
    s.add(_make_patient(record))


def _insert_record(s, record: dict) -> None:
    """Insert the parent row (flushed) before its children.

    Postgres enforces FK constraints and SQLAlchemy's unit of work does not
    order table inserts by raw ForeignKey columns (only via relationship()),
    so the patients row must be flushed before any child row is emitted.
    """
    _insert_patient(s, record)
    s.flush()
    _insert_children(s, record)


def _insert_children(s, record: dict) -> None:
    cog = record.get("cognitive")
    if cog:
        s.add(
            CognitiveAssessment(
                patient_id=record["id"],
                scale=cog.get("scale"),
                latest=cog.get("latest"),
                prior=cog.get("prior"),
                months=cog.get("months"),
            )
        )
    for name in record.get("comorbidities", []):
        s.add(Comorbidity(patient_id=record["id"], name=name))
    for slot in ("blood", "imaging", "pet"):
        value = record.get(slot)
        if value is not None:
            s.add(LabResult(patient_id=record["id"], slot=slot, payload=json.dumps(value)))
    for i, f in enumerate(record.get("factors", [])):
        s.add(
            RiskFactor(
                patient_id=record["id"],
                position=i,
                feature=f.get("feature"),
                text=f["text"],
                effect=f["effect"],
                value=f.get("value"),
            )
        )
    for h in record.get("history", []):
        s.add(PipelineHistory(patient_id=record["id"], at=h["at"], text=h["text"]))


def _model_signature() -> str:
    """Short id of the SERVED model, so a retrain re-seeds the derived fields.

    The cohort digest covers the inputs, not the model. Retraining (e.g. dropping
    a leaked feature) leaves every input byte-identical, so a cohort-only
    fingerprint would keep the previous run's risk factors in the database -- the
    live app then explains a score using a feature the current model no longer
    has. Folding the model's identity in makes the stored view self-invalidating.
    """
    try:
        from .config import MODEL_META_PATH

        meta = json.loads(MODEL_META_PATH.read_text(encoding="utf-8"))
        feats = ",".join(meta.get("features", []))
        blob = f"{meta.get('trained_at', '')}|{feats}".encode("utf-8")
        return hashlib.sha1(blob).hexdigest()[:8]
    except Exception:  # noqa: BLE001 -- a missing model card must not block seeding
        return "nomodel"


def seed_if_empty(records: List[dict], source: str = "") -> None:
    """Seed the database once per cohort identity.

    A DB seeded with one cohort (e.g. the 800-subject synthetic set) must NOT
    keep serving that data after the app switches to another (the real ADNI
    cohort). The stored fingerprint is `source:count:cohort_version:model`, so
    either a cohort change or a RETRAIN re-seeds instead of silently showing the
    previous run's patients and attributions.
    """
    if not enabled():
        return
    # cohort_version is a content digest of the cohort records (written by the
    # ingesters). Without it, re-ingesting data with corrected values would keep
    # serving the previous stage/score values out of Postgres forever.
    version = str(records[0].get("cohort_version") or "") if records else ""
    fingerprint = f"{source}:{len(records)}:{version}:{_model_signature()}"
    with _session() as s:
        meta = s.query(AppMeta).filter_by(key="cohort_fingerprint").first()
        current = meta.value if meta else None
        count = s.query(Patient).count()
        if count > 0 and current == fingerprint:
            return
        if count > 0:
            print(f"[db] cohort changed ({current or 'unknown'}) — re-seeding "
                  f"{count} → {len(records)} patients")
            # children first: Postgres enforces the FKs
            for model in (RiskFactor, PipelineHistory, LabResult, Comorbidity,
                          CognitiveAssessment):
                s.query(model).delete()
            s.query(Patient).delete()
            s.flush()
        # Parents first, then children, in ONE transaction: Postgres rejects
        # child rows whose parent is not yet inserted, and a midway failure must
        # not leave a half-seeded database behind. add_all (rather than add in a
        # loop) keeps this to batched inserts instead of per-row flushes.
        s.add_all([_make_patient(r) for r in records])
        s.flush()
        for r in records:
            _insert_children(s, r)
        if meta is None:
            meta = AppMeta(key="cohort_fingerprint")
            s.add(meta)
        meta.value = fingerprint
        s.commit()


def _assemble(patient: Patient) -> dict:
    pid = patient.id
    with _session() as s:
        cog = s.query(CognitiveAssessment).filter_by(patient_id=pid).first()
        comorb = [c.name for c in s.query(Comorbidity).filter_by(patient_id=pid).order_by(Comorbidity.id)]
        labs = {r.slot: json.loads(r.payload) for r in s.query(LabResult).filter_by(patient_id=pid)}
        factors = [
            {"feature": f.feature, "text": f.text, "effect": f.effect, "value": f.value}
            for f in s.query(RiskFactor).filter_by(patient_id=pid).order_by(RiskFactor.position)
        ]
        history = [
            {"at": h.at, "text": h.text}
            for h in s.query(PipelineHistory).filter_by(patient_id=pid).order_by(PipelineHistory.id)
        ]
    record = {
        "id": pid,
        "age": patient.age,
        "sex": patient.sex,
        "education_years": patient.education_years,
        "family_history": bool(patient.family_history),
        "comorbidities": comorb,
        "cognitive": None if cog is None else {"scale": cog.scale, "latest": cog.latest, "prior": cog.prior, "months": cog.months},
        "blood": labs.get("blood"),
        "imaging": labs.get("imaging"),
        "pet": labs.get("pet"),
        "factors": factors,
        "score": patient.score,
        "stage": patient.stage,
        "updated_at": patient.updated_at,
        "history": history,
    }
    # restore the non-column fields (ADAS-Cog 13, FAQ, APOE, real diagnosis...)
    if patient.extra:
        try:
            record.update(json.loads(patient.extra))
        except Exception as exc:  # noqa: BLE001 -- corrupt payload must not break reads
            print(f"[db] could not parse extra payload for {pid} ({exc})")
    return record


def load_all() -> Optional[List[dict]]:
    if not enabled():
        return None
    with _session() as s:
        patients = s.query(Patient).order_by(Patient.id).all()
    return [_assemble(p) for p in patients]


def save_record(record: dict) -> None:
    """Upsert one patient + replace its child rows (used to persist stage advances)."""
    if not enabled():
        return
    with _session() as s:
        existing = s.query(Patient).filter_by(id=record["id"]).first()
        if existing is None:
            _insert_record(s, record)
            s.commit()
            return
        existing.age = record.get("age")
        existing.sex = record.get("sex")
        existing.education_years = record.get("education_years")
        existing.family_history = 1 if record.get("family_history") else 0
        existing.score = record["score"]
        existing.stage = record["stage"]
        existing.updated_at = record["updated_at"]
        existing.extra = _extra_json(record)
        for model in (CognitiveAssessment, Comorbidity, LabResult, RiskFactor, PipelineHistory):
            s.query(model).filter_by(patient_id=record["id"]).delete()
        s.flush()
        _insert_children(s, record)  # parent already exists -- children only
        s.commit()