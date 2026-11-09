// Headless smoke test: feeds a still-image "webcam" (y4m) to the app, runs each
// filter for a few frames, screenshots it, and fails on any runtime error.
//
// Usage: node scripts/test-filters.mjs [path/to/video.y4m] [outDir]
// Requires `npm install` (serves MediaPipe from node_modules) and Playwright's Chromium.
import { createRequire } from 'node:module';
// Resolve Playwright from the project or any global NODE_PATH install.
const { chromium } = createRequire(import.meta.url)('playwright');
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const video = resolve(process.argv[2] || 'test-fixtures/neutral.y4m');
const outDir = resolve(process.argv[3] || 'test-output');
const only = process.argv[4]; // optional: single filter id
const PORT = 8123;
mkdirSync(outDir, { recursive: true });

const server = spawn(process.execPath, ['scripts/serve.mjs'], { env: { ...process.env, PORT }, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 600));

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${video}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
  proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined,
});
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 720, height: 1100 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && !/^INFO:/.test(m.text()) && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(String(e)));

let failed = false;
try {
  await page.goto(`http://localhost:${PORT}/?vision=local&filter=peekaboo-eyes`);
  await page.waitForFunction(() => window.__peekaboo?.running === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => window.__peekaboo.faceFrames > 3, null, { timeout: 30_000 });
  const ids = await page.evaluate(() => [...document.querySelectorAll('.chip')].map((c) => c.dataset.id));
  console.log('delegate:', await page.evaluate(() => window.__peekaboo.delegate));

  for (const id of ids) {
    if (only && id !== only) continue;
    await page.click(`.chip[data-id="${id}"]`);
    const before = await page.evaluate(() => window.__peekaboo.frames);
    await page.waitForFunction((b) => window.__peekaboo.frames > b + 40, before, { timeout: 20_000 });
    const info = await page.evaluate(() => ({
      errors: window.__peekaboo.errors.splice(0),
      meter: document.getElementById('meter').style.width,
      faceFrames: window.__peekaboo.faceFrames,
    }));
    await page.locator('#canvas').screenshot({ path: `${outDir}/${id}.png` });
    const ok = info.errors.length === 0;
    if (!ok) failed = true;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${id.padEnd(16)} trigger=${info.meter.padStart(4)} ${info.errors.join(' | ')}`);
  }
  if (consoleErrors.length) {
    failed = true;
    console.log('console errors:\n  ' + consoleErrors.join('\n  '));
  }
} catch (err) {
  failed = true;
  console.error('TEST ERROR', err);
  await page.screenshot({ path: `${outDir}/_failure.png` }).catch(() => {});
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
