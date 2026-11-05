/// <reference types="node" />
import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

// Use a Chrome/Chromium already on this computer if there is one (QA_CHROME_PATH,
// the normal Windows Chrome, or a preinstalled Linux Chromium); otherwise
// Playwright's own browser (npx playwright install chromium).
const installedChrome = [
  process.env.QA_CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/opt/pw-browsers/chromium',
].find(candidate => candidate && existsSync(candidate));
export default defineConfig({
  testDir: './tests/browser',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  outputDir: '.qa/browser-results',
  reporter: [['list'], ['json', { outputFile: '.qa/browser-results.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    launchOptions: installedChrome ? { executablePath: installedChrome } : {},
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'small-phone', use: { ...devices['iPhone SE'], defaultBrowserType: 'chromium' } },
    { name: 'large-phone', use: { ...devices['Pixel 7'], defaultBrowserType: 'chromium' } },
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: 'node tests/browser/server.mjs',
    url: 'http://127.0.0.1:4173/site/index.html',
    reuseExistingServer: false,
  },
});
