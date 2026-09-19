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
| Data pipeline (ETL) | Run & verified | **Real ADNI drop: 13 tables → 14,746 scored MMSE visits / 4,649 subjects → 3,636 subjects with a real clinician label.** Sentinels (`MMSCORE −1`, `NfL/GFAP −4/−5`, `PTGENDER −4`, `CDR/FAQ −1`, PET `qc_flag`) all filtered; nothing silently dropped |
| Real ADNI ingestion | Run & verified | `scripts/ingest_adni.py`: nearest-visit join (±183 d) across MMSE, plasma panel, FreeSurfer MRI, amyloid + tau PET, ADAS-Cog, FAQ, CDR, APOE — emits training matrix, visit table and serving records |
| Legacy paths still work | Run & verified | OASIS-1 (373 visits / 150 subjects) and the 800-subject synthetic cohort remain available via `--data real|synthetic` / `PATIENT_DATA` |
| 12-month follow-up labels | Simulated (synthetic cohort) | `scripts/simulate_followup.py` labels still drive the progression forecaster; real ADNI conversions are now available in `data/processed/adni_visits.csv` for the next retrain |
| Risk model trained on real data | Run & verified | XGBoost, **15 features across all 4 stages**; 5-fold CV AUC **0.901 ± 0.011**, held-out test AUC **0.902**, accuracy 0.812 on 3,636 real ADNI subjects |
| Leakage & robustness audit | Run & verified | FAQ (diagnosis-derived, like CDR) dropped from the feature set; early stopping moved off the test set; APOE encoding benchmarked; complete-case cross-check agrees (ρ = 0.82) — `artifacts/model_audit.txt` |
| Progression forecaster trained | Run & verified (synthetic labels) | XGBRegressor + XGBClassifier; MMSE-delta MAE **0.611 pts** (R² 0.679), conversion ROC AUC **0.770** (PR AUC 0.465 ≈ 2.8× lift) |
| Explainability | Run & verified | Global SHAP **with per-stage rollup** (`stage_importance.csv`) + full per-subject attribution; both an overall and a measured-only view, so a rarely-ordered test (PET) is not diluted to zero |
| Escalation rule engine | 39 pytest cases | Deterministic stage gates; clinician-in-the-loop via `override: true`; results loop via `POST /results`; **ordering gaps handled** — the stage stops at the first missing test and already-measured later slots are carried forward, never overwritten |
| Autonomous triage | Run & verified (browser E2E) | `POST /workup/next` / `/workup/run`: model picks subject → orders test → re-scores → re-ranks; live rank movements (e.g. `#12 → #2` after an abnormal blood panel) |
| Progression forecast served | Run & verified (local + Railway) | `GET /patients/{id}/progression` → trajectory, conversion probability with SHAP drivers, projected tier, stage-completion score checkpoints |
| Backend API | Run & verified | FastAPI + Swagger at `/docs`; `/health` reports `data_source` (e.g. `real+postgres` on Railway); live scoring via `pipeline.joblib` |
| Frontend dashboard | Run & verified (headless Chrome) | Zero mock data; ranked cohort, detail view, full-page progression view, risk simulator rebuilt on the model's real 15 features; production build clean, zero console errors |
| PostgreSQL store | Run & verified (Railway) | Activated by `DATABASE_URL`; schema created + seeded on boot, persists workup history across restarts, and **re-seeds when either the cohort or the served model changes** — a retrain can never leave stale attributions in the database |
| Docker demo | Written | `docker compose up --build` (single-image Railway deploy is the exercised path) |
| CI (GitHub Actions) | Not built | Deliberately excluded from scope |

---

## 2. Quick start (3 terminals)

```bash
# Terminal 1 — ML pipeline (once; generates data + artifacts)
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements-ml.txt
# Preferred — real ADNI drop: place the 13 CSVs in "ADNI DATA/" then:
python scripts/ingest_adni.py                          # 13 tables → features + serving cohort
python scripts/train_model.py --data adni              # risk model + SHAP + artifacts
# or the one-command runner (detects the ADNI drop automatically):
python scripts/run_pipeline.py

# Fallback — synthetic cohort (no real data needed)
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
| `data/processed/risk_scores.json` | Per-subject model scores + SHAP attributions. On real ADNI it is written **de-identified** — subject ID, score and feature attributions only, no age/sex/MMSE/ADAS/FAQ/biomarker values, because ADNI is DUA-restricted | **Committed** (deployment seed); regenerate with `python scripts/train_model.py` |
| `data/processed/adni_cohort.json`, `adni_features.csv`, `adni_visits.csv` | Real ADNI serving records, training matrix and longitudinal visit table | **Gitignored** (regenerate with `python scripts/ingest_adni.py`) |
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
   leakage) and neither is **FAQ** (part of ADNI's diagnostic algorithm).
   Subject-level stratified 80/20 split, plus a validation fold carved from
   *train only* for early stopping (the test set is never used for model
   selection); 5-fold CV + held-out metrics + majority-class baseline, all
   written to `artifacts/eval_report.txt`.
4. **Training (progression).** `scripts/simulate_followup.py` derives a
   deterministic 12-month follow-up for every subject — MMSE drift driven by the
   *observed* biomarker profile (amyloid/tau positivity accelerates decline,
   cognitive reserve slows it) and conversion labels from published base rates
   (CN ~4%/yr, MCI ~12%/yr, AD ~28%/yr) modulated by biomarker evidence.
   `scripts/train_progression_model.py` then trains two XGBoost models on the
   same baseline feature vector: an **MMSE-delta regressor** and a **conversion
   classifier** (class imbalance handled via `scale_pos_weight`).
5. **Explainability.** SHAP TreeExplainer produces global importance
   (`artifacts/global_importance.csv`) and per-subject factors. The detail view
   groups **all 16 factors by pipeline stage** (Cognition / Blood / MRI / PET);
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
│ DATA (never committed): ADNI DATA/*.csv · data/raw/*.csv · *.json     │
│   real ADNI 13-table drop (primary) · real OASIS-1 · synthetic        │
└───────────────────────────────┬───────────────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ ETL — ingest_adni.py (real) · ingest.py (OASIS) · generate_*.py       │
│   nearest-visit join (±183 d) → sentinel filtering → per-subject      │
│   feature table + real DIAGNOSIS labels + serving records             │
└───────────────────────────────┬───────────────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ TRAIN — train_model.py · train_progression_model.py (sklearn Pipeline)│
│   RISK:  15 features (4 stages) → XGBoost (RF fallback) → SHAP        │
│   PROG:  same baseline features → MMSE-delta regressor + conv. clf    │
│   artifacts: pipeline.joblib · progression_*.joblib · model cards     │
│              global_importance.csv · risk_scores.json · eval reports  │
└───────────────────────────────┬───────────────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ API — backend/ (FastAPI)                                              │
│   storage: ADNI cohort + startup batch rescore │ SQLite/Postgres      │
│   ordering gaps: stage stops at the first missing test, later results  │
│   stay on file and are never overwritten by a simulated one            │
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
│   Simulator: what-if workbench on the model's real 15 features        │
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
│       ├── RiskSimulator.jsx    #   what-if scoring on the model's 16 real features
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

Trained on **real ADNI** (the 13-table drop of 17 Sep 2026): **3,636 subjects**,
one row each at their latest visit carrying a real `DIAGNOSIS`. Labels are the
cohort's own clinician assessment — `1 = MCI or Dementia`, `0 = CN` (2,168 /
1,468; 59.6% impaired). No simulated label rule anywhere.

| Metric | Value |
|---|---|
| Model | XGBoost (`pipeline.joblib`), RandomForest fallback exported alongside |
| Features (15, spanning all 4 stages) | `age`, `sex`, `education_years`, `apoe_e4`, `mmse`, `mmse_change`, `adas_cog_13`, `ptau217`, `abeta4240`, `nfl`, `gfap`, `hippocampal_volume`, `hippocampal_icv_ratio`, `centiloids`, `tau_meta_temporal` |
| 5-fold CV AUC | **0.901 ± 0.011** ← headline number |
| Held-out test AUC | 0.902 — honest: the early-stopping validation fold is carved from train, so the test set is never touched during model selection |
| Held-out accuracy @0.5 | 0.812 (confusion `[[240 54], [83 351]]`) |
| Stratified test AUC | Stage 1 only (no biomarkers) **0.845** (n = 216) · biomarker-measured **0.921** (n = 512) |
| RF fallback test AUC | 0.903 |
| Majority-class baseline | accuracy 0.596, AUC 0.500 |
| Thresholds | High > 0.7 · Medium ≥ 0.4 (env-overridable) |

**Label leakage — what is excluded and why.** ADNI derives its `DIAGNOSIS` from
clinical staging, so any variable in that derivation leaks the label. Two are
barred from the feature set: **CDR** (the diagnosis is literally a function of
it) and **FAQ** (functional status, part of the same algorithm). Both are still
loaded for provenance/concordance reporting, never as predictors. **MMSE** is
retained — it overlaps with diagnosis through standard cutoffs but is not
deterministic, and a dementia triage tool that could not see a cognitive score
would be clinically useless; the caveat is carried in the model card and in
`artifacts/model_audit.txt`.

**Feature contribution (mean |SHAP|).** `overall` is cohort-wide; `measured`
counts only subjects who actually have that test — the honest way to read a
partially-observed cohort.

| Rank | Feature | Overall | Where measured | Measured | Stage |
|---|---|---|---|---|---|
| 1 | `adas_cog_13` | 1.070 | 1.204 | 77.9% | Cognition |
| 2 | `mmse` | 0.974 | 0.974 | 100% | Cognition |
| 3 | `tau_meta_temporal` | 0.232 | **0.608** | 19.7% | PET |
| 4 | `centiloids` | 0.249 | **0.433** | 29.3% | PET |
| 5 | `ptau217` | 0.074 | **0.158** | 30.9% | Blood |
| 6 | `hippocampal_icv_ratio` | 0.076 | 0.115 | 58.3% | MRI |
| 7 | `nfl` | 0.033 | **0.113** | 16.9% | Blood |
| 8 | `hippocampal_volume` | 0.074 | 0.103 | 58.3% | MRI |
| 9 | `sex` | 0.089 | 0.089 | 99.9% | Demographics |
| 10 | `age` | 0.083 | 0.083 | 99.9% | Demographics |
| 11 | `mmse_change` | 0.064 | 0.077 | 64.2% | Cognition (longitudinal) |
| 12 | `abeta4240` | 0.032 | 0.050 | 30.8% | Blood |
| 13 | `gfap` | 0.012 | 0.047 | 16.9% | Blood |
| 14 | `education_years` | 0.015 | 0.015 | 99.9% | Demographics |
| 15 | `apoe_e4` | 0.017 | 0.014 | 78.7% | Genetics |

**Contribution by pipeline stage** (`artifacts/stage_importance.csv`):

| Stage | Summed mean \|SHAP\| | Share |
|---|---|---|
| 1 — cognitive / clinical | 2.313 | 74.7% |
| 2 — blood biomarkers | 0.150 | 4.8% |
| 3 — MRI volumetrics | 0.150 | 4.8% |
| 4 — PET | 0.482 | **15.6%** |

Read together, these tables answer the obvious challenge — *"isn't the model
just MMSE?"* No: with cognition held out, **PET alone carries more weight than
blood and MRI combined** (15.6% vs 4.8% + 4.8%). PET looks small in the
cohort-wide column only because just 20–29% of subjects have a scan; among
subjects who *do* have one, tau SUVR is the fourth-strongest result in the
model. Both views are exported so neither can be quoted misleadingly.

**Missing-biomarker handling:** a subject whose blood/MRI/PET has not been
measured scores from cognition + demographics alone; XGBoost consumes the NaNs
natively and SHAP attributes the learned missing-value default (badge-marked in
the UI). Once a test completes, its measured contribution replaces the default
and the subject is re-scored instantly. The cohort demonstrates this
structurally: **2,514 subjects sit at Stage 1 · 332 at Stage 2 · 231 at Stage 3 ·
559 at Stage 4**.

### Ordering gaps — and why the stage stops at the first missing test

Real ADNI is not a tidy funnel. Modalities were added across study phases, so
**all eight combinations of blood / MRI / PET exist**: 1,055 subjects have
cognition only, 965 have an MRI but *no plasma panel*, 365 have MRI + PET and no
plasma, 129 have PET alone, and so on. **1,459 subjects (40%) have MRI and/or PET
on file with a missing blood draw.**

A naive "highest completed stage" rule labels every one of those Stage 3/4,
which claims a blood panel that was never drawn — the stepper then contradicts
the record. NeuroPilot instead defines:

> **stage = length of the complete prefix of the ordered pathway**
> (cognition → blood → MRI → PET)

So a subject with an MRI and no plasma panel is **Stage 1**, the rule engine
correctly recommends the missing blood draw, and two things stay true at once:

1. **Nothing measured is discarded.** The real MRI/PET values still feed the
   model — the score already uses them, the stage simply does not claim them as
   ordered milestones. `/patients/{id}` reports `slots_on_file` and
   `beyond_stage` so the UI can say "already on file" instead of looking
   self-contradictory.
2. **A real measurement is never overwritten.** Walking the pathway past an
already-measured slot *carries the real values forward* — the step is logged as
`result already on file (normal) — carried forward without re-measurement`, and
`POST /advance-stage` / `auto-workup` return `result.carried_forward: true`.
Only genuinely missing slots get a derived result. This is locked by
`test_ordering_gap_never_overwrites_a_real_measurement`, which asserts the
carried record is byte-identical before and after.

That behaviour is also the honest answer to *"why does this patient say MRI
completed but no blood marker?"* — because in the source cohort, that is exactly
what happened.

**Cohort tiers after training:** 1,687 High · 569 Medium · 1,380 Low (0.7/0.4).

### 7.2 Progression forecaster (12-month horizon)

Same baseline feature vector as the risk model; labels currently from the
simulated follow-up (133 conversions / 16.6% prevalence; 640 train / 160 test
subjects, stratified by conversion). Synthetic trajectories — see §13. Real
ADNI follow-up labels are extracted and ready for the next retrain.

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
  model's real 15 features, including per-stage "Measured / Not ordered"
  toggles).
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
- **Risk Simulator** — what-if workbench on the live model with its real 15
  features: demographics + APOE ε4, MMSE + change + ADAS-Cog 13 (always
  measured), p-tau217 / Aβ42/40 / NfL / GFAP (blood), hippocampal volume + ICV
  (MRI, the ratio is derived), Centiloids + tau SUVR (PET), with per-stage
  "Measured / Not ordered" switches that send `null` and route the model through
  its learned missing-value default — plus clinical presets and a live SHAP
  waterfall. (FAQ is deliberately absent — it is a leakage variable, see §7.1.)
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

- **The risk model now trains on real ADNI, but the progression forecaster does
  not yet.** The served risk model uses real observed measures and real
  clinician labels (`data_mode: adni`, 3,636 subjects, test AUC 0.902). The
  12-month forecaster still trains on simulated trajectories. Real follow-up
  labels are already extracted into `data/processed/adni_visits.csv` (2,389
  subjects with ≥2 scored visits, real MMSE deltas and diagnostic conversions),
  so the retrain is data-ready.
- **The ADNI cohort is not a general-population sample.** It is a
  research-cohort drop (highly educated, largely Western, volunteer-recruited)
  and the latest-visit label mix (40% CN / 33% MCI / 27% Dementia) reflects
  years of follow-up rather than community prevalence. Real deployment needs
  local validation data.
- **ADNI carries a data use agreement.** The CSVs are gitignored and must stay
  so; this repository ships the *code* that turns them into a model, never the
  cohort itself.
- **Progression labels are simulated trajectories**, shaped by published
  progression dynamics (CN ~4%/yr, MCI ~12%/yr, AD ~28%/yr base rates modulated
  by biomarker evidence) — not real patient outcomes. A production forecaster
  would retrain on an actual longitudinal cohort (e.g. ADNI follow-up visits).
- **The forecast is a "nothing changes" projection** — it assumes standard care
  continues; a real intervention (e.g. anti-amyloid therapy) would alter the
  trajectory. It is a probability, never a diagnosis or a guarantee.
- **PET is measured in a minority of real subjects** (tau 19.7%, amyloid 29.3%)
  because those scans were only added in later ADNI phases. The stage rollup
  therefore reports both a cohort-wide and a measured-only share — see §7.1.
- **Fixed by the real data, kept for the record:** in the synthetic cohort the
  PET features had ≈0 SHAP weight (amyloid/tau status correlate in the
  generator). On real measures, tau SUVR and Centiloids rank 4th and 5th.
- **The holdout is no longer optimistic**: early stopping now uses a validation
  fold carved from *train only*, so the held-out test AUC (0.902) is honest. It
  sits a hair below the 5-fold CV AUC (0.901 ± 0.011) — as expected, now that
  the test set is genuinely unseen during model selection.
- **APOE ε4 is a weak cross-sectional signal here.** Binary carrier, copy count
  (0/1/2), an explicit APOE × age interaction, and dropping it entirely all land
  within **0.0006 CV AUC** of each other (`artifacts/model_audit.txt`). Its
  clinical value is in *progression*, not same-day prevalence: a single-visit
  diagnosis is already visible in MMSE/ADAS, so APOE adds almost nothing on top.
- **Complete-case cross-check.** On the 510 subjects with all four families
  measured, a throwaway model trained with *no* missing values ranks features
  almost identically to the served model (8/10 top-10 overlap, Spearman
  ρ = 0.82) — evidence the NaN handling is not inventing structure the
  complete-case data does not support.
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
