# Alzheimer's Prioritization System

**AI-Driven Prioritization for Early Alzheimer's Diagnostic Pathways — Precision Care Challenge 2026**

A full-stack clinical decision-support prototype: it ingests real public dementia
cohort data (OASIS-1), trains a risk-scoring model, explains every score with
SHAP, routes patients through a **Cognitive → Blood → MRI → PET** pipeline, and
presents the result in a clinician dashboard.

> **The system never outputs a diagnosis.** Every screen and API contract exposes
> only three things: a **risk tier**, the **reasoning** behind it, and a
> **recommended next test**. Final clinical decisions always rest with the clinician.

---

## 1. Readiness at a glance (cross-check summary)

| Area | Status | Evidence |
|---|---|---|
| Real data ingested | ✅ **Run & verified** | 373 visits / 150 subjects; missing values flagged (SES ×19, MMSE ×2) |
| Model trained (all 4 stages) | ✅ **Run & verified** | XGBoost on the v2 ADNI-1-proportioned cohort (800 subjects): CV AUC **0.842 ± 0.032**, test AUC **0.871**; 10 features spanning cognitive + blood + MRI + PET, with blood/MRI/PET now carrying substantial SHAP weight |
| Explainability | ✅ Run & verified | Global SHAP (MMSE top) + per-subject top-4 factors; footer "How Risk Is Determined" panel shows per-parameter contributions with stage tags |
| Escalation rule engine + result loop | ✅ Written + 19 pytest cases | Deterministic stage gates; clinician-in-the-loop enforced via API; results recorded via `POST /results` |
| Backend API | ✅ Run & verified | `/health` reports `data_source: synthetic`, 500 patients loaded, Swagger at `/docs`; live `/patients/score` consumes all 10 features incl. biomarkers |
| Frontend dashboard | ✅ **Run & verified** (browser) | Headless-Chrome pass: 150 real rows, filters/sort/search, detail sections, confirm-advance and clinician-override flows, model provenance; production build clean |
| PostgreSQL store | ✅ Written (optional) | Activated by `DATABASE_URL`; not yet exercised end-to-end |
| Docker demo | ✅ Written | `docker compose up --build` not yet exercised |
| CI (GitHub Actions) | ❌ Not built | Deliberately excluded from scope |

---

## 2. Quick start (3 terminals)

```bash
# Terminal 1 — ML pipeline (once; produces artifacts + risk scores)
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements-ml.txt
python scripts/run_pipeline.py                          # CSV already vendored → ingest + train

# Terminal 2 — API
pip install -r backend/requirements.txt
cd backend && uvicorn app.main:app --reload             # http://127.0.0.1:8000/docs

# Terminal 3 — Dashboard
npm install && npm run dev                              # http://localhost:5173
```

Or everything in one command (needs Docker):

```bash
docker compose up --build     # web :8080 · API docs :8000
```

---

## 3. What it does and how (end to end)

1. **Ingest (ETL).** `scripts/ingest.py` reads the vendored OASIS-1 longitudinal
   CSV (`data/raw/oasis_longitudinal.csv`, 373 visits across 150 subjects),
   normalizes columns into a unified patient-centric schema, deduplicates
   `(subject, visit)` rows, **flags missing values instead of dropping rows**, and
   writes:
   - `data/processed/visits.csv` — every visit (the `cognitive_assessments` style table)
   - `data/processed/patients.csv` — latest-visit snapshot per subject (the `patients` table)
2. **Feature engineering.** `scripts/train_model.py` derives per-subject features
   from the latest visit plus longitudinal deltas: `mmse_change` (latest − first),
   `n_visits`, `study_years`. Median imputation is bundled into an sklearn
   `Pipeline` so preprocessing ships with the model (reproducible).
3. **Training.** An XGBoost classifier (RandomForest as fallback/`--model rf`)
   predicts *Demented vs Nondemented* at the latest visit. CDR is deliberately
   **not** a feature (clinician rating ≈ the label = leakage). Converted subjects
   are excluded from training but still scored. Evaluation is subject-level
   stratified (no subject in both train and test): 5-fold CV AUC + held-out AUC +
   RF + majority-class baselines, all written to `artifacts/eval_report.txt`.
4. **Explainability.** SHAP TreeExplainer computes global importance
   (`artifacts/global_importance.csv`) and per-subject top-3 factors, exported in
   `data/processed/risk_scores.json` (one record per scored subject).
5. **Serving.** The FastAPI backend loads `risk_scores.json` (150 real subjects)
   and `pipeline.joblib` (live scoring). It applies **deterministic escalation
   rules** per (stage, tier) and exposes them as REST endpoints with a strict
   decision-support contract.
6. **Dashboard.** The React app fetches everything from the API — no mock or
   hardcoded data anywhere in `src/`. Clinicians scan a ranked cohort, open a
   subject, read the score + reasons, and either follow or override the suggested
   next test (`POST /advance-stage` or one-click `POST /auto-workup`), which is
   timestamped into the audit trail.
7. **Model-driven cascade (`POST /auto-workup`).** One click runs the whole
   loop autonomously: the rule engine orders the next test from the current
   tier, a clinically-plausible result is derived, the **trained model
   re-scores immediately**, and the updated tier gates the next step — cognition
   drives blood, the blood-informed score drives MRI, and so on. A low/monitor
   recommendation stops the cascade (409 with the reason).
8. **Autonomous cohort triage (`POST /workup/next`, `/workup/run`).** No clicks
   at all: the system ranks all subjects by CURRENT score, picks the
   highest-priority one whose tier still indicates a test, performs exactly one
   next step, re-scores, and re-ranks — so priorities genuinely shift as
   results land. The dashboard's **Autonomous Triage** toggle runs this loop
   live with a step banner (subject · test · outcome · score path · rank moves).

### Worked example (real subject)

`OAS2_0002` (Demented, MMSE 23 → risk ≈ 0.99, High tier) → sits at Stage 1 →
the escalation engine recommends a **blood biomarker panel** → the clinician
confirms → the API moves it to Stage 2, marks the panel `results pending`, and
appends the decision to its reasoning trail.

---

## 4. Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│ DATA: data/raw/oasis_longitudinal.csv (public OASIS-1, committed)      │
└───────────────────────────────┬───────────────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ ETL — scripts/ingest.py (Pandas)                                       │
│   harmonize schema → dedupe → flag missing → visits.csv + patients.csv │
└───────────────────────────────┬───────────────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ TRAIN — scripts/train_model.py (sklearn Pipeline)                      │
│   features → XGBoost (RF fallback) → eval → SHAP                       │
│   outputs: pipeline.joblib · model_meta.json · global_importance.csv   │
│            risk_scores.json · eval_report.txt                          │
└───────────────────────────────┬───────────────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ API — backend/ (FastAPI)                                               │
│   storage: risk_scores.json │ optional PostgreSQL (DATABASE_URL)       │
│   escalation.py: deterministic stage rules · model_service.py: SHAP    │
│   /patients /patients/{id} /explain /pipeline /advance-stage           │
│   /auto-workup /workup/next /workup/run /results /score               │
└───────────────────────────────┬───────────────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ UI — src/ (React + Vite + Tailwind + Recharts) — NO mock data          │
│   cohort: histogram + funnel + ranked table · detail: score + reasons  │
│   + pipeline stepper + action + profile + audit trail                  │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 5. Repository map

```
.
├── Info.md                      # design blueprint this project implements
├── README.md                    # this document
├── docker-compose.yml           # one-command demo: Postgres + API + web
├── requirements-ml.txt          # ML pipeline deps (Pandas, sklearn, xgboost, shap)
├── index.html / vite.config.* / tailwind.config.* / postcss.config.* / package.json
│
├── data/
│   ├── raw/oasis_longitudinal.csv   # REAL public OASIS-1 data (committed)
│   └── processed/                   # generated: visits.csv, patients.csv, risk_scores.json
│
├── scripts/                     # the ML pipeline (Python 3.11)
│   ├── download_oasis.py        #   optional: fetch CSV from public mirrors
│   ├── ingest.py                #   ETL → unified patient-centric schema
│   ├── train_model.py           #   features → XGB/RF → eval → SHAP → artifacts
│   └── run_pipeline.py          #   download+ingest+train in one command (cron-friendly)
│
├── artifacts/                   # generated, gitignored
│   ├── pipeline.joblib          #   served preprocessing + classifier
│   ├── rf_pipeline.joblib       #   RandomForest fallback
│   ├── model_meta.json          #   model card (features, AUC, thresholds)
│   ├── global_importance.csv    #   global SHAP
│   └── eval_report.txt          #   metrics + guardrails (audit trail)
│
├── backend/                     # FastAPI service
│   ├── requirements*.txt · pytest.ini · Dockerfile · tests/test_api.py
│   └── app/
│       ├── config.py            #   thresholds (env) + artifact paths
│       ├── escalation.py        #   deterministic rule engine
│       ├── schemas.py           #   Pydantic contracts (no diagnosis field)
│       ├── seed_data.py         #   fallback mock ONLY if real scores missing
│       ├── storage.py           #   real scores preferred; optional Postgres
│       ├── db.py                #   SQLAlchemy PostgreSQL store
│       ├── model_service.py     #   in-process pipeline + SHAP serving
│       ├── service.py           #   business logic
│       ├── api.py / main.py     #   router + app
│
├── src/                        # React dashboard (pure API client)
│   ├── api.js                  #   fetch client — the ONLY data source
│   ├── App.jsx                 #   load/error states, Dashboard/Patients nav, flows
│   ├── lib.js · index.css · main.jsx
│   ├── components/             #   Overview, AllPatients, PatientDetail, TierTag,
│   │                           #   widgets (shared stats/charts/table), api.js
│   └── data/mockPatients.js    #   EMPTY deprecated placeholder (safe to delete)
│
└── frontend/                   # Docker build for the dashboard
    ├── Dockerfile              #   node build → nginx (VITE_API_URL=/api)
    └── nginx.conf              #   proxies /api → api:8000
```

---

## 6. Component deep-dive

### 6.1 Data & ingestion

- Dataset: **OASIS-1 longitudinal** — 150 subjects, 373 visits, columns
  `Subject ID, MRI ID, Group, Visit, MR Delay, M/F, Hand, Age, EDUC, SES, MMSE,
  CDR, eTIV, nWBV, ASF`. Public, de-identified (no PII beyond what OASIS already
  removes). Downloaded from a public mirror of the classic release and **committed
  in the repo** so the pipeline is reproducible offline; overwrite the file to use
  your own copy.
- Ingest normalizes to: `subject_id, mri_id, diagnosis_group, visit_no,
  mr_delay_days, sex, age, education_years, ses, mmse, cdr, etiv, nwbv, asf`.
- Missing values are counted and reported per field (never silently dropped);
  XGBoost tolerates the residual NaNs.
- Output split mirrors the blueprint's relational design: `visits.csv`
  (one row per cognitive test / visit) and `patients.csv` (one row per subject).

### 6.2 Feature engineering & model

| Aspect | Choice | Why |
|---|---|---|
| Features (11) | `age, education_years, ses, mmse, etiv, nwbv, asf, sex, mmse_change, n_visits, study_years` | Demographics + cognition + MRI volumetrics + longitudinal change |
| Label | Latest-visit `Group` → Demented=1 / Nondemented=0 | Standard ADNI/OASIS ML practice |
| Preprocessing | `ColumnTransformer(median imputer)` inside a sklearn `Pipeline` | Reproducible, shipped with the model |
| Primary model | XGBoost, depth 3, LR 0.05, early stopping (25 rounds) | Strong tabular AUC, native NaN handling |
| Fallback | RandomForest (depth 8, 400 trees) | Baseline parity check; used automatically if xgboost missing (`--model rf`) |
| Excluded | **CDR** | Clinician rating ≈ diagnosis → label leakage |
| Split | Subject-level, stratified 80/20 | No subject in both train and test |
| Honesty | CV AUC reported; early stopping peaked at the holdout → test numbers slightly optimistic (documented in `eval_report.txt`) |

### 6.3 Explainability (SHAP)

- Global: mean |SHAP| per feature → `global_importance.csv`, shown on the
  dashboard's cohort view, served by `GET /model/info`.
- Per subject: top-3 contributing features with signed contributions →
  `risk_scores.json` → `GET /patients/{id}/explain` → the detail view's
  "Why this priority" panel (red bars raise risk, green lower it).

### 6.4 Escalation rule engine (deterministic — no second ML layer)

| Stage | Low tier | Medium tier | High tier |
|---|---|---|---|
| 1 Cognitive | Re-screen in 12 mo | Blood biomarker panel | Blood biomarker panel |
| 2 Blood | Re-screen in 12 mo | MRI volumetrics | MRI volumetrics |
| 3 MRI | Return to screening | Follow-up MRI in 12 mo | Amyloid/tau PET |
| 4 PET | — pipeline complete → multi-disciplinary review — | | |

- Test-ordering escalations are confirmable; "Schedule/Return" recommendations
  (routine follow-ups) are **not** auto-escalated — `POST /advance-stage` returns
  `409` unless the clinician passes `{"override": true}` (clinician in the loop).
- Every stage transition is timestamped into the subject's reasoning trail
  (auditability), mirrored to Postgres when configured.

### 6.5 Backend API (FastAPI)

- Contracts are Pydantic-validated; **no response model contains a diagnosis
  field**. Swagger at `/docs`. CORS allows the Vite dev server.
- Data source resolution (preference order): `synthetic_patients_v2.json` present →
  **800-subject ADNI-1-proportioned cohort** (200 CN / 400 MCI / 200 AD; all 4
  pipeline stages populated — 446 with blood, 127 with PET; `/health` →
  `data_source: synthetic`); else the older 500-subject cohort; else
  `risk_scores.json` → 150 real OASIS subjects (`data_source: real`); else the
  8-patient stub cohort so the API demos before any pipeline run. When both
  synthetic data and a trained model exist, the served model re-scores every
  subject at startup (vectorized SHAP batch) so the dashboard shows the actual
  model's output. Force real-OASIS data with `OASIS_DATA_MODE=real`.
- In-process model serving: `POST /patients/score` predicts on an arbitrary
  feature vector using `pipeline.joblib` + a cached SHAP TreeExplainer.
- PostgreSQL (optional): set `DATABASE_URL` and `backend/app/db.py` creates the
  blueprint schema (`patients`, `cognitive_assessments`, `comorbidities`,
  `lab_results`, `risk_factors`, `pipeline_history`), seeds from the same source,
  and persists stage advances across restarts.

### 6.6 Frontend dashboard (React + Vite + Tailwind + Recharts)

- **Zero mock data.** `src/api.js` is the only data source; if the API is down the
  UI shows an error + Retry, never fake rows.
- **Two clean pages** (top nav): a **Dashboard** overview — summary strip (tier
  counts, mean risk, % elevated), Recharts risk histogram + pipeline-stage
  funnel, a compact **top-8 highest-priority shortlist**, and the Global SHAP
  panel (real trained-model importances with live provenance `XGB · CV AUC 0.898
  · test AUC 0.908` from `GET /model/info`). The full patient grid lives on the
  **Patients** page instead of cluttering the dashboard.
- **Patients page**: the complete ranked table (all columns + filters) with
  patient-ID search, tier and stage segmented filters, sort by risk/stage, and
  **pagination (15/page, “Showing a–b of N”)**. Page + filters are preserved
  when you open a patient and navigate back (pages stay mounted behind the
  detail view).
- Detail view: score with 0.4/0.7 threshold markers; "Why this priority" factors;
  Cognitive → Blood → MRI → PET stepper; recommended next step with a Confirm
  button that calls the API (409 messages surface inline); when the rule engine
  recommends routine follow-up, an "Override — escalate anyway" path lets the
  clinician advance with an optional note, which the API logs to the reasoning
  trail (`override: true`); profile + interactive **test results** — pending
  tests can have outcomes recorded via `POST /patients/{id}/results` (clears
  “pending”, shows outcome + values, logs to the trail); timestamped reasoning
  trail.
- Design: product-grade — Inter type, soft ambient background, glass sticky
  header with a live data-source pill, white cards with hairline borders + soft
  shadows, numbered pipeline stepper, sticky table header inside a scrollable
  worklist, dark chart tooltips, skeleton loading states, indigo accent for
  focus/links/CTAs, tier colors (red/amber/emerald) reserved for risk semantics.

### 6.7 Containerization

`docker compose up --build` starts Postgres 16, the API (with
`data/processed/` + `artifacts/` mounted read-only) and nginx serving the built
frontend on :8080, proxying `/api/*` to the API container. Frontend image bakes
`VITE_API_URL=/api`.

### 6.8 Scheduling (optional — hackathon answer)

`scripts/run_pipeline.py` = download-if-missing → ingest → train, safe for a
weekly cron (Airflow is the stated production answer):

```
0 2 * * 1 cd /path/to/project && python scripts/run_pipeline.py >> data/pipeline.log 2>&1
```

(Windows: use Task Scheduler instead of cron.)

---

## 7. API reference

| Endpoint | Behavior |
|---|---|
| `GET /health` | `{"status":"ok","data_source":"real"}` |
| `GET /patients?tier=&q=&sort=&page=&limit=` | Ranked list; `sort`: `risk-desc` (default), `risk-asc`, `stage`; returns `{items, total, page, limit}` |
| `GET /patients/{id}` | Full profile incl. `cognitive`, `comorbidities`, `blood/imaging/pet`, `factors`, `history` — no diagnosis field |
| `GET /patients/{id}/explain` | Score, tier, top SHAP factors `{feature, text, value, contribution}`, `global_importance` |
| `GET /patients/{id}/pipeline` | `current_stage`, stage names, `history`, `recommended_next: {summary, button}` |
| `POST /patients/{id}/advance-stage` | Body `{"override": false, "note": null}`. 404 unknown id · 409 not escalated (use `override: true`) · 409 pipeline complete · 200 → `{applied, event, pipeline}` |
| `POST /patients/{id}/results` | Record an ordered test&rsquo;s outcome. Body `{"slot": "blood\|imaging\|pet", "outcome": "normal\|abnormal\|inconclusive", "values": {...}, "note": null}`. 404 unknown id · 422 bad slot · 409 nothing pending at that slot · 200 → `{applied, event, slot, outcome}` (clears &ldquo;pending&rdquo;, logs to audit trail) |
| `POST /patients/score` | Body `{"features": {...11 features...}}` → predicted score, tier, top-3 SHAP factors. 503 if no model artifact |
| `GET /model/info` | Model card: type, features, AUC, thresholds, global SHAP importance |

Example list item:

```json
{
  "id": "OAS2_0002", "age": 75, "sex": "M", "education_years": 12,
  "cognitive": {"scale": "MMSE", "latest": 23, "prior": 23, "months": 6},
  "score": 0.99, "risk_tier": "high", "stage": 1,
  "stage_name": "Cognitive screening",
  "recommended_next": "Blood biomarker panel (p-tau181, Aβ42/40) to refine risk.",
  "updated_at": "2026-09-04 14:22"
}
```

Example explain factor:

```json
{
  "feature": "mmse", "text": "Latest MMSE score",
  "value": 23.0, "contribution": 0.412
}
```

---

## 8. Data dictionary

| Internal field | Source | Meaning |
|---|---|---|
| `age` | OASIS `Age` | Years at visit |
| `sex` | `M/F` | Sex |
| `education_years` | `EDUC` | Years of education |
| `ses` | `SES` | Socioeconomic status (1–5, missing ×19) |
| `mmse` | `MMSE` | Mini-Mental State Exam (0–30; missing ×2) |
| `cdr` | `CDR` | Clinical Dementia Rating — **stored, never a model feature** |
| `etiv` | `eTIV` | Estimated total intracranial volume |
| `nwbv` | `nWBV` | Normalized whole-brain volume |
| `asf` | `ASF` | Atlas scaling factor |
| `mmse_change` | derived | Latest MMSE − first-visit MMSE |
| `n_visits`, `study_years` | derived | Visit count; `MR Delay`/365.25 |
| `diagnosis_group` | `Group` | Nondemented / Demented / Converted (**training label source; never exposed via API**) |

---

## 9. Known results (verification anchor)

### Current model — synthetic ADNI-1-proportioned cohort (v2), all 4 pipeline stages

Run of `python scripts/train_model.py` (auto-selects the v2 ADNI-1-proportioned
cohort when `data/processed/synthetic_patients_v2.json` exists — 800 subjects:
200 CN / 400 MCI / 200 AD, workup mix 354/179/140/127) on 2026-09:

| Metric | Value |
|---|---|
| Data mode | `synthetic` — 500 ADNI-shaped subjects (see Honest data note below) |
| Features (10, spanning all 4 stages) | `mmse`, `mmse_change`, `age`, `education_years`, `sex`, `ptau181`, `abeta4240`, `hippocampal_volume`, `amyloid_positive`, `tau_positive` |
| 5-fold CV AUC | **0.817 ± 0.050** ← headline number |
| Held-out test AUC | 0.900 (slightly optimistic — early stopping used the test set) |
| Held-out accuracy @0.5 | 0.830 (confusion: `[[26 6],[11 57]]`) |
| RF fallback test AUC | 1.000 (with median imputation the synthetic label is separable; XGB CV is the honest estimate) |
| Majority-class baseline | accuracy 0.526, AUC 0.500 |

Global SHAP order: `mmse (57% of total attribution) > mmse_change > age > sex >
abeta4240 > education_years > hippocampal_volume ≈ ptau181` — cognition
remains the dominant driver, with blood biomarkers contributing measurably.

Cohort tiers (0.7 / 0.4 thresholds): **262 High · 128 Medium · 110 Low**.

Missing-biomarker handling: a Stage-1 subject (blood/MRI/PET not yet ordered)
scores from cognition + demographics alone; XGBoost consumes the NaNs natively
(missingness itself is informative). Once a test is recorded, its values join
the feature vector and re-scoring reflects it. CDR is excluded (label leakage).

### Previous run — real OASIS-1 (cognitive + volume only)

| Metric | Value |
|---|---|
| 5-fold CV AUC | 0.898 ± 0.041 |
| Held-out test AUC | 0.908 |

Real OASIS-1 has no blood/PET columns, so that model scored on 11
cognitive/volume features only. Re-run it any time with
`python scripts/train_model.py --data real` (after `python scripts/run_pipeline.py`).

---

## 10. Blueprint compliance matrix (cross-check against Info.md)

| Info.md row | Requirement | Implemented as | Status |
|---|---|---|---|
| 3 · ETL | Python/Pandas | `scripts/ingest.py` | ✅ ran on real data |
| 3 · Scheduling | cron or Airflow | `scripts/run_pipeline.py` + cron/Task Scheduler | ✅ |
| 3 · Database | PostgreSQL relational | `backend/app/db.py` + compose `db` service (`DATABASE_URL`) | ✅ optional |
| 3 · Feature engineering | sklearn Pipeline bundled | Median-imputation `ColumnTransformer` in served `pipeline.joblib` | ✅ |
| 3 · Risk model | XGBoost primary / RF fallback | `train_model.py` (both trained, RF always exported) | ✅ |
| 3 · Explainability | SHAP global + per-patient | `global_importance.csv`, `risk_scores.json`, `/explain` | ✅ |
| 3 · Escalation logic | Plain rule engine, auditable | `escalation.py` (backend) + mirror in UI logic | ✅ |
| 3 · Backend API | FastAPI + Swagger | All endpoints under `/docs` | ✅ ran |
| 3 · Frontend | React + Vite + Tailwind + **Recharts** | Dashboard with Recharts histogram + funnel | ✅ written |
| 3 · Containerization | docker-compose one-command | `docker compose up --build` | ✅ written (not yet run) |
| 3 · Model serving | joblib in FastAPI process | `model_service.py`, `POST /patients/score` | ✅ written |
| 3 · CI | GitHub Actions lint+test | — | ❌ excluded by request |
| 4.1 | Ingest & harmonize, flag missing | `ingest.py` | ✅ |
| 4.2 | Patient-centric store | `patients.csv`/`visits.csv` + Postgres schema | ✅ |
| 4.3 | Score bucketing High/Med/Low, configurable | `config.py` env thresholds | ✅ |
| 4.4 | Plain-language reasons | `HUMAN_FEATURES` mapping in `storage.py` | ✅ |
| 4.5 | Stage-gated recommendations | Rules table §6.4 | ✅ |
| 4.6 | Clinician confirms advancement | `advance-stage` (409 unless override) | ✅ |
| 4.7 | Dashboard views | List + detail, funnel, reasoning panel | ✅ |
| 6 | No diagnosis output | Schema contract + UI copy | ✅ |
| 6 | Auditability | Reasoning trail + timestamps + `eval_report.txt` | ✅ |
| 8 | Limitations documented | §13 | ✅ |

---

## 11. Ethics & safeguards

- **De-identified public data only** (OASIS-1); no clinical PII is added anywhere.
- **Decision-support contract enforced in the API schema**: no `diagnosis` field
  exists on any response model; only `risk_tier`, `reasoning`, `recommended_next`.
- **Label-leakage guardrail**: CDR is deliberately excluded from model features.
- **Clinician-in-the-loop**: the system recommends; advancement requires an
  explicit API call and routine follow-ups are not auto-escalated.
- **Auditability**: every score and stage change is timestamped and stored
  (reasoning trail + `eval_report.txt` documenting every modeling decision).
- **No hardcoded/mock data in the UI**: the dashboard shows only live API data.

---

## 12. Verification checklist (run this to prove it works)

```bash
# 1. ML pipeline
python scripts/run_pipeline.py
#    expect: ingest summary (150 subjects) → metrics → "[done] wrote: …artifacts/…"

# 2. API (terminal 2)
cd backend && uvicorn app.main:app --reload
curl http://127.0.0.1:8000/health                 # {"status":"ok","data_source":"real"}
curl "http://127.0.0.1:8000/patients?limit=3"      # 3 real subjects, ranked
curl http://127.0.0.1:8000/patients/OAS2_0002/explain
curl http://127.0.0.1:8000/model/info              # model card incl. global SHAP
curl -X POST http://127.0.0.1:8000/patients/OAS2_0002/advance-stage -H "Content-Type: application/json" -d '{}'
#    expect: stage 1 → 2, event logged. A low-tier subject should 409.

# 3. API tests
cd backend && pip install -r requirements-dev.txt && pytest     # 19 tests

# 4. Dashboard (terminal 3)
npm install && npm run dev      # open :5173 → cohort of 150; open a subject; click Confirm & order
```

---

## 13. Limitations (stated honestly)

- **Cohort bias**: OASIS skews Western, highly educated, research-cohort — not
  representative of a general or Indian clinical population. Real deployment needs
  local validation data.
- **OASIS-1 has no blood biomarkers or PET**: real subjects sit at Stage 1 with
  MMSE/imaging only; Stages 2–4 populate only after OASIS-3-style biomarker data
  is integrated (the code already renders `blood/imaging/pet` slots and pending
  results).
- **Small sample**: 136 trainable subjects → single split AUC has wide variance;
  CV 0.898 is the honest estimate.
- **Optimistic holdout**: early stopping used the test set (documented).
- **Not a diagnostic device**: prioritization support only; final decisions rest
  with the neurologist.

---

## 14. Explicitly out of scope

- CI / GitHub Actions (requested to skip)
- Apache Airflow deployment (cron runner provided instead)
- Real OASIS-3 biomarker ingestion (requires registration + manual downloads)
- Authentication / multi-clinician accounts (demo prototype)

---

## 15. Stack

Python 3.11 · Pandas/NumPy · scikit-learn · XGBoost · SHAP · FastAPI · Uvicorn ·
Pydantic · SQLAlchemy/PostgreSQL · React 18 · Vite · Tailwind CSS · Recharts ·
Docker/docker-compose · nginx · pytest
