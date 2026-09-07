"""Optional PostgreSQL store (blueprint sections 4.2 / 3).

Active only when DATABASE_URL is set (e.g. via docker-compose). The API keeps
its in-memory view for speed and mirrors every write to Postgres so the audit
trail survives restarts. All calls are best-effort -- if the database is
unreachable the API logs and keeps serving from memory.
"""
from __future__ import annotations

import json
import os
from typing import List, Optional

from sqlalchemy import Column, Float, ForeignKey, Integer, String, Text, create_engine
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


def enabled() -> bool:
    return bool(get_database_url())


def _insert_record(s, record: dict) -> None:
    s.add(
        Patient(
            id=record["id"],
            age=record.get("age"),
            sex=record.get("sex"),
            education_years=record.get("education_years"),
            family_history=1 if record.get("family_history") else 0,
            score=record["score"],
            stage=record["stage"],
            updated_at=record["updated_at"],
        )
    )
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


def seed_if_empty(records: List[dict]) -> None:
    if not enabled():
        return
    with _session() as s:
        if s.query(Patient).count() > 0:
            return
        for r in records:
            _insert_record(s, r)
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
    return {
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
        for model in (CognitiveAssessment, Comorbidity, LabResult, RiskFactor, PipelineHistory):
            s.query(model).filter_by(patient_id=record["id"]).delete()
        s.flush()
        _insert_record(s, record)
        s.commit()