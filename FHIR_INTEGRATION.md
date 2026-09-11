# NeuroPilot — FHIR Integration Procedure & Limitations

**Standard:** HL7® FHIR® R4 (4.0.1) — the version every major EHR (Epic, Cerner/Oracle Health, Meditech) exposes today.
**Auth model:** SMART on FHIR (OAuth 2.0).
**Purpose:** let NeuroPilot exchange data with hospital EHRs and FHIR servers so it can run *inside* a clinical network instead of beside it — and prove interoperability competence in front of judges.

> **Implementation status (updated):** **Phase 1 is implemented and merged.**
> - Module: `backend/app/fhir.py` — pure converters (`patient_resource`, `observation_resources`, `risk_assessment_resource`, `audit_event_resources`, `everything_bundle`, `capability_statement`, search helpers).
> - Endpoints: `GET /fhir/metadata`, `GET /fhir/Patient` (search), `GET /fhir/Patient/{id}` (read), `GET /fhir/Patient/{id}/$everything`, `GET /fhir/Observation?patient=`, `GET /fhir/RiskAssessment?patient=` — all serving `application/fhir+json`.
> - Tests: `backend/tests/test_fhir.py` (13 cases) including the **never-emit-Condition invariant**; full suite 37/37 passing.
> - Validation gate: `python scripts/validate_fhir.py` — validates every exported resource against a live HAPI FHIR server via `$validate`, then POSTs the full `$everything` bundles as transactions (see §3, Phase 1 step 3).

> Every mapping below is written against NeuroPilot's **actual** record shape
> (`backend/app/model_service.py::record_to_features`), not a generic example.

---

## 1. Why FHIR matters for this project (one paragraph for the PPT)

NeuroPilot currently owns its own patient store (SQLite locally, PostgreSQL on Railway) fed by a synthetic ADNI-shaped cohort. FHIR is the language hospitals already speak: every result, order and demographic fact lives as a **FHIR resource** reachable over REST. Integrating FHIR means NeuroPilot can (a) ingest real patients directly from an EHR instead of a CSV, (b) push its risk assessments back where clinicians already work, and (c) log its autonomous actions into the hospital's audit stream. It converts the project from a standalone dashboard into a **system of engagement layered on a system of record**.

---

## 2. Resource mapping — NeuroPilot model → FHIR R4

| NeuroPilot field (source) | FHIR resource | Profile / coding | Notes |
|---|---|---|---|
| `id` (`ADNI-0001`) | `Patient.identifier` | Local system URI, e.g. `urn:neuropilot:subject-id` | FHIR business identity ≠ display ID; keep a mapping table (see limitation L9) |
| `age` | `Patient.birthDate` | — | FHIR stores DOB, not age; compute age on ingest |
| `sex` (`M`/`F`) | `Patient.gender` | `male` / `female` (required binding) | Direct enum map |
| `education_years` | `Patient` → *not representable* | — | Must go to an `Observation` (social history category). No single perfect LOINC; use a local code or LOINC education panels (limitation L1) |
| `comorbidities[]` | `Condition` | ICD-10/SNOMED CT | Existing health-data convention |
| `family_history` (bool) | `FamilyMemberHistory` | SNOMED `160344006` "Family history of Alzheimer's disease" | One resource per relative or a summary flag |
| `cognitive.latest` / `cognitive.prior` (MMSE) | `Observation` | **LOINC 72106-8** *Total score [MMSE]* (panel: **72107-6**) | ✔ verified on loinc.org. Two observations, different `effectiveDateTime`; `mmse_change` is *derived*, never stored |
| `blood.pTau181` | `Observation.valueQuantity` | LOINC part **LP157017-7** (Tau protein.phosphorylated 181) + UCUM `pg/mL` | ⚠ no single plasma mass-concentration LOINC exists yet (limitation L1) |
| `blood.abeta4240` (Aβ42/40 ratio) | `Observation.valueQuantity` | LOINC **41027-4** *Tau protein/Amyloid beta 42 peptide [Ratio]* (CSF-origin code, reused by convention for plasma ratio) | ⚠ partial-fit coding (limitation L1) |
| Blood panel as a whole | `DiagnosticReport` | LOINC panel code, conclusions = `outcome` (normal/abnormal/inconclusive) | `DiagnosticReport.status` maps `completed` → `final` |
| `imaging.hippocampalVolumeCm3` | `Observation` (imaging-derived) | **No standard LOINC** — use RadLex/custom `neuropilot-hippocampal-volume` | Native home is DICOM SR; FHIR is the downstream copy (limitation L1) |
| MRI study itself | `ImagingStudy` | DICOM WADO-RS links | FHIR points to pixels; it does not carry them |
| `pet.amyloid` / `pet.tau` (`Positive`/`Negative`) | `Observation.valueCodeableConcept` | SNOMED CT positive/negative finding codes | String→SNOMED map is required glue (limitation L2) |
| `pet.amyloidSUVr` | `Observation.valueQuantity` | custom code + UCUM `{SUVR}` | No LOINC for SUVR |
| **"Order this test"** (autonomous loop step 2) | `ServiceRequest` (+ `Task`) | `intent: order`, `status: active` → result arrives → `completed` | NeuroPilot's orders become real, auditable hospital orders |
| **Risk score + tier + SHAP factors** | `RiskAssessment` | `prediction[].probabilityDecimal` = score; `prediction[].qualitativeRisk` = `high`/`medium`/`low` (HL7 v3 ObservationValue codes); `basis[]` = the Observation references; `note` = the no-diagnosis disclaimer | The most faithful FHIR home for NeuroPilot's core output (limitation L3) |
| **12-month progression forecast** | `RiskAssessment` | `occurrenceDateTime` = today, `prediction[].probabilityDecimal` = conversion %, `rationale` = drivers | Keep the "nothing-changes projection" caveat in `note` |
| `history[]` (event & reasoning trail) | `AuditEvent` (or `Provenance`) | one event per history row: who/what/when/why | `Provenance` for data lineage, `AuditEvent` for actions — your append-only trail becomes standards-native |
| `updated_at` | `Resource.meta.lastUpdated` | — | Free sync semantics |

**Anti-mapping (deliberate):** NeuroPilot's score must **never** land in a `Condition` or a `DiagnosticReport.conclusion`. The API contract — *risk tier + reasoning, never a diagnosis* — survives FHIR by construction: a `RiskAssessment` is explicitly not a diagnosis. Document this as a design decision, because a judge who knows FHIR will check it.

---

## 3. Procedure — four phases, lowest-risk first

### Phase 0 — Foundations (½ day)
1. Read the FHIR R4 spec basics: `Resource`, `Bundle`, REST verbs, `CapabilityStatement` (`GET /metadata` on any server).
2. Stand up a reference server locally — **HAPI FHIR JPA** (`docker run -p 8080:8080 hapiproject/hapi:latest`) — it needs zero configuration and ships a web UI for inspecting resources.
3. Decide the integration direction to demo first (Phase 1 below): *outbound export* is self-contained and can be shown with your existing cohort.

### Phase 1 — Outbound export: NeuroPilot → FHIR (**DONE — implemented, see status block above**)
1. ~~New module `backend/app/fhir.py`~~ → **implemented** with exactly these functions plus AuditEvent export and search helpers.
2. ~~Expose read-only endpoints~~ → **implemented** at `/fhir/metadata`, `/fhir/Patient`, `/fhir/Patient/{id}`, `/fhir/Patient/{id}/$everything`, `/fhir/Observation`, `/fhir/RiskAssessment`.
3. Validate: **run the automated gate** (needs Docker Desktop running):

```bash
# one-time: start a reference HAPI FHIR R4 server
docker run -d --name neuropilot-hapi -p 8090:8080 hapiproject/hapi:latest

# start the API (separate terminal)
cd backend && python -m uvicorn app.main:app --port 8000

# validate every exported resource server-side + store the bundles round-trip
python scripts/validate_fhir.py
```

Exit code 0 = every Observation, RiskAssessment and Patient passes HAPI's `$validate`. Fix anything it rejects until the gate passes — that is the Phase 1 acceptance criterion.

### Phase 2 — Inbound ingestion: FHIR → NeuroPilot (1–2 days)
1. `POST /fhir/Bundle` (type `transaction`): iterate entries, route each resource:
   - `Patient` → create/refresh record shell (id mapping table)
   - `Observation` with LOINC 72106-8 → `record["cognitive"]` (latest/prior resolved by `effectiveDateTime`)
   - LOINC p-tau181 / 41027-4 → `record["blood"]` values (convert & **validate UCUM units**; reject `mg/dL` for p-tau rather than guessing)
   - imaging/PET observations → `record["imaging"]` / `record["pet"]`, mapping SNOMED positive/negative back to the internal `Positive`/`Negative` strings
2. On a **new completed result**, call the existing `service.record_result(...)` path — the trained model re-scores automatically, the audit trail is appended, `persist()` mirrors to Postgres. **Do not re-implement scoring; reuse the pipeline.**
3. Reject-with-422 anything unmappable, listing the offending resource — silent dropping is the failure mode that destroys clinical trust.

### Phase 3 — Bidirectional workflow (2–3 days)
1. Autonomous loop's "order test" step emits a `ServiceRequest` (`intent=order`) to the hospital FHIR server; the slot stays internal-`pending` until a `DiagnosticReport`/`Observation` lands via `POST /fhir/Bundle` or a Subscription.
2. Replace the **simulated** lab result (`service._simulate_result`) with real FHIR-delivered results behind the same interface — the simulator becomes the fallback when no EHR is connected (env flag `FHIR_UPSTREAM=`).
3. Every autonomous action also writes an `AuditEvent` upstream, so the hospital's audit system sees the loop, not just NeuroPilot's own trail.

### Phase 4 — SMART on FHIR launch from the EHR (2–4 days, production-credibility tier)
1. Register NeuroPilot as a SMART app with the EHR's sandbox (Epic **App Orchard / FHIR sandbox**, Cerner **code console** — both free for developers).
2. Implement the SMART launch sequence: EHR opens `neuropilot.app/launch?iss=...&launch=...` → `GET {iss}/.well-known/smart-configuration` → OAuth2 `authorize` + `token` → receive `access_token` + **patient-scoped context**.
3. Scope request: `patient/Patient.read patient/Observation.read user/RiskAssessment.write` — minimum necessary.
4. The React dashboard gains a launch entry point; the API client attaches `Authorization: Bearer …` to every call. Your `GET /debug/env` pattern extends naturally to `GET /fhir/status` showing connected `iss`.

**Effort envelope:** Phases 0–1 ≈ a hackathon weekend; Phases 2–3 ≈ one focused week; Phase 4 is stretch-goal territory and only needs the sandbox, not a hospital.

---

## 4. Limitations — the honest list (know these before a judge asks)

| # | Limitation | Reality & mitigation |
|---|---|---|
| **L1** | **LOINC gaps for AD biomarkers.** MMSE is perfectly coded (72106-8 ✔), but plasma p-tau181 has only a LOINC *part* code (LP157017-7), no single mass-concentration code; Aβ42/40 ratio code (41027-4) is CSF-origin; hippocampal volume, SUVR and amyloid/tau-PET binary status have **no** LOINC codes at all. | Use part codes/custom CodeSystem `urn:neuropilot:codes` + document each. The field is moving (p-tau217 codes are appearing) — say that, it shows currency. |
| **L2** | **Semantic glue required.** Internal strings (`"Positive"`, `"abnormal"`) must map to SNOMED CT concepts and back; education-years and comorbidity detail don't fit `Patient` cleanly. | Centralize the mapping in `fhir.py` with a tested table — never inline it. |
| **L3** | **`RiskAssessment` is underused in the wild.** It is exactly the right resource, but most EHRs neither render it nor expose it in clinician workflows. | Export it anyway (correctness), AND keep the dashboard as the presentation surface. |
| **L4** | **The no-diagnosis contract must be defended.** Naïve integrators push risk outputs into `Condition`; that would turn decision-support into a diagnosis the moment it syncs. | Hard rule in `fhir.py`: no `Condition` is ever generated from model output. Test it. |
| **L5** | **Auth/privacy is a real project.** SMART on FHIR implies OAuth2 client registration, token lifecycle, scope minimization; real PHI pulls HIPAA/GDPR and BAA obligations into scope. | Demo against sandboxes with synthetic data only; label the data-source pill honestly (`synthetic`), which you already do. |
| **L6** | **Units & data quality.** FHIR will happily deliver p-tau in the wrong UCUM unit or MMSE as 0–100. Garbage flows straight into the model. | Validate `valueQuantity.code` on ingest; reject-with-422; never coerce. |
| **L7** | **Sync semantics.** FHIR is resource-oriented, not queue-oriented. R4 Subscriptions are basic; the richer topic-based model is R5. "Re-score the instant a result lands" needs polling or a subscription shim. | Poll `Observation?_lastUpdated=>{cursor}` every N seconds in the demo; name R5 subscriptions as the production path. |
| **L8** | **Cohort-scale mismatch.** NeuroPilot's triage loop ranks 800 subjects continuously; FHIR search/paging per patient is orders of magnitude too slow to drive that loop. | Keep the loop on the internal store (as now); use FHIR for ingress/egress and Bulk Data (`$export`) for cohort pulls. FHIR is the *border*, not the *engine*. |
| **L9** | **Identity mapping.** `ADNI-0001` is a study ID, not an MRN. Without a durable crosswalk, the same human becomes two patients. | `Patient.identifier` with a system URI + a small mapping table; make one record per human an invariant. |
| **L10** | **Version & profile drift.** R4 vs R5 differ (Subscriptions, `RiskAssessment` nuances); US Core profiles add element-level constraints (must-Support) that vanilla R4 ignores. | Pin to R4 + US Core 6.1 for US-facing work; declare capability in `/fhir/metadata`. |

---

## 5. What to say when a judge asks "is FHIR actually integrated?"

**Honest tiering:** *"Outbound FHIR R4 export — Patients, Observations with verified LOINC codes (MMSE 72106-8), and RiskAssessments carrying the score, tier and SHAP basis — is implemented and validated against a HAPI FHIR server. Inbound ingestion reuses the same scoring pipeline so results re-score automatically. SMART on FHIR launch is designed and demoable against Epic's sandbox; PHI handling is out of scope for synthetic data. And we deliberately never emit a Condition from model output — the no-diagnosis contract survives the standard."*

That answer shows standards fluency **and** the safety instinct — which is the entire point of NeuroPilot.

---

## 6. Judge-facing demo commands (Phase 1, live)

With the API running (`uvicorn app.main:app`), these all work right now:

```bash
# conformance statement
curl -s http://127.0.0.1:8000/fhir/metadata | python -m json.tool

# one patient's complete interoperable record: demographics, LOINC-coded
# Observations, RiskAssessment (score+tier+SHAP), AuditEvent trail
curl -s http://127.0.0.1:8000/fhir/Patient/ADNI-0085/$everything | python -m json.tool

# the decision-support output as a first-class FHIR resource
curl -s "http://127.0.0.1:8000/fhir/RiskAssessment?patient=ADNI-0085" | python -m json.tool
```

What to point at while it renders: `Observation.code.coding[]` carries **LOINC 72106-8** for MMSE and **LP157017-7 / 41027-4** for the blood panel; `RiskAssessment.prediction[]` carries the exact score the dashboard shows with the H/M/L qualitative tier; the `note` repeats the **never-a-diagnosis** disclaimer — and there is no `Condition` anywhere, by construction and by test.
