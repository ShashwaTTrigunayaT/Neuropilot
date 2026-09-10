# NeuroPilot — Alzheimer's Prioritization System

**AI-Driven Prioritization for Early Alzheimer's Diagnostic Pathways — Precision Care Challenge 2026**

A full-stack clinical decision-support prototype: it ingests a dementia cohort,
trains a risk-scoring model on measures spanning **cognition, blood biomarkers,
MRI volumetrics and PET**, explains every score with SHAP, routes patients
through a **Cognitive → Blood → MRI → PET** pipeline, and — when enabled —
**drives the entire workup autonomously**: it ranks the cohort, picks the
highest-priority subject itself, orders the next indicated test, re-scores, and
re-ranks live.

On top of the snapshot risk score, a second model family — the **Progression
Forecaster** — predicts *where each patient is headed*: expected MMSE change
over the next 12 months, the probability of clinical progression (converting to
the next diagnostic phase), and the projected future risk tier, rendered as an
observed-vs-predicted trajectory chart with the risk score at the moment each
stage test was completed.

> **The system never outputs a diagnosis.** Every screen and API contract exposes
> only three things: a **risk tier**, the **reasoning** behind it, and a
> **recommended next test**. Final clinical decisions always rest with the clinician.

---

## 1. Readiness at a glance

| Area | Status | Evidence |
|---|---|---|
| Data pipeline (ETL) | Run & verified | Real OASIS-1: 373 visits / 150 subjects; missing values flagged (SES ×19, MMSE ×2), never silently dropped |
| Synthetic ADNI-shaped cohort | Run & verified | 800 subjects in true ADNI-1 proportions (200 CN / 400 MCI / 200 AD); workup mix 354 / 179 / 140 / 127 across Stages 1–4 |
| 12-month follow-up simulation | Run & verified | `scripts/simulate_followup.py`: biomarker-driven trajectories, 133 conversions (16.6%); AD declines fastest (−2.83 MMSE/yr), CN slowest (−0.34) |
| Risk model trained (all 4 stages) | Run & verified | XGBoost, 10 features spanning cognition + blood + MRI + PET; CV AUC **0.842 ± 0.032**, test AUC **0.871** |
| Progression forecaster trained | Run & verified | XGBRegressor + XGBClassifier on the same 10 features; MMSE-delta MAE **0.611 pts** (R² 0.679), conversion ROC AUC **0.770** (PR AUC 0.465 vs 16.6% prevalence ≈ 2.8× lift) |
| Explainability | Run & verified | Global SHAP + full per-subject attribution (all 10 factors, grouped by pipeline stage, with `model default` badges for un-ordered tests) |
| Escalation rule engine | 24 pytest cases | Deterministic stage gates; clinician-in-the-loop via `override: true`; results loop via `POST /results` |
| Autonomous triage | Run & verified (browser E2E) | `POST /workup/next` / `/workup/run`: model picks subject → orders test → re-scores → re-ranks; live rank movements (e.g. `#12 → #2` after an abnormal blood panel) |
| Progression forecast served | Run & verified (local + Railway) | `GET /patients/{id}/progression` → trajectory, conversion probability with SHAP drivers, projected tier, stage-completion score checkpoints |
| Backend API | Run & verified | FastAPI + Swagger at `/docs`; `/health` reports `data_source` (e.g. `real+postgres` on Railway); live scoring via `pipeline.joblib` |
| Frontend dashboard | Run & verified (headless Chrome) | Zero mock data; ranked cohort, detail view, full-page progression view, risk simulator on the real 10-feature model; production build clean |
| PostgreSQL store | Run & verified (Railway) | Activated by `DATABASE_URL`; schema created + seeded on boot, persists workup history across restarts |
| Docker demo | Written | `docker compose up --build` (single-image Railway deploy is the exercised path) |
| CI (GitHub Actions) | Not built | Deliberately excluded from scope |

---

## 2. Quick start (3 terminals)

```bash
# Terminal 1 — ML pipeline (once; generates data + artifacts)
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements-ml.txt
python scripts/generate_adni_like_v2.py                # 800-subject ADNI-shaped cohort
python scripts/train_model.py                          # risk model + SHAP + artifacts

# Optional — the progression forecaster (uses the cohort above)
python scripts/simulate_followup.py                    # 12-month follow-up labels
python scripts/train_progression_model.py              # delta + conversion models

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
The *derived* artifacts — trained models (risk + progression) + risk scores —
**are committed** so a fresh deploy (Railway/Docker) serves both model families
without re-training:

| Path | What it is | How to get it |
|---|---|---|
| `data/raw/oasis_longitudinal.csv` | Real public OASIS-1 longitudinal CSV (150 subjects, 373 visits) | `python scripts/download_oasis.py` or manual download (see `data/raw/README.md`) |
| `data/processed/synthetic_patients_v2.json` | 800-subject synthetic cohort, ADNI-1 proportions, all 4 pipeline stages | `python scripts/generate_adni_like_v2.py` |
| `data/processed/synthetic_patients.json` | Legacy 500-subject synthetic cohort | `python scripts/generate_adni_like.py` |
| `data/processed/followup_12mo.json` | Simulated 12-month follow-up labels (MMSE drift + conversion) | `python scripts/simulate_followup.py` |
| `data/processed/visits.csv`, `patients.csv` | ETL output from real OASIS | `python scripts/ingest.py` |
| `data/processed/risk_scores.json` | Per-subject model scores + SHAP factors | **Committed** (deployment seed); regenerate with `python scripts/train_model.py` |
| `artifacts/pipeline.joblib`, `model_meta.json`, `global_importance.csv`, `eval_report.txt` | Risk model, model card, global SHAP, eval audit | **Committed** (deployment); regenerate with `python scripts/train_model.py` |
| `artifacts/progression_delta.joblib`, `progression_conversion.joblib`, `progression_meta.json`, `progression_report.txt` | Progression forecaster (MMSE-delta + conversion) + card + eval audit | **Committed** (deployment); regenerate with `python scripts/train_progression_model.py` |
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
3. **Training (risk).** XGBoost (RandomForest fallback) predicts the severity
   label. CDR is deliberately **not** a feature (clinician rating ≈ the label =
   leakage). Subject-level stratified 80/20 split; 5-fold CV + held-out metrics
   + majority-class baseline, all written to `artifacts/eval_report.txt`.
4. **Training (progression).** `scripts/simulate_followup.py` derives a
   deterministic 12-month follow-up for every subject — MMSE drift driven by the
   *observed* biomarker profile (amyloid/tau positivity accelerates decline,
   cognitive reserve slows it) and conversion labels from published base rates
   (CN ~4%/yr, MCI ~12%/yr, AD ~28%/yr) modulated by biomarker evidence.
   `scripts/train_progression_model.py` then trains two XGBoost models on the
   same 10-feature vector: an **MMSE-delta regressor** and a **conversion
   classifier** (class imbalance handled via `scale_pos_weight`).
5. **Explainability.** SHAP TreeExplainer produces global importance
   (`artifacts/global_importance.csv`) and per-subject factors. The detail view
   groups **all 10 factors by pipeline stage** (Cognition / Blood / MRI / PET);
   factors from un-ordered tests carry a dimmed **`model default`** badge — the
   model's learned missing-value path — with a footnote explaining it. The
   progression forecast exposes its own top SHAP drivers.
6. **Serving.** The FastAPI backend loads the cohort + `pipeline.joblib` and
   **re-scores every subject at startup** with the trained model (vectorized
   SHAP batch), so the dashboard shows the actual served model's output, not
   generator heuristics. Progression forecasts are computed per request and
   cached per `(patient, updated_at, stage)`.
7. **Dashboard.** React app fetches everything from the API — no mock or
   hardcoded data anywhere in `src/`. Clinicians scan a ranked cohort, open a
   subject, read score + full attribution + pipeline position + audit trail.
8. **Model-driven cascade (`POST /patients/{id}/auto-workup`).** Per-subject
   loop: the rule engine orders the next test from the current tier, a
   clinically-plausible result is derived, the **trained model re-scores
   immediately**, and the updated tier gates the next step. Stops (409) when
   the tier indicates no further testing.
9. **Autonomous cohort triage (`POST /workup/next`, `/workup/run`).** No clicks
   at all: the system ranks **all** subjects by current score, picks the
   highest-priority one whose tier still indicates a test, performs exactly one
   step, re-scores, and re-ranks — priorities genuinely shift as results land.
   The dashboard's **Autonomous Triage** header toggle runs this loop live
   (~1.4 s/step) with a banner showing subject · test · outcome · score path ·
   rank movement.
10. **12-month progression forecast (`GET /patients/{id}/progression`).** A
    full-page view behind the patient header's **Progression Probability**
    button: observed MMSE trajectory → predicted trajectory with uncertainty
    band, annotated with the pipeline stage reached today; conversion
    probability with top SHAP drivers; and the **projected risk tier** — the
    *current* risk model re-scored on the projected future vector (age+1,
    forecast MMSE, carried-forward biomarkers), so both model families stay
    consistent end-to-end. The chart also plots **the risk score at the moment
    each stage test was completed** (the trained model re-scored on the
    patient's data as it existed at that point), positioned as vertical
    outcome-colored lines with labeled markers.

### Worked example (from a live verification run)

SYN-0345 at risk 0.67 (medium) → the model orders **blood** → abnormal
p-tau181/Aβ42/40 → re-score **0.81 (high)** → MRI indicated → normal MRI pulls
it to **0.74**, still high → **PET** → pathway complete. In the cohort-level
autonomous run, an abnormal blood panel moved SYN-0087 **#12 → #2** in the
queue; later results pushed it back down — the priority queue reorders itself.
On the progression side, ADNI-0001 (MMSE 22, p-tau 5.8, Aβ42/40 0.055,
amyloid+/tau+) forecasts **MMSE 22 → 21 (−1.44 ± 1.1)** with a **90% conversion
probability**, drivers led by p-tau181 and Aβ42/40; ADNI-0500 forecasts a flat
trajectory (−0.05) at 2%.

---

## 5. Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│ DATA (never committed): data/raw/*.csv · data/processed/*.json        │
│   real OASIS-1 (optional) · synthetic ADNI-shaped cohorts             │
│   · simulated 12-month follow-up labels                               │
└───────────────────────────────┬───────────────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ GENERATE/ETL — generate_adni_like_v2.py · ingest.py                   │
│   · simulate_followup.py (12-mo trajectories, biomarker-driven)       │
│   harmonize → dedupe → flag missing → per-subject feature table       │
└───────────────────────────────┬───────────────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ TRAIN — train_model.py · train_progression_model.py (sklearn Pipeline)│
│   RISK:  10 features (4 stages) → XGBoost (RF fallback) → SHAP        │
│   PROG:  same 10 features → MMSE-delta regressor + conversion clf     │
│   artifacts: pipeline.joblib · progression_*.joblib · model cards     │
│              global_importance.csv · risk_scores.json · eval reports  │
└───────────────────────────────┬───────────────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ API — backend/ (FastAPI)                                              │
│   storage: synthetic cohort + startup batch rescore │ optional PG      │
│   escalation.py: deterministic stage rules · model_service.py: SHAP   │
│   progression.py: forecast + stage-completion score checkpoints       │
│   /patients · /patients/{id} · /explain · /pipeline · /advance-stage  │
│   /patients/{id}/auto-workup · /workup/next · /workup/run · /results  │
│   /patients/{id}/progression · /patients/score · /model/info · /health│
└───────────────────────────────┬───────────────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ UI — src/ (React + Vite + Tailwind) — NO mock data                    │
│   Overview: tier strip · risk histogram · stage funnel · top-8 list   │
│   Patients: ranked table, filters, search, pagination                 │
│   Detail: score gauge · 4-stage attribution radar · pipeline stepper  │
│           · audit trail · Progression Probability button              │
│   Progression (full page): observed-vs-predicted trajectory chart     │
│           with stage-score lane · conversion probability · drivers    │
│   Simulator: what-if workbench on the real 10-feature model           │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 6. Repository map

```
.
├── Info.md                      # design blueprint this project implements
├── README.md                    # this document
├── .env.example                 # every supported env var, documented
├── Dockerfile                   # single-image deploy: builds UI → serves via FastAPI (Railway)
├── docker-compose.yml           # one-command local demo: Postgres + API + web
├── railway.json                 # Railway deploy config (Dockerfile + start command)
├── requirements-ml.txt          # ML pipeline deps (Pandas, sklearn, xgboost, shap)
├── index.html / vite.config.js / tailwind.config.js / postcss.config.js / package.json
│
├── brand_assets/                # rendered logo/icon (PNG transparent, JPG, PDF brand sheet)
├── data/                        # datasets gitignored (see §3); derived scores committed
│   ├── raw/README.md            #   how to obtain OASIS-1
│   └── processed/risk_scores.json  # trained-model scores (deployment seed)
│
├── scripts/                     # the ML pipeline (Python 3.11)
│   ├── download_oasis.py        #   fetch real OASIS-1 CSV from a public mirror
│   ├── generate_adni_like.py    #   legacy 500-subject synthetic cohort
│   ├── generate_adni_like_v2.py #   800-subject ADNI-1-proportioned cohort (default)
│   ├── ingest.py                #   ETL real OASIS → unified patient-centric schema
│   ├── simulate_followup.py     #   deterministic 12-month follow-up labels
│   ├── train_model.py           #   features → XGB/RF → eval → SHAP → artifacts
│   ├── train_progression_model.py # delta + conversion models → artifacts
│   ├── run_pipeline.py          #   download + ingest + train in one command
│   └── render_brand_assets.cjs  #   regenerate brand_assets/ from BrandLogo.jsx (node)
│
├── artifacts/                   # trained models + cards + SHAP + eval (committed for deploy)
│   ├── pipeline.joblib          #   served preprocessing + risk classifier
│   ├── progression_delta.joblib #   12-month MMSE-delta regressor
│   ├── progression_conversion.joblib # 12-month conversion classifier
│   ├── model_meta.json / progression_meta.json  # model cards
│   ├── global_importance.csv    #   global SHAP
│   ├── eval_report.txt / progression_report.txt # metrics + guardrails (audit)
│   └── rf_pipeline.joblib       #   RF fallback (local only, gitignored)
│
├── backend/                     # FastAPI service
│   ├── requirements.txt · requirements-dev.txt · pytest.ini · Dockerfile
│   ├── tests/                   #   24 pytest cases (API + DB seed FK integrity)
│   └── app/
│       ├── config.py            #   thresholds (env) + artifact paths
│       ├── schemas.py           #   Pydantic contracts (no diagnosis field)
│       ├── seed_data.py         #   tiny fallback cohort if nothing generated
│       ├── storage.py           #   cohort loading + startup rescore; optional PG
│       ├── db.py                #   SQLAlchemy PostgreSQL store
│       ├── model_service.py     #   in-process pipeline + batch SHAP serving
│       ├── escalation.py        #   deterministic rule engine
│       ├── progression.py       #   12-month forecast + stage-score checkpoints
│       ├── service.py           #   business logic (advance, results, workups)
│       ├── api.py / main.py     #   router + app (also serves the built SPA)
│
├── src/                         # React dashboard (pure API client)
│   ├── api.js                   #   fetch client — the ONLY data source
│   ├── App.jsx                  #   views, flows, Autonomous Triage loop
│   ├── lib.js · index.css · main.jsx
│   └── components/
│       ├── Overview.jsx         #   dashboard: strip, charts, top-8, SHAP panel
│       ├── AllPatients.jsx      #   ranked table: filters, search, pagination
│       ├── PatientDetail.jsx    #   detail: score, attribution radar, actions, trail
│       ├── ProgressionView.jsx  #   full-page 12-month forecast
│       ├── TrajectoryChart.jsx  #   observed-vs-predicted MMSE + stage-score lane
│       ├── RiskSimulator.jsx    #   what-if scoring on the real 10-feature model
│       ├── FeatureRadarChart.jsx · RiskDistributionChart.jsx · StageProgressionChart.jsx
│       ├── Footer.jsx           #   telemetry + "How risk is determined" explainer
│       ├── TierTag.jsx · BrandLogo.jsx · widgets.jsx
│
└── frontend/                    # docker-compose build for the dashboard
    ├── Dockerfile               #   node build → nginx (VITE_API_URL=/api)
    └── nginx.conf               #   proxies /api → api:8000
```

---

## 7. Model cards

### 7.1 Risk model (current)

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

### 7.2 Progression forecaster (12-month horizon)

Same 10 baseline features as the risk model; labels from the simulated
follow-up (133 conversions / 16.6% prevalence; 640 train / 160 test subjects,
stratified by conversion). Synthetic trajectories — see §13.

| Model | Metric | Result |
|---|---|---|
| MMSE-delta regressor | test MAE | **0.611 pts** (mean-baseline 1.043) |
| | test RMSE / R² | 0.741 / 0.679 |
| Conversion classifier | test ROC AUC | **0.770** |
| | test PR AUC | 0.465 (vs 0.169 prevalence ≈ 2.8× lift) |
| | Brier score | 0.143 (calibration) |
| | accuracy @0.5 | 0.800 (majority baseline 0.831) |

**Guardrails** (`artifacts/progression_report.txt`): subject-level holdout;
same NaN = stage-not-ordered convention; imbalance via `scale_pos_weight` (5.04);
the projected 12-month tier comes from re-scoring the **current risk model** on
the projected future vector — one consistent model family end-to-end.

### 7.3 Previous run — real OASIS-1 (cognitive + volume features only)

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
  model's judgment. `/health` reports the resolved source (e.g. `synthetic`,
  `real`, `real+postgres`); `/debug/env` shows deploy diagnostics.
- **In-process model serving:** `POST /patients/score` predicts on an arbitrary
  feature vector with `pipeline.joblib` + a cached SHAP TreeExplainer (this
  powers the what-if **Risk Simulator** in the UI, whose controls mirror the
  real 10 features, including per-stage "Measured / Not ordered" toggles).
- **Progression serving:** `GET /patients/{id}/progression` returns the full
  forecast (404 → 503-safe: `model_available: false` when artifacts are absent).

| Endpoint | Behavior |
|---|---|
| `GET /health` | `{"status":"ok","data_source":"synthetic"}` |
| `GET /debug/env` | Deploy diagnostics: `DATABASE_URL` presence/scheme, db layer enabled (no secret values) |
| `GET /patients?tier=&q=&sort=&page=&limit=` | Ranked list; `sort`: `risk-desc` (default), `risk-asc`, `stage`; returns `{items, total, page, limit}` |
| `GET /patients/{id}` | Full profile: `cognitive`, `blood`, `imaging`, `pet`, `factors` (all, with `feature` + `value`), `history` — no diagnosis field |
| `GET /patients/{id}/explain` | Score, tier, all SHAP factors `{feature, text, value, contribution}`, `global_importance` |
| `GET /patients/{id}/pipeline` | `current_stage`, stage names, `history`, `recommended_next: {summary, button}` |
| `GET /patients/{id}/progression` | 12-month forecast: MMSE `trajectory` (observed + predicted with band), `projected` score/tier/conversion probability + drivers, `score_checkpoints` (risk score at each completed stage test), `disclaimer` |
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
  "cognitive": {"scale": "MMSE", "latest": 22, "prior": 24, "months": 6},
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

## 10. Frontend dashboard (React + Vite + Tailwind)

- **Zero mock data.** `src/api.js` is the only data source; if the API is down
  the UI shows an error + Retry, never fake rows.
- **Overview** — summary strip (tier counts, mean risk, % elevated), risk
  histogram + pipeline-stage funnel, top-8 highest-priority shortlist ranked by
  progression probability, global SHAP panel with live model provenance from
  `GET /model/info`.
- **Patients** — complete ranked table: tier/stage segmented filters, ID search,
  sort by risk/stage, pagination (15/page), page state preserved when opening a
  subject and returning.
- **Detail view** — score gauge with 0.4/0.7 threshold markers; **Clinical Risk
  Attribution** grouped by pipeline stage (Cognition / Blood / MRI / PET) with
  signed bars, measured values, and `model default` badges + footnote for
  un-ordered tests; Cognitive → Blood → MRI → PET stepper; recommended next
  step with Confirm (409 messages surface inline; "Override — escalate anyway"
  for routine follow-ups, logged with `override: true`); interactive test
  results; timestamped audit trail; **Export Consultation Report** (print).
- **Progression Probability → full-page forecast** — header button opens a
  dedicated view (not a popup): full-width **trajectory chart** — observed MMSE
  path (−6 mo → today, dashed "today" divider) → predicted path with uncertainty
  band, annotated with the stage reached today; below the plot, a dedicated
  **score lane** plots the risk score at each completed stage test (vertical
  outcome-colored lines crossing the curve, labeled diamonds: red abnormal /
  amber inconclusive / green normal) plus the **12-month projected score** at
  the right edge; metric cards for MMSE today → projected (± band), conversion
  probability (color-graded ≥60% red / 30–60% amber / <30% green), projected
  risk gauge, and top forecast drivers; back navigation returns to the same
  patient's record, `Esc` exits to the cohort.
- **Autonomous Triage** — header toggle drives the whole cohort: a step banner
  shows `SUBJECT · TEST outcome · 0.68 → 0.81 (high) ↑ #12 → #2`; auto-stops
  when every pathway is complete.
- **Risk Simulator** — what-if workbench on the live model with the real 10
  features: demographics, MMSE + change (always measured), p-tau181 /
  Aβ42/40 (blood), hippocampal volume (MRI), amyloid/tau PET toggles, with
  per-stage "Measured / Not ordered" switches that send `null` and route the
  model through its learned missing-value default — plus clinical presets and a
  live SHAP waterfall.
- **Design** — product-grade: Inter type, ambient background, glass sticky
  header with live data-source pill, hairline cards, numbered stepper, sticky
  table headers, dark chart tooltips, skeletons, indigo focus accent, tier
  colors reserved for risk semantics, light + dark themes. Brand assets
  (`brand_assets/`) are rendered from the in-app logo vector.

---

## 11. Configuration

All env vars (see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `HIGH_RISK_THRESHOLD` / `MEDIUM_RISK_THRESHOLD` | `0.7` / `0.4` | Tier bucketing (API + training) |
| `OASIS_DATA_MODE` | `synthetic` | `real` forces the 150-subject OASIS cohort |
| `DATABASE_URL` | unset | Enables PostgreSQL persistence (`backend/app/db.py`) |
| `PROJECT_ROOT` | auto | Artifact/data root (override in Docker: `/app`) |
| `RISK_SCORES_PATH` / `MODEL_PATH` / `MODEL_META_PATH` / `GLOBAL_IMPORTANCE_PATH` | `data/processed/…`, `artifacts/…` | Artifact locations |
| `VITE_API_URL` | `http://127.0.0.1:8000` | API base URL for the frontend |
| `CORS_ORIGINS` | unset | Comma-separated extra allowed origins |

PostgreSQL (optional): with `DATABASE_URL` set, `db.py` creates the blueprint
schema (`patients`, `cognitive_assessments`, `comorbidities`, `lab_results`,
`risk_factors`, `pipeline_history`), seeds from the same source, and persists
stage advances across restarts. Verified on Railway: the single `Dockerfile`
builds the React bundle (stage 1) and serves it from the FastAPI process
alongside the API on `$PORT`; committed artifacts mean no re-training on boot.
(If you add a Railway Postgres plugin, `DATABASE_URL=${{Postgres.DATABASE_PRIVATE_URL}}`
and the store activates automatically.)

---

## 12. Verification checklist (run this to prove it works)

```bash
# 1. Data + risk model
python scripts/generate_adni_like_v2.py
python scripts/train_model.py
#    expect: CV AUC ≈ 0.84, SHAP table, "[done] wrote: artifacts/…"

# 1b. Progression forecaster
python scripts/simulate_followup.py
python scripts/train_progression_model.py
#    expect: delta MAE ≈ 0.61, conversion AUC ≈ 0.77, "[done] wrote: artifacts/progression_…"

# 2. API
cd backend && uvicorn app.main:app --reload
curl http://127.0.0.1:8000/health                       # data_source: synthetic
curl "http://127.0.0.1:8000/patients?limit=3"           # top-3 ranked subjects
curl http://127.0.0.1:8000/patients/ADNI-0001/explain   # full attribution
curl http://127.0.0.1:8000/patients/ADNI-0001/progression  # 12-mo forecast
curl -X POST http://127.0.0.1:8000/workup/next          # one autonomous step
curl -X POST http://127.0.0.1:8000/patients/ADNI-0001/advance-stage \
     -H "Content-Type: application/json" -d '{}'
#    expect: order + auto result + rescored; a low-tier subject 409s

# 3. API tests
cd backend && pip install -r requirements-dev.txt && pytest    # 24 tests

# 4. Dashboard
npm install && npm run dev   # open :5173 → toggle Autonomous Triage;
                             # open a patient → "Progression Probability" → full-page forecast
```

---

## 13. Limitations (stated honestly)

- **The current served models are trained on synthetic data.** The v2 cohort is
  ADNI-1-proportioned and clinically plausible (severity-correlated biomarkers,
  realistic reference ranges), but it is generated, not observed. The model
  cards, `/model/info` and `/health` all disclose `data_mode: synthetic`. The
  real-OASIS model (cognition + volumes only) remains reproducible via
  `--data real`.
- **Progression labels are simulated trajectories**, shaped by published
  progression dynamics (CN ~4%/yr, MCI ~12%/yr, AD ~28%/yr base rates modulated
  by biomarker evidence) — not real patient outcomes. A production forecaster
  would retrain on an actual longitudinal cohort (e.g. ADNI follow-up visits).
- **The forecast is a "nothing changes" projection** — it assumes standard care
  continues; a real intervention (e.g. anti-amyloid therapy) would alter the
  trajectory. It is a probability, never a diagnosis or a guarantee.
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
