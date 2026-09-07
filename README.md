# NeuroPilot — Alzheimer's Prioritization System

**AI-Driven Prioritization for Early Alzheimer's Diagnostic Pathways — Precision Care Challenge 2026**

A full-stack clinical decision-support prototype: it ingests a dementia cohort,
trains a risk-scoring model on measures spanning **cognition, blood biomarkers,
MRI volumetrics and PET**, explains every score with SHAP, routes patients
through a **Cognitive → Blood → MRI → PET** pipeline, and — when enabled —
**drives the entire workup autonomously**: it ranks the cohort, picks the
highest-priority subject itself, orders the next indicated test, re-scores, and
re-ranks live.

> **The system never outputs a diagnosis.** Every screen and API contract exposes
> only three things: a **risk tier**, the **reasoning** behind it, and a
> **recommended next test**. Final clinical decisions always rest with the clinician.

---

## 1. Readiness at a glance

| Area | Status | Evidence |
|---|---|---|
| Data pipeline (ETL) | ✅ Run & verified | Real OASIS-1: 373 visits / 150 subjects; missing values flagged (SES ×19, MMSE ×2), never silently dropped |
| Synthetic ADNI-shaped cohort | ✅ Run & verified | 800 subjects in true ADNI-1 proportions (200 CN / 400 MCI / 200 AD); workup mix 354 / 179 / 140 / 127 across Stages 1–4 |
| Model trained (all 4 stages) | ✅ Run & verified | XGBoost, 10 features spanning cognition + blood + MRI + PET; CV AUC **0.842 ± 0.032**, test AUC **0.871** |
| Explainability | ✅ Run & verified | Global SHAP + full per-subject attribution (all 10 factors, grouped by pipeline stage, with `model default` badges for un-ordered tests) |
| Escalation rule engine | ✅ 23 pytest cases | Deterministic stage gates; clinician-in-the-loop via `override: true`; results loop via `POST /results` |
| Autonomous triage | ✅ Run & verified (browser E2E) | `POST /workup/next` / `/workup/run`: model picks subject → orders test → re-scores → re-ranks; live rank movements (e.g. `#12 → #2` after an abnormal blood panel) |
| Backend API | ✅ Run & verified | FastAPI + Swagger at `/docs`; `/health` reports `data_source`; live scoring via `pipeline.joblib` |
| Frontend dashboard | ✅ Run & verified (headless Chrome) | Zero mock data; ranked cohort, detail view, radar/attribution panels, Autonomous Triage toggle with live step banner; production build clean |
| PostgreSQL store | ✅ Written (optional) | Activated by `DATABASE_URL`; not yet exercised end-to-end |
| Docker demo | ✅ Written | `docker compose up --build` (not yet exercised) |
| CI (GitHub Actions) | ❌ Not built | Deliberately excluded from scope |

---

## 2. Quick start (3 terminals)

```bash
# Terminal 1 — ML pipeline (once; generates data + artifacts)
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements-ml.txt
python scripts/generate_adni_like_v2.py                # 800-subject ADNI-shaped cohort
python scripts/train_model.py                          # train + SHAP + artifacts

# Terminal 2 — API
pip install -r backend/requirements.txt
cd backend && uvicorn app.main:app --reload            # http://127.0.0.1:8000/docs

# Terminal 3 — Dashboard
npm install && npm run dev                             # http://localhost:5173
```

Or everything in one command (needs Docker):

```bash
docker compose up --build     # web :8080 · API docs :8000
```

Optional real-data mode:

```bash
python scripts/download_oasis.py      # fetch public OASIS-1 CSV into data/raw/
python scripts/run_pipeline.py        # download (if missing) → ingest → train
# then start the API with OASIS_DATA_MODE=real to serve the 150 real subjects
```

---

## 3. Data policy — no datasets in this repository

**This repo contains zero patient data and no source datasets.** The raw OASIS
CSV and the synthetic cohorts are downloaded/generated locally and gitignored.
The *derived* artifacts — trained model + risk scores — **are committed** so a
fresh deploy (Railway/Docker) serves the trained model without re-training:

| Path | What it is | How to get it |
|---|---|---|
| `data/raw/oasis_longitudinal.csv` | Real public OASIS-1 longitudinal CSV (150 subjects, 373 visits) | `python scripts/download_oasis.py` or manual download (see `data/raw/README.md`) |
| `data/processed/synthetic_patients_v2.json` | 800-subject synthetic cohort, ADNI-1 proportions, all 4 pipeline stages | `python scripts/generate_adni_like_v2.py` |
| `data/processed/synthetic_patients.json` | Legacy 500-subject synthetic cohort | `python scripts/generate_adni_like.py` |
| `data/processed/visits.csv`, `patients.csv` | ETL output from real OASIS | `python scripts/ingest.py` |
| `data/processed/risk_scores.json` | Per-subject model scores + SHAP factors | **Committed** (deployment seed); regenerate with `python scripts/train_model.py` |
| `artifacts/pipeline.joblib`, `model_meta.json`, `global_importance.csv`, `eval_report.txt` | Trained model, model card, global SHAP, eval audit | **Committed** (deployment); regenerate with `python scripts/train_model.py` |
| `artifacts/rf_pipeline.joblib` | RandomForest fallback model | Local only — gitignored |

Why: OASIS data carries its own licensing terms and the synthetic cohorts are
reproducible from a seeded generator in seconds — committing neither keeps the
repo clean and legally simple. The derived model artifacts are an exception:
they are needed for one-command deployment.

---

## 4. What it does and how (end to end)

1. **Generate / ingest.** `scripts/generate_adni_like_v2.py` builds an
   800-subject cohort shaped like ADNI-1 (25% CN / 50% MCI / 25% AD) with
   severity-correlated measures at every pipeline stage: MMSE + longitudinal
   cognition, p-tau181 (pg/mL) + Aβ42/40 ratio, hippocampal volume (cm³),
   amyloid/tau PET status + SUVR. `scripts/ingest.py` does the equivalent
   harmonization for real OASIS-1 (dedupe `(subject, visit)`, flag missing).
2. **Feature engineering.** `scripts/train_model.py` derives per-subject
   features: latest MMSE, `mmse_change` (latest − first), demographics, and —
   when the corresponding test was actually performed — `ptau181`, `abeta4240`,
   `hippocampal_volume`, `amyloid_positive`, `tau_positive`. Un-ordered tests
   stay **NaN** (XGBoost consumes missing values natively; missingness itself
   is informative).
3. **Training.** XGBoost (RandomForest fallback) predicts the severity label.
   CDR is deliberately **not** a feature (clinician rating ≈ the label =
   leakage). Subject-level stratified 80/20 split; 5-fold CV + held-out metrics
   + majority-class baseline, all written to `artifacts/eval_report.txt`.
4. **Explainability.** SHAP TreeExplainer produces global importance
   (`artifacts/global_importance.csv`) and per-subject factors. The detail view
   groups **all 10 factors by pipeline stage** (Cognition / Blood / MRI / PET);
   factors from un-ordered tests carry a dimmed **`model default`** badge — the
   model's learned missing-value path — with a footnote explaining it.
5. **Serving.** The FastAPI backend loads the cohort + `pipeline.joblib` and
   **re-scores every subject at startup** with the trained model (vectorized
   SHAP batch), so the dashboard shows the actual served model's output, not
   generator heuristics.
6. **Dashboard.** React app fetches everything from the API — no mock or
   hardcoded data anywhere in `src/`. Clinicians scan a ranked cohort, open a
   subject, read score + full attribution + pipeline position + audit trail.
7. **Model-driven cascade (`POST /patients/{id}/auto-workup`).** Per-subject
   loop: the rule engine orders the next test from the current tier, a
   clinically-plausible result is derived, the **trained model re-scores
   immediately**, and the updated tier gates the next step. Stops (409) when
   the tier indicates no further testing.
8. **Autonomous cohort triage (`POST /workup/next`, `/workup/run`).** No clicks
   at all: the system ranks **all** subjects by current score, picks the
   highest-priority one whose tier still indicates a test, performs exactly one
   step, re-scores, and re-ranks — priorities genuinely shift as results land.
   The dashboard's **Autonomous Triage** header toggle runs this loop live
   (~1.4 s/step) with a banner showing subject · test · outcome · score path ·
   rank movement.

### Worked example (from a live verification run)

SYN-0345 at risk 0.67 (medium) → the model orders **blood** → abnormal
p-tau181/Aβ42/40 → re-score **0.81 (high)** → MRI indicated → normal MRI pulls
it to **0.74**, still high → **PET** → pathway complete. In the cohort-level
autonomous run, an abnormal blood panel moved SYN-0087 **#12 → #2** in the
queue; later results pushed it back down — the priority queue reorders itself.

---

## 5. Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│ DATA (never committed): data/raw/*.csv · data/processed/*.json        │
│   real OASIS-1 (optional) · synthetic ADNI-shaped cohorts             │
└───────────────────────────────┬───────────────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ GENERATE/ETL — scripts/generate_adni_like_v2.py · scripts/ingest.py   │
│   harmonize → dedupe → flag missing → per-subject feature table       │
└───────────────────────────────┬───────────────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ TRAIN — scripts/train_model.py (sklearn Pipeline)                     │
│   10 features (4 stages) → XGBoost (RF fallback) → eval → SHAP        │
│   artifacts: pipeline.joblib · model_meta.json · global_importance.csv│
│              risk_scores.json · eval_report.txt                       │
└───────────────────────────────┬───────────────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ API — backend/ (FastAPI)                                              │
│   storage: synthetic cohort + startup batch rescore │ optional PG      │
│   escalation.py: deterministic stage rules · model_service.py: SHAP   │
│   /patients · /patients/{id} · /explain · /pipeline · /advance-stage  │
│   /patients/{id}/auto-workup · /workup/next · /workup/run · /results  │
│   /patients/score · /model/info · /health                             │
└───────────────────────────────┬───────────────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ UI — src/ (React + Vite + Tailwind + Recharts) — NO mock data         │
│   Overview: tier strip · risk histogram · stage funnel · top-8 list   │
│   Patients: ranked table, filters, search, pagination                 │
│   Detail: score gauge · 4-stage attribution radar · pipeline stepper  │
│           · audit trail · Autonomous Triage banner                    │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 6. Repository map

```
.
├── Info.md                      # design blueprint this project implements
├── README.md                    # this document
├── .env.example                 # every supported env var, documented
├── docker-compose.yml           # one-command demo: Postgres + API + web
├── requirements-ml.txt          # ML pipeline deps (Pandas, sklearn, xgboost, shap)
├── index.html / vite.config.js / tailwind.config.js / postcss.config.js / package.json
│
├── data/                        # datasets gitignored (see §3); derived scores committed
│   ├── raw/README.md            #   how to obtain OASIS-1
│   └── processed/risk_scores.json  # trained-model scores (deployment seed)
│
├── scripts/                     # the ML pipeline (Python 3.11)
│   ├── download_oasis.py        #   fetch real OASIS-1 CSV from a public mirror
│   ├── generate_adni_like.py    #   legacy 500-subject synthetic cohort
│   ├── generate_adni_like_v2.py #   800-subject ADNI-1-proportioned cohort (default)
│   ├── ingest.py                #   ETL real OASIS → unified patient-centric schema
│   ├── train_model.py           #   features → XGB/RF → eval → SHAP → artifacts
│   └── run_pipeline.py          #   download + ingest + train in one command
│
├── artifacts/                   # trained model + card + SHAP + eval (committed for deploy)
│   ├── pipeline.joblib          #   served preprocessing + classifier
│   ├── model_meta.json          #   model card (features, AUC, thresholds)
│   ├── global_importance.csv    #   global SHAP
│   ├── eval_report.txt          #   metrics + guardrails (audit trail)
│   └── rf_pipeline.joblib       #   RF fallback (local only, gitignored)
│
├── backend/                     # FastAPI service
│   ├── requirements.txt · requirements-dev.txt · pytest.ini · Dockerfile
│   ├── tests/test_api.py        #   23 pytest cases
│   └── app/
│       ├── config.py            #   thresholds (env) + artifact paths
│       ├── schemas.py           #   Pydantic contracts (no diagnosis field)
│       ├── seed_data.py         #   tiny fallback cohort if nothing generated
│       ├── storage.py           #   cohort loading + startup rescore; optional PG
│       ├── db.py                #   SQLAlchemy PostgreSQL store
│       ├── model_service.py     #   in-process pipeline + batch SHAP serving
│       ├── escalation.py        #   deterministic rule engine
│       ├── service.py           #   business logic (advance, results, workups)
│       ├── api.py / main.py     #   router + app
│
├── src/                         # React dashboard (pure API client)
│   ├── api.js                   #   fetch client — the ONLY data source
│   ├── App.jsx                  #   views, flows, Autonomous Triage loop
│   ├── lib.js · index.css · main.jsx
│   └── components/
│       ├── Overview.jsx         #   dashboard: strip, charts, top-8, SHAP panel
│       ├── AllPatients.jsx      #   ranked table: filters, search, pagination
│       ├── PatientDetail.jsx    #   detail: score, attribution radar, actions, trail
│       ├── RiskSimulator.jsx    #   what-if scoring against the live model
│       ├── FeatureRadarChart.jsx · RiskDistributionChart.jsx · StageProgressionChart.jsx
│       ├── Footer.jsx           #   telemetry + "How risk is determined" explainer
│       ├── TierTag.jsx · BrandLogo.jsx · widgets.jsx
│
└── frontend/                    # Docker build for the dashboard
    ├── Dockerfile               #   node build → nginx (VITE_API_URL=/api)
    └── nginx.conf               #   proxies /api → api:8000
```

---

## 7. Model card (current trained model)

Trained on the **v2 synthetic ADNI-1-proportioned cohort** (800 subjects: 200 CN
/ 400 MCI / 200 AD; workup mix 354 Stage-1 / 179 Stage-2 / 140 Stage-3 /
127 Stage-4). Synthetic data — see §13 limitations.

| Metric | Value |
|---|---|
| Model | XGBoost (`pipeline.joblib`), RandomForest fallback exported alongside |
| Features (10, spanning all 4 stages) | `mmse`, `mmse_change`, `age`, `education_years`, `sex`, `ptau181`, `abeta4240`, `hippocampal_volume`, `amyloid_positive`, `tau_positive` |
| 5-fold CV AUC | **0.842 ± 0.032** ← headline number |
| Held-out test AUC | 0.871 (slightly optimistic — early stopping used the test set) |
| Held-out accuracy @0.5 | 0.750 (confusion `[[52 15], [25 68]]`; Low n=67, High n=93) |
| RF fallback test AUC | 0.874 |
| Majority-class baseline | accuracy 0.581, AUC 0.500 |
| Thresholds | High > 0.7 · Medium ≥ 0.4 (env-overridable) |

**Global SHAP importance (mean |SHAP|):**

| Rank | Feature | Importance | Stage |
|---|---|---|---|
| 1 | `mmse` | 1.068 | Cognition |
| 2 | `ptau181` | 0.304 | Blood |
| 3 | `abeta4240` | 0.233 | Blood |
| 4 | `age` | 0.184 | Demographics |
| 5 | `hippocampal_volume` | 0.175 | MRI |
| 6 | `mmse_change` | 0.084 | Cognition (longitudinal) |
| 7 | `education_years` | 0.031 | Demographics |
| 8 | `sex` | 0.010 | Demographics |
| 9 | `amyloid_positive` | 0.008 | PET |
| 10 | `tau_positive` | 0.000 | PET |

Cognition dominates, and blood biomarkers carry real weight — the ADNI-shaped
cohort fixed v1's "PET weightless" artifact (only 5 PET subjects then; 127 now).
`tau_positive` remains near-zero because amyloid/tau status are highly
correlated in the generator.

**Missing-biomarker handling:** a Stage-1 subject (blood/MRI/PET not yet
ordered) scores from cognition + demographics alone; XGBoost consumes the NaNs
natively and SHAP attributes the learned missing-value default (small,
badge-marked in the UI). Once a test completes, its measured contribution
replaces the default and the subject is re-scored instantly.

**Cohort tiers after training:** 291 High · 227 Medium · 282 Low (0.7/0.4).

### Previous run — real OASIS-1 (cognitive + volume features only)

| Metric | Value |
|---|---|
| 5-fold CV AUC | 0.898 ± 0.041 |
| Held-out test AUC | 0.908 |

Real OASIS-1 has no blood/PET columns, so that model scored on 11
cognitive/volume features only. Re-run any time with
`python scripts/train_model.py --data real` (after `python scripts/run_pipeline.py`).

---

## 8. Escalation rule engine (deterministic — no second ML layer)

| Stage | Low tier | Medium tier | High tier |
|---|---|---|---|
| 1 Cognitive | Re-screen in 12 mo | Blood biomarker panel | Blood biomarker panel |
| 2 Blood | Re-screen in 12 mo | MRI volumetrics | MRI volumetrics |
| 3 MRI | Return to screening | Follow-up MRI in 12 mo | Amyloid/tau PET |
| 4 PET | — pipeline complete → multi-disciplinary review — | | |

- Test-ordering escalations are confirmable; "Schedule/Return" recommendations
  are **not** auto-escalated — `POST /advance-stage` returns `409` unless the
  clinician passes `{"override": true}` (clinician in the loop).
- Every stage transition, test order, result and re-score is timestamped into
  the subject's reasoning trail (auditability), mirrored to Postgres when
  configured.

---

## 9. Backend API (FastAPI)

Contracts are Pydantic-validated; **no response model contains a diagnosis
field**. Swagger at `/docs`. CORS allows the Vite dev server (+ `CORS_ORIGINS`).

- **Data source resolution:** synthetic v2 cohort if present (default; 800
  subjects) → legacy 500-subject cohort → real OASIS scores
  (`OASIS_DATA_MODE=real` forces real) → 8-patient stub so the API demos before
  any pipeline run. When a trained model exists, every subject is re-scored at
  startup (vectorized SHAP batch) — the dashboard always shows the served
  model's judgment.
- **In-process model serving:** `POST /patients/score` predicts on an arbitrary
  feature vector with `pipeline.joblib` + a cached SHAP TreeExplainer.

| Endpoint | Behavior |
|---|---|
| `GET /health` | `{"status":"ok","data_source":"synthetic"}` |
| `GET /patients?tier=&q=&sort=&page=&limit=` | Ranked list; `sort`: `risk-desc` (default), `risk-asc`, `stage`; returns `{items, total, page, limit}` |
| `GET /patients/{id}` | Full profile: `cognitive`, `blood`, `imaging`, `pet`, `factors` (all, with `feature` + `value`), `history` — no diagnosis field |
| `GET /patients/{id}/explain` | Score, tier, all SHAP factors `{feature, text, value, contribution}`, `global_importance` |
| `GET /patients/{id}/pipeline` | `current_stage`, stage names, `history`, `recommended_next: {summary, button}` |
| `POST /patients/{id}/advance-stage` | Body `{"override": false, "note": null}`. 404 unknown id · 409 not indicated (use `override: true`) · 200 → `{applied, event, result, rescored, new_score, new_tier, pipeline}`. Ordering a test auto-derives a plausible result and re-scores. |
| `POST /patients/{id}/results` | Record an ordered test's outcome. Body `{"slot": "blood\|imaging\|pet", "outcome": "normal\|abnormal\|inconclusive", "values": {...}, "note": null}`. 404 · 422 bad slot · 409 nothing pending · 200 → `{applied, event, slot, outcome, new_score, new_tier}` (re-scores) |
| `POST /patients/{id}/auto-workup` | Per-subject cascade: tier-gated blood → MRI → PET with re-score each step. 409 + reason when the tier indicates no test. |
| `POST /workup/next` | **One autonomous step**: ranks the cohort, picks the top subject whose tier indicates a test, orders → result → re-score → re-rank. Returns `{subject: {id, slot, outcome, score_before, score_after, rank_before, rank_after, ...}, queue_remaining, done, reason}` |
| `POST /workup/run` | Body `{"max_steps": 25}` → runs up to N autonomous steps; `{steps_run, done, remaining, total}` |
| `POST /patients/score` | Body `{"features": {...}}` → `{score, risk_tier, factors, model_type}`. 503 if no model artifact |
| `GET /model/info` | Model card: type, features, trained_at, thresholds, CV/test AUC, global SHAP importance |

Example list item:

```json
{
  "id": "ADNI-0001", "age": 80, "sex": "F", "education_years": 12,
  "cognitive": {"scale": "MMSE", "latest": 22, "prior": 24, "months": 12},
  "score": 0.96, "risk_tier": "high", "stage": 2,
  "stage_name": "Blood biomarkers",
  "recommended_next": "MRI volumetrics to assess hippocampal atrophy.",
  "updated_at": "2026-09-07 12:04"
}
```

Example attribution factor (grouped by stage in the UI):

```json
{"feature": "abeta4240", "text": "Aβ42/40 ratio", "value": 0.081, "contribution": 0.367}
```

---

## 10. Frontend dashboard (React + Vite + Tailwind + Recharts)

- **Zero mock data.** `src/api.js` is the only data source; if the API is down
  the UI shows an error + Retry, never fake rows.
- **Overview** — summary strip (tier counts, mean risk, % elevated), Recharts
  risk histogram + pipeline-stage funnel, top-8 highest-priority shortlist,
  global SHAP panel with live model provenance from `GET /model/info`.
- **Patients** — complete ranked table: tier/stage segmented filters, ID search,
  sort by risk/stage, pagination (15/page), page state preserved when opening a
  subject and returning.
- **Detail view** — score gauge with 0.4/0.7 threshold markers; **Clinical Risk
  Attribution** grouped by pipeline stage (Cognition / Blood / MRI / PET) with
  signed bars, measured values, and `model default` badges + footnote for
  un-ordered tests; Cognitive → Blood → MRI → PET stepper; recommended next
  step with Confirm (409 messages surface inline; "Override — escalate anyway"
  for routine follow-ups, logged with `override: true`); interactive test
  results; timestamped audit trail.
- **Autonomous Triage** — header toggle drives the whole cohort: a step banner
  shows `SUBJECT · TEST outcome · 0.68 → 0.81 (high) ↑ #12 → #2`; auto-stops
  when every pathway is complete.
- **Design** — product-grade: Inter type, ambient background, glass sticky
  header with live data-source pill, hairline cards, numbered stepper, sticky
  table headers, dark chart tooltips, skeletons, indigo focus accent, tier
  colors reserved for risk semantics, light + dark themes.

---

## 11. Configuration

All env vars (see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `HIGH_RISK_THRESHOLD` / `MEDIUM_RISK_THRESHOLD` | `0.7` / `0.4` | Tier bucketing (API + training) |
| `OASIS_DATA_MODE` | `synthetic` | `real` forces the 150-subject OASIS cohort |
| `DATABASE_URL` | unset | Enables PostgreSQL persistence (`backend/app/db.py`) |
| `PROJECT_ROOT` | auto | Artifact/data root (override in Docker) |
| `RISK_SCORES_PATH` / `MODEL_PATH` / `MODEL_META_PATH` / `GLOBAL_IMPORTANCE_PATH` | `data/processed/…`, `artifacts/…` | Artifact locations |
| `VITE_API_URL` | `http://127.0.0.1:8000` | API base URL for the frontend |
| `CORS_ORIGINS` | unset | Comma-separated extra allowed origins |

PostgreSQL (optional): with `DATABASE_URL` set, `db.py` creates the blueprint
schema (`patients`, `cognitive_assessments`, `comorbidities`, `lab_results`,
`risk_factors`, `pipeline_history`), seeds from the same source, and persists
stage advances across restarts.

---

## 12. Verification checklist (run this to prove it works)

```bash
# 1. Data + model
python scripts/generate_adni_like_v2.py
python scripts/train_model.py
#    expect: CV AUC ≈ 0.84, SHAP table, "[done] wrote: artifacts/…"

# 2. API
cd backend && uvicorn app.main:app --reload
curl http://127.0.0.1:8000/health                       # data_source: synthetic
curl "http://127.0.0.1:8000/patients?limit=3"           # top-3 ranked subjects
curl http://127.0.0.1:8000/patients/ADNI-0001/explain   # full attribution
curl -X POST http://127.0.0.1:8000/workup/next          # one autonomous step
curl -X POST http://127.0.0.1:8000/patients/ADNI-0001/advance-stage \
     -H "Content-Type: application/json" -d '{}'
#    expect: order + auto result + rescored; a low-tier subject 409s

# 3. API tests
cd backend && pip install -r requirements-dev.txt && pytest    # 23 tests

# 4. Dashboard
npm install && npm run dev   # open :5173 → toggle Autonomous Triage
```

---

## 13. Limitations (stated honestly)

- **The current served model is trained on synthetic data.** The v2 cohort is
  ADNI-1-proportioned and clinically plausible (severity-correlated biomarkers,
  realistic reference ranges), but it is generated, not observed. The model
  card, `/model/info` and `/health` all disclose `data_mode: synthetic`. The
  real-OASIS model (cognition + volumes only) remains reproducible via
  `--data real`.
- **Cohort bias**: OASIS skews Western, highly educated, research-cohort — not
  representative of a general clinical population. Real deployment needs local
  validation data.
- **PET signal is thin even in v2**: `tau_positive` ≈ 0 SHAP weight because
  amyloid/tau status correlate in the generator; real ADNI-scale data would
  rank amyloid/tau PET among the strongest predictors.
- **Optimistic holdout**: early stopping used the test set (documented in
  `eval_report.txt`); CV AUC is the honest estimate.
- **Simulated results**: ordering a test derives a plausible result from the
  subject's severity — a demo stand-in for a real LIS/RIS integration.
- **Not a diagnostic device**: prioritization support only; final decisions
  rest with the clinician.

---

## 14. Explicitly out of scope

- CI / GitHub Actions (requested to skip)
- Apache Airflow deployment (cron-friendly `run_pipeline.py` provided instead)
- Real ADNI/OASIS-3 biomarker ingestion (requires registration + manual downloads)
- Authentication / multi-clinician accounts (demo prototype)

---

## 15. Stack

Python 3.11 · Pandas/NumPy · scikit-learn · XGBoost · SHAP · FastAPI · Uvicorn ·
Pydantic · SQLAlchemy/PostgreSQL · React 18 · Vite · Tailwind CSS · Recharts ·
Docker/docker-compose · nginx · pytest
