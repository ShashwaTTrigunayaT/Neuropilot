/**
 * Render NeuroPilot brand assets (icon + logo lockup) to PNG / JPG / PDF.
 * Usage: node scripts/render_brand_assets.js   (writes into brand_assets/)
 *
 * The icon mirrors src/components/BrandLogo.jsx (NeuroPilotIcon): rounded tile,
 * gradient to-tr from #0D8282 via #0FA0A0 to #2563EB, brain + neural-axis SVG.
 */
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = path.join(__dirname, '..', 'brand_assets');

const BRAIN_SVG = `
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"
       stroke="currentColor" stroke-width="1.7">
    <path d="M11 4.5C9.2 4.2 7.2 4.8 6 6.2C4.5 7.8 4.2 10.2 5 12.2C4 13.5 3.8 15.5 4.8 17C5.8 18.5 7.5 19.5 9.5 19.5C10.5 19.5 11 20 11.5 20.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M13 4.5C14.8 4.2 16.8 4.8 18 6.2C19.5 7.8 19.8 10.2 19 12.2C20 13.5 20.2 15.5 19.2 17C18.2 18.5 16.5 19.5 14.5 19.5C13.5 19.5 13 20 12.5 20.5" stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="12" y1="4.5" x2="12" y2="20.5" stroke="white" stroke-opacity="0.85" stroke-width="1.3" stroke-dasharray="1.5 2"/>
    <circle cx="12" cy="7" r="1.2" fill="white"/>
    <circle cx="12" cy="12.5" r="1.5" fill="#38E1B0"/>
    <circle cx="12" cy="18" r="1.2" fill="white"/>
    <circle cx="8" cy="11" r="1" fill="#FFFFFF" fill-opacity="0.9"/>
    <circle cx="16" cy="11" r="1" fill="#FFFFFF" fill-opacity="0.9"/>
    <circle cx="8.5" cy="15.5" r="1" fill="#FFFFFF" fill-opacity="0.9"/>
    <circle cx="15.5" cy="15.5" r="1" fill="#FFFFFF" fill-opacity="0.9"/>
    <path d="M8 11L12 12.5L16 11" stroke="#38E1B0" stroke-width="0.9" stroke-opacity="0.75"/>
  </svg>
`;

function pageHtml({ dark = false, withText = false, whiteBg = false } = {}) {
  const textColor = dark ? '#FFFFFF' : '#16181B';
  const subColor = dark ? 'rgba(255,255,255,0.75)' : '#5B6472';
  const bodyBg = whiteBg ? 'background:#FFFFFF;' : '';
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;700;900&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Inter', system-ui, sans-serif; ${bodyBg} }
  .stage { display: inline-flex; padding: 8px; }
  .tile {
    display: flex; align-items: center; justify-content: center;
    background: linear-gradient(to top right, #0D8282, #0FA0A0, #2563EB);
  }
  .tile svg { stroke: white; display: block; }
  /* icon-only asset: 1024px tile, app-icon radius (33.3%), svg at 55.5% */
  .icon .tile { width: 1024px; height: 1024px; border-radius: 341px; }
  .icon .tile svg { width: 568px; height: 568px; }
  /* logo lockup asset */
  .lockup { display: inline-flex; align-items: center; gap: 36px; }
  .lockup .tile { width: 256px; height: 256px; border-radius: 85px; }
  .lockup .tile svg { width: 142px; height: 142px; }
  .lockup .text { line-height: 1.08; }
  .lockup h1 { font-size: 150px; font-weight: 900; letter-spacing: -0.02em; color: ${textColor}; }
  .lockup p { font-size: 44px; font-weight: 500; margin-top: 10px; color: ${subColor}; }
</style>
</head>
<body>
  <div class="stage ${withText ? 'lockup' : 'icon'}">
    <div class="tile">${BRAIN_SVG}</div>
    ${withText ? `<div class="text"><h1>NeuroPilot</h1><p>Clinical Decision Support &amp; Risk Triage</p></div>` : ''}
  </div>
</body>
</html>`;
}

async function settle(page) {
  // Fonts may stall if the network is flaky — race instead of blocking forever.
  await Promise.race([
    page.evaluateHandle('document.fonts.ready'),
    new Promise((r) => setTimeout(r, 6000)),
  ]);
  await new Promise((r) => setTimeout(r, 250));
}

(async () => {
  require('fs').mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--force-color-profile=srgb'],
  });
  const page = await browser.newPage();

  async function shoot(html, selector, out, { jpeg = false, omitBackground = true } = {}) {
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settle(page);
    const el = await page.$(selector);
    await el.screenshot({
      path: path.join(OUT, out),
      omitBackground: omitBackground && !jpeg,
      type: jpeg ? 'jpeg' : 'png',
      ...(jpeg ? { quality: 95 } : {}),
    });
    console.log('wrote', out);
  }

  // 1. Icon — transparent PNG (best for slides over any background)
  await shoot(pageHtml(), '.icon', 'neuropilot-icon-1024.png');
  // 2. Icon — JPG on white (for tools without transparency support)
  await shoot(pageHtml({ whiteBg: true }), '.icon', 'neuropilot-icon-1024.jpg', { jpeg: true, omitBackground: false });
  // 3. Lockup — dark text for light slides
  await shoot(pageHtml({ withText: true }), '.lockup', 'neuropilot-logo-dark-text.png');
  // 4. Lockup — white text for dark slides
  await shoot(pageHtml({ dark: true, withText: true }), '.lockup', 'neuropilot-logo-white-text.png');

  // 5. Vector PDF brand sheet (A4 landscape)
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8">
     <link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;700;900&display=swap" rel="stylesheet">
     <style>
       * { margin: 0; box-sizing: border-box; }
       body { font-family: 'Inter', system-ui, sans-serif; color: #16181B; padding: 48px 56px; }
       h1 { font-size: 34px; font-weight: 900; letter-spacing: -0.02em; }
       p.lead { color: #5B6472; font-size: 15px; margin-top: 6px; }
       .grid { display: flex; gap: 56px; margin-top: 44px; align-items: flex-start; }
       .card { border: 1px solid #E4E1DB; border-radius: 18px; padding: 40px; text-align: center; }
       .card .label { font-size: 12px; color: #5B6472; margin-top: 22px; font-weight: 500; }
       .tile { display: inline-flex; align-items: center; justify-content: center;
               background: linear-gradient(to top right, #0D8282, #0FA0A0, #2563EB); }
       .tile svg { stroke: white; }
       .big .tile { width: 200px; height: 200px; border-radius: 67px; }
       .big .tile svg { width: 111px; height: 111px; }
       .row { display: flex; gap: 40px; margin-top: 44px; align-items: center; }
       .lockup { display: inline-flex; align-items: center; gap: 20px; }
       .lockup .tile { width: 96px; height: 96px; border-radius: 32px; }
       .lockup .tile svg { width: 53px; height: 53px; }
       .lockup h2 { font-size: 56px; font-weight: 900; letter-spacing: -0.02em; line-height: 1.05; }
       .lockup p { font-size: 17px; font-weight: 500; margin-top: 4px; }
       .darkcard { background: #16181B; border-radius: 18px; padding: 34px 44px; }
       .darkcard .lockup h2 { color: #fff; }
       .darkcard .lockup p { color: rgba(255,255,255,0.75); }
       .swatches { display: flex; gap: 14px; margin-top: 46px; }
       .sw { width: 120px; height: 68px; border-radius: 12px; position: relative; }
       .sw span { position: absolute; bottom: 6px; left: 8px; font-size: 11px; color: #fff; opacity: 0.9; }
     </style></head><body>
     <h1>NeuroPilot — Brand Assets</h1>
     <p class="lead">Clinical Decision Support &amp; Risk Triage · AI-driven 4-stage diagnostic pipeline</p>
     <div class="grid">
       <div class="card big"><div class="tile">${BRAIN_SVG}</div><div class="label">App icon · gradient #0D8282 → #0FA0A0 → #2563EB</div></div>
       <div>
         <div class="lockup"><div class="tile">${BRAIN_SVG}</div><div><h2>NeuroPilot</h2><p style="color:#5B6472">Clinical Decision Support &amp; Risk Triage</p></div></div>
         <div class="darkcard" style="margin-top:26px"><div class="lockup"><div class="tile">${BRAIN_SVG}</div><div><h2>NeuroPilot</h2><p>Clinical Decision Support &amp; Risk Triage</p></div></div></div>
       </div>
     </div>
     <div class="swatches">
       <div class="sw" style="background:#0D8282"><span>#0D8282</span></div>
       <div class="sw" style="background:#0FA0A0"><span>#0FA0A0</span></div>
       <div class="sw" style="background:#2563EB"><span>#2563EB</span></div>
       <div class="sw" style="background:#38E1B0"><span style="color:#123332">#38E1B0</span></div>
     </div>
     </body></html>`,
    { waitUntil: 'domcontentloaded', timeout: 60000 }
  );
  await settle(page);
  await page.pdf({
    path: path.join(OUT, 'neuropilot-brand.pdf'),
    format: 'A4',
    landscape: true,
    printBackground: true,
    margin: { top: '0px', bottom: '0px', left: '0px', right: '0px' },
  });
  console.log('wrote neuropilot-brand.pdf');

  await browser.close();
})();
