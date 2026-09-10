/**
 * Render NeuroPilot — System Architecture Blueprint to HTML + PDF + PNGs.
 * Usage: node scripts/render_architecture.cjs
 *
 * Outputs (project root):
 *   NeuroPilot_Architecture.html
 *   NeuroPilot_Architecture.pdf           (4 sheets, 1280x880 px pages)
 *   architecture_pages/arch_page_1..4.png (2x high-res, drop into PPT)
 *
 * Sheets:
 *   1. End-to-end system blueprint (data -> pipeline -> artifacts -> serving -> API -> UI -> persistence)
 *   2. Autonomous triage loop (the live runtime decision cycle)
 *   3. Model layer detail (risk model + progression forecaster + explainability)
 *   4. Deployment topology & trust/audit rails
 */
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = path.join(__dirname, '..');
const OUT_PDF = path.join(ROOT, 'NeuroPilot_Architecture.pdf');
const OUT_HTML = path.join(ROOT, 'NeuroPilot_Architecture.html');
const PNG_DIR = path.join(ROOT, 'architecture_pages');

const PAGE_W = 1280;
const PAGE_H = 880;

/* ------------------------------------------------------------------ */
/* Shared CSS                                                          */
/* ------------------------------------------------------------------ */

const CSS = `
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:'Inter',Arial,Helvetica,sans-serif; color:#16181B; background:#ECE9E2; }
.mono { font-family:'IBM Plex Mono','Courier New',monospace; }

.page {
  width:${PAGE_W}px; height:${PAGE_H}px; background:#F7F5F1;
  padding:34px 46px 44px; position:relative; overflow:hidden;
  page-break-after:always; margin:0 auto 24px;
}
.page:last-child { page-break-after:auto; margin-bottom:0; }

.page-head { display:flex; align-items:flex-end; justify-content:space-between; margin-bottom:14px; }
.page-title { font-size:24px; font-weight:900; letter-spacing:-0.4px; }
.page-sub { font-size:11.5px; color:#5B6472; margin-top:3px; max-width:860px; }
.brand-chip {
  display:inline-flex; align-items:center; gap:8px; background:#fff; border:1px solid #E3DFD6;
  border-radius:999px; padding:6px 13px; font-size:10.5px; font-weight:800; color:#0D8282; white-space:nowrap;
}
.brand-tile {
  width:18px; height:18px; border-radius:6px;
  background:linear-gradient(135deg,#0D8282 0%,#0FA0A0 55%,#2563EB 100%);
}

.node {
  background:#fff; border:1.5px solid #E3DFD6; border-radius:12px; padding:9px 12px 10px;
  box-shadow:0 1px 3px rgba(22,24,27,0.05); flex:1; min-width:0;
}
.node-title { font-size:12px; font-weight:800; color:#16181B; line-height:1.25; }
.node-body { font-size:9.8px; line-height:1.4; color:#5B6472; margin-top:3px; }
.node-tag {
  display:inline-block; font-size:8px; font-weight:800; letter-spacing:0.9px; text-transform:uppercase;
  color:#0D8282; background:rgba(13,130,130,0.08); border-radius:999px; padding:2px 8px; margin-bottom:4px;
}
.node-tag.warn { color:#B45309; background:rgba(217,119,6,0.10); }
.node-tag.db { color:#7C3AED; background:rgba(124,58,237,0.08); }
.node-tag.ui { color:#2563EB; background:rgba(37,99,235,0.08); }
.node-tag.model { color:#0F766E; background:rgba(15,118,110,0.09); }

.col-label { font-size:9.5px; font-weight:800; letter-spacing:1.1px; text-transform:uppercase; color:#8A94A6; margin-bottom:6px; }

.flow-row { display:flex; align-items:stretch; gap:8px; }
.flow-row .node { flex:1; }
.flow-arrow { display:flex; align-items:center; color:#B9B3A8; flex:0 0 auto; }

.down { display:flex; justify-content:center; color:#B9B3A8; margin:3px 0; }

.footer-note { position:absolute; bottom:14px; left:46px; right:46px; display:flex; justify-content:space-between; font-size:9px; color:#8A94A6; }

.badge-row { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.mini {
  background:#fff; border:1px solid #E3DFD6; border-radius:8px; padding:5px 10px;
  font-size:9px; color:#3F4654; font-weight:600;
}
.mini b { color:#0D8282; }

/* Sheet 2 */
.loop-band { border:2px dashed rgba(13,130,130,0.55); border-radius:16px; padding:16px 16px 12px; background:rgba(13,130,130,0.03); position:relative; }
.loop-label {
  position:absolute; top:-8px; left:20px; background:#F7F5F1; padding:0 8px;
  font-size:8.5px; font-weight:800; letter-spacing:1px; color:#0D8282; text-transform:uppercase;
}
.step { display:flex; gap:8px; align-items:center; flex:1; min-width:0; }
.step-num {
  width:20px; height:20px; border-radius:999px; background:#0D8282; color:#fff;
  font-size:10.5px; font-weight:800; display:flex; align-items:center; justify-content:center; flex-shrink:0;
}
.node-glow { border-color:rgba(13,130,130,0.5); box-shadow:0 0 0 3px rgba(13,130,130,0.08); }

/* Sheet 3 */
.model-card { border-radius:13px; padding:12px 14px; background:#fff; border:1.5px solid #E3DFD6; flex:1; min-width:0; }
.model-card.primary { border-color:rgba(13,130,130,0.5); }
.metric-chip {
  display:inline-flex; flex-direction:column; background:#F7F5F1; border:1px solid #E3DFD6;
  border-radius:9px; padding:6px 9px; min-width:78px;
}
.metric-chip .k { font-size:8px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; color:#8A94A6; }
.metric-chip .v { font-size:14px; font-weight:900; color:#16181B; font-family:'IBM Plex Mono',monospace; }
`;

/* ------------------------------------------------------------------ */
/* Icons + builders                                                    */
/* ------------------------------------------------------------------ */

const ARROW_R = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>';
const ARROW_D = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m6 13 6 6 6-6"/></svg>';

function node(tag, tagClass, title, body) {
  const bodyHtml = body ? '<div class="node-body">' + body + '</div>' : '';
  return '<div class="node"><span class="node-tag ' + (tagClass || '') + '">' + tag + '</span>'
    + '<div class="node-title">' + title + '</div>' + bodyHtml + '</div>';
}

function pageHead(title, sub) {
  return '<div class="page-head"><div>'
    + '<div class="page-title">' + title + '</div>'
    + '<div class="page-sub">' + sub + '</div>'
    + '</div><span class="brand-chip"><span class="brand-tile"></span>NeuroPilot</span></div>';
}

function footer(n) {
  return '<div class="footer-note">'
    + '<span>NeuroPilot &mdash; Priority Triage for Cognitive Care &middot; Precision Care Challenge 2026</span>'
    + '<span>' + n + ' / 4</span></div>';
}

const down = '<div class="down">' + ARROW_D + '</div>';

/* ------------------------------------------------------------------ */
/* SHEET 1 — End-to-end system blueprint                               */
/* ------------------------------------------------------------------ */

function sheet1() {
  const head = pageHead(
    'System Blueprint',
    'End-to-end architecture &mdash; data &rarr; training pipeline &rarr; model artifacts &rarr; serving &rarr; decision API &rarr; dashboard &rarr; persistence. One command runs the whole loop.'
  );

  const r1 = '<div class="flow-row">'
    + node('INPUT', '', 'Real OASIS-1 longitudinal', '150 subjects &middot; 373 visits &middot; SES/MMSE gaps audited, never silently dropped')
    + node('INPUT', '', 'Synthetic ADNI-shaped cohort v2', '800 subjects &middot; 200 CN / 400 MCI / 200 AD &middot; all 4 stages measured')
    + node('INPUT', '', '12-month follow-up simulation', 'biomarker-driven drift &middot; 133 conversions &middot; published conversion base rates')
    + '</div>';

  const r2 = '<div class="flow-row">'
    + node('ETL', '', 'scripts/ingest.py', 'schema check &middot; dedupe &middot; missing-value audit &middot; patients + visits tables')
    + node('TRAIN', '', 'scripts/train_model.py', 'XGBoost pipeline + RF fallback &middot; subject-level split &middot; leakage guards')
    + node('TRAIN', '', 'scripts/train_progression_model.py', 'MMSE-&Delta; regressor + conversion classifier &middot; same 10-feature vector')
    + '</div>';

  const r3 = '<div class="flow-row">'
    + node('ARTIFACTS', '', 'artifacts/ &mdash; git-tracked for deployment',
      'pipeline.joblib &middot; rf_pipeline.joblib &middot; progression_delta.joblib &middot; progression_conversion.joblib &middot; model_meta.json &middot; eval reports + global importance')
    + '</div>';

  const r4 = '<div class="flow-row">'
    + node('SERVING', '', 'FastAPI app &mdash; backend/app', 'lifespan loads artifacts once &middot; model_service + progression modules &middot; SHAP TreeExplainer cached')
    + node('SERVING', '', 'Escalation rule engine', 'transparent (stage &times; tier) &rarr; next-test matrix &middot; clinician-in-the-loop &middot; explicit override path')
    + node('SERVING', '', 'Storage layer', 'in-memory cohort + optional Postgres mirror &middot; 24 pytest cases cover the API surface')
    + '</div>';

  const r5 = '<div class="flow-row">'
    + node('API', '', 'Decision API &mdash; 14 typed endpoints',
      '/patients &middot; /patients/{id} &middot; /explain &middot; /pipeline &middot; /progression &middot; /compare &middot; /score &middot; /workup/* &middot; /advance-stage &middot; /results &middot; /health &middot; /model/info')
    + node('API', '', 'OpenAPI + Swagger at /docs',
      'every request/response typed with Pydantic &middot; no diagnosis field anywhere &mdash; risk tier + reasoning only')
    + '</div>';

  const r6 = '<div class="flow-row">'
    + node('UI', 'ui', 'React 19 + Vite + Tailwind',
      'Dashboard &middot; Worklist &middot; Patient record &middot; Progression view &middot; Priority Comparison &middot; Risk Simulator')
    + node('UI', 'ui', 'Decision aids on the record',
      'risk gauge with 0.4 / 0.7 threshold marks &middot; SHAP attribution &middot; event &amp; reasoning trail &middot; 12-mo forecast')
    + node('UI', 'ui', 'Autonomous Triage toggle',
      'workup/next every ~1.4 s &middot; the model picks patient AND test &middot; every pick streams to the live banner')
    + '</div>';

  const r7 = '<div class="flow-row">'
    + node('PERSISTENCE', 'db', 'SQLite (local default)', 'backend/neuropilot.db &mdash; zero-config local persistence')
    + node('PERSISTENCE', 'db', 'PostgreSQL (Railway)', 'DATABASE_URL &rarr; init_db() &middot; seed_if_empty() &middot; per-event persist() mirror &middot; verified live')
    + node('PACKAGING', 'db', 'Docker + compose', 'single Dockerfile: builds UI &rarr; serves SPA from FastAPI on $PORT &middot; compose spins Postgres + API + UI')
    + '</div>';

  return '<div class="page">' + head
    + '<div class="col-label">1 &middot; Data sources</div>' + r1 + down
    + '<div class="col-label">2 &middot; Training pipeline (python scripts/)</div>' + r2 + down
    + '<div class="col-label">3 &middot; Model artifacts</div>' + r3 + down
    + '<div class="col-label">4 &middot; Serving layer (backend/app)</div>' + r4 + down
    + '<div class="col-label">5 &middot; Decision API</div>' + r5 + down
    + '<div class="col-label">6 &middot; React dashboard (src/)</div>' + r6 + down
    + '<div class="col-label">7 &middot; Persistence &amp; packaging</div>' + r7
    + footer(1) + '</div>';
}

/* ------------------------------------------------------------------ */
/* SHEET 2 — Autonomous triage loop                                    */
/* ------------------------------------------------------------------ */

function sheet2() {
  const head = pageHead(
    'Autonomous Triage Loop',
    'The runtime decision cycle: the model picks the patient AND the test, every result re-scores the cohort, and every step lands in the audit trail. Cognition drives blood; the blood-informed score drives MRI; and so on.'
  );

  const s1 = '<div class="step"><div class="step-num">1</div>'
    + node('PICK', '', 'POST /workup/next', 'highest full-precision score whose tier still indicates a test &mdash; deterministic, auditable max() pick')
    + '</div>';
  const s2 = '<div class="step"><div class="step-num">2</div>'
    + node('GATE', '', 'Rule-engine gate', 'escalation matrix (stage &times; tier) decides WHICH test &mdash; never another ML layer')
    + '</div>';
  const s3 = '<div class="step"><div class="step-num">3</div>'
    + node('EXECUTE', '', 'Test runs, result lands', 'blood &rarr; MRI &rarr; PET &middot; severity-coherent result ranges stand in for LIS/RIS feeds')
    + '</div>';
  const s4 = '<div class="step"><div class="step-num">4</div>'
    + node('RE-SCORE', 'model', 'Trained model re-runs', 'NaN slot becomes a measured value &rarr; score, tier, SHAP attribution update live &middot; example 0.68 &rarr; 0.81, rank #12 &rarr; #2')
    + '</div>';
  const s5 = '<div class="step"><div class="step-num">5</div>'
    + node('STOP', 'warn', 'Stop conditions', 'tier says no test indicated &middot; Stage 4 complete &middot; queue empty &mdash; the model never over-tests')
    + '</div>';
  const s6 = '<div class="step"><div class="step-num">6</div>'
    + node('AUDIT', 'warn', 'Trail + live banner', 'append-only events with API timestamps &middot; rank before/after logged &middot; clinician sees every pick')
    + '</div>';

  const loop = '<div class="loop-band"><span class="loop-label">Continuous loop while Autonomous Triage is ON</span>'
    + '<div class="flow-row">' + s1 + '<div class="flow-arrow">' + ARROW_R + '</div>' + s2 + '</div>'
    + down
    + '<div class="flow-row">' + s3 + '<div class="flow-arrow">' + ARROW_R + '</div>' + s4 + '</div>'
    + down
    + '<div class="flow-row">' + s5 + '<div class="flow-arrow">' + ARROW_R + '</div>' + s6 + '</div>'
    + '</div>';

  const safety = '<div class="flow-row" style="margin-top:12px;">'
    + node('SAFETY', 'warn', 'Clinician override', 'engine can decline an escalation (409 with reason); clinician can force with override=true &mdash; logged as an explicit override event')
    + node('SAFETY', 'warn', 'No silent failures', 'declined escalations return the engine reason; queue drains visibly on the banner; every state change is an event')
    + node('SAFETY', 'warn', 'Priority comparison built in', '2&ndash;6 patients ranked on an explicit ladder: full-precision score &rarr; 12-mo conversion probability &rarr; stage &rarr; stable ID')
    + '</div>';

  const badges = '<div class="badge-row" style="margin-top:10px;">'
    + '<span class="mini"><b>~1.4 s</b> cadence between autonomous steps</span>'
    + '<span class="mini"><b>409</b> = engine decline with human-readable reason</span>'
    + '<span class="mini"><b>0.68 &rarr; 0.81</b> blood result moves rank #12 &rarr; #2 (live verification run)</span>'
    + '<span class="mini"><b>max(candidates, key=score)</b> &mdash; the entire selection policy, in one line</span>'
    + '</div>';

  return '<div class="page">' + head + loop + safety + badges + footer(2) + '</div>';
}

/* ------------------------------------------------------------------ */
/* SHEET 3 — Model layer                                               */
/* ------------------------------------------------------------------ */

function sheet3() {
  const head = pageHead(
    'Model Layer',
    'Two XGBoost model families on one shared 10-feature stage-aware vector. Missing tests are never imputed or invented &mdash; missingness is a learned, informative state; the pipeline orders the right test to resolve it.'
  );

  const vec = node('SHARED INPUT', 'model',
    'The 10-feature stage-aware vector',
    '<span class="mono">age &middot; sex &middot; education_years &middot; mmse &middot; mmse_change &middot; ptau181 &middot; abeta4240 &middot; hippocampal_volume &middot; amyloid_positive &middot; tau_positive</span>'
    + '<br>Un-ordered tests stay <b>NaN</b> &mdash; XGBoost routes them down a learned default path; SHAP badges it <span class="mono">model default</span>. Measured-but-gappy values (OASIS SES/MMSE) are median-imputed inside the bundled sklearn pipeline &mdash; identical at train and serve time.');

  const m1 = '<div class="model-card primary">'
    + '<span class="node-tag model">MODEL 1 &middot; RISK SCORING</span>'
    + '<div class="node-title">XGBoost classifier &mdash; who needs attention now</div>'
    + '<div class="node-body">Severity-correlated labels &middot; CDR excluded (label-leakage guard) &middot; subject-level split &middot; preprocessing bundled in the served artifact. Serves score, tier (0.4 / 0.7 thresholds), per-patient SHAP attribution, global importance and Risk Simulator re-scoring.</div>'
    + '<div style="display:flex; gap:7px; margin-top:9px; flex-wrap:wrap;">'
    + '<div class="metric-chip"><span class="k">CV AUC</span><span class="v">0.842</span></div>'
    + '<div class="metric-chip"><span class="k">Test AUC</span><span class="v">0.871</span></div>'
    + '<div class="metric-chip"><span class="k">Accuracy</span><span class="v">0.750</span></div>'
    + '<div class="metric-chip"><span class="k">RF fallback</span><span class="v">0.874</span></div>'
    + '</div></div>';

  const m2 = '<div class="model-card">'
    + '<span class="node-tag model">MODEL 2 &middot; PROGRESSION FORECAST</span>'
    + '<div class="node-title">XGBoost pair &mdash; where the patient is headed</div>'
    + '<div class="node-body">Same 10 features, two heads: MMSE-&Delta; regressor (expected 12-month point change &plusmn; uncertainty band) + conversion classifier (probability of crossing into the next phase: CN&rarr;MCI, MCI&rarr;AD, AD&rarr;severe). Projected tier = the risk model re-scoring the future vector.</div>'
    + '<div style="display:flex; gap:7px; margin-top:9px; flex-wrap:wrap;">'
    + '<div class="metric-chip"><span class="k">&Delta; MAE</span><span class="v">0.611</span></div>'
    + '<div class="metric-chip"><span class="k">&Delta; R&sup2;</span><span class="v">0.679</span></div>'
    + '<div class="metric-chip"><span class="k">Conv. AUC</span><span class="v">0.770</span></div>'
    + '<div class="metric-chip"><span class="k">PR lift</span><span class="v">2.8&times;</span></div>'
    + '</div></div>';

  const shap = node('EXPLAINABILITY', 'model', 'SHAP everywhere &mdash; same explainer family across both models',
    'Per-patient waterfall attribution with measured values &middot; global mean-|SHAP| importance chart &middot; missing-stage <span class="mono">model default</span> badge (dimmed, footnoted) &middot; progression forecast drivers &middot; Risk Simulator live waterfall &mdash; a clinician can see WHY before trusting WHAT.');

  const guards = '<div class="badge-row" style="margin-top:10px;">'
    + '<span class="mini"><b>Guardrail</b> &middot; CDR excluded &mdash; clinician rating &asymp; diagnosis (label leakage)</span>'
    + '<span class="mini"><b>Guardrail</b> &middot; subject-level split &mdash; no subject in train AND test</span>'
    + '<span class="mini"><b>Guardrail</b> &middot; imputation inside artifact &mdash; train/serve parity</span>'
    + '<span class="mini"><b>Guardrail</b> &middot; no diagnosis field in any API contract</span>'
    + '<span class="mini"><b>Guardrail</b> &middot; disclaimer on every forecast</span>'
    + '</div>';

  return '<div class="page">' + head
    + '<div class="col-label">Shared feature space</div>' + vec + down
    + '<div class="flow-row">' + m1 + m2 + '</div>' + down
    + '<div class="col-label">One explainability surface</div>' + shap
    + guards + footer(3) + '</div>';
}

/* ------------------------------------------------------------------ */
/* SHEET 4 — Deployment & trust                                        */
/* ------------------------------------------------------------------ */

function sheet4() {
  const head = pageHead(
    'Deployment &amp; Trust Architecture',
    'One container to production, Postgres-backed persistence, and the provenance rails that make every number on screen defensible under questioning.'
  );

  const deploy = '<div class="flow-row">'
    + node('CI/CD', '', 'GitHub &rarr; Railway', 'push &rarr; Dockerfile build &rarr; image ships UI bundle + backend + model artifacts &rarr; $PORT serves SPA and API same-origin')
    + node('CI/CD', '', 'docker-compose (local)', 'Postgres + API + frontend spin up in one command &mdash; the judged demo runs offline-safe')
    + node('CONFIG', '', 'Config &amp; provenance', 'env-overridable thresholds &middot; /health data_source pill (synthetic | real | real+postgres) &middot; /debug/env deploy diagnostics')
    + '</div>';

  const trust = '<div class="flow-row" style="margin-top:10px;">'
    + node('AUDIT', 'warn', 'Append-only event trail', 'every order, result, re-score and override logged with API timestamps &middot; mirrored to Postgres &middot; visible on record + pipeline views')
    + node('AUDIT', 'warn', 'Provenance always visible', 'data-source pill + model card in the UI &middot; /model/info exposes trained-at, thresholds, AUROC &middot; no hidden state')
    + node('AUDIT', 'warn', 'Clinician-in-the-loop', 'autonomy is bounded: the engine recommends, the clinician confirms &mdash; override is explicit, flagged and logged')
    + '</div>';

  const verified = '<div class="badge-row" style="margin-top:12px;">'
    + '<span class="mini"><b>Railway verified</b> &middot; real+postgres live &middot; 800 subjects seeded &middot; progression + compare endpoints 200 OK</span>'
    + '<span class="mini"><b>24 pytest cases</b> &middot; API surface covered on every push</span>'
    + '<span class="mini"><b>0 mock data</b> &middot; the dashboard reads only the decision API</span>'
    + '<span class="mini"><b>Artifacts in git</b> &middot; deploy contains the exact trained models</span>'
    + '</div>';

  return '<div class="page">' + head
    + '<div class="col-label">1 &middot; Deployment topology</div>' + deploy + down
    + '<div class="col-label">2 &middot; Trust &amp; audit rails</div>' + trust
    + verified + footer(4) + '</div>';
}

/* ------------------------------------------------------------------ */
/* Assemble + render                                                   */
/* ------------------------------------------------------------------ */

const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
  + '<title>NeuroPilot — System Architecture Blueprint</title>'
  + '<link rel="preconnect" href="https://fonts.googleapis.com">'
  + '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&family=IBM+Plex+Mono:wght@500;600&display=swap" rel="stylesheet">'
  + '<style>' + CSS + '</style></head><body>'
  + sheet1() + sheet2() + sheet3() + sheet4()
  + '</body></html>';

(async () => {
  if (!fs.existsSync(PNG_DIR)) fs.mkdirSync(PNG_DIR, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'],
  });
  try {
    fs.writeFileSync(OUT_HTML, html);
    console.log('[done] wrote NeuroPilot_Architecture.html');

    const page = await browser.newPage();
    await page.setViewport({ width: PAGE_W, height: PAGE_H, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.evaluate(() => document.fonts.ready);
    await new Promise((r) => setTimeout(r, 800));

    const handles = await page.$$('.page');
    for (let i = 0; i < handles.length; i++) {
      await handles[i].screenshot({ path: path.join(PNG_DIR, 'arch_page_' + (i + 1) + '.png') });
    }
    console.log('[done] wrote ' + handles.length + ' PNGs to architecture_pages/');

    await page.pdf({
      path: OUT_PDF,
      width: PAGE_W + 'px',
      height: PAGE_H + 'px',
      printBackground: true,
      displayHeaderFooter: false,
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
    });
    const kb = Math.round(fs.statSync(OUT_PDF).size / 1024);
    console.log('[done] wrote NeuroPilot_Architecture.pdf (' + kb + ' KB, ' + handles.length + ' sheets)');
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('RENDER FAILED:', e.message); process.exit(1); });
