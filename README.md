# NeuroPilot

### AI-driven prioritization for early Alzheimer's diagnostic pathways

*Precision Care Challenge 2026 — a clinical decision-support prototype

NeuroPilot scores a dementia cohort from **cognition, blood biomarkers, MRI
volumetrics and PET**, explains every score with SHAP, and moves each patient
down a fixed pathway: **Cognitive → Blood → MRI → PET**. It can walk that
pathway unattended — rank the cohort, choose the next patient, order the test,
re-score, re-rank — and it speaks **HL7 FHIR R4** and the **ABDM (India) consent
flow**, so it can live *inside* a hospital network instead of beside it.

> [!IMPORTANT]
> **NeuroPilot never outputs a diagnosis.** Every screen and every API contract
> carries one of three things: a **risk tier**, the **reasoning** behind it, and
> a **recommended next test**. No `Condition` resource is emitted in either
> direction. The decision is the clinician's.

| | |
|---|---|
| **Cohort** | 3,636 real ADNI subjects in the ingested source · **2,581 served** after the test-result filter |
| **Served model** | Refined conversion XGBoost, 14 features · model-supported **12-month risk outlook** · CV AUC **0.819 ± 0.031** · held-out AUC **0.796** |
| **Risk display** | Clinician-facing 12-month conversion-risk outlook with model attribution and a recommended next test |
| **MMSE estimate** | Real ADNI follow-up · test MAE **1.549 points** (baseline 1.859) |
| **Tests** | **229 passing** |
| **Interoperability** | FHIR R4 phases 1–4 · SMART on FHIR launched **live against a real public EHR sandbox** · ABDM consent flow (mock gateway) |

The app presents a **12-month risk outlook**, supported by the active refined conversion model. Global feature attribution is distinct from the top SHAP factor for an individual patient.

---

## Contents

| | | |
|---|---|---|
| [1. The product in one minute](#1-the-product-in-one-minute) | [7. Repository map](#7-repository-map) | [13. Configuration](#13-configuration) |
| [2. The loop, drawn](#2-the-loop-drawn) | [8. Served model card](#8-served-model-card) | [14. Tests](#14-tests) |
| [3. Readiness](#3-readiness) | [9. Model-supported outlook](#9-model-supported-outlook) | [15. Verification](#15-verification) |
| [4. Quick start](#4-quick-start) | [10. Escalation rules](#10-escalation-rules) | [16. Limitations](#16-limitations) |
| [5. Data policy](#5-data-policy) | [11. API](#11-api) | [17. Out of scope](#17-out-of-scope) |
| [6. Architecture](#6-architecture) | [12. Dashboard](#12-dashboard) | [18. Stack](#18-stack) |

---

## 1. The product in one minute

**The problem.** A memory clinic has more referrals than scan slots. Who gets
worked up first, and with what?

**The answer, in three parts.**

1. **A ranked worklist.** Every subject gets a risk score, a tier, and the SHAP
   factors that produced them. Nothing is hidden behind a number.
2. **A pathway that means something.** A measurement counts only once the
   pathway has *reached* its stage. Ordering the blood panel therefore tells you
   something you did not already know — which is not true if the score has been
   quietly reading the MRI all along.
3. **Automation with a signature.** `/workup/plan` proposes a batch with its
   reasoning and changes nothing. `/workup/execute` acts only on what you
   approved, re-checking every subject against its live state first.

**What it deliberately is not**

- **Not a diagnostic device.** It prioritizes and explains. It never names a
  disease.
- **Not a black box.** Every tier, every order, every re-score carries its
  reasoning and its timestamp.
- **Model-supported, not fabricated.** The 12-month risk outlook comes from the
  served conversion model. Clinical measurements are only recorded from real
  results; unmeasured values remain missing.
- **EHR import and results recording are separate steps.** SMART import reads the
  bound patient's real chart; a missing result stays missing until a result is
  entered or received. Importing a chart never fabricates test results.
- **Not finished.** [§16](#16-limitations) is a long, honest list.

---

## 2. The loop, drawn

```mermaid
flowchart LR
    A["Subject<br/>cognition only"] -->|score + tier| B{Next test indicated?}
    B -->|no| R["Multi-disciplinary review"]
    B -->|yes| C["Order the test<br/>ServiceRequest out"]
    C --> D["Result returns<br/>Bundle or UI"]
    D --> E["Re-score with the served model"]
    E -->|re-rank| A
```

Drop a result in and the queue reorders itself. Order a test and nothing moves
until a real value comes back — no stand-in results, ever.

---

## 3. Readiness

| Area | Status | Evidence |
|---|---|---|
| ADNI ingestion | ✅ Run & verified | 13-table drop, nearest-visit join (±183 d) across MMSE, ADAS-Cog 13, plasma panel, FreeSurfer MRI, amyloid/tau PET, APOE. Sentinel codes filtered, never read as values |
| Served conversion model | ✅ Run & verified | Refined XGBoost · 14 features · model-supported 12-month risk outlook · CV AUC **0.819 ± 0.031** · held-out AUC **0.796** |
| Leakage & outcome audit | ✅ Run & verified | FAQ excluded; `mmse_change` excluded because unavailable at first visits · bounded follow-up labels; short follow-up is unknown, not stable |
| MMSE forecaster | ✅ Run & verified | Real follow-up · held-out MAE **1.549** (baseline 1.859) · R² **0.296** |
| Explainability | ✅ Run & verified | Global SHAP with per-stage rollup, plus a *measured-only* view so a rarely-ordered test is not diluted to zero |
| Escalation engine | ✅ Run & verified | Deterministic stage gates, no second ML layer · clinician-in-the-loop `override` · ordering gaps carried forward, never overwritten |
| Autonomous triage | ✅ Run & verified | `/workup/next`, `/run`, `/plan` (read-only), `/execute` (approved subset, re-checked) |
| Cohort filtering | ✅ Run & verified | From the ADNI serving cohort, subjects with no blood/MRI/PET result anywhere are dropped: **2,581 served** |
| Backend API | ✅ Run & verified | FastAPI + Swagger at `/docs` · `/health` names the resolved data source · startup batch re-score |
| PostgreSQL store | ✅ Run & verified (Railway) | Store of record in a deployment · created and seeded on boot · re-seeds when the cohort **or** the served model changes |
| Frontend | ✅ Run & verified | React + Vite + Tailwind · **zero mock data** · clean production build, no console errors · a second, phone-only design system below 768px |
| FHIR R4 | ✅ Run & verified | Export · atomic inbound ingestion · bidirectional orders/results · SMART on FHIR launch · **134 tests** across the FHIR and SMART suites · the launch sequence additionally ran **end-to-end against the real public SMART Health IT sandbox** ([§16](#16-limitations)) |
| ABDM (India) | ✅ Run & verified (mock) | Consent → grant → encrypted pull → re-score · Fidelius checked byte-for-byte against published `fidelius-cli` vectors · 28 tests |
| Docker & deploy | ✅ Run & verified | One image: SPA build (node 20) served by FastAPI (`python:3.11-slim`, `$PORT`) · `railway.json` · `docker-compose.yml` |
| CI | ⛔ Not built | Deliberately out of scope |

---

## 4. Quick start

```bash
# ── 1. ML pipeline (once — generates the cohort and the artifacts) ────────────
python -m venv .venv && source .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -r requirements-ml.txt
# Put the ADNI tables in "ADNI DATA/" first (DUA-restricted — see data/raw/README.md)
python scripts/inspect_adni_coverage.py              # per-modality coverage, read-only
python scripts/run_pipeline.py                       # ingest → model artifacts + follow-up conversion/MMSE forecasts

# ── 2. API ────────────────────────────────────────────────────────────────────
pip install -r backend/requirements.txt
cd backend && uvicorn app.main:app --reload          # http://127.0.0.1:8000/docs

# ── 3. Dashboard ──────────────────────────────────────────────────────────────
npm install && npm run dev                           # http://localhost:5173
```

Or the whole thing in one command (needs Docker; mounts `data/processed` and
`artifacts`):

```bash
docker compose up --build          # web :8080 · API docs :8000
```

---

## 5. Data policy

> [!NOTE]
> **This repository contains no patient data.** ADNI is access-controlled under
> a Data Use Agreement and is not redistributable. What ships is the code that
> turns the tables into trained artifacts. The app serves the refined conversion
> model and presents its model-supported **12-month risk outlook**. The older
> same-visit classifier is not used for the app's default scores.

| Path | What it is | In git? |
|---|---|---|
| `ADNI DATA/*.csv` | The 13-table ADNI drop | ❌ never |
| `data/processed/risk_scores.json` | De-identified precomputed fallback scores; not the default live scores when the refined model is available | ✅ yes |
| `data/processed/adni_*.{json,csv}` | Serving records, training matrix, visit table, follow-up pairs | ❌ gitignored |
| `artifacts/progression_conversion.joblib` + `progression_meta.json` + importance | The served refined conversion classifier, model card and attribution for the 12-month risk outlook | ✅ yes |
| `artifacts/progression_delta.joblib` + progression report | The served MMSE-change forecaster | ✅ yes |
| `artifacts/pipeline.joblib` + `model_meta.json` + eval/audit | Separate same-visit classifier artifact; not used for default served scores | ✅ yes |
| `artifacts/rf_pipeline.joblib`, `progression_projection.joblib` | RF fallback · local-only attribute-estimate models | ❌ local only |

### Where the cohort lives in a deployment

An image built from this repository has **no cohort file** to copy — so the
database carries it, seeded once from a machine that legitimately holds the data:

```bash
# once, and again after any retrain — the stored fingerprint folds in the served
# model, so derived scores/tiers/attributions are recomputed
DATABASE_URL='postgresql://user:pw@host:5432/railway' python scripts/seed_db.py
```

Set `PATIENT_DATA=adni` on the service. A healthy boot logs:

```
[api] data source: adni+postgres (2581 patients loaded)   # cohort file + database
[api] data source: postgres    (2581 patients loaded)     # cohort from the database
```

Three guards protect stored patients — each one written after a real deploy went
wrong:

- **An empty cohort never seeds.** A container that cannot find the cohort file
  cannot wipe a database that still holds the last good one.
- **Stubs never replace real patients.** With neither file nor database, the API
  reports `mock` instead of overwriting Postgres with demo stubs.
- **A stored cohort that filters to zero is repaired from the file**, never served
  as an empty dashboard.

`scripts/seed_db.py` refuses to run without `DATABASE_URL` and refuses to seed
stubs, so it cannot be aimed at the wrong thing by accident.

---

## 6. Architecture

```mermaid
flowchart TB
    ADNI["ADNI DATA/*.csv<br/>13 tables · DUA-restricted"]

    subgraph ETL["ETL — scripts/ingest_adni.py"]
        JOIN["nearest-visit join ±183 d<br/>sentinel filtering<br/>features + follow-up labels<br/>serving cohort"]
    end

    subgraph TRAIN["Training — scripts/train_*.py"]
        CONV["served 12-month risk outlook:<br/>14 features · XGBoost + SHAP"]
        PROG["supported outlook: MMSE delta +<br/>accepted forward estimates"]
    end

    subgraph APIG["API — backend/app (FastAPI)"]
        STORE["cohort store<br/>startup batch re-score<br/>SQLite / PostgreSQL"]
        RULES["stage gating · evidence-gated tier<br/>escalation · model serving"]
        IO["/fhir/* export · Bundle · push · SMART<br/>/abdm/* consent + Fidelius<br/>/workup/* plan · execute"]
    end

    subgraph UIG["UI — src/ (React + Vite + Tailwind)"]
        VIEWS["worklist · detail + attribution<br/>progression · simulator<br/>Autonomous Neuro · Interoperability"]
    end

    ADNI --> JOIN
    JOIN --> CONV
    JOIN --> PROG
    CONV --> STORE
    PROG --> STORE
    STORE --> RULES
    RULES --> IO
    IO --> VIEWS
```

Layering rules worth knowing: `fhir.py` and `fhir_ingest.py` are **pure**
converters; `service.py` owns mutations; `config.py` owns the two rules that
every path shares — stage gating and the evidence-gated tier.

---

## 7. Repository map

```
.
├── README.md · FHIR_INTEGRATION.md · ABDM_INTEGRATION.md · FHIR_REMAINING.md
├── .env.example                 every supported env var, documented
├── Dockerfile                   node 20 build → python:3.11-slim serving SPA + API on $PORT
├── docker-compose.yml           postgres:16-alpine + api + web (nginx)
├── railway.json                 Railway deploy config
├── requirements-ml.txt          pandas · scikit-learn · xgboost · shap
│
├── ADNI DATA/                   raw tables (gitignored, DUA-restricted)
├── data/raw/README.md           how to obtain the drop · what ingestion writes
├── data/processed/              datasets gitignored · risk_scores.json committed
├── artifacts/                   models · cards · SHAP · eval + audit reports
├── brand_assets/                rendered logo, icon, brand sheet
│
├── scripts/
│   ├── ingest_adni.py           drop → visits / features / labels / serving cohort
│   ├── train_model.py           features → XGB/RF → eval → SHAP → artifacts
│   ├── train_progression_model.py   conversion + MMSE delta + follow-up estimates
│   ├── build_projection_targets.py  which attributes have enough support to show
│   ├── run_pipeline.py          ingest + both models, one command
│   ├── audit_model_fixes.py     leakage + robustness audit
│   ├── inspect_adni_coverage.py per-modality coverage (read-only)
│   ├── seed_db.py               seed the deployment database
│   ├── refresh_railway.py       push artifacts / reseed a deployed instance
│   ├── validate_fhir.py         server-side $validate gate for exported resources
│   └── render_brand_assets.cjs  regenerate brand_assets from BrandLogo.jsx
│
├── backend/
│   ├── tests/                   229 pytest cases (§14)
│   └── app/
│       ├── main.py · api.py     app factory (serves the built SPA) + routers
│       ├── config.py            thresholds · stage gating · evidence rule · paths
│       ├── schemas.py           Pydantic contracts (no diagnosis field)
│       ├── storage.py · db.py   cohort loading + startup re-score · SQLAlchemy store
│       ├── service.py           business logic: advance, results, workups
│       ├── escalation.py        deterministic stage rule engine
│       ├── model_service.py     served pipeline + batch SHAP
│       ├── progression.py · visits.py    model-supported risk outlook · visit history
│       ├── seed_data.py         placeholder stubs (last resort only)
│       ├── fhir.py              R4 resources (Patient / Observation / RiskAssessment …)
│       ├── fhir_ingest.py       inbound mapper (pure) — atomic, unit-checked
│       ├── fhir_import.py       read a chart over a SMART session · browse a server
│       ├── fhir_client.py       outbound push + reachability probe
│       ├── net.py               shared outbound-HTTP facts (transport errors, URL hygiene)
│       ├── smart.py             SMART on FHIR (OAuth2 + PKCE), tokens server-side
│       ├── fidelius.py          ABDM Fidelius crypto (Curve25519 · HKDF-SHA256 · AES-GCM)
│       └── abdm.py · abdm_mock.py   HIU consent client + mock CM/HIP at /mock-abdm
│
├── src/
│   ├── api.js                   fetch client — the ONLY data source
│   └── components/              Overview · AutoScrollShowcase · Header · AllPatients
│                                PatientDetail · ProgressionView · TrajectoryChart
│                                RiskSimulator · FeatureRadarChart · CohortComposition
│                                CompareView · AutonomousTriage · Interoperability
│                                AbdmPanel · MobileWelcome · Footer · TierTag · BrandLogo · widgets
│
└── frontend/                    docker-compose dashboard image (nginx → /api)
```

---

## 8. Served model and attribution

The app serves a **model-supported 12-month conversion-risk outlook** from the
refined XGBoost classifier. It uses 14 features from cognition, blood, MRI and
PET, with SHAP attribution and a recommended clinical next step. The evaluation
metrics below are for this served model. Served cohort records are latest visits
while training baselines are first visits, a train/serve shift that needs
monitoring.

| Metric | Value |
|---|---|
| Model | XGBoost conversion classifier (`progression_conversion.joblib`) |
| Features | 14, spanning cognition, blood, MRI and PET |
| 5-fold CV AUC | **0.819 ± 0.031** |
| Held-out test AUC | **0.796** |
| Held-out PR AUC | **0.386** (8.45% conversion prevalence) |
| Held-out Brier score | **0.089** |
| Stage 1 only | AUC **0.822** (n=232) |
| Blood measured | AUC **0.732** (n=95) |
| PET measured | AUC **0.793** (n=205) |

### Confusion matrix at threshold 0.5

Rows are actual outcome; columns are model prediction. `0` = did not convert,
`1` = converted.

| Actual \\ Predicted | 0 · No conversion | 1 · Conversion 
|---|---:|---:|
| **0 · No conversion** | 273 | 26 |
| **1 · Conversion** | 14 | 14 |

This is the 327-subject held-out set; accuracy is **0.878**.

`age` · `sex` · `education_years` · `mmse` · `adas_cog_13` · `apoe_e4` ·
`ptau217` · `abeta4240` · `nfl` · `gfap` · `hippocampal_volume` ·
`hippocampal_icv_ratio` · `centiloids` · `tau_meta_temporal`

### 8.1 Relative feature attribution

**Relative feature attribution** in the Overview is the cohort-level, global
mean absolute SHAP ranking from the active refined model. Its checked-in local
artifact ranks Amyloid PET just above Tau PET. That is different from the
patient-detail attribution: those SHAP factors are calculated for one person,
so **Tau PET can be that patient's top factor**. The patient-specific leader
need not match the global ranking. The Overview loads global importance from
`GET /model/info`; individual factors come from that patient's explanation.
Neither ranking is a causal effect or diagnosis.

| # | Feature | Mean \|SHAP\| | Share | Stage |
|---|---|---:|---:|---|
| 1 | Amyloid PET (Centiloids) | 1.186 | 16% | PET |
| 2 | Tau PET (temporal SUVR) | 1.168 | 16% | PET |
| 3 | ADAS-Cog 13 | 1.070 | 15% | Cognition |
| 4 | Hippocampal / ICV ratio | 0.973 | 13% | MRI |
| 5 | Hippocampal volume | 0.549 | 8% | MRI |
| 6 | Aβ42/40 ratio (plasma) | 0.380 | 5% | Blood |
| 7 | NfL (plasma) | 0.380 | 5% | Blood |
| 8 | Age | 0.311 | 4% | Clinical |
| 9 | APOE ε4 carrier | 0.292 | 4% | Clinical |
| 10 | p-tau217 (plasma) | 0.248 | 3% | Blood |
| 11 | Biological sex | 0.232 | 3% | Clinical |
| 12 | MMSE | 0.178 | 2% | Cognition |
| 13 | Education (years) | 0.167 | 2% | Clinical |
| 14 | GFAP (plasma) | 0.102 | 1% | Blood |

### 8.2 Outcome and feature exclusions

The target is conversion from a first labelled CN/MCI visit to a strictly worse
ADNI diagnostic category within the bounded follow-up window. Subjects without
adequate follow-up are excluded as **unknown outcome**, not treated as stable.
The served feature set excludes `faq_total` (label leakage) and
`mmse_change` (available at only 2.5% of first visits, so recent decline speed
is not part of the baseline model). The model card and evaluation details are in
`artifacts/progression_meta.json` and `artifacts/progression_report.txt`.

### 8.3 Tiers require corroborating evidence

The served model provides a **12-month conversion-risk outlook**, not a
same-visit classification of whether someone currently has MCI or dementia. The
tier answers *"do we have enough evidence to act on this score?"* Cognition is
the assessment the referral was already based on, so it cannot corroborate
itself.

| Tier | Requires |
|---|---|
| **High** | score > 0.70 **and** ≥ 1 biomarker inside the ordered pathway |
| **Medium** | score ≥ 0.40 — includes cognition-only patients, flagged *awaiting confirmation* |
| **Low** | score < 0.40 |

On the current served cohort (2,581): **111 High · 438 Medium · 2,032 Low**.
Of the **1,459 subjects at Stage 1**, **138 score above 0.70 and are held at
Medium** (mean MMSE 19.5) — their biomarker is on file but sits *beyond* the
pathway, so the score cannot see it either (§8.4). They are promoted
automatically the moment the intervening test is reached.

At Stage 1 both Medium and High order the blood panel, so the automation behaves
identically — a cognition-only patient is still first to be tested.

### 8.4 Ordering gaps, and why the stage stops at the first missing test

Real ADNI is not a tidy funnel — modalities were added across study phases, so
all eight combinations of blood / MRI / PET exist. In the served cohort,
**1,574 records hold a result measured outside the ordered prefix** (blood
1,122 · MRI 2,120 · PET 1,168 are on file; stage counts a *prefix*, not a
maximum).

A "highest completed stage" rule would label those subjects Stage 3/4 and claim
a blood panel that was never drawn — the stepper would then contradict the
record. NeuroPilot defines instead:

> **stage = the length of the complete prefix of the ordered pathway.**

So a subject with an MRI and no plasma panel is **Stage 1**, the rule engine
recommends the missing blood draw, and two things stay true at once:

- **Nothing measured is discarded.** Real MRI/PET values still feed the model
  once the pathway reaches them, and `/patients/{id}` reports `slots_on_file`
  plus `beyond_stage` so the UI can say *already on file* instead of looking
  self-contradictory.
- **A real measurement is never overwritten.** Walking past an already-measured
  slot carries the real values forward — logged as
  `result already on file (normal) — carried forward without re-measurement`.
  Only genuinely missing slots get a derived result. Locked by
  `test_ordering_gap_never_overwrites_a_real_measurement`, which asserts the
  carried record is byte-identical before and after.

Served cohort shape: **1,459 · 332 · 231 · 559** across stages 1–4.

---

## 9. Model-supported outlook

The served model provides a 12-month conversion-risk outlook alongside
MMSE-change estimates and supported attribute estimates, based on real ADNI
follow-up data. Evaluation metrics for the refined classifier and MMSE estimate
are listed below.

| Model | Metric | Result |
|---|---|---|
| MMSE-delta regressor | test MAE | **1.549 pts** (mean-baseline 1.859) |
| | RMSE / R² | 2.217 / 0.296 (n = 1,387) |
| Conversion classifier | 5-fold CV AUC | **0.819 ± 0.031** |
| | held-out ROC AUC | **0.796** |
| | PR AUC | 0.386 — ≈4.6× lift over 8.45% prevalence |
| | Brier | 0.089 |
| | accuracy @0.5 | 0.878 (majority baseline 0.914) |
| | by baseline | CN **0.657** (n = 775, 2.97% convert) · MCI **0.761** (n = 859, 13.39%) |

Held-out confusion matrix at the 0.5 threshold (rows = actual, columns = predicted;
`0` = no conversion, `1` = conversion):

| Actual \\ Predicted | 0 | 1 |
|---|---:|---:|
| **0 · No conversion** | 273 | 26 |
| **1 · Conversion** | 14 | 14 |

> **Accuracy below the majority baseline is intentional.** At 8.45% prevalence,
> answering "will not convert" for everyone scores 0.914 while carrying no
> information. AUC, PR AUC and Brier are the honest measures here.

### Which attribute estimates are supported — and which are withheld

An attribute estimate is shown only when its model beats *assume no change*
by at least 10% on CV MAE. On the current run exactly one target clears the bar:

| Target | Gain vs no-change | Shown? |
|---|---|---|
| Hippocampal volume | **+28.7%** | ✅ model-supported estimate |
| ADAS-Cog 13 | +5.1% | ❌ carried at today's value |
| Centiloids | +6.6% | ❌ carried at today's value |
| Hippocampal / ICV ratio | +0.0% | ❌ carried at today's value |

The reason an attribute estimate is withheld is surfaced on the page. The
attribute-estimate models are local-only (gitignored), so a deployment reports
the same reasons instead of guessing.

**Guardrails.** Subject-level holdout · conversion defined over a bounded
evaluation window, with subjects whose follow-up is too short **excluded rather
than assumed stable** · a shorter window was rejected for carrying too few
positives to calibrate · baseline features are *first* visits while served
records are *latest* visits · `mmse_change` excluded (present in only 2.5% of
first visits) · `faq_total` excluded (leakage) · the future tier is calculated by
re-scoring the **served conversion model** on the model-supported future vector.

> A flat forecast is a real answer: **ADNI-0500** (stage 1, MMSE 28, score 0.017)
> projects a conversion probability near zero and a Low tier.

---

## 10. Escalation rules

Deterministic stage gates (`backend/app/escalation.py`). No second ML layer.

| Stage | Low | Medium | High |
|---|---|---|---|
| 1 · Cognitive | Re-screen in 12 mo | **Blood panel** | **Blood panel** |
| 2 · Blood | Re-screen in 12 mo | **MRI volumetrics** | **MRI volumetrics** |
| 3 · MRI | Return to screening | Follow-up MRI in 12 mo | **Amyloid / tau PET** |
| 4 · PET | — pathway complete → multi-disciplinary review — | | |

Test-ordering escalations are confirmable. "Schedule / return" recommendations
are **not** auto-escalated: `POST /advance-stage` returns `409` unless the
clinician passes `{"override": true}`. Every transition, order, result and
re-score is timestamped into the subject's audit trail, and mirrored to Postgres
when configured.

---

## 11. API

Pydantic-validated, Swagger at `/docs`. **No response model contains a diagnosis
field.** CORS allows the Vite dev server plus `CORS_ORIGINS`.

### Cohort & decisions

| Endpoint | Behaviour |
|---|---|
| `GET /health` · `GET /debug/env` | Resolved data source + count · deploy diagnostics (database shape, outbound FHIR destination, and whether the configured URL needed trimming — never secrets) |
| `GET /patients?tier=&q=&sort=&page=&limit=` | Ranked worklist. `sort`: `risk-desc`, `risk-asc`, `stage` |
| `GET /patients/{id}` | Full profile: slots, all SHAP `factors`, `history`, `slots_on_file`, `beyond_stage` |
| `GET /patients/{id}/explain` | Score, tier, patient-specific SHAP factors and global importance |
| `GET /model/info` | Active served model card, metrics, feature list and global SHAP importance (`legacy` is reference metadata, not the scored model) |
| `GET /patients/{id}/pipeline` | Stage, stage names, history, `recommended_next` |
| `GET /patients/{id}/refined` | Refined outlook: observed + model-estimated MMSE with a band, top drivers and supported risk score/tier |
| `GET /patients/{id}/progression` | 12-month risk outlook with trajectory, conversion probability + drivers, risk tier and per-stage score checkpoints |
| `POST /patients/compare` | Side-by-side comparison of subjects |
| `POST /patients/score` | Score an arbitrary feature vector with the served pipeline + SHAP (powers the simulator) |

### Acting on a record

Patients arriving through SMART or an inbound FHIR Bundle are filed in the
NeuroPilot store, then scored by the configured served model. From patient
detail, a clinician can also record a result manually. A blank/unavailable test
remains missing; no result is fabricated. The model-supported risk outlook is
separate from these import and result-entry workflows.

| Endpoint | Behaviour |
|---|---|
| `POST /patients/{id}/advance-stage` | `{"override": false, "note": null}` → order, carry forward, re-score. `404` unknown · `409` not indicated |
| `POST /patients/{id}/results` | `{"slot", "outcome", "values", "note"}` → re-scores. `422` bad slot **or a value that is not a number in a measurement field** (nothing is written) · `409` nothing pending |
| `POST /patients/{id}/auto-workup` | Per-subject cascade blood → MRI → PET, re-scoring at each step |

### Automation

| Endpoint | Behaviour |
|---|---|
| `POST /workup/next` · `POST /workup/run` | One autonomous step, or up to N: rank → order → re-score → re-rank, returning tier, queue movement, projected-vs-actual and the reason |
| `POST /workup/plan` | **Read-only** proposal batch: four labelled reasons per action, `impact` verdict, projected score and rank. Computed on copies — mutates nothing |
| `POST /workup/execute` | Executes **only the approved subset**, re-checking each subject first. Returns an executed ledger plus every skipped subject with its reason |

### FHIR R4

| Endpoint | Behaviour |
|---|---|
| `GET /fhir/metadata` | `CapabilityStatement` with a SMART security block |
| `GET /fhir/Patient` · `/{id}` · `/{id}/$everything` | Searchset · single read · the complete record as one `collection` Bundle |
| `GET /fhir/Observation?patient=` · `/fhir/RiskAssessment?patient=` | LOINC-coded measurements (MMSE 72106-8 …) · score, tier and SHAP basis |
| `GET /fhir/ServiceRequest?patient=&status=` | Placed orders — `active` = result owed, `completed` = real value on file |
| `GET /fhir/DiagnosticReport?patient=` | Completed panels; the conclusion describes *the test*, never the model |
| `POST /fhir/Bundle` | **Inbound.** `transaction` / `collection` / `document` (NRCES). Prefers the **ABHA address** as subject id, keeps a crosswalk, **idempotent** on patient + measurement fingerprint/date. Atomic: any unmappable resource or wrong UCUM unit rejects the whole bundle with a 422 `OperationOutcome` naming every offender; accepted observations update/create the record and recalculate its score/tier |
| `POST /ingest/fhir` | Direct ingestion for a HIP pushing without a consent exchange |
| `POST /fhir/push/{id}` | Push orders + results + RiskAssessment + AuditEvent as one atomic FHIR transaction |
| `GET /fhir/status` | Four phases, outbound reachability, SMART session, exchange-surface counts — subjects, **`from_fhir`** (subjects posted in over the FHIR boundary), RiskAssessments, observations, open and completed orders |
| `GET /fhir/smart/launch` | 302 to the authorize URL (PKCE S256, single-use `state`); accepts a per-launch patient and an opaque `launch` context |
| `GET /fhir/smart/charts` | Browse/filter the connected FHIR server's own `Patient` records (optionally by name), identify records already imported, and select a real server-local id for launch |
| `GET /fhir/smart/callback` | Exchanges the code, holds the token server-side, returns the browser with `?smart=connected&patient=…`; failures return `?smart=error&reason=…` instead of a raw document |
| `GET /fhir/smart/status` · `/context` · `POST /refresh` · `POST /logout` | Registration facts, bound patient context, renewal, disconnect — never token material |
| `POST /fhir/smart/import-patient` | Explicitly imports the patient bound to the active SMART session: reads `Patient`, `Observation` and `DiagnosticReport`, maps supported measurements, records EHR provenance, then creates or updates and re-scores the NeuroPilot record. Re-importing identical data is idempotent; unmappable data returns an `OperationOutcome` without a partial write |

### ABDM (India)

| Endpoint | Behaviour |
|---|---|
| `POST /abdm/consent` · `GET /abdm/consent/{id}` | Open a consent request for an ABHA address (the **only** identifier that leaves) · poll it; consent arrives as a callback, so nothing blocks |
| `POST /abdm/consent/{id}/records` | The HIU's ephemeral DH **public** key and nonce travel here — never the private half |
| `POST /abdm/consents/notify` · `/abdm/health-information/on-request` | Consent-Manager callbacks. An unknown id is acknowledged, not errored — a retrying CM must not wedge |
| `POST /abdm/health-information/transfer` | The HIP's encrypted push: bearer, transaction and MD5 checked before decrypting, GCM tag verified, replay refused, then ingested through the same scoring path as a result typed in the UI |
| `GET /abdm/status` · `GET /abdm/sessions` · `POST /abdm/reset` | Config, CM reachability, crypto parameters · live sessions · demo reset |

<details>
<summary><b>Example payloads</b></summary>

```json
{ "id": "ADNI-0500", "age": 71, "sex": "M", "education_years": 16,
  "cognitive": {"scale": "MMSE", "latest": 28, "prior": 29, "months": 6},
  "score": 0.017, "risk_tier": "low", "stage": 1, "stage_name": "Cognitive",
  "recommended_next": "Blood biomarker panel for p-tau217 / Aβ42-40 / NfL / GFAP.",
  "updated_at": "2026-09-25 20:14" }
```

```json
{"feature": "abeta4240", "text": "Aβ42/40 ratio", "value": 0.081, "contribution": 0.367}
```
</details>

---

## 12. Dashboard

React + Vite + Tailwind. **Zero mock data** — `src/api.js` is the only source; if
the API is down you get an error and a Retry, never fake rows.

**Overview** · a self-advancing capability preview, the cohort ribbon (subjects ·
High/Medium/Low · mean risk · **From FHIR**), the served model's attribution
radar, and the top-8 shortlist.

**Patients** (`P`) · cohort shape charts, stage-gate pills directly above the
table they filter, then the ranked worklist: tier/stage filters, search, sort,
pagination, page state preserved when you open a subject and come back.

**Detail** · score gauge with 0.4/0.7 thresholds · patient-specific **Clinical
Risk Attribution** grouped by stage with signed SHAP bars, measured values and
`model default` badges for un-ordered tests · the Cognitive → Blood → MRI → PET
stepper · recommended next
step with Confirm (`409` messages surface inline) and an explicit *Override —
escalate anyway* path · interactive result entry · the audit trail · printable
consultation report.

**Progression** · a full page, not a popup: observed → predicted MMSE with
an uncertainty band, the risk score at each completed stage test plotted as
outcome-coloured markers, the model-supported 12-month risk outlook, metric
cards, conversion probability and top drivers.

**Autonomous Neuro** (`A`) · the approval console. A proposed batch with
per-action reasoning and a blunt impact verdict, independent approve/reject, a
sticky `N of M approved` bar, then an execution **ledger** — stage, both scores,
tier, queue movement, and every skipped subject with its reason. Below it, the
supervised run mode with a fixed-height, auto-following log that keeps its rows
after Stop.

**Interoperability** (`F`) · the four FHIR phases with live state, outbound
reachability, SMART launch/renew/disconnect, and a name-filterable chart picker
backed by the hospital server's own `Patient` records. Select a server-local
chart, launch it in context, then explicitly import its `Patient`, `Observation`
and `DiagnosticReport` data into NeuroPilot. The import maps supported records,
keeps the EHR id and issuer as provenance, avoids duplicate writes on re-import,
and shows the new/refreshed subject, score, tier and mapped counts; errors reject
without partial writes. Also includes preview/export-and-push, a manual inbound
Bundle tester, and the **ABDM consent flow** (request → grant → encrypted pull →
post-ingest stage, tier and scores), plus exchange-surface counts. Clinical test
results can also be recorded from the patient detail workflow; an order alone
never invents or completes a result.

**Simulator** (`S`) · what-if scoring on the served conversion model's 14
features, with per-stage *Measured / Not ordered* switches that send `null` and
route the model through its learned missing-value path, plus a live SHAP waterfall.

**Keyboard** · `D` overview · `P` patients · `S` simulator · `F` interoperability
· `A` autonomous · `T` theme · `Esc` back · `←` `→` step between patients.

**Design** · Inter type, ambient background, glass sticky header with a live
data-source pill, hairline cards, skeletons, light and dark themes, tier colours
reserved for risk semantics, and `prefers-reduced-motion` respected throughout.

**On a phone** · below 768px the dashboard is a second design system, not a
scaled-down desktop. A pale aquamarine page and one aquamarine accent that
draws edges instead of filling them; cards, badges, glows and explanatory prose
are dropped rather than shrunk, so what is left is the numbers and the decision.
Every grid that names a column count at `sm` or above collapses to **two**
columns — the widest that still leaves a cell readable at 360px — and a lone
card left over in an odd row spans the full width instead of stranding beside an
empty half. Below `sm` a ribbon stops being one divided panel and becomes
uniformly-sized cards. The sliding showcase is replaced by a single full-bleed
welcome panel whose height is measured from the device viewport, so it meets the
fold exactly; that panel is the one exemption from the phone rules and renders as
drawn. `prefers-reduced-motion` is honoured on both.

**On a large screen** · at 1536px and up the layout keeps responding rather than
growing empty margins. The 1152px rail widens in steps — 1312px at 1536, 1536px
at 1920, 1792px at 2560 — and the small label type steps up with it, because
almost all of it is set in px and would otherwise stay fixed while the page grew
around it. Prose keeps its own narrow measure, so only the rails widen. Nothing
below 1536px is affected.

---

## 13. Configuration

Every variable is documented in `.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `HIGH_RISK_THRESHOLD` / `MEDIUM_RISK_THRESHOLD` | `0.7` / `0.4` | Tier bucketing |
| `PATIENT_DATA` | `auto` | `adni` requires the real cohort (deployments) · `mock` forces stubs |
| `DATABASE_URL` | unset | SQLAlchemy store · **store of record** in a deployment |
| `PROJECT_ROOT` | auto | Artifact/data root (Docker: `/app`) |
| `RISK_SCORES_PATH`, `MODEL_PATH`, `MODEL_META_PATH`, `GLOBAL_IMPORTANCE_PATH` | `data/processed/…`, `artifacts/…` | Artifact locations |
| `VITE_API_URL` | `http://127.0.0.1:8000` | API base as seen by the browser |
| `CORS_ORIGINS` | unset | Extra allowed origins |
| `FHIR_BASE_URL` | unset | Outbound hospital server. Unset = not configured, and every outbound call says so. Whitespace is trimmed — a value pasted with a newline used to be an invalid URL |
| `FHIR_PUSH_ORDERS` | `false` | Push each new order as a `ServiceRequest`, best-effort |
| `FHIR_AUTH_TOKEN` / `FHIR_TIMEOUT_SECONDS` | unset / `8` | Static bearer for a non-SMART server · outbound timeout |
| `SMART_CLIENT_ID` / `SMART_CLIENT_SECRET` | `neuropilot-demo` / unset | SMART app registration — public clients use PKCE, no secret |
| `SMART_REDIRECT_URI` | `…/fhir/smart/callback` | Must match the registered URI byte-for-byte |
| `SMART_SCOPES` | minimum-necessary set | `launch/patient openid fhirUser` + read Patient/Observation/DiagnosticReport/RiskAssessment + write RiskAssessment |
| `SMART_LAUNCH_PATIENT_ID` | unset | Fallback chart for a standalone launch that names none — a demo default, not the only way to choose |
| `FRONTEND_BASE_URL` | `http://localhost:5173` | Where the SMART callback hands the browser back to |
| `ABDM_CM_BASE_URL` | unset | Real Consent Manager. Unset = the in-process mock |
| `ABDM_HIU_ID` / `ABDM_CM_ID` / `ABDM_CM_TOKEN` | demo values | HIU identity and the bearer presented to the CM (a real HIU signs each request) |
| `ABDM_CALLBACK_BASE_URL` | `http://127.0.0.1:8000` | Where the CM calls back and the HIP pushes — **must be publicly reachable** for a real sandbox |
| `ABDM_TIMEOUT_SECONDS` / `ABDM_USE_MOCK_GATEWAY` | `10` / `true` | Outbound timeout · mount the mock CM + HIP at `/mock-abdm` |
| `ABDM_REQUESTER_NAME` / `ABDM_REQUESTER_REGNO` | demo values | Requester identity in the consent request |

> Deeper detail lives in **`FHIR_INTEGRATION.md`** (FHIR R4 + SMART procedures and
> demo commands) and **`ABDM_INTEGRATION.md`** (consent flow + Fidelius, and what
> is verified versus what needs a sandbox account). **`FHIR_REMAINING.md`** splits
> what is left by what blocks it.

---

## 14. Tests

**229 cases, all green.** `conftest.py` forces the in-memory store
(`DATABASE_URL=""`), so no test can ever mutate a persistent database.

Every suite runs against a **mock** that speaks the real contract shapes — an
in-process mock EHR for the SMART and chart-import suites, a mock Consent
Manager plus mock HIP for ABDM, all over real HTTP. That is deliberate: a test
suite must not depend on a network it does not control. The one **live**
interoperability exercise is separate and manual — a real SMART launch against
the public SMART Health IT sandbox — and is recorded in
[§16](#16-limitations) as a one-time verification, not as test coverage. The two
claims are kept apart on purpose.

| Suite | Cases | Covers |
|---|---|---|
| `test_api.py` | 45 | Worklist, detail, attribution, ordering gaps, results, thresholds, tier gating |
| `test_fhir_import.py` | 34 | Chart browsing, SMART-session import, token scoping per server, credential-leak guards — against a mock EHR speaking the real contract shapes |
| `test_smart.py` | 30 | Discovery, PKCE/state, callback, refresh, expiry, no-token-material guarantees |
| `test_fhir_phase3.py` | 27 | Orders, reports, push, status, launch targeting, value validation, export robustness |
| `test_fhir.py` | 17 | Export resources · **never-emit-Condition** invariant · values match the record |
| `test_abdm.py` | 15 | Consent → grant → encrypted pull → re-score, over real HTTP |
| `test_cohort_source_guard.py` | 14 | A stored cohort is never replaced by stubs; source reporting stays honest |
| `test_fidelius.py` | 13 | Curve25519 ECDH + HKDF-SHA256 + AES-GCM, byte-for-byte against reference vectors |
| `test_fhir_nrces.py` | 13 | NRCES document bundles, ABHA identity + crosswalk, idempotency |
| `test_fhir_ingest.py` | 13 | Inbound mapping, UCUM enforcement, atomic rejection naming offenders |
| `test_pg_driver.py` · `test_db_seed.py` · `test_declared_dependencies.py` | 8 | Driver pinning · seeding guard · every imported package is declared |

```bash
cd backend && pip install -r requirements-dev.txt && pytest -q
```

---

## 15. Verification

```bash
# 0 · Data (needs the ADNI drop in "ADNI DATA/")
python scripts/inspect_adni_coverage.py          # per-modality coverage, read-only

# 1 · Ingest + both models
python scripts/run_pipeline.py                   # writes data/processed + artifacts

# 2 · API
cd backend && uvicorn app.main:app --reload
curl http://127.0.0.1:8000/health                            # data_source: adni (+postgres)
curl "http://127.0.0.1:8000/patients?limit=3"                # top-3 ranked subjects
curl http://127.0.0.1:8000/patients/ADNI-0500/explain        # full attribution
curl http://127.0.0.1:8000/patients/ADNI-0500/progression    # model-supported 12-month risk outlook
curl -X POST http://127.0.0.1:8000/workup/next               # one autonomous step
curl -X POST http://127.0.0.1:8000/workup/plan \
     -H "Content-Type: application/json" -d '{"limit": 5}'   # read-only proposal

# 3 · Backend tests (in-memory store — no database is touched)
cd backend && pytest -q                                      # 229 passed

# 4 · ABDM consent flow (no ABDM account: mock CM + HIP run in-process)
BASE=http://127.0.0.1:8000
S=$(curl -s -X POST $BASE/abdm/consent -H 'Content-Type: application/json' \
    -d '{"abha_address":"ADNI-0006@sbx"}' \
    | python -c "import sys,json;print(json.load(sys.stdin)['session_id'])")
curl -s $BASE/abdm/consent/$S              # GRANTED arrives as a callback
curl -s -X POST $BASE/abdm/consent/$S/records
curl -s $BASE/abdm/consent/$S              # RECEIVED + post-ingest scores

# 5 · Dashboard
npm install && npm run build && npm run dev

# 6 · SMART on FHIR against a REAL public sandbox (one-time, manual — not a test)
#      register the client id at launch.smarthealthit.org, set SMART_CLIENT_ID,
#      SMART_REDIRECT_URI and FRONTEND_BASE_URL to the host the EHR must return to
curl -s "http://127.0.0.1:8000/fhir/smart/launch?iss=https://launch.smarthealthit.org/v/r4/fhir&format=json" \
  | python -m json.tool          # the authorize URL: PKCE S256 + single-use state
curl -s http://127.0.0.1:8000/fhir/smart/status | python -m json.tool
#      -> "connected": true, "iss": "https://launch.smarthealthit.org/v/r4/fhir"
```

---

## 16. Limitations

> [!WARNING]
> Read this section before quoting any number above. Several of these are the
> reason a claim is phrased the way it is.

**Data & model**

- **ADNI is a research cohort, not a population sample** — highly educated,
  largely Western, volunteer-recruited. Its follow-up and conversion rates do
  not represent community prevalence. Real deployment needs local validation
  data.
- **ADNI is DUA-restricted.** The CSVs stay gitignored; this repository ships the
  code that turns them into a model, never the cohort.
- **Training and serving visits differ.** The refined conversion model trains
  from first labelled CN/MCI visits, while served cohort records represent latest
  visits; this train/serve shift needs monitoring.
- **PET coverage varies by dataset and model artifact.** For the refined model's
  checked evaluation cohort, amyloid coverage is about 59% and tau PET coverage
  about 25%. Individual patient-specific SHAP factors can rank differently from
  the global importance list shown on Overview.
- **The retained same-visit classifier is not the default served model.** Its
  evaluation and attribution files describe a different task; they are not
  evidence for the live conversion scores. The default configuration serves
  `progression_conversion.joblib`.
- **Only hippocampal volume has a supported attribute estimate.** ADAS-Cog 13,
  Centiloids and hippocampal/ICV ratio fail the *beat assume-no-change by 10%*
  bar and are carried at today's value, with the reason shown on the page.
- **This is decision support, not a diagnosis.** A real intervention or new
  clinical information can change the patient's outlook; the model output is one
  input to clinician review.

**Interoperability**

- **SMART on FHIR is verified against a real public EHR sandbox, not a mock.** The
  full OAuth2/PKCE launch was run live: client registration with SMART Health IT's
  `launch.smarthealthit.org`, real token exchange, and a real Synthea patient and
  encounter context returned to the session — `/fhir/smart/status` reported
  `connected: true` against `iss: https://launch.smarthealthit.org/v/r4/fhir`. What
  remains is registration with a **production** EHR — Epic, Oracle Health, or a
  hospital's own FHIR server — which needs institutional access this project does
  not have.
- **No real hospital network has been exercised.** Export, ingestion, orders,
  results and chart browsing are implemented and tested, but the automated suites
  run against a **mock** server speaking the real contract shapes, and an outbound
  push needs `FHIR_BASE_URL` pointed at a real server. The live sandbox run above
  is a **one-time manual verification, not test coverage** — "tested against a
  real sandbox" (manual) and "tested in the suite" (automated, against a mock) are
  two different claims and are not conflated.
- **SMART sessions are per-process memory** — unencrypted, lost on restart, not
  shared across replicas. Right for a sandbox demo; explicitly not production
  authentication.
- **The outbound push has no outbox.** `POST /fhir/push/{id}` is synchronous and
  `FHIR_PUSH_ORDERS` is best-effort: a hospital that is down when an order is
  placed receives nothing, and nothing retries. The failure is recorded in the
  audit trail rather than lost, and every write is a `PUT` to a deterministic id,
  so a retry would be safe once a durable outbox exists.
- **ABDM has never touched the real sandbox.** The consent flow and Fidelius are
  verified against published reference vectors and an in-process mock HIE-CM + HIP
  over real HTTP — not against a live Consent Manager, which needs sandbox
  approval. Requests carry a static bearer instead of an ABDM signature and
  sessions are in memory. Full list: `ABDM_INTEGRATION.md` §7.

**Behaviour worth knowing**

- **Ordering a test with no result on file places the order and leaves the score
  unchanged.** No simulated result is ever fabricated.
- **A `DiagnosticReport` never completes a slot** — it is applied as a conclusion
  to a slot that already holds real values, so a document cannot unlock the
  biomarker-gated High tier.
- **A value in a measurement field must be a number.** Numeric strings are
  coerced, blanks dropped, anything else refused with a 422 naming the field.
  Records written before that check existed still hold text; the export skips it
  rather than failing, and re-entering the number restores it.
- **Integration-panel order counts are capped at the first 200 ranked patients**,
  so those totals are a sample, not a cohort-wide figure. Known and unfixed.
- **Not a diagnostic device.** Prioritization support only; every decision rests
  with the clinician.

---

## 17. Out of scope

| Skipped | Why |
|---|---|
| CI / GitHub Actions | Requested out of scope |
| Apache Airflow | A cron-friendly `run_pipeline.py` covers it |
| Cohorts other than ADNI | Each needs its own registration and ingestion path |
| Authentication / multi-clinician accounts | Demo prototype |

---

## 18. Stack

| Layer | Tools |
|---|---|
| ML | Python 3.11 · pandas · NumPy · scikit-learn · XGBoost · SHAP |
| API | FastAPI · Uvicorn · Pydantic · SQLAlchemy (PostgreSQL 16 / SQLite) |
| UI | React 18 · Vite 5 · Tailwind CSS 3 · Recharts · lucide-react |
| Ops | Docker · docker-compose · nginx · pytest |
