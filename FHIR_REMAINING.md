# FHIR & ABDM — what remains

**Status: every codeable phase is implemented. What follows is the complete
remaining work, split by what actually blocks it.**

Implemented and verified (backend 144 pytest cases, frontend build clean):

| Area | Where |
|---|---|
| FHIR R4 export (Patient, Observation, RiskAssessment, AuditEvent, `$everything`) | `backend/app/fhir.py`, `/fhir/*` |
| FHIR inbound ingestion — `transaction` / `collection` / **`document`** (NRCES), ABHA-preferred identity + crosswalk, idempotent on ABHA + observation date, atomic 422 | `backend/app/fhir_ingest.py`, `POST /fhir/Bundle`, `POST /ingest/fhir` |
| Bidirectional workflow — `ServiceRequest` orders out, `DiagnosticReport` results in, one-transaction push | `backend/app/fhir.py`, `fhir_client.py`, `/fhir/push/{id}` |
| SMART on FHIR — OAuth2 + PKCE, patient context, tokens server-side | `backend/app/smart.py`, `/fhir/smart/*` |
| ABDM HIU consent flow — request → grant callback → records request → encrypted pull → re-score | `backend/app/abdm.py`, `/abdm/*` |
| Fidelius encryption — BouncyCastle Curve25519 (short-Weierstrass), HKDF-SHA256, AES-256-GCM, verified byte-for-byte against `fidelius-cli` reference vectors | `backend/app/fidelius.py` |
| Mock HIE-CM + mock HIP — the whole flow demonstrable with no ABDM account | `backend/app/abdm_mock.py`, mounted at `/mock-abdm` |

This file replaces `FHIR plan.md` (Phases 1–5 done, plan retired) and the
limitation lists that lived only inside the older integration docs. Detailed
procedures and demo commands stay in `FHIR_INTEGRATION.md` (HL7 FHIR) and
`ABDM_INTEGRATION.md` (ABDM).

---

## 1. Blocked on you — external, no code closes it

| Item | What it needs |
|---|---|
| **ABDM sandbox registration** (was Phase 2) | Individual HIU registration on the ABDM sandbox. Gates the live round trip below |
| **One real ABDM round trip** (was Phase 6) | Registration, plus: signed CM requests instead of the static bearer (L11), confirmation of the sandbox's Fidelius version (L10), and a **publicly reachable** `ABDM_CALLBACK_BASE_URL`. The swap is config-only — point `ABDM_CM_BASE_URL` at the sandbox and the mock is bypassed |
| **SMART client registration** | Register the app with an EHR sandbox (Epic App Orchard / Cerner code console, both free) and set `SMART_CLIENT_ID` + `SMART_REDIRECT_URI`. An unregistered client id is rejected *by the EHR*, not by this code |

## 2. Codeable, not built — the honest gaps

| # | Gap | Reality |
|---|---|---|
| **L11** | **No outbox on the FHIR push.** | The biggest one. `POST /fhir/push/{id}` is a synchronous POST and `FHIR_PUSH_ORDERS` is best-effort: a hospital that is down when an order is placed receives nothing, and nothing retries. A failure is written to the audit trail — a mitigation, not delivery. Because every write is a `PUT` against a deterministic id, retrying is already safe; what is missing is a durable queue with backoff and an idempotency key |
| **L7** | **No subscription / polling shim.** | "Re-score the instant a result lands" currently means the hospital pushes to us. The pull direction needs `Observation?_lastUpdated=>{cursor}` polling (demo) or R5 topic subscriptions (production) |
| **L11a** | **ABDM CM requests are not signed.** | A real HIU signs each request with its ABDM key pair and exchanges it for a token; we send a static bearer (`ABDM_CM_TOKEN`). This is the one thing a real Consent Manager will insist on |
| **L12** | **Consent artefacts are not retained as the legal record.** | Only ids and the outcome are kept. Production must store the artefact, purpose and erasure schedule, and honour `dataEraseAt` |
| **L13** | **ABDM sessions and key material are in memory.** | A restart drops an in-flight consent and its ephemeral key. Forward secrecy is respected in-process (the private half is dropped after a pull), but a deployment must persist sessions |
| **L10** | **Fidelius 2.x variant not implemented.** | The implemented scheme is the one pinned by the `fidelius-cli`/`pyfidelius` reference vectors. Against a 2.x HIP the alternate key derivation must be added to `fidelius.py` |
| **L12 (SMART)** | **SMART sessions live in process memory.** | One session per process, unencrypted, lost on restart, not shared across replicas. Fine for a sandbox demo; a clinical deployment stores it server-side per user, encrypted at rest |
| **L10 (FHIR)** | **No US Core 6.1 profile declaration.** | Pinned to vanilla R4; `/fhir/metadata` does not declare profile conformance |
| **L9 (partial)** | **Crosswalk covers ABHA only.** | The ABHA crosswalk is implemented. Still open: an MRN crosswalk for sites with no ABHA, and reconciliation when two source systems disagree |

## 3. Unverified — needs something running, not code

| Check | Blocker |
|---|---|
| `scripts/validate_fhir.py` against a live HAPI FHIR server | Phase 1's own acceptance criterion ("exit code 0 = every resource passes HAPI `$validate`"). Docker is installed here but the daemon was not running when last attempted |
| `docker compose up --build` end to end | The single-image Railway deploy is the exercised path; the compose file is written but not recently run |

## 4. Deliberately out — inherent, not gaps

- **LOINC coverage for AD biomarkers** (L1): MMSE is perfectly coded; plasma p-tau has only a part code; hippocampal volume, SUVR and PET status have no LOINC codes at all. We publish `urn:neuropilot:codes` alongside and document each.
- **`RiskAssessment` is underused in the wild** (L3): correct resource, most EHRs neither render it nor expose it. Export it anyway; keep the dashboard as the presentation surface.
- **Cohort-scale mismatch** (L8): the triage loop ranks thousands of subjects continuously; FHIR search/paging is orders of magnitude too slow to drive it. FHIR is the *border*, not the *engine* — Bulk Data (`$export`) is the cohort-pull path.
- **No `Condition`, ever** (L4): enforced by construction and tested, in both directions.
- **The mock gateway is not a sandbox** (L15/L16): it grants consent automatically, resolves ABHA → subject locally, fires callbacks from a timer, and tags every value it synthesises as simulator output. It reproduces the contract and direction of every call; it does not reproduce the network's timing, failure modes or authentication.
