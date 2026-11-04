import { test, expect } from '@playwright/test';

const pages = ['index.html', 'support.html', 'privacy.html', 'terms.html', 'guidelines.html', 'dare-safety.html', '404.html'];
test.beforeEach(async ({ page }) => {
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
});
for (const mode of ['light', 'dark'] as const) {
  for (const name of pages) {
    test(`${name} ${mode}: readable, fits, images and internal links work`, async ({ page, request }) => {
      await page.emulateMedia({ colorScheme: mode });
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`/site/${name}`);
      await expect(page.locator('h1').first()).toBeVisible();
      expect(await page.locator('body').innerText()).not.toContain('[YOUR');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await page.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
      const links = await page.locator('a[href]').evaluateAll(anchors => anchors.map(anchor => (anchor as HTMLAnchorElement).href));
      for (const link of new Set(links)) {
        const url = new URL(link);
        if (url.hostname !== '127.0.0.1') continue;
        const response = await request.get(link);
        expect(response.status(), `broken internal link ${link}`).toBe(200);
        if (url.hash) {
          const html = await response.text();
          const target = decodeURIComponent(url.hash.slice(1));
          expect(await page.evaluate(({ html, target }) => !!new DOMParser().parseFromString(html, 'text/html').getElementById(target), { html, target })).toBe(true);
        }
      }
      expect(errors).toEqual([]);
    });
  }
}

test('unknown website page shows a real 404 and a working home link', async ({ page }) => {
  const response = await page.goto('/site/missing-page');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await page.getByRole('link', { name: 'Go to the home page' }).click();
  await expect(page.getByRole('heading', { name: 'peekaboo', exact: true })).toBeVisible();
});
