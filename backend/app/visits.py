"""Per-subject visit history, from the processed ADNI visits artifact.

The served patient record keeps only two cognitive scores -- `latest` and
`prior` -- because that is all the served model consumes (`mmse` and
`mmse_change`). The processed visits table behind the cohort has every scored
visit instead: 14.7k rows, up to 21 visits for a single subject, each one a real
clinician visit with its own MMSE, ADAS-Cog and CDR-SB.

That is what the outlook chart is drawn against. Two points is a line; eleven
points over twelve years is a trajectory, and it is the difference between the
reader seeing a decline and the reader seeing that the decline is one bad visit
after four stable years.

Design constraints, both learned from how the rest of this app is deployed:

* Loaded lazily and cached. The API process should not pay 1.8MB of CSV parsing
  at boot for a chart most requests never open.
* Absence is normal, not an error. The DB-backed deployment carries no cohort
  file under the ADNI Data Use Agreement, and the visits artifact is optional
  everywhere; callers get an empty series and fall back to the two-point
  trajectory rather than 500ing.

Every value served here is a measured visit -- nothing on the chart is
interpolated, and no point is carried forward from another subject.
"""
from __future__ import annotations

import csv
from functools import lru_cache
from typing import Optional

from .config import VISITS_PATH

# The columns the chart and its hover readout use. All are joined per visit by
# scripts/ingest_adni.py, so a missing value means "not measured at that visit",
# never "looked up elsewhere".
_NUMERIC = ("mmse", "adas_cog_13", "cdr_sb", "faq_total", "n_visits")

# The model's own feature columns, carried PER VISIT so a visit can be scored and
# not only plotted: the same row that draws a dot also produces the risk score at
# that dot, which is what a risk-versus-time chart needs. A column absent from the
# artifact stays None -- "not measured at that visit" -- and the served model
# consumes missing features natively, so no value is ever borrowed from another
# row. `sex` is M/F in the artifact and mapped to the model's 0/1 at scoring time.
_SCORABLE = ("age", "sex", "education_years", "apoe_e4", "mmse", "adas_cog_13",
             "ptau217", "abeta4240", "nfl", "gfap", "hippocampal_volume",
             "hippocampal_icv_ratio", "centiloids", "tau_meta_temporal")


def available() -> bool:
    return VISITS_PATH.exists()


def _patient_id(rid: str) -> str:
    """ADNI RID -> the cohort's patient id (`ADNI-0002`)."""
    try:
        return f"ADNI-{int(rid):04d}"
    except (TypeError, ValueError):
        return ""


def _number(raw: Optional[str]) -> Optional[float]:
    if raw is None or raw == "":
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if value == value else None  # drop NaN


@lru_cache(maxsize=1)
def _index() -> dict[str, list[dict]]:
    """{patient id: [visit, ...]} sorted by date, with month offsets filled in.

    One pass, one cache, built on first use. A malformed row is skipped rather
    than raised on: a chart annotation must never be able to take down a request.
    """
    if not available():
        return {}

    rows: dict[str, list[dict]] = {}
    try:
        handle = VISITS_PATH.open("r", encoding="utf-8", newline="")
    except OSError:
        return {}

    with handle:
        for raw in csv.DictReader(handle):
            patient_id = _patient_id(raw.get("RID", ""))
            date = (raw.get("date") or "").strip()
            if not patient_id or not date:
                continue
            visit = {
                "date": date,
                "mmse": _number(raw.get("mmse")),
                "adas": _number(raw.get("adas_cog_13")),
                "cdr": _number(raw.get("cdr_sb")),
                "faq": _number(raw.get("faq_total")),
                "n_visits": _number(raw.get("n_visits")),
                "stage": _number(raw.get("stage")),
                "model_features": {
                    col: (_number(raw.get(col)) if col != "sex" else (raw.get(col) or None))
                    for col in _SCORABLE
                },
            }
            rows.setdefault(patient_id, []).append(visit)

    for visits in rows.values():
        visits.sort(key=lambda v: v["date"])
        # Month offsets are measured from the subject's own first visit, so every
        # subject's series starts at 0 and the chart never mixes clocks.
        for i, visit in enumerate(visits):
            visit["visit_no"] = i + 1
            visit["total"] = len(visits)
    return rows


def series(patient_id: Optional[str]) -> list[dict]:
    """Every scored visit for one subject, oldest first. Empty when unknown."""
    if not patient_id:
        return []
    return _index().get(patient_id, [])


def history(patient_id: Optional[str]) -> Optional[dict]:
    """Summary of the observed history: how much of it there is, and its slope.

    The slope is a least-squares fit over the subject's own visits (MMSE points
    per year), which is the number a clinician would actually quote -- and it is
    labelled as a fit, not as a measurement.
    """
    visits = series(patient_id)
    if not visits:
        return None
    first, last = visits[0], visits[-1]
    slope = _slope_per_year(visits)
    return {
        "n_visits": len(visits),
        "first_date": first["date"],
        "last_date": last["date"],
        "span_months": round(months_between(first["date"], last["date"]), 1),
        "span_years": round(months_between(first["date"], last["date"]) / 12, 1),
        "mmse_first": first.get("mmse"),
        "mmse_last": last.get("mmse"),
        "slope_per_year": slope,
        "source": "real ADNI follow-up visits",
    }


def months_between(start: str, end: str) -> float:
    """Elapsed months between two ISO dates (30.44 days per month)."""
    from datetime import date as _date

    try:
        a = _date.fromisoformat(start[:10])
        b = _date.fromisoformat(end[:10])
    except ValueError:
        return 0.0
    return (b - a).days / 30.44


def _slope_per_year(visits: list[dict]) -> Optional[float]:
    """Least-squares MMSE trend across the subject's visits, per year.

    Needs at least three visits with a score: two points always fit perfectly, so
    a slope from them would be a straight line dressed up as a trend.
    """
    points = []
    zero = None
    for visit in visits:
        if visit.get("mmse") is None:
            continue
        if zero is None:
            zero = visit["date"]
        points.append((months_between(zero, visit["date"]), float(visit["mmse"])))
    if len(points) < 3:
        return None

    n = len(points)
    mean_x = sum(p[0] for p in points) / n
    mean_y = sum(p[1] for p in points) / n
    denom = sum((p[0] - mean_x) ** 2 for p in points)
    if denom == 0:
        return None
    slope_per_month = sum((p[0] - mean_x) * (p[1] - mean_y) for p in points) / denom
    return round(slope_per_month * 12, 2)
