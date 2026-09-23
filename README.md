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
| Legacy cohorts | Retired | OASIS-1 and the synthetic cohorts were removed with their scripts and files; `PATIENT_DATA` knows only `adni|mock`, and `--data real|synthetic` no longer exists |
| Follow-up labels | Run & verified (real ADNI) | Real baseline → follow-up visit pairs from the ADNI drop: **1,634 pairs, 138 conversions (8.45%)** — `data/processed/adni_progression.csv`, not a simulated drift rule |
| Risk model trained on real data | Run & verified | XGBoost, **15 features across all 4 stages**; 5-fold CV AUC **0.901 ± 0.011**, held-out test AUC **0.902**, accuracy 0.812 on 3,636 real ADNI subjects |
| Leakage & robustness audit | Run & verified | FAQ (diagnosis-derived, like CDR) dropped from the feature set; early stopping moved off the test set; APOE encoding benchmarked; complete-case cross-check agrees (ρ = 0.82) — `artifacts/model_audit.txt` |
| Progression forecaster trained | Run & verified (real ADNI follow-up) | XGBRegressor + XGBClassifier on 1,634 real pairs; MMSE-delta MAE **1.549 pts** (baseline 1.859, R² 0.297), conversion 5-fold CV AUC **0.819 ± 0.031**, held-out AUC **0.796** at 8.45% prevalence |
| Explainability | Run & verified | Global SHAP **with per-stage rollup** (`stage_importance.csv`) + full per-subject attribution; both an overall and a measured-only view, so a rarely-ordered test (PET) is not diluted to zero |
| Escalation rule engine | 42 pytest cases | Deterministic stage gates; **evidence-gated High tier** (blocked, not just advised, by `has_biomarker_evidence`); clinician-in-the-loop via `override: true`; results return via `POST /results`; **ordering gaps handled** — the stage stops at the first missing test and already-measured later slots are carried forward, never overwritten |
| Autonomous triage | Run & verified (browser E2E) | `POST /workup/next` / `/workup/run`: model picks subject → orders test → re-scores → re-ranks; live rank movements (e.g. `#12 → #2` after an abnormal blood panel) |
| Approval-gated triage console | Run & verified (165 pytest cases) | A dedicated **Autonomous Neuro** view that splits the decision in two. `POST /workup/plan` is **read-only** — every projection is computed on a deep copy, so asking what a batch would do cannot do it. Each proposal carries its reasoning (why this subject · why this test · cost to the patient · expected effect) and a blunt impact verdict (`order only` / `no change` / `changes tier`). `POST /workup/execute` acts on **only the approved subjects**, re-checks each against its live state (one that moved is skipped with the reason rather than advanced on a stale plan), and writes the plan id into the subject's audit trail |
| Progression forecast served | Run & verified (local + Railway) | `GET /patients/{id}/progression` → trajectory, conversion probability with SHAP drivers, projected tier, stage-completion score checkpoints |
| Backend API | Run & verified | FastAPI + Swagger at `/docs`; `/health` reports `data_source` — `adni` (local cohort file), `adni+postgres` / `postgres` (served from the seeded database), or `mock` if only placeholder stubs could be found; live scoring via `pipeline.joblib` |
| Frontend dashboard | Run & verified (headless Chrome) | Zero mock data; ranked cohort, detail view, full-page progression view, risk simulator rebuilt on the model's real 15 features; production build clean, zero console errors |
| PostgreSQL store | Run & verified (Railway) | Activated by `DATABASE_URL`; schema created + seeded on boot, persists workup history across restarts, and **re-seeds when either the cohort or the served model changes** — a retrain can never leave stale attributions in the database. In a deployment it is the **store of record** for the DUA-restricted cohort (seeded once by `scripts/seed_db.py`); an empty cohort never wipes it, placeholder stubs never replace it, and a stored cohort that filters to zero is repaired from the file rather than served as an empty dashboard |
| FHIR R4 integration | Run & verified (152 pytest cases) | **Four phases live:** export (`/fhir/Patient/{id}/$everything`, LOINC-coded Observations, `RiskAssessment`), inbound ingestion (`POST /fhir/Bundle`, accepting `transaction`/`collection`/**`document`** bundles — the NRCES shape — with the **ABHA address as the preferred subject identifier** and a crosswalk that keeps one human one patient, plus idempotency on ABHA + observation date so a retried document writes nothing; atomic — 422 `OperationOutcome` on any unmappable resource or wrong UCUM unit), bidirectional (`ServiceRequest` orders → `DiagnosticReport`/`Observation` results → re-score through the served model; one-transaction push to an outbound server), and SMART on FHIR launch (authorization-code + PKCE, patient-scoped context, token held server-side). No `Condition` is ever emitted, on either direction |
| ABDM (India) consent flow | Run & verified (28 pytest cases) | **HIU side of ABDM, Phases 4-5:** consent request → GRANTED/DENIED callback → health-information request (only the HIU's *public* ephemeral key travels) → HIP pushes Fidelius-encrypted FHIR → decrypted, mapped and re-scored through the served model. Fidelius is implemented on BouncyCastle Curve25519 (**short-Weierstrass, not X25519** — the trap that produces `ABDM-9999`), HKDF-SHA256 + AES-256-GCM with the tag verified, and is checked **byte-for-byte against the published `fidelius-cli` reference ciphertext**. Runs with no ABDM account against an in-process mock HIE-CM + mock HIP at `/mock-abdm`. See `ABDM_INTEGRATION.md` |
| Docker demo | Written | `docker compose up --build` (single-image Railway deploy is the exercised path) |
| CI (GitHub Actions) | Not built | Deliberately excluded from scope |

---

## 2. Quick start (3 terminals)

```bash
# Terminal 1 — ML pipeline (once; generates data + artifacts)
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements-ml.txt
# Place the real ADNI tables in "ADNI DATA/" first (access-controlled — see
# data/raw/README.md), then check coverage and run the whole pipeline:
python scripts/inspect_adni_coverage.py                # per-modality coverage (read-only)
python scripts/run_pipeline.py                         # ingest → risk model → progression model
#   ...or run the steps individually:
python scripts/ingest_adni.py                          # 13 tables → features + serving cohort
python scripts/train_model.py --data adni              # risk model + SHAP + artifacts
python scripts/train_progression_model.py --data adni  # delta + conversion models

# Terminal 2 — API
pip install -r backend/requirements.txt
cd backend && uvicorn app.main:app --reload            # http://127.0.0.1:8000/docs

# Terminal 3 — Dashboard
npm install && npm run dev                             # http://localhost:5173
```

Or everything in one command (needs Docker, mounts data/processed + artifacts):

```bash
docker compose up --build     # web :8080 · API docs :8000
```

---

## 3. Data policy — no datasets in this repository

**This repo contains zero patient data and no source datasets.** The ADNI tables
and the retiring legacy cohorts are all kept out of git. The *derived* artifacts —
trained models (risk + progression) + risk scores — **are committed** so a fresh
deploy (Railway/Docker) serves both model families without re-training:

| Path | What it is | How to get it |
|---|---|---|
| `ADNI DATA/*.csv` | The real 13-table ADNI drop (cognition, plasma panel, FreeSurfer MRI, amyloid/tau PET, DXSUM, APOE…) | Request access from ADNI and accept the DUA — **never commit it** (see `data/raw/README.md`) |
| `data/processed/risk_scores.json` | Per-subject model scores + SHAP attributions. On real ADNI it is written **de-identified** — subject ID, score and feature attributions only, no age/sex/MMSE/ADAS/FAQ/biomarker values, because ADNI is DUA-restricted | **Committed** (deployment seed); regenerate with `python scripts/train_model.py` |
| `data/processed/adni_cohort.json`, `adni_features.csv`, `adni_visits.csv` | Real ADNI serving records, training matrix and longitudinal visit table | **Gitignored** (regenerate with `python scripts/ingest_adni.py`) |
| `artifacts/pipeline.joblib`, `model_meta.json`, `global_importance.csv`, `eval_report.txt` | Risk model, model card, global SHAP, eval audit | **Committed** (deployment); regenerate with `python scripts/train_model.py` |
| `artifacts/progression_delta.joblib`, `progression_conversion.joblib`, `progression_meta.json`, `progression_report.txt` | Progression forecaster (MMSE-delta + conversion) + card + eval audit | **Committed** (deployment); regenerate with `python scripts/train_progression_model.py` |
| `artifacts/rf_pipeline.joblib` | RandomForest fallback model | Local only — gitignored |

Why: ADNI is access-controlled under a Data Use Agreement and is not
redistributable, which is what keeps the repo clean and legally simple. The
derived model artifacts are the deliberate exception: they are needed for
one-command deployment, and in a deployment the cohort itself is seeded into the
database rather than shipped in the image (§11).

---

## 4. What it does and how (end to end)

1. **Ingest.** `scripts/ingest_adni.py` reads the real 13-table ADNI drop and
   performs a nearest-visit join (±183 days) across cognition (MMSE, ADAS-Cog
   13), the plasma panel (p-tau181/217, Aβ42/40, NfL, GFAP), FreeSurfer MRI
   volumetrics and amyloid/tau PET. Sentinel codes (`MMSCORE −1`, `−4`/`−5`
   not-reported markers, PET `qc_flag`) are filtered rather than read as values,
   and the real `DIAGNOSIS` column supplies the label. Output: the training
   matrix, the longitudinal visit table and the serving cohort
   (`data/processed/adni_*.{csv,json}`).
2. **Feature engineering.** `scripts/train_model.py` derives per-subject
   features: latest MMSE, `mmse_change`, ADAS-Cog 13, APOE-ε4, demographics, and —
   when the corresponding test was actually performed — `ptau217`, `abeta4240`,
   `nfl`, `gfap`, `hippocampal_volume` / `hippocampal_icv_ratio`, `centiloids`,
   `tau_meta_temporal_suvr`. Un-ordered tests stay **NaN** (XGBoost consumes
   missing values natively; missingness itself is informative).
3. **Training (risk).** XGBoost (RandomForest fallback) predicts the severity
   label. CDR is deliberately **not** a feature (clinician rating ≈ the label =
   leakage) and neither is **FAQ** (part of ADNI's diagnostic algorithm).
   Subject-level stratified 80/20 split, plus a validation fold carved from
   *train only* for early stopping (the test set is never used for model
   selection); 5-fold CV + held-out metrics + majority-class baseline, all
   written to `artifacts/eval_report.txt`.
4. **Training (progression).** `scripts/ingest_adni.py` pairs each baseline
   visit with the subject's real follow-up visit (1,634 pairs, 138 conversions —
   8.45%), so the labels are **clinician follow-up diagnoses, not simulated
   trajectories**. `scripts/train_progression_model.py` trains two XGBoost
   models on the same baseline feature vector: an **MMSE-delta regressor** and a
   **conversion classifier** (class imbalance handled via `scale_pos_weight`).
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
   cascade: the rule engine orders the next test from the current tier, a
   clinically-plausible result is derived, the **trained model re-scores
   immediately**, and the updated tier gates the next step. Stops (409) when
   the tier indicates no further testing.
9. **Autonomous cohort triage (`POST /workup/next`, `/workup/run`).** No clicks
   at all: the system ranks **all** subjects by current score, picks the
   highest-priority one whose tier still indicates a test, performs exactly one
   step, re-scores, and re-ranks — priorities genuinely shift as results land.
   Each step returns the **same reasoning an approvable proposal carries** (why
   this subject · why this test · cost to the patient · expected effect) plus
   what the model **projected before acting**, so an unattended step can be read
   back with the questions answered instead of only narrated. The dashboard's
   **Autonomous Neuro** view runs this live (~1.4 s/step), streaming a
   per-step row: subject, stage transition, test, priority and official score
   before → after, tier change, queue movement, **expected vs actual** ("✓ as
   projected" when they agree), and an expandable rationale. The log **outlives
   the run** — stopping it keeps the rows so the run can be reviewed.
   Background ticks refresh the cohort **in place**: the view is never replaced
   by a skeleton mid-run, so the page cannot collapse under the cursor and the
   Stop control (header, card, or `Esc`) is always reachable.
10. **Approval-gated triage console (`POST /workup/plan`, `POST /workup/execute`).**
    The same policy with a human signature on each batch. `/workup/plan` walks the
    live queue and returns the next batch of indicated tests **without mutating
    anything** — every projection runs on a deep copy of the record. Each action
    states its reasoning: why this subject (rank, score, tier), why this test
    (the rule engine's own gate), the cost to the patient (a result already on
    file is zero-cost; an order changes nothing until a result returns), and the
    expected effect (projected priority score, tier movement, queue position).
    The verdict is deliberately blunt — `order only`, `no change`, `changes tier`
    — so a batch that would spend tests without moving anyone is visible *before*
    approval rather than after. `/workup/execute` acts on **only the approved
    subjects**; each is re-checked against its live state first, so a subject
    whose pathway moved between proposal and approval is skipped with the reason
    instead of advanced on a stale plan. Every executed step writes the plan id
    into the subject's audit trail, so an autonomous action is always traceable
    back to the human decision that authorised it.
11. **12-month progression forecast (`GET /patients/{id}/progression`).** A
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
│ DATA (never committed): ADNI DATA/*.csv (13 tables, DUA-restricted)   │
└───────────────────────────────┬───────────────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ ETL — ingest_adni.py                                                  │
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
│   ordering gaps: stage stops at the first missing test, later results │
│   stay on file and are never overwritten by a simulated one           │
│   escalation.py: deterministic stage rules · model_service.py: SHAP   │
│   progression.py: forecast + stage-completion score checkpoints       │
│   /patients · /patients/{id} · /explain · /pipeline · /advance-stage  │
│   /patients/{id}/auto-workup · /workup/next · /workup/run · /results  │
│   /workup/plan (read-only) · /workup/execute (approved subset only)   │
│   /patients/{id}/progression · /patients/score · /model/info · /health│
└───────────────────────────────┬───────────────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ UI — src/ (React + Vite + Tailwind) — NO mock data                    │
│   Overview: full-screen capability preview · ribbon · charts · top-8   │
│   Patients: ranked table, filters, search, pagination                 │
│   Detail: score gauge · 4-stage attribution radar · pipeline stepper  │
│           · audit trail · Progression Probability button              │
│   Progression (full page): observed-vs-predicted trajectory chart     │
│           with stage-score lane · conversion probability · drivers    │
│   Simulator: what-if workbench on the model's real 15 features        │
│   Autonomous console: reasoned proposals · approval gate · ledger     │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 6. Repository map

```
.
├── Info.md                      # design blueprint this project implements
├── README.md                    # this document
├── FHIR_INTEGRATION.md          # HL7 FHIR R4 integration: phases, limits, demo commands
├── ABDM_INTEGRATION.md          # ABDM consent flow + Fidelius: procedure, limits, commands
├── FHIR plan.md                 # phase-by-phase ABDM plan (status tracked inline)
├── .env.example                 # every supported env var, documented
├── Dockerfile                   # single-image deploy: builds UI → serves via FastAPI (Railway)
├── docker-compose.yml           # one-command local demo: Postgres + API + web
├── railway.json                 # Railway deploy config (Dockerfile + start command)
├── requirements-ml.txt          # ML pipeline deps (Pandas, sklearn, xgboost, shap)
├── index.html / vite.config.js / tailwind.config.js / postcss.config.js / package.json
│
├── brand_assets/                # rendered logo/icon (PNG transparent, JPG, PDF brand sheet)
├── ADNI DATA/                   # raw ADNI tables (gitignored — DUA-restricted, never committed)
├── data/                        # datasets gitignored (see §3); derived scores committed
│   ├── raw/README.md            #   how to obtain the ADNI drop + what ingestion writes
│   └── processed/risk_scores.json  # trained-model scores (deployment seed)
│
├── scripts/                     # the ML pipeline (Python 3.11)
│   ├── ingest_adni.py           #   real ADNI drop → visits/features/progression/cohort
│   ├── train_model.py           #   features → XGB/RF → eval → SHAP → artifacts
│   ├── train_progression_model.py # delta + conversion models → artifacts
│   ├── run_pipeline.py          #   ingest + train in one command (cron-friendly)
│   ├── seed_db.py               #   seed/prepare the DEPLOYMENT database (no dataset shipped)
│   ├── audit_model_fixes.py     #   leakage + robustness audit of the served model
│   ├── inspect_adni_coverage.py #   per-modality coverage of the ingested cohort (read-only)
│   ├── validate_fhir.py         #   server-side validation gate for exported FHIR resources
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
│   ├── tests/                   #   152 pytest cases (API · DB seed · FHIR · SMART · ABDM)
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
│       ├── fhir.py              #   FHIR R4 resources (Patient/Observation/RiskAssessment…)
│       ├── fhir_ingest.py       #   inbound FHIR mapper (pure) — atomic, unit-checked
│       ├── fhir_client.py       #   outbound push + server reachability probe
│       ├── smart.py             #   SMART on FHIR (OAuth2 + PKCE), tokens server-side
│       ├── fidelius.py          #   ABDM Fidelius crypto (BouncyCastle Curve25519, AES-GCM)
│       ├── abdm.py              #   ABDM HIU consent-flow client + session state machine
│       ├── abdm_mock.py         #   mock HIE-CM + mock HIP (simulator, mounted at /mock-abdm)
│       ├── api.py / main.py     #   router + app (also serves the built SPA)
│
├── src/                         # React dashboard (pure API client)
│   ├── api.js                   #   fetch client — the ONLY data source
│   ├── App.jsx                  #   views, flows, Autonomous Neuro console
│   ├── lib.js · index.css · main.jsx
│   └── components/
│       ├── Overview.jsx         #   landing: preview, ribbon, top-8, SHAP
│       ├── AutoScrollShowcase.jsx  # self-advancing full-screen preview rail
│       ├── Header.jsx           #   sticky chrome: brand · nav · run control · theme
│       ├── AllPatients.jsx      #   ranked table: filters, search, pagination
│       ├── PatientDetail.jsx    #   detail: score, attribution radar, actions, trail
│       ├── ProgressionView.jsx  #   full-page 12-month forecast
│       ├── TrajectoryChart.jsx  #   observed-vs-predicted MMSE + stage-score lane
│       ├── RiskSimulator.jsx    #   what-if scoring on the model's 16 real features
│       ├── FeatureRadarChart.jsx · RiskDistributionChart.jsx · StageProgressionChart.jsx
│       ├── Interoperability.jsx #   FHIR R4 exchange surface (F shortcut)
│       ├── AbdmPanel.jsx        #   live ABDM consent → encrypted pull panel
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
| Thresholds | Score bands High > 0.7 · Medium ≥ 0.4 (env-overridable) — **High additionally requires a biomarker result on file** (see §7.1) |

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

### Risk tiers require corroborating evidence

The score answers *"how much does this look like the thing we are looking for?"*
The tier answers *"do we have enough to act on?"* — and those are not the same
question. Cognition is the assessment the referral was already based on, so a
high cognitive score on its own cannot corroborate itself: it is exactly the
situation that exists *before* the pipeline has done its job.

So the tier is gated. `risk_tier(score, evidence)` (one function, `config.py`,
that every path — API, escalation, progression, FHIR export, simulator — routes
through):

| Tier | Requires |
|---|---|
| **High** | score > 0.70 **and** ≥ 1 biomarker result on file (blood, MRI or PET) |
| **Medium** | score ≥ 0.40 — includes cognition-only patients flagged *awaiting confirmation* |
| **Low** | score < 0.40 |

Measured effect on the real ADNI cohort: **452 of 1,055 cognition-only patients
move High → Medium** (they score 0.70–0.996 on cognition alone, at a mean MMSE of
22.2 — genuinely impaired, but with no biomarker saying *what* pathology). Cohort
tiers go `1628 / 687 / 1321` → `~1173 / ~1135 / ~1328`.

Two things this deliberately does **not** do:

- **It does not weaken triage.** At Stage 1 both Medium and High order the blood
  panel, so autonomous triage behaves identically — a cognition-only patient is
  still the *first* to be tested. They simply cannot be labelled High until the
  result lands, at which point they are promoted automatically.
- **It does not touch the model's attribution.** ADAS-Cog 13 and MMSE stay the
  top two SHAP features because they measurably are (single-feature AUC 0.885 and
  0.836). Rebalancing those bars to look more even would misrepresent the model —
  the honest lever was the tier rule, not the training data. (Removing 70% of
  cognition-only *subjects* from training was tried and does nothing: cognition's
  stage share moved 60.2% → 60.7%.)

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

Same baseline feature vector as the risk model. Labels are **real ADNI follow-up
outcomes** — baseline visit paired with the subject's next visit (1,634 pairs,
138 conversions, 8.45% prevalence; subject-level split 1,307 train / 327 test).

| Model | Metric | Result |
|---|---|---|
| MMSE-delta regressor | test MAE | **1.549 pts** (mean-baseline 1.859) |
| | test RMSE / R² | 2.217 / 0.297 |
| Conversion classifier | 5-fold CV AUC | **0.819 ± 0.031** |
| | held-out ROC AUC | **0.796** (Stage-1-only subgroup 0.822) |
| | held-out PR AUC | 0.386 (vs 0.0845 prevalence ≈ 4.6× lift) |
| | Brier score | 0.089 (calibration) |
| | accuracy @0.5 | 0.878 (majority baseline 0.914 — see §13) |

**Guardrails** (`artifacts/progression_report.txt`): subject-level holdout;
same NaN = stage-not-ordered convention; imbalance via `scale_pos_weight` (5.04);
the projected 12-month tier comes from re-scoring the **current risk model** on
the projected future vector — one consistent model family end-to-end.

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

- **Data source resolution:** the real ADNI cohort file when present → the same
  cohort from the database it was seeded into (`scripts/seed_db.py`) → placeholder
  stubs only if neither exists. `PATIENT_DATA=adni` makes a missing cohort loud
  instead of substituting stubs. When a trained model exists, every subject is
  re-scored at startup (vectorized SHAP batch) — the dashboard always shows the
  served model's judgment. `/health` reports the resolved source
  (`adni`, `adni+postgres`, `postgres`, or `mock`); `/debug/env` shows deploy
  diagnostics.
- **In-process model serving:** `POST /patients/score` predicts on an arbitrary
  feature vector with `pipeline.joblib` + a cached SHAP TreeExplainer (this
  powers the what-if **Risk Simulator** in the UI, whose controls mirror the
  model's real 15 features, including per-stage "Measured / Not ordered"
  toggles).
- **Progression serving:** `GET /patients/{id}/progression` returns the full
  forecast (404 → 503-safe: `model_available: false` when artifacts are absent).

| Endpoint | Behavior |
|---|---|
| `GET /health` | `{"status":"ok","data_source":"adni"}` (or `adni+postgres` / `postgres` / `mock` — see §11) |
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
| `POST /workup/plan` | **Read-only proposal.** Body `{"limit": 8}` (1–25) → walks the live priority queue and returns the next batch of indicated tests with `rationale` (4 labelled reasons), `impact` (`order-only`\|`none`\|`marginal`\|`material`\|`reclassifies`), `projected_priority_score`, `projected_rank`, `rank_delta`, `result_on_file`, plus a `summary` and a `cohort` snapshot. **Changes nothing** — projections are computed on copies |
| `POST /workup/execute` | Body `{"patient_ids": [...], "plan_id": "...", "note": null}` → executes **only the approved subset**. Each subject is re-checked first; one no longer indicating a test is skipped with the reason. 422 on an empty list. Returns `{executed: [{stage_before/after, slot, result_on_file, official_score_before/after, priority_score_before/after, tier_before/after, rank_before/after}], skipped: [{patient_id, reason}], executed_count, skipped_count, queue_remaining, total}` |
| `POST /patients/score` | Body `{"features": {...}}` → `{score, risk_tier, factors, model_type}`. 503 if no model artifact |
| `GET /model/info` | Model card: type, features, trained_at, thresholds, CV/test AUC, global SHAP importance |
| `GET /fhir/metadata` | FHIR R4 `CapabilityStatement` — resources, `transaction` interaction, SMART security block |
| `GET /fhir/Patient` · `/fhir/Patient/{id}` · `/fhir/Patient/{id}/$everything` | Cohort searchset (ranked), single read, and the complete interoperable record as one `collection` Bundle |
| `GET /fhir/Observation?patient=` · `/fhir/RiskAssessment?patient=` | LOINC-coded measurements (MMSE 72106-8 …) and the score + tier + SHAP basis as a `RiskAssessment` |
| `GET /fhir/ServiceRequest?patient=&status=` | **Placed orders.** `status=active` = the hospital still owes a result; `completed` = a real value is on file |
| `GET /fhir/DiagnosticReport?patient=` | Completed panels: `conclusion` + `conclusionCode` describe *the test*, never the model's output |
| `POST /fhir/Bundle` | **Inbound ingestion.** `transaction` / `collection` / `document` (NRCES: Composition header + `#local` / `urn:uuid:` references) → mapped → re-scored by the same served model. Prefers the **ABHA address** as the subject identifier and binds it as a crosswalk; **idempotent on ABHA + observation date** (a retried document is reported as a duplicate, writes nothing and does not re-score). Atomic: any unmappable resource, dangling reference or wrong unit rejects the whole bundle with a 422 `OperationOutcome` naming every offender. Unrecognised codes are reported, not dropped |
| `POST /fhir/push/{id}` | Push the record (orders + results + `RiskAssessment` + `AuditEvent` trail) to `FHIR_BASE_URL` as one atomic FHIR *transaction* |
| `GET /fhir/status` | Integration status: which phases are live, outbound-server reachability, SMART session, exchange-surface counts |
| `GET /fhir/smart/launch` | Begin a SMART launch → 302 to the EHR authorize URL (PKCE S256, single-use `state`); `format=json` returns the URL instead |
| `GET /fhir/smart/callback` | Exchange the code, hold the token server-side, redirect the browser to the dashboard with `?smart=connected&patient=…` |
| `GET /fhir/smart/status` · `/fhir/smart/context` · `POST /fhir/smart/refresh` · `POST /fhir/smart/logout` | Registration facts, bound patient context, token renewal, disconnect (never returns token material) |
| `POST /abdm/consent` · `GET /abdm/consent/{id}` | **ABDM:** open a consent request for an ABHA address (the *only* identifier that leaves), then poll it — consent arrives as a callback, so nothing blocks |
| `POST /abdm/consent/{id}/records` | Ask the Consent Manager for the records; the HIU's ephemeral DH **public** key + nonce travel here, never the private half |
| `POST /abdm/consents/notify` · `/abdm/health-information/on-request` | The two **Consent-Manager-driven callbacks**. Shaped by ABDM, and they acknowledge rather than error on an unknown id — a retrying CM must not be able to wedge |
| `POST /abdm/health-information/transfer` | The HIP's Fidelius-encrypted push. Checks the bearer, the transaction, and the MD5 before decrypting; verifies the GCM tag; refuses a replay (409); then decrypted records go through `service.ingest_record` — the same scoring path as a result typed in the UI |
| `GET /abdm/status` · `POST /abdm/reset` | ABDM config, CM reachability, Fidelius parameters, session counts · clear sessions (demo reset) |
| `POST /ingest/fhir` | Direct FHIR ingestion for a HIP that pushes without a consent exchange (same mapper and scoring path as `POST /fhir/Bundle`) |

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
- **Overview (landing page)** — opens on the preview: ten full-screen panels that advance on
  their own, one capability each (the system itself, the real ADNI cohort, the four stages, the three
  scores, attribution, the patient record, the simulator, autonomous triage, the outlook, FHIR).
  Each panel is a slide — a tinted summary column in the brand accent beside the full explanation —
  and double-clicking the stage returns to the lead panel and restarts its dwell. Below it a joined
  cohort ribbon (subjects, high/medium/low, mean refined risk) behind hairline dividers, the served
  model's attribution radar, and the top-8 shortlist, ordered tier-then-score so the tier beside a
  subject always matches its position. Every summary column wears the same brand-accent surface — a
  panel's own accent is used only in the detail column, where it marks stage identity.
- **Header** (`components/Header.jsx`) — the only chrome on every view: brand lockup with the
  gradient rule and a live data-source chip, one segmented nav whose four tabs share a single
  definition of the active state, the autonomous run/stop control (deliberately outside the view
  tree so a running step cannot unmount it), and the theme toggle.
- **Patients** — opens on the cohort's shape, then the worklist: **risk-density and
  stage-occupancy charts** at equal height (moved here from the landing page, where
  they sat between the attribution radar and the closing call to action), the
  stage-gate pills immediately above the table they filter, then the complete ranked
  table: tier/stage segmented filters, ID search, sort by risk/stage, pagination
  (15/page), page state preserved when opening a subject and returning.
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
- **Autonomous Neuro** — a dedicated view (`A` shortcut) built the way a
  clinician would actually sign off on automation. It opens with the cohort
  state (awaiting workup · pathway complete · tier split) and a **proposed
  batch** the model derives from the live queue. Each proposal shows the subject
  and its rank, the test, priority `0.83 → 0.91` with the delta, the tier
  transition, the queue movement, and a blunt impact verdict; beneath it, the
  four reasons — *why this subject · why this test · cost to the patient ·
  expected effect* — are stated inline, not hidden behind a tooltip. Every
  action is independently approve/reject-able (the batch starts fully selected;
  deselecting is the point), and a sticky bar reports `N of M approved` before
  **Approve & execute**. Execution returns a **ledger**: each subject with its
  stage, priority and official score before → after, tier, queue movement, and
  whether a real result was incorporated or an order merely placed — plus every
  skipped subject with the reason, since a plan whose premise expired must be
  refused visibly rather than silently. Below it, the **supervised instant mode**
  keeps the ungated mode available (start/stop + live log, auto-stops when every
  pathway is complete) for when you want to watch the policy run rather than
  approve it. Its log is **not a black box**, and it is not inline either:
  a **side-by-side layout** puts the explanation and its single control on the
  left and the log on the right, in a **fixed-height scroll region of its own**.
  The document height is therefore identical at step 1 and step 50 (measured:
  one value across a whole run), so it cannot push the page around — and
  the log gets real vertical room rather than a few hundred pixels crammed under
  the copy. Rows read oldest → newest like a terminal and auto-follow the tail,
  but only while you are already at the bottom, so scrolling up to study a step
  is never yanked away by the next tick (a **Jump to latest** control appears
  instead). Each row carries the same facts a proposal card does — the subject
  and its rank, the stage transition, the test, priority *and* official score
  before → after, the tier change, the queue movement, whether a real result was
  incorporated or an order merely placed — with **what the model projected before
  acting** beside what actually happened (`✓ as projected` when they agree), and
  the full four-part reasoning one click away. Rows persist after Stop, so a run
  stays reviewable.
- **Risk Simulator** — what-if workbench on the live model with its real 15
  features: demographics + APOE ε4, MMSE + change + ADAS-Cog 13 (always
  measured), p-tau217 / Aβ42/40 / NfL / GFAP (blood), hippocampal volume + ICV
  (MRI, the ratio is derived), Centiloids + tau SUVR (PET), with per-stage
  "Measured / Not ordered" switches that send `null` and route the model through
  its learned missing-value default — plus clinical presets and a live SHAP
  waterfall. (FAQ is deliberately absent — it is a leakage variable, see §7.1.)
- **Interoperability (FHIR R4 + ABDM)** — a dedicated view (`F` shortcut) that
  makes the integration inspectable rather than claimed: the four FHIR phases
  with live/planned state, outbound-server reachability, the bound SMART session
  (patient in context, issuer, expiry, scopes) with launch/renew/disconnect, an
  export-and-push panel showing the `$everything` bundle shape and the patient's
  orders as real `ServiceRequest` resources, and an inbound-bundle tester that
  surfaces the 422 `OperationOutcome` verbatim when a bundle is refused.
  Below it, the **ABDM consent flow** panel runs the HIU exchange live: type an
  ABHA address, request consent, watch the grant arrive as a callback, pull the
  Fidelius-encrypted records, and see the post-ingest stage, tier and scores for
  the patients the pull touched — with the exchange timeline and the crypto
  parameters shown alongside it.
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
| `PATIENT_DATA` | `auto` | `adni` requires the real cohort (deployments); `mock` forces placeholder stubs |
| `DATABASE_URL` | unset | PostgreSQL store (`backend/app/db.py`). The **store of record** in a deployment — seed it with `scripts/seed_db.py` |
| `PROJECT_ROOT` | auto | Artifact/data root (override in Docker: `/app`) |
| `RISK_SCORES_PATH` / `MODEL_PATH` / `MODEL_META_PATH` / `GLOBAL_IMPORTANCE_PATH` | `data/processed/…`, `artifacts/…` | Artifact locations |
| `VITE_API_URL` | `http://127.0.0.1:8000` | API base URL for the frontend |
| `CORS_ORIGINS` | unset | Comma-separated extra allowed origins |
| `FHIR_BASE_URL` | unset | Outbound hospital FHIR server (e.g. `http://localhost:8090/fhir`). Unset = not configured, and every outbound call says so |
| `FHIR_PUSH_ORDERS` | `false` | Push each newly placed order as a `ServiceRequest`, best-effort (never blocks triage; failures go to the audit trail) |
| `FHIR_AUTH_TOKEN` / `FHIR_TIMEOUT_SECONDS` | unset / `8` | Static bearer token for a non-SMART server; outbound timeout |
| `SMART_CLIENT_ID` / `SMART_CLIENT_SECRET` | `neuropilot-demo` / unset | SMART app registration (issued by the EHR sandbox; public clients have no secret) |
| `SMART_REDIRECT_URI` | `http://localhost:8000/fhir/smart/callback` | Must match the registered redirect URI byte-for-byte |
| `SMART_SCOPES` | minimum-necessary set | Requested scopes (`launch/patient` + read Patient/Observation/DiagnosticReport/RiskAssessment + write RiskAssessment) |
| `FRONTEND_BASE_URL` | `http://localhost:5173` | Where the SMART callback hands the browser back to |
| `ABDM_CM_BASE_URL` | unset | Real ABDM Consent Manager (e.g. `https://dev.abdm.gov.in/cm`). Unset = use the in-process mock gateway |
| `ABDM_HIU_ID` / `ABDM_CM_ID` / `ABDM_CM_TOKEN` | `neuropilot-demo-hiu` / `sbx` / `mock-cm-token` | Our HIU identity and the bearer presented to the CM (a real HIU signs each request instead — `ABDM_INTEGRATION.md` L11) |
| `ABDM_CALLBACK_BASE_URL` | `http://127.0.0.1:8000` | Where the CM calls back and where the HIP pushes records. **Must be publicly reachable** for a real sandbox |
| `ABDM_USE_MOCK_GATEWAY` | `true` | Mount the mock HIE-CM + mock HIP at `/mock-abdm` (ignored once `ABDM_CM_BASE_URL` is set) |
| `ABDM_REQUESTER_NAME` / `ABDM_REQUESTER_REGNO` | demo values | Requester identity carried in the consent request |

Integration docs: `FHIR_INTEGRATION.md` (HL7 FHIR R4, SMART on FHIR) and
`ABDM_INTEGRATION.md` (ABDM HIU consent flow, Fidelius encryption, and what is
verified versus what needs a sandbox account).

PostgreSQL (optional locally, **the store of record in a deployment**): with
`DATABASE_URL` set, `db.py` creates the blueprint schema (`patients`,
`cognitive_assessments`, `comorbidities`, `lab_results`, `risk_factors`,
`pipeline_history`), seeds from the same source, and persists stage advances
across restarts. Verified on Railway: the single `Dockerfile` builds the React
bundle (stage 1) and serves it from the FastAPI process alongside the API on
`$PORT`; committed artifacts mean no re-training on boot.
(If you add a Railway Postgres plugin, `DATABASE_URL=${{Postgres.DATABASE_PRIVATE_URL}}`
and the store activates automatically.)

### Where the cohort lives in a deployment

The served cohort is derived from ADNI, which is access-restricted under a Data
Use Agreement. It is therefore **not committed, and not baked into the image** —
a build from the repository has no cohort file to copy. The database carries it
instead, seeded once from a machine that legitimately holds the data:

```bash
# once, and again after any retrain (the stored fingerprint folds in the served
# model, so the derived score/tier/attributions are recomputed)
DATABASE_URL='postgresql://user:pw@host:5432/railway' python scripts/seed_db.py
```

Set `PATIENT_DATA=adni` on the deployed service. A healthy boot then reads:

```
[api] data source: adni+postgres (2581 patients loaded)   # file + database
[api] data source: postgres    (2581 patients loaded)     # cohort from the DB
```

Three rules protect the stored cohort, each written after a real deploy failure:

* **An empty cohort never seeds.** A container that cannot find the cohort file
  cannot wipe the database that still holds the last good cohort.
* **Placeholder stubs never replace real patients.** If neither a cohort file nor
  a seeded database is available, the API says so (`mock`) — it will not overwrite
  Postgres with the demo stubs.
* **A stored cohort that filters down to nothing is repaired from the file**, not
  served as an empty dashboard (`0 patients` is never the intent).

`scripts/seed_db.py` refuses to run without `DATABASE_URL` and refuses to seed
stubs, so it can never be pointed at the wrong thing by accident.

---

## 12. Verification checklist (run this to prove it works)

```bash
# 0. Data (requires the ADNI drop in "ADNI DATA/")
python scripts/inspect_adni_coverage.py   # per-modality coverage, read-only

# 1. Ingest + risk model + progression forecaster
python scripts/run_pipeline.py
#    expect: ingest_adni writes data/processed/adni_*.{csv,json}, then the model
#    cards print CV AUC / MAE / conversion AUC and "[done] wrote: artifacts/…"

# 2. API
cd backend && uvicorn app.main:app --reload
curl http://127.0.0.1:8000/health                       # data_source: adni (+ postgres if set)
curl "http://127.0.0.1:8000/patients?limit=3"           # top-3 ranked subjects
curl http://127.0.0.1:8000/patients/ADNI-0001/explain   # full attribution
curl http://127.0.0.1:8000/patients/ADNI-0001/progression  # 12-mo forecast
curl -X POST http://127.0.0.1:8000/workup/next          # one autonomous step
curl -X POST http://127.0.0.1:8000/patients/ADNI-0001/advance-stage \
     -H "Content-Type: application/json" -d '{}'
#    expect: order + auto result + rescored; a low-tier subject 409s

# 3. API tests (the in-memory store; DATABASE_URL is forced empty in conftest)
cd backend && pip install -r requirements-dev.txt && pytest    # 152 tests

# 3b. ABDM consent flow (no ABDM account needed — the mock CM+HIP run in-process)
BASE=http://127.0.0.1:8000
S=$(curl -s -X POST $BASE/abdm/consent -H 'Content-Type: application/json' \
    -d '{"abha_address":"ADNI-0006@sbx"}' \
    | python -c "import sys,json;print(json.load(sys.stdin)['session_id'])")
curl -s $BASE/abdm/consent/$S      # GRANTED arrives as a callback
curl -s -X POST $BASE/abdm/consent/$S/records
curl -s $BASE/abdm/consent/$S      # RECEIVED + the post-ingest scores

# 4. Dashboard
npm install && npm run dev   # open :5173 → toggle Autonomous Neuro;
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
- **ABDM has never touched the real sandbox.** The HIU consent flow and the
  Fidelius crypto are verified against published reference vectors and an
  in-process mock HIE-CM + mock HIP, over real HTTP — but not against a live
  Consent Manager (that needs sandbox approval). Requests are signed with an
  ABDM key pair in real life; here they carry a static bearer token; consent
  sessions live in memory; and the mock gateway grants consent automatically,
  resolves ABHA → subject locally, and tags every value it synthesises as
  simulator output. Full list, with the Fidelius-version caveat: `ABDM_INTEGRATION.md` §7.
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
- **FHIR is integrated, but no real hospital network has been exercised.**
  Export, inbound ingestion, orders (`ServiceRequest`), results
  (`DiagnosticReport`) and the SMART launch flow are all implemented and covered
  by 103 tests — but the SMART flow is verified against a **mock** SMART server,
  and the outbound push needs `FHIR_BASE_URL` pointed at a HAPI reference
  server. The remaining external step is registering the client id with an EHR
  sandbox (Epic App Orchard / Cerner code console).
- **The outbound push has no outbox.** `POST /fhir/push/{id}` is a synchronous
  transaction; `FHIR_PUSH_ORDERS` is best-effort. A hospital that is down when
  an order is placed receives nothing and nothing retries — the failure is
  recorded in the patient's audit trail rather than lost silently, but
  guaranteed delivery would need a durable outbox (every write is a `PUT`
  against a deterministic id, so retrying is already safe).
- **SMART sessions are in-process.** One session per process, unencrypted, lost
  on restart and not shared across replicas — correct for a sandbox demo, and
  explicitly not production authentication.
- **Ordering a test with no result on file places the order and leaves the
  official score unchanged** (slots stay `ordered` until a real value arrives via
  `POST /fhir/Bundle` or `POST /patients/{id}/results`). No simulated result is
  ever fabricated — the previous stand-in was removed deliberately.
- **A `DiagnosticReport` never completes a slot.** A report arriving from a
  hospital is applied as a *conclusion* to a slot that already holds real
  values, or stored as a report — so a document cannot unlock the
  biomarker-gated High tier.
- **Not a diagnostic device**: prioritization support only; final decisions
  rest with the clinician.

---

## 14. Explicitly out of scope

- CI / GitHub Actions (requested to skip)
- Apache Airflow deployment (cron-friendly `run_pipeline.py` provided instead)
- OASIS-3 / other external cohorts (real ADNI ingestion **is** built; further
  cohorts would need their own registration and ingestion path)
- Authentication / multi-clinician accounts (demo prototype)

---

## 15. Stack

Python 3.11 · Pandas/NumPy · scikit-learn · XGBoost · SHAP · FastAPI · Uvicorn ·
Pydantic · SQLAlchemy/PostgreSQL · React 18 · Vite · Tailwind CSS · Recharts ·
Docker/docker-compose · nginx · pytest
