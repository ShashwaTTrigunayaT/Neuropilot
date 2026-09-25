/* THROWAWAY: verifies the Interoperability inbound panel (import + collapsed tester). Delete after use. */
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
    const el = [...document.querySelectorAll('button,a')].find((b) =>
      /Interoperability/.test(b.textContent || '')
    );
    el && el.click();
  });
  await page.waitForFunction(() => document.body.innerText.includes('Import from the EHR session'), {
    timeout: 30000,
  });

  /* 1. is the manual tester collapsed by default? */
  const tester = await page.evaluate(() => {
    const d = [...document.querySelectorAll('details')].find((x) =>
      /Manual bundle tester/.test(x.textContent || '')
    );
    if (!d) return { found: false };
    const ta = d.querySelector('textarea');
    return {
      found: true,
      open: d.open,
      textareaRendered: ta ? ta.getBoundingClientRect().height > 0 : null,
    };
  });
  console.log('1. manual tester:', JSON.stringify(tester));

  /* 2. the import button */
  const importBtn = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) =>
      /Import patient from EHR/.test(x.textContent || '')
    );
    const note = document.body.innerText.match(/Reads[\s\S]{0,170}/);
    return { enabled: b ? !b.disabled : null, note: note ? note[0].replace(/\n+/g, ' ') : null };
  });
  console.log('2. import button:', JSON.stringify(importBtn, null, 1));

  await page.evaluate(() => {
    [...document.querySelectorAll('button')]
      .find((x) => /Import patient from EHR/.test(x.textContent || ''))
      .click();
  });
  await page.waitForFunction(
    () => /Patient imported and scored|Patient refreshed and re-scored|Chart already imported/.test(document.body.innerText),
    { timeout: 90000 }
  );
  await sleep(1500);
  console.log('3. import card:');
  console.log(
    await page.evaluate(() => {
      const t = document.body.innerText;
      const i = t.indexOf('Subject');
      return i >= 0 ? t.slice(Math.max(0, i - 200), i + 620).replace(/\n{2,}/g, '\n') : 'CARD NOT FOUND';
    })
  );

  /* 4. does the manual paste flow still work? */
  await page.evaluate(() => {
    const d = [...document.querySelectorAll('details')].find((x) =>
      /Manual bundle tester/.test(x.textContent || '')
    );
    if (d) d.open = true;
  });
  await page.evaluate(() => {
    [...document.querySelectorAll('button')]
      .find((x) => /Send bundle/.test(x.textContent || ''))
      .click();
  });
  await page.waitForFunction(() => /transaction-response received/.test(document.body.innerText), {
    timeout: 40000,
  });
  console.log('4. manual paste receipt:');
  console.log(
    await page.evaluate(() => {
      const t = document.body.innerText;
      const i = t.indexOf('transaction-response received');
      return t.slice(i, i + 420).replace(/\n{2,}/g, '\n');
    })
  );

  console.log(
    '5. horizontal overflow px:',
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
  );
  await page.screenshot({ path: '_preview_import.png' });
  console.log('6. console errors:', errors.length ? errors : 'none');
  await browser.close();
})();
