/**
 * NeuroPilot — ONE-PAGE complex system flowchart (engineering style).
 * Usage: node scripts/render_architecture_onepage.cjs
 *
 * Outputs (project root):
 *   NeuroPilot_Flowchart_OnePage.html
 *   NeuroPilot_Flowchart_OnePage.pdf   (single sheet, 1280x896 px)
 *   NeuroPilot_Flowchart_OnePage.png   (2x, 2560x1792 — drop into PPT)
 *
 * Style: plain rects + orthogonal wires + decision diamonds + loop-backs.
 * No cards, no pills, no shadows. Every wire is a real call path in the repo.
 */
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = path.join(__dirname, '..');
const PAGE_W = 1280, PAGE_H = 896;
const W = 1188, H = 768;

const INK = '#16181B', WIRE = '#3F4654', MUT = '#5B6472', FAINT = '#6A7280';
const ZS = '#9AA0AB';                     // zone stroke
const TEAL = '#0D8282', PURPLE = '#7C3AED', AMBER = '#B45309', GREEN = '#0F766E';

/* ---------- primitives ---------- */
function mk(id, color) {
  return '<marker id="' + id + '" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">'
    + '<path d="M 0 0 L 10 5 L 0 10 z" fill="' + color + '"/></marker>';
}
const DEFS = '<defs>' + mk('m-ink', WIRE) + mk('m-teal', TEAL) + mk('m-purple', PURPLE)
  + mk('m-amber', AMBER) + mk('m-green', GREEN) + '</defs>';

function txt(x, y, s, o) {
  o = o || {};
  return '<text x="' + x + '" y="' + y + '" font-size="' + (o.size || 9.5) + '"'
    + ' font-weight="' + (o.weight || 400) + '" fill="' + (o.fill || MUT) + '"'
    + (o.anchor ? ' text-anchor="' + o.anchor + '"' : '')
    + (o.mono ? ' font-family="IBM Plex Mono,monospace"' : '')
    + (o.ls ? ' letter-spacing="' + o.ls + '"' : '') + '>' + s + '</text>';
}

/* wire with optional label placed at pts[idx] */
function wire(pts, o) {
  o = o || {};
  const c = o.c || WIRE;
  const mid = { 'm-ink': WIRE }[o.m] || o.m;
  const mkId = mid || ({ [WIRE]: 'm-ink', [TEAL]: 'm-teal', [PURPLE]: 'm-purple', [AMBER]: 'm-amber', [GREEN]: 'm-green' }[c] || 'm-ink');
  const d = 'M ' + pts.map((p) => p[0] + ' ' + p[1]).join(' L ');
  let s = '<path d="' + d + '" fill="none" stroke="' + c + '" stroke-width="' + (o.sw || 1.3) + '"'
    + (o.dash ? ' stroke-dasharray="5 3.5"' : '');
  if (o.noArrow) s += '/';
  else s += ' marker-end="url(#' + mkId + ')"';
  s += '/>';
  if (o.both) s = s.replace('/>', ' marker-start="url(#' + mkId + ')"/>');
  if (o.label) {
    const lp = o.at || pts[1];
    s += txt(lp[0], lp[1], o.label, { size: 8.3, weight: 600, fill: c, anchor: o.la || 'start' });
  }
  return s;
}

/* plain process box */
function pbox(x, y, w, h, title, lines, o) {
  o = o || {};
  const st = o.stroke || '#4A4F58';
  let s = '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="2.5" fill="#fff" stroke="' + st + '" stroke-width="1.15"' + (o.dash ? ' stroke-dasharray="4 3"' : '') + '/>';
  s += txt(x + 9, y + 15, title, { size: 10.6, weight: 800, fill: INK });
  let ly = y + 28;
  (lines || []).forEach((l) => {
    const mono = l.charAt(0) === '`';
    s += txt(x + 9, ly, mono ? l.slice(1) : l, { size: mono ? 8.2 : 8.8, fill: MUT, mono: mono });
    ly += 11.5;
  });
  return s;
}

/* decision diamond */
function dia(cx, cy, w, h, label, sub) {
  const p = cx + ',' + (cy - h / 2) + ' ' + (cx + w / 2) + ',' + cy + ' ' + cx + ',' + (cy + h / 2) + ' ' + (cx - w / 2) + ',' + cy;
  let s = '<polygon points="' + p + '" fill="#fff" stroke="' + AMBER + '" stroke-width="1.3"/>';
  s += txt(cx, cy - (sub ? 2 : -3.5), label, { size: 10.4, weight: 800, fill: INK, anchor: 'middle' });
  if (sub) s += txt(cx, cy + 10.5, sub, { size: 8, fill: MUT, anchor: 'middle' });
  return s;
}

/* dashed zone container + floating label */
function zone(x, y, w, h, label, above) {
  let s = '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="3" fill="rgba(255,255,255,0.4)" stroke="' + ZS + '" stroke-width="1.1" stroke-dasharray="5 3.5"/>';
  s += above
    ? txt(x + 2, y - 5, label, { size: 9, weight: 800, fill: FAINT, ls: '1' })
    : txt(x + 12, y + 16, label, { size: 9, weight: 800, fill: FAINT, ls: '1' });
  return s;
}

/* legend line sample */
function legLine(x, y, c, dash) {
  return '<line x1="' + x + '" y1="' + (y - 3) + '" x2="' + (x + 26) + '" y2="' + (y - 3) + '" stroke="' + c + '" stroke-width="1.6"' + (dash ? ' stroke-dasharray="5 3.5"' : '') + ' marker-end="url(#m-ink)"/>';
}

/* ---------- sheet ---------- */
let s = '';

/* ===== BAND 1 — DATA + TRAINING (y 6..170) ===== */
s += zone(8, 6, 552, 164, 'DATA & ETL');
s += pbox(24, 40, 140, 42, 'OASIS-1 CSV', ['150 subj · 373 visits']);
s += pbox(24, 104, 140, 42, 'Synthetic v2', ['800 subj · 4 stages']);
s += pbox(208, 40, 130, 42, 'ingest.py', ['audit · dedupe']);
s += pbox(208, 104, 130, 42, 'cohort tables', ['patients · visits']);
s += pbox(372, 72, 136, 42, 'follow-up sim', ['12-mo · 133 conv']);
s += wire([[164, 61], [208, 61]]);
s += wire([[164, 125], [208, 125]]);
s += wire([[273, 82], [273, 104]]);
s += wire([[338, 125], [352, 125], [352, 93], [372, 93]]);

s += pbox(580, 72, 120, 48, '10-feature', ['stage-aware vector']);
s += wire([[508, 93], [580, 93]]);

s += zone(716, 6, 464, 164, 'TRAINING (scripts/)');
s += pbox(726, 40, 180, 42, 'train_model.py', ['XGBoost risk + RF · guards']);
s += pbox(726, 104, 180, 42, 'train_progression.py', ['MMSE-delta + conversion']);
s += pbox(940, 72, 224, 60, 'artifacts/ — git-tracked', ['4 joblib + meta + reports', 'shipped inside the image']);
s += wire([[700, 82], [708, 82], [708, 61], [726, 61]]);
s += wire([[700, 106], [708, 106], [708, 125], [726, 125]]);
s += wire([[906, 61], [922, 61], [922, 88], [940, 88]]);
s += wire([[906, 125], [922, 125], [922, 108], [940, 108]]);

/* ===== BAND 2 — SERVING (y 186..300) ===== */
s += zone(8, 186, 1172, 114, 'SERVING — FastAPI lifespan (backend/app)', true);
s += pbox(24, 210, 190, 64, 'model_service', ['score + SHAP attribution', 'thresholds 0.4 / 0.7 · tiers']);
s += pbox(232, 210, 190, 64, 'progression module', ['12-mo forecast · drivers', 'projected tier re-score']);
s += pbox(458, 210, 190, 64, 'escalation rule engine', ['(stage x tier) -> next test', 'declines with reason · override']);
s += pbox(684, 210, 170, 64, 'Decision API', ['`/patients /compare /progression', '`/score /workup /advance-stage', '`no diagnosis field anywhere']);
s += pbox(872, 210, 166, 64, 'storage + db.py', ['init_db · seed_if_empty', 'persist() event mirror']);
s += pbox(1080, 206, 92, 74, 'SQLite /', ['`PostgreSQL']);

/* API bus above the boxes */
s += wire([[119, 210], [119, 196]], { noArrow: true });
s += wire([[327, 210], [327, 196]], { noArrow: true });
s += wire([[553, 210], [553, 196]], { noArrow: true });
s += wire([[119, 196], [769, 196]], { noArrow: true });
s += wire([[769, 196], [769, 210]], { c: TEAL });

/* artifacts loaded once */
s += wire([[948, 132], [948, 210]], { label: 'loaded once at lifespan startup', at: [956, 168] });

/* DB read/write */
s += wire([[1038, 238], [1080, 238]], { label: 'w', at: [1044, 232] });
s += wire([[1080, 262], [1038, 262]], { label: 'r', at: [1044, 276] });

/* feedback: forecast -> risk model (dashed purple) */
s += wire([[327, 274], [327, 286], [140, 286], [140, 276]], { c: PURPLE, dash: true, label: 'projected vector -> risk re-score', at: [150, 282] });

/* ===== BAND 3 — TRIAGE LOOP (y 316..436) ===== */
s += zone(8, 316, 1172, 120, 'AUTONOMOUS TRIAGE LOOP — runtime (while toggle is ON)', true);
s += dia(180, 376, 180, 76, 'Test indicated?', '(stage x tier) rule gate');
s += pbox(320, 350, 190, 52, 'order test · result lands', ['blood -> MRI -> PET cascade', 'LIS / RIS stand-in values']);
s += pbox(560, 350, 190, 52, 're-score + audit event', ['model re-runs on new evidence', '0.68 -> 0.81 · rank #12 -> #2']);
s += pbox(800, 350, 190, 52, 'decline — 409 + reason', ['tier says stop · no over-testing', 'override=true escape (logged)']);

s += wire([[80, 274], [80, 376], [90, 376]], { c: TEAL, label: 'pick subject (max score)', at: [4, 322] });
s += wire([[270, 376], [320, 376]], { c: TEAL, label: 'YES', at: [280, 370], la: 'start' });
s += wire([[510, 376], [560, 376]]);
s += wire([[655, 402], [655, 428], [180, 428], [180, 416]], { c: TEAL, label: 'next subject · ~1.4 s cadence', at: [300, 424] });
s += wire([[180, 338], [180, 326], [895, 326], [895, 348]], { c: AMBER, label: 'NO — tier says stop', at: [200, 332] });
s += wire([[700, 350], [700, 300]], { c: GREEN, dash: true, label: 'score / tier / SHAP update live', at: [708, 318] });
s += wire([[700, 402], [700, 418], [1126, 418], [1126, 282]], { c: AMBER, dash: true, label: 'audit events (append-only)', at: [760, 414] });
s += wire([[895, 402], [895, 432]], { c: AMBER, label: 'reason -> clinician', at: [903, 436] });

/* ===== BAND 4 — UI + DEPLOY (y 452..646) ===== */
s += zone(8, 452, 680, 194, 'DASHBOARD — React (src/)', true);
s += pbox(24, 486, 152, 42, 'Overview', ['tiers · funnel · shortlist']);
s += pbox(192, 486, 152, 42, 'Worklist', ['ranked queue · multi-select']);
s += pbox(360, 486, 152, 42, 'Priority Comparison', ['tiebreak ladder']);
s += pbox(24, 556, 152, 42, 'Patient record', ['gauge · SHAP · trail']);
s += pbox(192, 556, 152, 42, 'Progression view', ['trajectory · forecast']);
s += pbox(360, 556, 152, 42, 'Risk Simulator', ['live what-if']);
s += txt(24, 634, 'renders only what the API returns — zero mock data in the client', { size: 8.4, fill: FAINT });

/* API -> UI rail through the band gap */
s += wire([[769, 274], [769, 308], [295, 308], [295, 452]], { c: TEAL, label: 'HTTP / JSON — the only source the UI reads', at: [360, 304] });

s += zone(704, 452, 476, 194, 'DEPLOYMENT & TRUST', true);
s += pbox(724, 486, 120, 40, 'git push + CI');
s += pbox(874, 490 - 4 + 0, 150, 40, 'Docker image', ['UI + API + artifacts']);
s += wire([[844, 506], [874, 506]]);
s += pbox(1044, 486, 120, 40, 'Railway $PORT');
s += wire([[1024, 506], [1044, 506]]);
s += pbox(724, 556, 200, 60, 'append-only audit trail', ['API timestamps · Postgres mirror', 'visible on record + pipeline views'], { stroke: AMBER, dash: true });
s += pbox(944, 556, 220, 60, 'provenance', ['`/health data_source pill', '`/model/info AUROC · thresholds']);

/* ===== BAND 5 — LEGEND (y 662..756) ===== */
s += '<rect x="8" y="662" width="1172" height="94" rx="3" fill="#fff" stroke="#4A4F58" stroke-width="1.15"/>';
s += txt(28, 682, 'LEGEND — every wire is a real call path in the repo', { size: 9.5, weight: 800, fill: INK, ls: '0.6' });
s += legLine(28, 704, WIRE) + txt(62, 704, 'data / request path', { size: 9 });
s += legLine(28, 722, TEAL) + txt(62, 722, 'autonomous decision path', { size: 9 });
s += legLine(28, 740, PURPLE, true) + txt(62, 740, 'model feedback (projected vector re-score)', { size: 9 });
s += legLine(560, 704, AMBER, true) + txt(594, 704, 'safety · audit · override', { size: 9 });
s += txt(594, 722, 'DECISION', { size: 7.6, weight: 800, fill: AMBER, anchor: 'middle' });
s += '<polygon points="600,726 612,731 600,736 588,731" fill="#fff" stroke="' + AMBER + '" stroke-width="1.2"/>';
s += txt(620, 734, 'decision point (rule-engine gate)', { size: 9 });
s += legLine(560, 740, GREEN, true) + txt(594, 740, 'result lands -> live update', { size: 9 });
s += txt(28, 756 - 14, 'risk AUC 0.871 · conversion AUC 0.770 · delta MAE 0.611 · PR lift 2.8x · 24 pytest · artifacts git-tracked · no diagnosis field in any contract', { size: 9.2, weight: 700, fill: INK, mono: true });

/* ---------- assemble ---------- */
const svg = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" style="font-family:Inter,Arial,sans-serif;display:block">' + DEFS + s + '</svg>';

const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
  + '<title>NeuroPilot — System Flowchart (one page)</title>'
  + '<link rel="preconnect" href="https://fonts.googleapis.com">'
  + '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=IBM+Plex+Mono:wght@500;600&display=swap" rel="stylesheet">'
  + '<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Inter,Arial,sans-serif;background:#ECE9E2;display:flex;flex-direction:column;align-items:center;padding:24px 0}'
  + '.page{width:' + PAGE_W + 'px;background:#F7F5F1;padding:26px 46px 24px;box-shadow:0 2px 12px rgba(0,0,0,0.08)}'
  + '.hd{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:10px}'
  + '.t{font-size:24px;font-weight:900;letter-spacing:-0.4px;color:' + INK + '}'
  + '.st{font-size:11px;color:' + MUT + ';margin-top:3px}'
  + '.chip{font-size:10.5px;font-weight:800;color:' + TEAL + ';border:1px solid #E3DFD6;background:#fff;border-radius:999px;padding:6px 13px}'
  + '</style></head><body><div class="page">'
  + '<div class="hd"><div><div class="t">NeuroPilot — Complete System Flowchart</div>'
  + '<div class="st">One page, every real path: data &rarr; training &rarr; artifacts &rarr; serving &rarr; autonomous loop &rarr; dashboard &rarr; deployment</div></div>'
  + '<span class="chip">NeuroPilot · Precision Care Challenge 2026</span></div>'
  + svg + '</div></body></html>';

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'] });
  try {
    fs.writeFileSync(path.join(ROOT, 'NeuroPilot_Flowchart_OnePage.html'), html);
    console.log('[done] HTML');

    const page = await browser.newPage();
    await page.setViewport({ width: PAGE_W, height: PAGE_H, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.evaluate(() => document.fonts.ready);
    await new Promise((r) => setTimeout(r, 700));

    await page.$('.page').then((el) => el.screenshot({ path: path.join(ROOT, 'NeuroPilot_Flowchart_OnePage.png') }));
    console.log('[done] PNG (2x)');

    await page.pdf({
      path: path.join(ROOT, 'NeuroPilot_Flowchart_OnePage.pdf'),
      width: PAGE_W + 'px', height: (PAGE_H + 48) + 'px',
      printBackground: true, margin: { top: '0', bottom: '0', left: '0', right: '0' },
    });
    console.log('[done] PDF');
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('RENDER FAILED:', e.message); process.exit(1); });
