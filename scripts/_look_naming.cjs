/* THROWAWAY verification of the filing-number naming + provenance. Delete after use. */
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new',
    args: ['--no-sandbox'],
    defaultViewport: { width: 1440, height: 1000 },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto('http://127.0.0.1:8000/', { waitUntil: 'networkidle2', timeout: 90000 });
  await page.evaluate(() => {
    [...document.querySelectorAll('button,a')]
      .find((b) => /interoperability/i.test(b.textContent || ''))
      .click();
  });
  await page.waitForFunction(() => /import from the ehr session/i.test(document.body.innerText), {
    timeout: 30000,
  });

  await page.evaluate(() => {
    [...document.querySelectorAll('button')]
      .find((x) => /import patient from ehr/i.test(x.textContent || ''))
      .click();
  });
  await page.waitForFunction(
    () => /(imported and scored|refreshed and re-scored|already imported)/i.test(document.body.innerText),
    { timeout: 60000, polling: 400 }
  );
  await sleep(1200);
  console.log('=== import card ===');
  console.log(
    await page.evaluate(() => {
      const t = document.body.innerText.replace(/\n{2,}/g, '\n');
      const i = t.search(/SUBJECT/i);
      return t.slice(Math.max(0, i - 90), i + 460);
    })
  );

  /* does the record itself show the real EHR id? */
  await page.evaluate(() => {
    [...document.querySelectorAll('button')]
      .find((x) => /open the imported record/i.test(x.textContent || ''))
      .click();
  });
  await page.waitForFunction(() => /pulled from the ehr record/i.test(document.body.innerText), {
    timeout: 40000,
    polling: 400,
  });
  await sleep(800);
  console.log('=== record masthead provenance ===');
  console.log(
    await page.evaluate(() => {
      const t = document.body.innerText.replace(/\n{2,}/g, '\n');
      const i = t.search(/SUBJECT RECORD/i);
      return t.slice(i, i + 640);
    })
  );

  await page.screenshot({ path: '_preview_import.png' });
  console.log('=== console errors ===', errors.length ? errors : 'none');
  await browser.close();
})();
