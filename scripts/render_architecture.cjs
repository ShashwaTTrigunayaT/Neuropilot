/**
 * Render NeuroPilot — System Architecture FLOWCHART (SVG) to HTML + PDF + PNGs.
 * Usage: node scripts/render_architecture.cjs
 *
 * Outputs (project root):
 *   NeuroPilot_Architecture.html
 *   NeuroPilot_Architecture.pdf           (4 sheets, 1280x880 px pages)
 *   architecture_pages/arch_page_1..4.png (2x high-res, drop into PPT)
 *
 * Sheets (all drawn as genuine flowcharts — boxes, labeled arrows, decision
 * diamonds, loop-backs; no card grids):
 *   1. End-to-end system flow (data -> training -> artifacts -> serving -> API -> UI -> deploy)
 *   2. Autonomous triage loop (flowchart with decision diamonds + loop-back arrow)
 *   3. Model layer flow (one feature vector branching into two model families)
 *   4. Deployment & trust flow (git push -> container -> clinician browser)
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
const SVG_W = 1188;
const SVG_H = 726;

/* palette */
const INK = '#16181B';
const MUTED = '#5B6472';
const FAINT = '#8A94A6';
const LINE = '#E3DFD6';
const PAPER = '#F7F5F1';
const TEAL = '#0D8282';
const AMBER = '#B45309';
const PURPLE = '#7C3AED';
const BLUE = '#2563EB';
const GREEN = '#0F766E';

/* ------------------------------------------------------------------ */
/* SVG primitives                                                      */
/* ------------------------------------------------------------------ */

const DEFS =
  '<defs>'
  + mk('mk-teal', TEAL) + mk('mk-amber', AMBER) + mk('mk-purple', PURPLE)
  + mk('mk-blue', BLUE) + mk('mk-gray', FAINT) + mk('mk-green', GREEN)
  + '</defs>';

function mk(id, color) {
  return '<marker id="' + id + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
    + '<path d="M 0 0 L 10 5 L 0 10 z" fill="' + color + '"/></marker>';
}

function txt(x, y, s, o) {
  o = o || {};
  return '<text x="' + x + '" y="' + y + '"'
    + ' font-size="' + (o.size || 9.5) + '"'
    + ' font-weight="' + (o.weight || 400) + '"'
    + ' fill="' + (o.fill || MUTED) + '"'
    + (o.anchor ? ' text-anchor="' + o.anchor + '"' : '')
    + (o.mono ? ' font-family="IBM Plex Mono, Courier New, monospace"' : '')
    + (o.spacing ? ' letter-spacing="' + o.spacing + '"' : '')
    + '>' + s + '</text>';
}

/* process box: tag pill + bold title + small lines (lines starting with '`' render mono) */
function rbox(x, y, w, h, o) {
  o = o || {};
  const accent = o.accent || TEAL;
  const strokeC = o.glow ? accent : LINE;
  const sw = o.glow ? 1.8 : 1.4;
  let s = '<g>';
  s += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="11" fill="#FFFFFF"'
    + ' stroke="' + strokeC + '" stroke-width="' + sw + '"'
    + (o.glow ? ' filter="url(#soft)"' : '') + '/>';
  let ty = y + 20;
  if (o.tag) {
    const tw = o.tag.length * 5.6 + 16;
    s += '<rect x="' + (x + 13) + '" y="' + (y + 9) + '" width="' + tw + '" height="14" rx="7" fill="' + accent + '14"/>';
    s += txt(x + 13 + tw / 2, y + 19.5, o.tag.toUpperCase(), { size: 7.6, weight: 800, fill: accent, anchor: 'middle', spacing: '0.8' });
    ty = y + 38;
  }
  s += txt(x + 14, ty, o.title, { size: 12, weight: 800, fill: INK });
  const lines = o.lines || [];
  let ly = ty + 13.5;
  for (let i = 0; i < lines.length; i++) {
    const mono = lines[i].charAt(0) === '`';
    s += txt(x + 14, ly, mono ? lines[i].slice(1) : lines[i], { size: mono ? 8.8 : 9.3, fill: MUTED, mono: mono });
    ly += 12.5;
  }
  s += '</g>';
  return s;
}

/* start/end terminal */
function pill(cx, y, w, h, label, color) {
  const x = cx - w / 2;
  return '<g>'
    + '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + h / 2 + '" fill="' + color + '12" stroke="' + color + '" stroke-width="1.6"/>'
    + txt(cx, y + h / 2 + 4, label, { size: 10.5, weight: 800, fill: color, anchor: 'middle', spacing: '1' })
    + '</g>';
}

/* decision diamond */
function diamond(cx, cy, w, h, label, sub) {
  const p = (cx) + ',' + (cy - h / 2) + ' ' + (cx + w / 2) + ',' + cy + ' ' + cx + ',' + (cy + h / 2) + ' ' + (cx - w / 2) + ',' + cy;
  let s = '<g><polygon points="' + p + '" fill="#FFF9F0" stroke="' + AMBER + '" stroke-width="1.7"/>';
  s += txt(cx, cy - (sub ? 2 : -4), label, { size: 11, weight: 800, fill: INK, anchor: 'middle' });
  if (sub) s += txt(cx, cy + 12, sub, { size: 8.8, fill: MUTED, anchor: 'middle' });
  s += '</g>';
  return s;
}

/* polyline arrow with optional label near a chosen point */
function flow(pts, o) {
  o = o || {};
  const color = o.color || FAINT;
  const mkId = { [TEAL]: 'mk-teal', [AMBER]: 'mk-amber', [PURPLE]: 'mk-purple', [BLUE]: 'mk-blue', [GREEN]: 'mk-green' }[color] || 'mk-gray';
  const d = 'M ' + pts.map((p) => p[0] + ' ' + p[1]).join(' L ');
  let s = '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.7"'
    + (o.dash ? ' stroke-dasharray="5 4"' : '') + ' marker-end="url(#' + mkId + ')"/>';
  if (o.label) {
    const lp = o.labelAt || pts[1];
    s += txt(lp[0], lp[1], o.label, { size: 8.6, weight: 600, fill: color === FAINT ? FAINT : color, anchor: o.labelAnchor || 'start' });
  }
  return s;
}

function svgWrap(inner) {
  return '<svg width="' + SVG_W + '" height="' + SVG_H + '" viewBox="0 0 ' + SVG_W + ' ' + SVG_H + '"'
    + ' style="font-family:Inter,Arial,Helvetica,sans-serif">' + DEFS
    + '<filter id="soft" x="-20%" y="-20%" width="140%" height="140%">'
    + '<feDropShadow dx="0" dy="1.5" stdDeviation="2.5" flood-color="' + TEAL + '" flood-opacity="0.18"/></filter>'
    + inner + '</svg>';
}

/* stage chip on the left rail */
function chip(cx, cy, n, color) {
  return '<g><circle cx="' + cx + '" cy="' + cy + '" r="11" fill="' + color + '12" stroke="' + color + '" stroke-width="1.4"/>'
    + txt(cx, cy + 4, String(n), { size: 10.5, weight: 800, fill: color, anchor: 'middle' }) + '</g>';
}

const pageCSS = ''
  + '* { margin:0; padding:0; box-sizing:border-box; }'
  + 'body { font-family:"Inter",Arial,sans-serif; background:#ECE9E2; color:' + INK + '; }'
  + '.page { width:' + PAGE_W + 'px; height:' + PAGE_H + 'px; background:' + PAPER + ';'
  + ' padding:30px 46px 40px; position:relative; overflow:hidden; page-break-after:always; margin:0 auto 24px; }'
  + '.page:last-child { page-break-after:auto; margin-bottom:0; }'
  + '.page-head { display:flex; align-items:flex-end; justify-content:space-between; margin-bottom:10px; }'
  + '.page-title { font-size:23px; font-weight:900; letter-spacing:-0.4px; }'
  + '.page-sub { font-size:11px; color:' + MUTED + '; margin-top:3px; max-width:900px; }'
  + '.brand-chip { display:inline-flex; align-items:center; gap:8px; background:#fff; border:1px solid ' + LINE
  + '; border-radius:999px; padding:6px 13px; font-size:10.5px; font-weight:800; color:' + TEAL + '; white-space:nowrap; }'
  + '.brand-tile { width:18px; height:18px; border-radius:6px; background:linear-gradient(135deg,#0D8282 0%,#0FA0A0 55%,#2563EB 100%); }'
  + '.footer-note { position:absolute; bottom:13px; left:46px; right:46px; display:flex; justify-content:space-between; font-size:9px; color:' + FAINT + '; }';

function pageHead(title, sub) {
  return '<div class="page-head"><div><div class="page-title">' + title + '</div>'
    + '<div class="page-sub">' + sub + '</div></div>'
    + '<span class="brand-chip"><span class="brand-tile"></span>NeuroPilot</span></div>';
}

function footer(n) {
  return '<div class="footer-note"><span>NeuroPilot &mdash; Priority Triage for Cognitive Care &middot; Precision Care Challenge 2026</span>'
    + '<span>' + n + ' / 4</span></div>';
}

function page(title, sub, n, inner) {
  return '<div class="page">' + pageHead(title, sub) + svgWrap(inner) + footer(n) + '</div>';
}

/* ------------------------------------------------------------------ */
/* SHEET 1 — End-to-end system flow                                    */
/* ------------------------------------------------------------------ */

function sheet1() {
  const CX = 594;               // main spine x
  const BW = 560, BX = CX - BW / 2; // main column boxes
  let s = '';

  /* row 1: three data sources */
  const y1 = 6, h1 = 62;
  s += rbox(40, y1, 356, h1, { tag: 'input', title: 'Real OASIS-1 longitudinal', lines: ['150 subjects · 373 visits · gaps audited, never dropped'] });
  s += rbox(416, y1, 356, h1, { tag: 'input', title: 'Synthetic ADNI-shaped cohort v2', lines: ['800 subjects · 200 CN / 400 MCI / 200 AD · all 4 stages'] });
  s += rbox(792, y1, 356, h1, { tag: 'input', title: '12-month follow-up simulation', lines: ['biomarker-driven drift · 133 conversions'] });

  /* merge into training */
  const ym = y1 + h1 + 10;
  s += flow([[218, y1 + h1], [218, ym], [CX, ym]]);
  s += flow([[594, y1 + h1], [CX, ym]]);
  s += flow([[970, y1 + h1], [970, ym], [CX, ym]]);
  s += flow([[CX, ym], [CX, ym + 24]], { color: TEAL, label: 'cohort tables + feature vectors' });

  /* row 2: training pipeline */
  const y2 = ym + 24, h2 = 62;
  s += rbox(BX, y2, BW, h2, { tag: 'training', title: 'scripts/ — ingest, train, validate', glow: true, lines: ['ingest.py (audit) -> train_model.py (XGBoost + RF) -> train_progression_model.py', 'subject-level split · CDR excluded · thresholds 0.4 / 0.7'] });
  s += chip(288, y2 + h1 / 2 + 8, 1, TEAL);

  /* row 3: artifacts */
  const y3 = y2 + h2 + 26;
  s += flow([[CX, y2 + h2], [CX, y3]], { color: TEAL, label: 'joblib + meta + eval reports' });
  s += rbox(BX, y3, BW, h2, { tag: 'artifacts', title: 'artifacts/ — git-tracked, shipped in the image', lines: ['`pipeline.joblib · rf_pipeline.joblib · progression_delta.joblib', '`progression_conversion.joblib · model_meta.json · eval reports'] });
  s += chip(288, y3 + h1 / 2 + 8, 2, TEAL);

  /* row 4: serving + DB side */
  const y4 = y3 + h2 + 26;
  s += flow([[CX, y3 + h2], [CX, y4]], { color: TEAL, label: 'loaded once at lifespan startup' });
  s += rbox(BX, y4, BW, 78, { tag: 'serving', title: 'FastAPI app — backend/app', glow: true, lines: ['model_service (score + SHAP) · progression (forecast)', 'escalation.py rule engine · storage.py + db.py mirror'] });
  s += chip(288, y4 + 32, 3, TEAL);
  s += rbox(914, y4 + 2, 234, 74, { tag: 'persistence', accent: PURPLE, title: 'SQLite / PostgreSQL', lines: ['init_db() · seed_if_empty()', 'persist() on every event'] });
  s += flow([[BX + BW, y4 + 39], [914, y4 + 39]], { color: PURPLE, label: 'writes', labelAt: [BX + BW + 6, y4 + 32] });
  s += flow([[914, y4 + 58], [BX + BW, y4 + 58]], { color: PURPLE, label: 'reads', labelAt: [BX + BW + 6, y4 + 66] });

  /* row 5: API + swagger side */
  const y5 = y4 + 78 + 26;
  s += flow([[CX, y4 + 78], [CX, y5]], { color: TEAL, label: 'in-process' });
  s += rbox(BX, y5, BW, 62, { tag: 'api', title: 'Decision API — 14 typed endpoints', lines: ['`/patients · /compare · /progression · /score · /workup/* · /advance-stage', 'Pydantic contracts — risk tier + reasoning only, never a diagnosis'] });
  s += chip(288, y5 + 24, 4, TEAL);
  s += rbox(914, y5 + 2, 234, 58, { tag: 'docs', accent: BLUE, title: 'Swagger UI at /docs', lines: ['/health provenance · /debug/env'] });
  s += flow([[BX + BW, y5 + 31], [914, y5 + 31]], { color: BLUE });

  /* row 6: UI */
  const y6 = y5 + 62 + 26;
  s += flow([[CX, y5 + 62], [CX, y6]], { color: BLUE, label: 'HTTP / JSON — the only data source the UI has' });
  s += rbox(254, y6, 680, 62, { tag: 'dashboard', accent: BLUE, title: 'React 19 + Vite + Tailwind — src/', glow: true, lines: ['Overview · Worklist · Patient record · Progression view · Priority Comparison · Risk Simulator', 'risk gauge (0.4 / 0.7 marks) · SHAP attribution · event trail · autonomous triage toggle'] });
  s += chip(228, y6 + 24, 5, BLUE);

  /* row 7: deploy */
  const y7 = y6 + 62 + 26;
  s += flow([[CX, y6 + 62], [CX, y7]], { color: BLUE, label: 'bundled by' });
  s += rbox(40, y7, 1108, 56, { tag: 'packaging', accent: PURPLE, title: 'Dockerfile (UI build -> SPA served by FastAPI on $PORT) · docker-compose (Postgres + API + UI) · GitHub -> Railway' });
  s += chip(288, y7 + 21, 6, PURPLE);

  return page('System Flow — End to End',
    'How a subject becomes a decision: data lands, models train, artifacts ship, the API serves, the dashboard decides — every arrow is a real data path in the repo.',
    1, s);
}

/* ------------------------------------------------------------------ */
/* SHEET 2 — Autonomous triage loop (true flowchart)                   */
/* ------------------------------------------------------------------ */

function sheet2() {
  const CX = 594;
  const BW = 372, BX = CX - BW / 2;
  let s = '';

  /* start */
  s += pill(CX, 4, 240, 32, 'AUTONOMOUS TRIAGE ON', TEAL);
  s += flow([[CX, 36], [CX, 58]], { color: TEAL });

  /* pick */
  const yP = 58, hP = 58;
  s += rbox(BX, yP, BW, hP, { tag: '1 · pick', title: 'POST /workup/next — pick the subject', glow: true, lines: ['highest full-precision score whose tier still', 'indicates a test — deterministic max(), auditable'] });

  /* decision 1 */
  const d1y = yP + hP + 46;
  s += flow([[CX, yP + hP], [CX, d1y - 44]], { color: TEAL });
  s += diamond(CX, d1y, 320, 84, 'Tier indicates a test?');
  s += txt(CX + 168, d1y - 6, 'YES', { size: 9, weight: 800, fill: GREEN, anchor: 'start' });
  s += txt(CX - 168, d1y - 10, 'NO', { size: 9, weight: 800, fill: AMBER, anchor: 'end' });

  /* NO branch -> stop */
  s += flow([[CX - 160, d1y], [900, d1y], [900, d1y + 24]], { color: AMBER });
  s += rbox(744, d1y + 24, 312, 62, { tag: 'stop', accent: AMBER, title: 'No over-testing — decline with reason', lines: ['low tier · monitor · pathway complete', 'returned to the UI as 409 + human-readable cause'] });
  s += pill(900, d1y + 108, 236, 30, 'SUBJECT LEFT UNTOUCHED', AMBER);
  s += flow([[900, d1y + 86], [900, d1y + 108]], { color: AMBER });

  /* YES path: rule engine */
  const yG = d1y + 42, hG = 58;
  s += flow([[CX, d1y + 42], [CX, yG]], { color: TEAL });
  s += rbox(BX, yG, BW, hG, { tag: '2 · gate', title: 'Escalation rule engine decides WHICH test', lines: ['(stage x tier) matrix: blood / MRI / PET', 'plain if-else — auditable, never another ML layer'] });

  /* execute */
  const yE = yG + hG + 24;
  s += flow([[CX, yG + hG], [CX, yE]], { color: TEAL });
  s += rbox(BX, yE, BW, hG, { tag: '3 · execute', title: 'Test runs, result lands', lines: ['blood -> MRI -> PET cascade, tier-gated each step', 'severity-coherent values stand in for LIS / RIS feeds'] });

  /* re-score */
  const yR = yE + hG + 24;
  s += flow([[CX, yE + hG], [CX, yR]], { color: TEAL });
  s += rbox(BX, yR, BW, 62, { tag: '4 · re-score', accent: GREEN, title: 'Trained model re-runs on new evidence', glow: true, lines: ['NaN slot becomes a measured value -> score, tier, SHAP', 'update live — example 0.68 -> 0.81, rank #12 -> #2'] });

  /* audit side */
  s += rbox(744, yR + 2, 312, 58, { tag: 'audit', accent: AMBER, title: 'Append-only event trail', lines: ['API-timestamped · rank before / after · Postgres mirror'] });
  s += flow([[BX + BW, yR + 31], [744, yR + 31]], { color: AMBER, dash: true });

  /* decision 2 */
  const d2y = yR + 62 + 46;
  s += flow([[CX, yR + 62], [CX, d2y - 42]], { color: TEAL });
  s += diamond(CX, d2y, 330, 84, 'Stage 4 or queue empty?', 'every subject worked to its indicated depth');
  s += txt(CX + 173, d2y - 8, 'YES', { size: 9, weight: 800, fill: GREEN, anchor: 'start' });
  s += txt(CX - 173, d2y - 8, 'NO', { size: 9, weight: 800, fill: TEAL, anchor: 'end' });

  /* end */
  s += pill(CX, d2y + 64, 250, 32, 'PATHWAY COMPLETE — AUDITED', GREEN);
  s += flow([[CX, d2y + 42], [CX, d2y + 64]], { color: GREEN });

  /* NO -> loop back to pick */
  s += flow([[CX - 165, d2y], [236, d2y], [236, yP + 29], [BX, yP + 29]], { color: TEAL, label: 'next subject · ~1.4 s cadence', labelAt: [244, d2y - 8] });

  /* override side (dashed) */
  s += rbox(40, yG - 6, 178, 72, { tag: 'safety', accent: AMBER, title: 'Clinician override', dash: true, lines: ['force with override=true', 'event flagged + logged'] });
  s += flow([[218, yG + 29], [BX, yG + 29]], { color: AMBER, dash: true });

  return page('Autonomous Triage — Decision Flowchart',
    'The live loop: the model picks the patient AND the test, every result re-scores the cohort, and two honest exits exist — the engine declines with a reason, or the clinician overrides on the record.',
    2, s);
}

/* ------------------------------------------------------------------ */
/* SHEET 3 — Model layer flow                                          */
/* ------------------------------------------------------------------ */

function sheet3() {
  const CX = 594;
  let s = '';

  /* shared vector */
  s += rbox(294, 4, 600, 66, { tag: 'shared input', accent: GREEN, title: 'Patient record -> 10-feature stage-aware vector', glow: true, lines: ['`age · sex · edu · mmse · mmse_change · ptau181 · abeta42/40 · hip_vol · amyloid · tau', 'un-ordered tests stay NaN — learned missing path, never imputed or invented'] });

  /* branch elbows */
  s += flow([[444, 70], [444, 104], [300, 104], [300, 128]], { color: GREEN });
  s += flow([[744, 70], [744, 104], [888, 104], [888, 128]], { color: GREEN });

  /* left: risk model */
  s += rbox(60, 128, 480, 66, { tag: 'model 1 · risk', accent: TEAL, title: 'XGBoost classifier — who needs attention now', glow: true, lines: ['severity-correlated labels · subject-level split', 'preprocessing bundled in the served artifact'] });
  s += flow([[300, 194], [300, 226]], { color: TEAL, label: 'predict + explain' });
  s += rbox(60, 226, 480, 60, { tag: 'outputs', title: 'risk score · tier (0.4 / 0.7) · per-patient SHAP attribution', lines: ['serves the gauge, ranked worklist, attribution panel, global importance'] });

  /* right: progression */
  s += rbox(648, 128, 480, 66, { tag: 'model 2 · forecast', accent: PURPLE, title: 'XGBoost pair — where the patient is headed', lines: ['MMSE-delta regressor (12-mo point change ± band)', 'conversion classifier (CN->MCI, MCI->AD, AD->severe)'] });
  s += flow([[888, 194], [888, 226]], { color: PURPLE, label: 'predict' });
  s += rbox(648, 226, 480, 60, { tag: 'outputs', accent: PURPLE, title: 'expected MMSE change · conversion probability', lines: ['projected tier* · trajectory with stage-score checkpoints'] });

  /* feedback loop: forecast -> risk model (projected tier) */
  s += flow([[648, 256], [578, 256], [578, 161], [540, 161]], { color: PURPLE, dash: true });
  s += txt(584, 214, '*risk model re-scores', { size: 8.4, weight: 600, fill: PURPLE });
  s += txt(584, 226, 'the projected future vector', { size: 8.4, weight: 600, fill: PURPLE });

  /* merge into API */
  s += flow([[300, 286], [300, 318], [CX, 318]]);
  s += flow([[888, 286], [888, 318], [CX, 318]]);
  s += flow([[CX, 318], [CX, 340]], { color: TEAL, label: 'one API surface for both families' });

  s += rbox(314, 340, 560, 54, { tag: 'serving', title: 'Decision API — 14 typed endpoints, no diagnosis field', lines: ['`/patients · /compare · /progression · /score · /workup/* · /docs'] });

  /* UI surfaces */
  s += flow([[CX, 394], [CX, 420]], { color: BLUE, label: 'HTTP / JSON' });
  s += rbox(254, 420, 680, 78, { tag: 'dashboard', accent: BLUE, title: 'Where the models become decisions', glow: true, lines: ['risk gauge with threshold marks · SHAP attribution · event and reasoning trail', '12-month forecast view with trajectory + stage-score lane', 'priority comparison ladder (score -> conversion -> stage -> ID) · risk simulator'] });

  /* guardrails */
  s += rbox(40, 530, 1108, 118, { tag: 'guardrails', accent: AMBER, title: 'Why the numbers are defensible', lines: [
    'CDR excluded — a clinician rating approximates the diagnosis (label leakage)',
    'subject-level split — no subject appears in train AND test',
    'imputation lives inside the artifact — identical at train and serve time',
    'no diagnosis field in any API contract · disclaimer on every forecast',
    'metrics — risk AUC 0.871 (CV 0.842) · conversion AUC 0.770, PR lift 2.8x · delta MAE 0.611',
  ] });

  return page('Model Layer — Two Families, One Vector',
    'Both model families read the same stage-aware feature vector; the forecast loops back through the risk model to project the future tier — one consistent model story end to end.',
    3, s);
}

/* ------------------------------------------------------------------ */
/* SHEET 4 — Deployment & trust flow                                   */
/* ------------------------------------------------------------------ */

function sheet4() {
  const CX = 594;
  let s = '';

  s += pill(CX, 4, 160, 30, 'git push', TEAL);
  s += flow([[CX, 34], [CX, 52]], { color: TEAL, label: 'main branch' });

  s += rbox(434, 52, 320, 46, { tag: 'ci', title: 'GitHub repository', lines: ['source + git-tracked model artifacts'] });
  s += flow([[CX, 98], [CX, 116]], { color: TEAL });

  s += rbox(434, 116, 320, 56, { tag: 'build', title: 'Railway — builds the Dockerfile', glow: true, lines: ['UI bundle + backend + artifacts in one image'] });
  s += flow([[CX, 172], [CX, 196]], { color: TEAL, label: 'deploy' });

  /* container */
  s += rbox(254, 196, 680, 84, { tag: 'production container', title: 'FastAPI serves the decision API + built SPA on $PORT', glow: true, lines: ['artifacts loaded once at startup · escalation rule engine in-process', 'same-origin: dashboard and API share one origin — no CORS in the demo path'] });

  /* postgres side */
  s += rbox(954, 196, 194, 84, { tag: 'database', accent: PURPLE, title: 'PostgreSQL', lines: ['`DATABASE_URL', 'init + seed + per-event', 'persist() mirror'] });
  s += flow([[934, 224], [954, 224]], { color: PURPLE, label: 'writes', labelAt: [908, 218], labelAnchor: 'end' });
  s += flow([[954, 252], [934, 252]], { color: PURPLE, label: 'reads', labelAt: [908, 264], labelAnchor: 'end' });

  /* local compose side */
  s += rbox(40, 196, 194, 84, { tag: 'local demo', accent: BLUE, title: 'docker-compose', dash: true, lines: ['Postgres + API + UI', 'one command, offline-safe'] });
  s += flow([[234, 238], [254, 238]], { color: BLUE, dash: true });

  /* browser */
  s += flow([[CX, 280], [CX, 316]], { color: BLUE, label: 'same-origin HTTP' });
  s += rbox(314, 316, 560, 56, { tag: 'clinician browser', accent: BLUE, title: 'Dashboard — Overview · Worklist · Record · Forecast · Compare', lines: ['zero mock data — the UI renders only what the API returns'] });

  /* trust rails */
  s += rbox(40, 412, 1108, 122, { tag: 'trust rails', accent: AMBER, title: 'What makes the deployment defensible', lines: [
    'append-only audit trail — every order, result, re-score and override, with API timestamps',
    'provenance always visible — /health data_source pill · /model/info AUROC + thresholds + trained-at',
    'clinician-in-the-loop — the engine recommends, a human confirms; override is explicit and logged',
    'Railway verified live — real+postgres · 800 subjects seeded · progression + compare endpoints 200 OK',
    '24 pytest cases cover the API surface on every push',
  ] });

  /* deployment verification arrows back */
  s += flow([[314, 344], [120, 344], [120, 412]], { color: AMBER, dash: true, label: 'audit', labelAt: [128, 380] });

  return page('Deployment and Trust — Flow to Production',
    'One push goes from laptop to a Postgres-backed, artifact-complete deployment; every runtime event lands in an append-only trail a judge can inspect.',
    4, s);
}

/* ------------------------------------------------------------------ */
/* Assemble + render                                                   */
/* ------------------------------------------------------------------ */

const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
  + '<title>NeuroPilot — System Architecture Flowchart</title>'
  + '<link rel="preconnect" href="https://fonts.googleapis.com">'
  + '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&family=IBM+Plex+Mono:wght@500;600&display=swap" rel="stylesheet">'
  + '<style>' + pageCSS + '</style></head><body>'
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
