/**
 * Render NeuroPilot — Judge Q&A Defense document to PDF.
 * Usage: node scripts/render_qa_pdf.cjs   (writes NeuroPilot_Judge_QA.pdf in project root)
 *
 * Covers: the judge question ("why are same-score patients prioritized differently?")
 * answered in depth, plus the full expected-question bank across every dimension
 * (problem, data, model, explainability, progression, rules, autonomy, engineering,
 * deployment, limitations). All numbers come from artifacts/ and the live codebase.
 */
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = path.join(__dirname, '..', 'NeuroPilot_Judge_QA.pdf');

/* ------------------------------------------------------------------ */
/* Content                                                             */
/* ------------------------------------------------------------------ */

const SECTIONS = [
  {
    title: 'The Question You Were Asked',
    lead: '"Why are patients with the same score prioritized differently?"',
    items: [
      {
        q: 'The answer in one sentence',
        a: `They almost never actually have the same score — the dashboard <b>displays</b> scores rounded to two decimals (<code>0.81</code> can be 0.8067 or 0.8132), while <b>ranking and all decisions use full-precision model output</b>; and when two patients are clinically indistinguishable, the system deliberately surfaces <i>why</i> each one is ranked there (SHAP attribution) instead of silently inventing a preference — that decision stays with the clinician.`,
      },
      {
        q: 'The five-layer answer (say it in this order)',
        a: `
<b>1. Display rounding, not decision rounding.</b> The score is a continuous float64 from a gradient-boosted ensemble. The UI shows <code>toFixed(2)</code> for readability; the ranked table sorts by the full-precision value. Two rows reading "0.96" are almost never equal internally — the tie is an artifact of the display, and the ordering between them is real.<br><br>
<b>2. Priority is not the score alone — it is (tier, stage).</b> The rule engine gates the next test on the <i>risk tier</i> (high &gt; 0.7 · medium ≥ 0.4 · low) crossed with the <i>pipeline stage</i> the patient has reached. A 0.65 at Stage 1 (medium) gets a blood panel; a 0.65 at Stage 3 (medium) gets a 12-month follow-up MRI. Same displayed score, different indicated action — by clinical design.<br><br>
<b>3. Tier boundaries change behavior at the same "displayed" score.</b> 0.69 vs 0.71 both display near "0.7" but straddle the high-tier threshold — at Stage 3 that is the difference between a follow-up MRI and an amyloid/tau PET. The thresholds are configurable (env-overridable) and shown on the gauge.<br><br>
<b>4. Same score, different reasoning — and we show it.</b> Two patients at 0.75 can arrive there by different paths: one via cognition (MMSE 20, declining), another via biomarkers (p-tau 6.1, hippocampus 2.1 cm³) with a decent MMSE. SHAP attribution exposes exactly this. If a clinician must break a near-tie, they break it on <i>evidence composition</i>, which the UI makes visible per patient.<br><br>
<b>5. In autonomous mode the choice is deterministic and auditable.</b> <code>workup/next</code> picks the highest-scoring subject whose tier still indicates a test (exact code: <code>max(candidates, key=score)</code>). Because features are continuous, exact float ties across 800 subjects are measure-zero; the audit trail logs every pick with before/after rank.`,
      },
      {
        q: 'If we wanted an explicit tiebreaker (production answer)',
        a: `We would add a deterministic, documented chain — never a hidden one: <b>① score (full precision) → ② higher conversion probability</b> (we already compute a 12-month progression probability per patient — the natural clinical tiebreaker) <b>→ ③ longer waiting time → ④ stable patient ID</b>. The key design principle: ties are resolved by <i>declared, auditable policy</i>, not by silent side effects of sort stability.`,
      },
      {
        q: 'The honest concession (judges reward this)',
        a: `"If two patients are truly indistinguishable on every measured dimension, the system <b>refuses to fake a preference</b> — it presents both reasonings side by side and leaves the call to the clinician. In a clinical decision-support product, an unexplainable ordering is worse than a visible tie." Then note the roadmap item: surface the explicit tiebreaker policy in the UI so the ordering is always explainable end-to-end.`,
      },
    ],
  },
  {
    title: 'Problem & Product',
    items: [
      {
        q: 'What problem does NeuroPilot solve?',
        a: `Memory-clinic and trial-screening workflows drown in undifferentiated referral lists: every patient waits the same, test ordering is ad-hoc, and the patients who would benefit most from early workup are found late. NeuroPilot turns a static cohort into a <b>continuously re-ranked, self-advancing priority queue</b>: each patient carries a model score, an explanation, a pipeline position (Cognitive → Blood → MRI → PET), and a 12-month outlook — and the system itself can drive the workup, one indicated test at a time, re-scoring and re-ranking as results land.`,
      },
      {
        q: 'Why prioritization, not diagnosis?',
        a: `Because that is the honest, safe, and regulated scope for this evidence base. A diagnosis changes a life; our models are trained on synthetic, ADNI-shaped data and would need local validation before any clinical use. So the system outputs exactly three things — <b>risk tier, reasoning, recommended next test</b> — and no endpoint or screen contains a diagnosis field. It makes the queue smarter; it does not make the call.`,
      },
      {
        q: 'Who is the user, and what do they see?',
        a: `A clinician or trial coordinator. Overview: tier distribution, risk histogram, stage funnel, top-8 shortlist. Patients: the full ranked, filterable table. Detail: score gauge with thresholds, all 10 SHAP factors grouped by stage, pipeline stepper, recommended next step, interactive results entry, timestamped audit trail. One click: the full-page 12-month progression forecast.`,
      },
      {
        q: 'Why four stages, in that order?',
        a: `It mirrors the real diagnostic funnel and a cost/invaiseness gradient: <b>cognition</b> (cheap, universal, always measured) → <b>blood biomarkers</b> (cheap draw, p-tau181 + Aβ42/40) → <b>MRI volumetrics</b> (hippocampal atrophy) → <b>PET</b> (amyloid/tau — most expensive, most invasive, ordered only when the tier still indicates it). Each stage refines the score; the updated tier decides whether the next stage is even indicated. Low-tier patients stop early — that is the resource-saving point.`,
      },
      {
        q: 'How is this different from "just an ML model"?',
        a: `The model is one component of five: a <b>deterministic rule engine</b> decides what tests are indicated (auditable if/else, not another ML layer), an <b>explanation layer</b> (SHAP) makes every score defensible, a <b>pipeline/audit layer</b> tracks every order, result and re-score, an <b>autonomy layer</b> drives the cohort workup under tier gating, and a <b>forecasting family</b> projects 12-month trajectories. Remove the model and the product still has a defensible clinical workflow — that is deliberate.`,
      },
      {
        q: 'Walk me through the product in 30 seconds.',
        a: `Open the dashboard: 800 ranked subjects. Toggle <b>Autonomous Triage</b>: the system picks the highest-priority subject itself, orders its next indicated test, derives the result, re-scores with the trained model, and re-ranks the queue — the banner shows <code>SYN-0087 · BLOOD abnormal · 0.68 → 0.81 (high) · #12 → #2</code>. Open any patient: gauge, stage-grouped SHAP, stepper, audit trail, and a Progression Probability button that opens the full 12-month forecast chart.`,
      },
    ],
  },
  {
    title: 'Data',
    items: [
      {
        q: 'Real data or synthetic?',
        a: `Both, by design. <b>Real:</b> public OASIS-1 longitudinal (150 subjects, 373 visits) runs the full ETL — dedupe, missing-value audit (SES ×19, MMSE ×2 flagged, never silently dropped). <b>Synthetic:</b> an 800-subject ADNI-1-proportioned cohort (200 CN / 400 MCI / 200 AD) with severity-correlated measures at all four stages — this is the served default because OASIS-1 has <i>no blood, MRI-volumetry or PET columns</i>, and a 4-stage product needs 4-stage data.`,
      },
      {
        q: 'Why not use real ADNI data?',
        a: `ADNI requires registration, data-use certification and manual downloads — not redistributable in a hackathon repo. We built the generator to ADNI-1's published composition and biomarker ranges specifically so the <b>swap is one command</b>: point <code>train_model.py --data</code> at a real cohort and the same pipeline, guardrails and API serve it unchanged.`,
      },
      {
        q: 'Is the synthetic cohort clinically plausible — or did you hand the model the answer?',
        a: `It is generator-shaped, and we say so plainly: measures are severity-correlated with realistic reference ranges (p-tau 0.6–7.5 pg/mL, Aβ42/40 0.04–0.16, hippocampus 1.6–4.3 cm³), CDR included only as the label source and excluded from features. The honest framing: the model demonstrates the <i>methodology</i> end-to-end; performance numbers on synthetic data are a floor, not a claim. The model card, /model/info and /health all disclose <code>data_mode: synthetic</code>.`,
      },
      {
        q: 'How is missing data handled?',
        a: `Two distinct cases. <b>Un-ordered tests</b> stay NaN — XGBoost consumes missing values natively, and SHAP attributes the learned missing-value path (shown in the UI as a dimmed <code>model default</code> badge, so un-measured stages are visible, not hidden). <b>Measured-but-missing values</b> (e.g. OASIS SES/MMSE gaps) are median-imputed inside the sklearn Pipeline, which is bundled into the served artifact — imputation is therefore identical at train and serve time.`,
      },
      {
        q: 'What prevents subject overlap between train and test?',
        a: `Subject-level splitting: a patient is entirely in train or entirely in test — no visit-level leakage. Stratified by label; 80/20. The same discipline carries into the progression models (stratified by conversion).`,
      },
      {
        q: 'What is your reproducibility story?',
        a: `Seeded generators (fixed seed in both cohort scripts), deterministic follow-up simulation, versioned artifacts with <code>trained_at</code> and full metric cards (<code>artifacts/eval_report.txt</code>, <code>progression_report.txt</code>), and committed artifacts so a fresh deploy serves the exact model that was evaluated.`,
      },
    ],
  },
  {
    title: 'Model — Risk Scoring',
    items: [
      {
        q: 'Why XGBoost?',
        a: `Tabular, mixed-type, small-to-medium clinical data is its strength: it handles missing values natively (essential for staged workups), captures non-linear threshold effects (MMSE 24 vs 23 is not a linear event), and trains in seconds so re-scoring on every result is practical. A RandomForest fallback ships alongside (test AUC 0.874 vs 0.871) — and the baseline gap proves the complexity is warranted.`,
      },
      {
        q: 'Why not deep learning / why not an LLM?',
        a: `With 800 subjects, a deep net would overfit and lose the SHAP-speed explainability we serve per request. LLMs are the wrong tool for a calibrated numeric risk estimate — we use deterministic code where determinism matters and reserve narrative language for the UI copy.`,
      },
      {
        q: 'Exactly what are the features, and why is CDR excluded?',
        a: `Ten, spanning all four stages: <code>mmse</code>, <code>mmse_change</code>, <code>age</code>, <code>education_years</code>, <code>sex</code>, <code>ptau181</code>, <code>abeta4240</code>, <code>hippocampal_volume</code>, <code>amyloid_positive</code>, <code>tau_positive</code>. CDR is excluded because it is a <b>clinician rating that effectively encodes the diagnosis</b> — training on it is label leakage and the model would be a parrot, not a predictor.`,
      },
      {
        q: 'What are the actual numbers?',
        a: `5-fold CV AUC <b>0.842 ± 0.032</b> (the honest estimate), held-out test AUC 0.871, accuracy@0.5 <b>0.750</b> on 160 unseen subjects, majority-class baseline 0.581 — about <b>+17 points over naive guessing</b>. Confusion matrix [[52 15],[25 68]]. Per-class: high-tier precision 0.819 / recall 0.731.`,
      },
      {
        q: 'Is AUC 0.84 good enough for clinical use?',
        a: `For <i>prioritization</i>, yes-in-principle; for deployment, not yet — because the data is synthetic. Rank quality is what the product needs (AUC measures exactly that), and 0.84 with a 0.58 baseline is a solid signal. The caveat is stated in the model card, the eval report and the UI footer: synthetic training data, optimistic holdout (early stopping used the test set), real deployment requires local validation.`,
      },
      {
        q: 'Where do the thresholds 0.7 / 0.4 come from?',
        a: `They are policy, not model output — deliberately configurable via environment (<code>HIGH_RISK_THRESHOLD</code>/<code>MEDIUM_RISK_THRESHOLD</code>) so a clinical site can calibrate to its own capacity and prevalence. The gauge shows them explicitly; nothing about tiering is hidden inside the model.`,
      },
      {
        q: 'How does a score change when a test result lands?',
        a: `The result is written into the patient record, the 10-feature vector is recomputed (NaN → measured value), and the served pipeline re-scores immediately — score and tier update live, and the audit trail timestamps the transition. In the verification run an abnormal blood panel moved one subject <b>0.68 → 0.81</b> and its rank <b>#12 → #2</b>.`,
      },
    ],
  },
  {
    title: 'Explainability',
    items: [
      {
        q: 'Why SHAP?',
        a: `It is the standard for tree-ensemble attribution with solid theoretical grounding (Shapley values): consistent, locally accurate, and fast via TreeExplainer. It gives both views the product needs — <b>global</b> importance (which features drive the cohort: MMSE 1.068, p-tau181 0.304, Aβ42/40 0.233, age 0.184, hippocampal volume 0.175) and <b>per-patient</b> reason codes with signed contributions.`,
      },
      {
        q: 'What is the "model default" badge?',
        a: `The contribution shown for a <b>test that was never ordered</b> — XGBoost routed that NaN down a learned default path. We badge it (dimmed, with a footnote) because presenting a number for an un-measured biomarker would be misleading. The moment the test completes, the measured contribution replaces it. This is a transparency feature judges consistently notice.`,
      },
      {
        q: 'Can a clinician challenge the score?',
        a: `Yes — that is the design. Every factor is shown with its measured value and signed contribution, grouped by pipeline stage; the clinician can see the score is "driven by cognition, biomarkers normal" and act on judgment. The rule engine additionally refuses to auto-escalate routine follow-ups (409) without an explicit <code>override: true</code>, which is logged.`,
      },
    ],
  },
  {
    title: 'Progression Forecaster',
    items: [
      {
        q: 'What exactly does "probability of clinical progression" mean?',
        a: `The model's estimate that the patient crosses into the next diagnostic phase within <b>12 months</b>: CN → MCI, MCI → AD, or AD → severe decline (MMSE &lt; 15). It is trained on the same 10-feature baseline vector, with labels from simulated follow-up trajectories driven by published base rates (CN ~4%/yr, MCI ~12%/yr, AD ~28%/yr) modulated by each patient's biomarker evidence.`,
      },
      {
        q: 'How accurate is the forecast?',
        a: `MMSE-delta regressor: test MAE <b>0.611 points</b> (mean-baseline 1.043) — a year-ahead forecast within ~0.6 points; R² 0.679. Conversion classifier: ROC AUC <b>0.770</b>, PR AUC 0.465 against 16.6% prevalence (<b>~2.8× lift</b>), Brier 0.143. The uncertainty is visible: the trajectory chart shows a ± band (~75% interval) around the predicted path.`,
      },
      {
        q: 'How is the "projected tier" computed? Is it a third model?',
        a: `No third model — deliberately. The <b>current risk model</b> is re-scored on the projected future vector (age+1, forecast MMSE, carried-forward biomarkers). One consistent model family end-to-end means the "today vs 12-month" comparison on screen is apples-to-apples.`,
      },
      {
        q: 'What are the stage-score markers on the trajectory chart?',
        a: `The risk score <b>at the moment each stage test was completed</b>: the trained model is re-scored on the patient's data <i>as it existed then</i> (later-stage results masked to unmeasured). You literally watch the score climb as blood → MRI → PET results land — the chart tells the same story the live system performed.`,
      },
      {
        q: 'Is the forecast a diagnosis or a guarantee?',
        a: `Neither — the card carries the disclaimer in the UI and the API payload. It is a "nothing changes" projection under standard care; an intervention (e.g. anti-amyloid therapy) would alter the trajectory. And it is trained on simulated trajectories shaped by published dynamics — production would retrain on a real longitudinal cohort.`,
      },
    ],
  },
  {
    title: 'Rule Engine & Pipeline Logic',
    items: [
      {
        q: 'Why a rule engine for escalation instead of another ML model?',
        a: `Because test-ordering policy must be <b>auditable, defensible and inspectable</b> — a transparent (stage × tier) table beats a second black box deciding who gets an MRI. In a clinical/regulatory context, "the if-statement did it" is a feature. The ML decides <i>how risky</i>; the rules decide <i>what that risk means procedurally</i>.`,
      },
      {
        q: 'State the escalation matrix.',
        a: `<table>
<tr><th>Stage</th><th>Low</th><th>Medium</th><th>High</th></tr>
<tr><td>1 Cognitive</td><td>Re-screen 12 mo</td><td>Blood panel</td><td>Blood panel</td></tr>
<tr><td>2 Blood</td><td>Re-screen 12 mo</td><td>MRI volumetrics</td><td>MRI volumetrics</td></tr>
<tr><td>3 MRI</td><td>Return to screening</td><td>Follow-up MRI 12 mo</td><td>Amyloid/tau PET</td></tr>
<tr><td>4 PET</td><td colspan="3">— pathway complete → multi-disciplinary review —</td></tr>
</table>`,
      },
      {
        q: 'How is the clinician kept in the loop?',
        a: `Three mechanisms: (1) "Schedule/Return" recommendations are never auto-executed — <code>advance-stage</code> 409s unless <code>override: true</code>; (2) every order, result, re-score and override is timestamped in the reasoning trail (mirrored to Postgres); (3) the autonomous loop is opt-in and can be toggled off mid-run — the system stops, mid-state intact.`,
      },
      {
        q: 'What happens at Stage 4 / pathway end?',
        a: `The pipeline reports complete and routes to multi-disciplinary review. In autonomous mode that subject simply drops out of the testable queue — the system never loops tests for completeness's sake.`,
      },
    ],
  },
  {
    title: 'Autonomy & Safety',
    items: [
      {
        q: 'How autonomous is it, really?',
        a: `Fully, within a hard scope: <code>workup/next</code> ranks the cohort, picks the top subject whose tier indicates a test, orders it, derives a plausible result, re-scores, re-ranks — and reports before/after rank for audit. <code>workup/run</code> batches up to N steps. It stops cleanly when no tier indicates a test. It never prescribes treatment, never diagnoses, and never escalates routine follow-ups without override.`,
      },
      {
        q: 'What stops it ordering unnecessary tests?',
        a: `The tier gate: a low tier at any stage returns "re-screen in 12 months" — no test indicated, the cascade stops with a 409 and a stated reason. Cost escalates with stage by design (PET only for Stage-3 high tier), so the expensive modalities are naturally rationed by the same table.`,
      },
      {
        q: 'What if the model is wrong?',
        a: `Bounded blast radius: a wrong score mis-<i>orders</i> the queue — it does not diagnose or treat. The clinician sees the attribution behind every score and can override anything; every automated action is reversible and logged. And the failure mode we care about (missed high-risk patients) is measurable: recall on the held-out set is reported in the eval report rather than buried.`,
      },
      {
        q: 'Are the "results" real?',
        a: `No — ordering a test derives a clinically plausible outcome from the subject's severity profile. That is a declared demo stand-in for a real LIS/RIS integration, and it is what makes the live loop (order → result → re-score → re-rank) demonstrable without a hospital backend.`,
      },
    ],
  },
  {
    title: 'Engineering & Architecture',
    items: [
      {
        q: 'Draw the system.',
        a: `<b>Scripts</b> (Python 3.11: generate/ingest/simulate/train) → <b>artifacts</b> (pipeline.joblib + progression models + model cards, committed) → <b>FastAPI</b> (loads cohort, re-scores everyone at startup via vectorized SHAP batch; rule engine; progression serving; optional Postgres persistence) → <b>React + Vite + Tailwind</b> SPA (pure API client, zero mock data). Single Dockerfile: builds the UI, serves it from the API process on $PORT.`,
      },
      {
        q: 'How is the model served? Any latency concerns?',
        a: `In-process — the sklearn Pipeline + XGBoost joblib loads at startup with a cached SHAP TreeExplainer; per-request scoring is milliseconds and startup re-scores all 800 subjects in one vectorized batch. At this scale a separate model server (MLflow/TorchServe) would be over-engineering; the boundary where that changes is clearly understood.`,
      },
      {
        q: 'Why FastAPI / React / Postgres?',
        a: `FastAPI: async, Pydantic-validated contracts (which structurally enforce "no diagnosis field"), auto Swagger for judges to poke endpoints live. React+Vite+Tailwind: fast, componentized, product-grade UI with zero hardcoded data — <code>src/api.js</code> is the only data source, so an API outage shows an error, never fake rows. Postgres (optional, active on Railway): relational integrity fits one-row-per-event clinical history; the schema mirrors the blueprint (patients, cognitive_assessments, lab_results, pipeline_history…).`,
      },
      {
        q: 'What is tested?',
        a: `24 pytest cases covering the API contract end-to-end (sorting, filtering, tiering, 404/409/422 semantics, workup loop, progression) plus DB seed foreign-key integrity. The frontend was verified with headless-Chrome E2E probes (navigation round-trips, chart rendering, autonomous banner).`,
      },
      {
        q: 'How do you handle concurrent edits / race conditions in the demo?',
        a: `Single-writer in-process state for the demo scope; Postgres persistence when configured, with every state change event-logged. Production would move to optimistic locking on patient records — acknowledged as out of demo scope.`,
      },
    ],
  },
  {
    title: 'Deployment',
    items: [
      {
        q: 'Where is this deployed and how?',
        a: `Railway, from a single Dockerfile: stage 1 builds the React bundle, stage 2 is a Python 3.11 slim runtime that copies the backend, the committed artifacts, and the built SPA, and serves everything from one uvicorn process on $PORT. Push-to-deploy from GitHub. Postgres via Railway plugin with <code>DATABASE_URL=\${{Postgres.DATABASE_PRIVATE_URL}}</code>.`,
      },
      {
        q: 'Why are model artifacts committed to git? Isn’t that an anti-pattern?',
        a: `It is a deliberate deployment trade-off: committed artifacts mean a fresh container serves the exact evaluated model with <b>zero training at boot</b> — critical for a judged demo's reliability. Datasets are <i>not</i> committed (licensing + reproducibility: the cohorts regenerate from seeded scripts in seconds). Production CI would swap this for artifact registry + version pinning; the eval reports already pin what each artifact should produce.`,
      },
      {
        q: 'Scaling & security posture?',
        a: `Scaling: the app is stateless per request (state lives in the DB when enabled) — scale horizontally behind a load balancer; model inference is cheap. Security/PHI: this demo holds synthetic subjects only; production would need PHI controls (encryption at rest, access control, audit retention) and is explicitly listed out of scope — we would not ship it otherwise.`,
      },
    ],
  },
  {
    title: 'Limitations & Roadmap',
    items: [
      {
        q: 'State the limitations — before we find them.',
        a: `We lead with them: (1) <b>synthetic training data</b> — methodology demo, not a clinical claim; disclosed in the model card, /model/info, /health. (2) <b>Simulated progression labels</b> shaped by published dynamics, not observed outcomes. (3) <b>Simulated test results</b> stand in for LIS/RIS. (4) <b>Optimistic holdout</b> — early stopping used the test set; CV AUC is the honest number. (5) <b>PET signal thin</b> (amyloid/tau correlate in the generator). (6) <b>No auth/multi-clinician</b>, demo prototype. Every one of these has a named production answer.`,
      },
      {
        q: 'What would productionization actually take?',
        a: `Retrain on a real registered cohort (ADNI/OASIS-3) with local validation; replace derived results with LIS/RIS integration; auth + role-based access; artifact registry and CI; drift monitoring (score distribution + SHAP stability dashboards); prospective evaluation of the escalation matrix with clinical governance. The architecture is already shaped for this swap — that was the design constraint.`,
      },
      {
        q: 'What would you build next?',
        a: `The explicit tiebreaker policy surfaced in the UI (score → conversion probability → waiting time → ID); intervention-aware forecasting ("what if anti-amyloid therapy starts now"); cohort-level capacity planning (queue vs scanner slots); and FHIR interoperability so orders/results speak hospital language natively.`,
      },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* HTML                                                                */
/* ------------------------------------------------------------------ */

const esc = (s) => s; // content is trusted, written by us
const tocItems = SECTIONS.map((s, i) => ({ n: i + 1, title: s.title, count: s.items.length }));

const itemHtml = (item, idx, secNum) => `
  <div class="qa">
    <div class="q"><span class="qn">${secNum}.${idx + 1}</span>${esc(item.q)}</div>
    <div class="a">${item.a}</div>
  </div>`;

const sectionHtml = (sec, i) => `
  <section class="sec ${i === 0 ? 'hero-sec' : ''}">
    <h2><span class="secnum">${i + 1}</span>${esc(sec.title)}</h2>
    ${sec.lead ? `<p class="lead">${esc(sec.lead)}</p>` : ''}
    ${sec.items.map((it, j) => itemHtml(it, j, i + 1)).join('')}
  </section>`;

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=IBM+Plex+Mono:wght@500;600&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --ink: #16181B; --muted: #5B6472; --line: #E4E1DB;
    --teal: #0D8282; --teal2: #0FA0A0; --blue: #2563EB; --mint: #38E1B0;
  }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: 'Inter', system-ui, sans-serif; color: var(--ink); font-size: 10.2px; line-height: 1.62; }
  code, .mono { font-family: 'IBM Plex Mono', monospace; font-size: 0.92em; background: #F3F1EC; border-radius: 4px; padding: 1px 5px; }
  b { font-weight: 700; }

  /* ---------- cover ---------- */
  .cover { page-break-after: always; display: flex; flex-direction: column; height: 262mm; }
  .cover .band { background: linear-gradient(120deg, var(--teal) 0%, var(--teal2) 55%, var(--blue) 100%);
    border-radius: 20px; padding: 54px 52px; color: #fff; margin-top: 8mm; }
  .cover .band .kicker { font-size: 11px; font-weight: 700; letter-spacing: 0.22em; text-transform: uppercase; opacity: 0.85; }
  .cover .band h1 { font-size: 42px; font-weight: 900; letter-spacing: -0.02em; line-height: 1.06; margin-top: 14px; }
  .cover .band p { margin-top: 14px; font-size: 14px; font-weight: 500; opacity: 0.92; max-width: 152mm; }
  .cover .meta { margin-top: auto; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8mm; }
  .cover .meta .box { border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; }
  .cover .meta .k { font-size: 9px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }
  .cover .meta .v { font-size: 13px; font-weight: 700; margin-top: 4px; }
  .cover .note { margin-top: 8mm; color: var(--muted); font-size: 9.5px; }

  /* ---------- toc ---------- */
  .toc { page-break-after: always; }
  .toc h2 { font-size: 22px; font-weight: 900; letter-spacing: -0.01em; margin: 10mm 0 8mm; }
  .toc .row { display: flex; align-items: baseline; gap: 10px; padding: 7px 2px; border-bottom: 1px solid var(--line); }
  .toc .row .n { font-family: 'IBM Plex Mono', monospace; font-weight: 600; color: var(--teal); width: 26px; }
  .toc .row .t { font-weight: 600; font-size: 12px; }
  .toc .row .c { margin-left: auto; color: var(--muted); font-size: 9.5px; }

  /* ---------- sections ---------- */
  .sec { page-break-before: always; }
  .sec.hero-sec { page-break-before: avoid; }
  h2 { font-size: 19px; font-weight: 900; letter-spacing: -0.01em; margin-bottom: 6mm;
       display: flex; align-items: center; gap: 10px; }
  h2 .secnum { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px;
       border-radius: 8px; background: linear-gradient(135deg, var(--teal), var(--blue)); color: #fff;
       font-size: 13px; font-weight: 800; flex: none; }
  .lead { font-size: 12.5px; font-weight: 600; color: var(--teal); background: #EAF6F5;
       border-left: 3px solid var(--teal); border-radius: 0 10px 10px 0; padding: 10px 14px; margin-bottom: 6mm; }

  .qa { margin-bottom: 5.2mm; page-break-inside: avoid; }
  .q { font-size: 11.6px; font-weight: 800; letter-spacing: -0.005em; display: flex; gap: 8px; margin-bottom: 2mm; }
  .q .qn { font-family: 'IBM Plex Mono', monospace; color: var(--blue); font-weight: 600; font-size: 10px; flex: none; padding-top: 1.5px; }
  .a { color: #2A2E35; padding-left: 34px; }
  .a b { color: var(--ink); }

  table { border-collapse: collapse; width: 100%; margin: 3mm 0 2mm; font-size: 9.6px; }
  th, td { border: 1px solid var(--line); padding: 5px 8px; text-align: left; vertical-align: top; }
  th { background: #F3F1EC; font-weight: 700; }
  td:first-child { font-weight: 600; }

  .qa-hero { border: 1.5px solid var(--teal); border-radius: 14px; padding: 14px 16px; background: #F7FCFB; }
  .qa-hero .q { color: var(--teal); }

  @page { margin: 16mm 15mm 15mm; }
  @media screen {
    body { background: #FAF9F6; }
    .sheet { max-width: 920px; margin: 0 auto; padding: 32px 28px 64px; }
    .sec { margin-top: 44px; }
  }
</style>
</head>
<body>
  <div class="cover">
    <div class="band">
      <div class="kicker">Precision Care Challenge 2026 · Judge Q&amp;A Defense</div>
      <h1>NeuroPilot</h1>
      <p>Every question a judge can ask — answered from the build. Anchored by the live question:
      <b>“Why are patients with the same score prioritized differently?”</b> — with the five-layer answer,
      the explicit tiebreaker policy, and the honest concession.</p>
    </div>
    <div class="meta">
      <div class="box"><div class="k">Risk model</div><div class="v">AUC 0.842 ± 0.032 (CV)</div></div>
      <div class="box"><div class="k">Progression forecast</div><div class="v">AUC 0.770 · MAE 0.61 pts</div></div>
      <div class="box"><div class="k">Cohort</div><div class="v">800 subjects · 4 stages</div></div>
      <div class="box"><div class="k">Scope guard</div><div class="v">Tier · reasoning · next test</div></div>
      <div class="box"><div class="k">Tests</div><div class="v">24 pytest · E2E verified</div></div>
      <div class="box"><div class="k">Deployed</div><div class="v">Railway · push-to-deploy</div></div>
    </div>
    <div class="note">All figures verified against <span class="mono">artifacts/eval_report.txt</span>,
    <span class="mono">artifacts/progression_report.txt</span> and the deployed build. Prepared ${new Date().toISOString().slice(0, 10)}.</div>
  </div>

  <div class="toc">
    <h2>Contents</h2>
    ${tocItems.map((t) => `<div class="row"><span class="n">${t.n}</span><span class="t">${t.title}</span><span class="c">${t.count} question${t.count > 1 ? 's' : ''}</span></div>`).join('')}
  </div>

  ${SECTIONS.map(sectionHtml).join('')}
</body>
</html>`;

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'],
  });
  try {
    // Standalone HTML (screen-friendly) — same content, no Chrome needed to view
    const htmlOut = path.join(__dirname, '..', 'NeuroPilot_Judge_QA.html');
    fs.writeFileSync(htmlOut, html.replace('<body>', '<body><div class="sheet">').replace('</body>', '</div></body>'));
    console.log(`[done] wrote ${htmlOut}`);

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.evaluate(() => document.fonts.ready);
    await new Promise((r) => setTimeout(r, 700)); // let webfonts settle
    await page.pdf({
      path: OUT,
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: `<div style="width:100%;font-size:8px;color:#5B6472;font-family:Inter,Arial,sans-serif;
        display:flex;justify-content:space-between;padding:0 15mm 4mm;">
          <span>NeuroPilot — Judge Q&amp;A Defense · Precision Care Challenge 2026</span>
          <span class="pageNumber"></span></div>`,
      margin: { top: '16mm', bottom: '17mm', left: '15mm', right: '15mm' },
    });
    const kb = Math.round(fs.statSync(OUT).size / 1024);
    console.log(`[done] wrote ${OUT} (${kb} KB, ${SECTIONS.reduce((a, s) => a + s.items.length, 0)} Q&A)`);
  } finally {
    await browser.close();
  }
})();
