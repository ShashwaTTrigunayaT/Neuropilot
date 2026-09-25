// Throwaway verification: browse the EHR's charts and pick one for a launch.
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP = 'http://127.0.0.1:8000';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav', { timeout: 30000 });
  await page.evaluate(() => {
    [...document.querySelectorAll('nav button')]
      .find((b) => /Interoperability/i.test(b.textContent || ''))
      ?.click();
  });
  // /fhir/status probes the outbound server and can take ~8s.
  await new Promise((r) => setTimeout(r, 16000));

  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((n) =>
      /Browse charts on this server/i.test(n.textContent || '')
    );
    if (!b) return false;
    b.click();
    return true;
  });
  await new Promise((r) => setTimeout(r, 12000));

  const listed = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('ul li button')].filter((b) =>
      /[0-9a-f]{8}-[0-9a-f]{4}/.test(b.textContent || '')
    );
    const header = [...document.querySelectorAll('p')].find((p) =>
      /charts? on/i.test(p.textContent || '')
    );
    return {
      header: header?.textContent?.trim() ?? null,
      rowCount: rows.length,
      first: rows[0]?.textContent?.trim().replace(/\s+/g, ' ') ?? null,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  // Pick the second chart and confirm the launch link follows it.
  const picked = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('ul li button')].filter((b) =>
      /[0-9a-f]{8}-[0-9a-f]{4}/.test(b.textContent || '')
    );
    if (rows.length < 2) return null;
    rows[1].click();
    return true;
  });
  await new Promise((r) => setTimeout(r, 900));
  const launch = await page.evaluate(() => {
    const input = [...document.querySelectorAll('input')].find((i) =>
      (i.placeholder || '').includes('blank = server default')
    );
    const btn = [...document.querySelectorAll('a')].find((a) => /Launch \(/.test(a.textContent || ''));
    return { field: input?.value ?? null, label: btn?.textContent?.trim(), href: btn?.getAttribute('href') };
  });

  console.log(JSON.stringify({ clicked, listed, picked, launch, consoleErrors: errors }, null, 2));
  await browser.close();
})();
