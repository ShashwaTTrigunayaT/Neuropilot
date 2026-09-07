# Software Prototype Blueprint
## AI-Driven Prioritization System for Early Alzheimer's Diagnostic Pathways
### Precision Care Challenge 2026

---

## 1. What the Prototype Actually Does

A clinician logs in, sees a ranked list of patients (High / Medium / Low priority), clicks one, and sees:

1. The risk score and tier
2. The top factors driving that score (explainability)
3. Which stage of the 4-stage pipeline the patient is at (Cognitive → Blood → MRI → PET)
4. A recommended next action ("Recommend blood biomarker panel")

Underneath, the system ingests ADNI/OASIS patient records, engineers features, scores each patient with a trained ML model, explains the score with SHAP, and applies rule-based escalation logic to place each patient in the pipeline. **It never outputs a diagnosis — only a priority tier and a recommended next test.**

---

## 2. Full Architecture (Layer by Layer)

```
┌─────────────────────────────────────────────────────────┐
│ DATA SOURCES: ADNI, OASIS (CSV/DICOM downloads)          │
└───────────────────────────┬─────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────┐
│ INGESTION & ETL LAYER (Python, Pandas, cron/Airflow)      │
│  - Parses raw ADNI/OASIS files                            │
│  - Cleans, deduplicates, harmonizes column schemas         │
│  - Writes into unified Patient data model                  │
└───────────────────────────┬─────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────┐
│ PATIENT-CENTRIC DATA STORE (PostgreSQL)                    │
│  - patients, cognitive_scores, comorbidities, labs,         │
│    imaging_features, pipeline_status tables                 │
└───────────────────────────┬─────────────────────────────┘
                             ▼
┌───────────────────────┬───────────────────────────────────┐
│ RISK SCORING ENGINE     │ EXPLAINABILITY LAYER               │
│ (scikit-learn/XGBoost)  │ (SHAP)                              │
│  - Feature engineering  │  - Per-patient feature attribution  │
│  - Trained classifier   │  - Global feature importance        │
│  - Outputs probability  │  - Generates human-readable reasons │
└───────────────────────┴───────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────┐
│ ESCALATION RULE ENGINE (Python business logic)              │
│  Stage 1 Cognitive → Stage 2 Blood → Stage 3 MRI → Stage 4 PET │
│  - Threshold + model-score based stage advancement            │
└───────────────────────────┬─────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────┐
│ BACKEND API (FastAPI, REST/JSON)                             │
│  /patients  /patients/{id}  /patients/{id}/explain            │
│  /patients/{id}/pipeline-status                                │
└───────────────────────────┬─────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────┐
│ CLINICIAN DASHBOARD (React + Tailwind + Recharts)             │
│  - Prioritized patient list, filters, sort by tier              │
│  - Patient detail: score, reasoning panel, pipeline tracker      │
└─────────────────────────────────────────────────────────┘
```

---

## 3. Technology Stack — What and Why

| Layer | Technology | Why This Choice |
|---|---|---|
| Data ingestion / ETL | Python 3.11, Pandas, NumPy | Standard for tabular clinical data; ADNI/OASIS ship as CSV + imaging metadata, which Pandas handles natively |
| Scheduling (optional) | Apache Airflow (or a simple cron + Python script for hackathon scope) | Demonstrates a repeatable, auditable ingestion pipeline — Airflow is the honest answer for production, cron script is the pragmatic hackathon answer |
| Database | PostgreSQL | Relational integrity matters here — a patient has one row per cognitive test, one per lab panel, one per scan; foreign keys naturally express that. Free, well-documented, easy to demo locally via Docker |
| Feature engineering | Pandas, scikit-learn Pipeline/ColumnTransformer | Keeps preprocessing (scaling, imputation, encoding) reproducible and bundled with the trained model |
| Risk scoring model | XGBoost (primary) or scikit-learn RandomForestClassifier (fallback/baseline) | Tabular, mixed-type, small-to-medium clinical datasets are XGBoost's strong suit; it handles missing values natively (common in real clinical data) and gives strong AUC on ADNI-style tasks in published literature |
| Explainability | SHAP (SHapley Additive exPlanations) | Directly satisfies the brief's "explainability and transparency" requirement; produces both per-patient reason codes and global feature importance; TreeExplainer is fast on XGBoost/RandomForest |
| Escalation logic | Plain Python rule engine (score thresholds + stage-gating conditions) | The brief wants "clear, interpretable, valid" logic — a transparent if/else/threshold system is more auditable and defensible in a clinical/regulatory context than another ML layer deciding escalation |
| Backend API | FastAPI (Python) | Async, auto-generates OpenAPI/Swagger docs (useful for judges to poke at your API live), integrates cleanly with the same Python ML stack — no language-boundary friction |
| Frontend | React + Vite, Tailwind CSS, Recharts | React for component-driven dashboard; Recharts for score distributions and pipeline funnel visuals; Tailwind for fast, clean styling without a design team |
| Containerization | Docker + docker-compose | One-command spin-up (Postgres + API + frontend) — critical for a judged demo where reliability matters more than infra sophistication |
| Model serving | Model pickled/joblib, loaded directly into the FastAPI process (no separate model server needed at this scale) | Avoids overengineering; a dedicated model server (e.g., MLflow, TorchServe) is unnecessary for a single tabular classifier serving a few hundred patients in a demo |
| Version control / CI | GitHub + GitHub Actions (lint + test on push) | Standard, and a green CI badge is a small but real credibility signal to judges |

---

## 4. How Each Component Actually Functions

### 4.1 Data Ingestion & ETL

- Pulls the ADNI and OASIS CSV exports (demographics, MMSE/MoCA scores, diagnosis labels, select biomarker/imaging-derived features like hippocampal volume).
- A Python script (`ingest.py`) reads each source, renames columns to a shared internal schema (e.g., both cohorts' cognitive score fields map to one `cognitive_score` column), flags missing values rather than silently dropping rows, and deduplicates on subject ID.
- Writes cleaned records into PostgreSQL via SQLAlchemy.

This is the layer that satisfies "organize data into a unified patient-centric structure."

### 4.2 Patient-Centric Data Store

Core tables:
- **patients** — demographics, enrollment cohort
- **cognitive_assessments** — MMSE/MoCA score, test date
- **comorbidities** — hypertension, diabetes, cardiovascular history flags
- **lab_results** — blood biomarker values (where available in ADNI, e.g., plasma p-tau proxies)
- **imaging_features** — MRI-derived volumetrics (hippocampal volume, cortical thickness) from ADNI/OASIS processed imaging data
- **risk_scores** — model output, SHAP top factors, tier, timestamp
- **pipeline_status** — current stage (1–4), recommended next action

### 4.3 Risk Scoring Engine

- **Features:** cognitive score, age, education, comorbidity flags, available blood markers, available imaging-derived volumetrics.
- **Labels:** derived from ADNI/OASIS's existing diagnostic labels (CN / MCI / AD) — used to train a model that predicts probability of progression toward AD, which is standard practice in ADNI-based ML literature.
- **Model:** XGBoost classifier, trained offline (in a Jupyter notebook or script), evaluated with stratified train/test split, AUC-ROC and calibration checked before shipping the model file into the app.
- **Output:** a probability (0–1), bucketed into High (>0.7), Medium (0.4–0.7), Low (<0.4) — thresholds are configurable, not hardcoded, since real deployment would tune these against clinical validation data.

### 4.4 Explainability Layer

- SHAP TreeExplainer runs against the trained XGBoost model.
- For each patient, computes SHAP values per feature and surfaces the top 3–4 contributing factors, translated into plain language (e.g., "MoCA decline (−4 points in 6 months)" instead of a raw feature name).
- Also computes global feature importance once at training time, useful for a "how does this system decide?" panel for judges/clinicians.

### 4.5 Escalation Rule Engine

Deterministic, not another model — this is intentional for auditability:

- **Stage 1→2:** if risk tier is Medium or High → recommend blood biomarker panel.
- **Stage 2→3:** if biomarker result plus updated risk score stays Medium/High → recommend MRI.
- **Stage 3→4:** if MRI shows meaningful structural change (e.g., hippocampal volume below a percentile threshold for age) plus sustained High tier → recommend PET.
- Every gate logs why it fired, feeding the reasoning trail shown in the UI.

### 4.6 Backend API (FastAPI)

Key endpoints:
- `GET /patients` — paginated, sortable list with tier, name/ID, current stage
- `GET /patients/{id}` — full profile
- `GET /patients/{id}/explain` — SHAP reasoning payload
- `GET /patients/{id}/pipeline` — stage history and next recommended step
- `POST /patients/{id}/advance-stage` — clinician manually confirms/overrides stage advancement (keeps a human in the loop, per the "decision-support only" requirement)
- Auto-generated Swagger UI at `/docs` for live demo credibility.

### 4.7 Clinician Dashboard (React)

- **Patient list view:** table/cards color-coded by tier, sortable, filterable by stage.
- **Patient detail view:** score gauge, SHAP reasoning panel (bar chart of top factors), pipeline stepper (Cognitive → Blood → MRI → PET, current stage highlighted), recommended next action button.
- **Cohort overview (nice-to-have):** funnel chart showing how many patients are at each stage, useful for the "resource optimization" narrative in your pitch.

---

## 5. End-to-End Data Flow (One Patient, Worked Example)

1. Patient record ingested from ADNI → lands in `patients` + `cognitive_assessments`.
2. Feature pipeline builds their feature vector (MoCA score, age, hypertension flag, etc.).
3. XGBoost model scores them: **0.78 → High tier**.
4. SHAP explains: top factors = "MoCA decline," "hypertension," "family history."
5. Escalation engine: High tier at Stage 1 → recommends blood biomarker panel, advances to Stage 2.
6. API serves this to the dashboard.
7. Clinician sees the patient at the top of the list, opens detail view, sees the three reasons, clicks "confirm and order biomarker test."

---

## 6. Non-Functional / Ethical Requirements Baked Into the Design

- **No identifiable data:** only public ADNI/OASIS records, no PII beyond what those datasets already de-identify.
- **Decision-support framing enforced in the API contract itself:** no endpoint returns a "diagnosis" field — only `risk_tier`, `reasoning`, and `recommended_next_test`.
- **Auditability:** every score and stage transition is timestamped and stored, so the full reasoning trail is reconstructable later.
- **Clinician-in-the-loop:** stage advancement requires explicit confirmation via `POST /patients/{id}/advance-stage` rather than auto-progressing — the system recommends, the clinician decides.

---

## 7. Suggested Build Order for a Hackathon Timeline

1. **Data + model first:** get ADNI/OASIS loaded, train and validate the XGBoost model offline, confirm SHAP output makes clinical sense. (This de-risks the hardest part early.)
2. **Database + ETL script:** stand up Postgres, write the ingestion script, load real records.
3. **Backend API:** wrap the trained model + SHAP + rule engine in FastAPI endpoints.
4. **Frontend:** build the patient list and detail view against the live API.
5. **Polish:** pipeline funnel chart, reasoning panel styling, docker-compose for one-command demo.

---

## 8. Limitations to State Upfront (Judges Respect This)

- ADNI/OASIS skew toward Western, highly educated, research-cohort populations — not representative of a general or Indian clinical population; a real deployment needs local validation data.
- Blood-biomarker fields in ADNI are limited/proxy — Stage 2 in a real deployment would need integration with an actual clinical lab feed.
- The model informs prioritization, not diagnosis — final clinical decisions always rest with the neurologist.