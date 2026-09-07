"""FastAPI application entrypoint.

Run (from the backend/ directory):
    uvicorn app.main:app --reload

Docs: http://127.0.0.1:8000/docs
"""
from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import service
from .api import router

app = FastAPI(
    title="NeuroPlot API",
    description=(
        "Decision-support service for the early Alzheimer's diagnostic pipeline. "
        "Ranks patients by risk (XGBoost + SHAP), tracks the Cognitive → Blood → MRI → PET "
        "pipeline, and recommends next tests via deterministic escalation rules. "
        "**No endpoint returns a diagnosis** — only risk tier, reasoning, and recommended next test. "
        "Stage advancement requires clinician confirmation (POST /advance-stage)."
    ),
    version="0.1.0",
)

# The React dashboard (Vite dev server) talks to this API during development.
# Localhost is allowed on any port (dev servers, preview builds); other origins
# can be added explicitly via CORS_ORIGINS (comma-separated) for staging/demo.
_localhost = r"https?://(localhost|127\.0\.0\.1)(:\d+)?"
_extra = [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", *_extra],
    allow_origin_regex=_localhost,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

from pathlib import Path
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

app.include_router(router)

# Production SPA static file serving (if dist exists)
_project_root = Path(os.getenv("PROJECT_ROOT", Path(__file__).resolve().parents[2]))
_dist_dir = _project_root / "dist"
if not _dist_dir.exists():
    _dist_dir = Path("dist").resolve()

if _dist_dir.exists() and (_dist_dir / "index.html").exists():
    if (_dist_dir / "assets").exists():
        app.mount("/assets", StaticFiles(directory=str(_dist_dir / "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def _serve_spa(full_path: str):
        target = _dist_dir / full_path
        if full_path and target.exists() and target.is_file():
            return FileResponse(str(target))
        return FileResponse(str(_dist_dir / "index.html"))


@app.on_event("startup")
def _report_source() -> None:
    print(f"[api] data source: {service.DATA_SOURCE} "
          f"({len(service.PATIENTS)} patients loaded)")