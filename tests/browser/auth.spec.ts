import { test, expect } from '@playwright/test';
import { Buffer } from 'node:buffer';

test.beforeEach(async ({ page }) => {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') { await route.continue(); return; }
    // Every off-machine request is blocked, including real storage and push hosts.
    if (url.hostname !== 'qa-backend.invalid') { await route.abort(); return; }
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,apikey,content-type,x-client-info', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'content-type': 'application/json' };
    if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    if (url.pathname.endsWith('/rpc/username_available')) {
      const taken = route.request().postDataJSON()?.name === 'qa_taken';
      await route.fulfill({ status: 200, headers, body: taken ? 'false' : 'true' }); return;
    }
    await route.fulfill({ status: 400, headers, body: JSON.stringify({ error: 'Wrong username or password.', message: 'Wrong username or password.', code: 'invalid_credentials' }) });
  });
});

test('signed-in settings preserve privacy after a failed save', async ({ page }) => {
  test.fixme(process.env.QA_FULL_WEB !== '1', 'Signed-in web crashes in native pager/maps code: codegenNativeCommands is not a function. QA_FULL_WEB=1 reproduces it. Native UI needs an Android/iOS device.');
  page.on('pageerror', error => console.log('Signed-in browser error:', error.message));
  const id = '00000000-0000-4000-8000-000000000001';
  const user = { id, aud: 'authenticated', role: 'authenticated', email: 'qa@example.invalid', app_metadata: {}, user_metadata: {} };
  const jwtPart = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const accessToken = `${jwtPart({ alg: 'HS256', typ: 'JWT' })}.${jwtPart({ sub: id, exp: Math.floor(Date.now()/1000)+3600 })}.fake-qa-signature`;
  await page.addInitScript(({ session }) => localStorage.setItem('sb-qa-backend-auth-token', JSON.stringify(session)), {
    session: { user, access_token: accessToken, refresh_token: 'qa-refresh-no-access', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now()/1000)+3600 },
  });
  let privateAccount = false;
  let rejectSave = false;
  const profile = () => ({ id, username: 'qa_user', display_name: 'QA User', bio: '', avatar_path: null, is_private: privateAccount, location_sharing: false, hit_ups_from: 'everyone' });
  await page.route('https://qa-backend.invalid/**', async route => {
    const url = new URL(route.request().url());
    const headers = { 'access-control-allow-origin': '*', 'content-type': 'application/json', 'content-range': '0-0/1' };
    if (url.pathname.endsWith('/profiles')) {
      if (route.request().method() === 'PATCH') {
        if (rejectSave) { await route.fulfill({ status: 503, headers, body: JSON.stringify({ message: 'Local simulated database outage' }) }); return; }
        const change = route.request().postDataJSON();
        privateAccount = change.is_private ?? privateAccount;
      }
      await route.fulfill({ status: 200, headers, body: JSON.stringify(profile()) }); return;
    }
    if (url.pathname.endsWith('/legal_acceptances')) {
      await route.fulfill({ status: 200, headers, body: route.request().method() === 'HEAD' ? '' : '[]' }); return;
    }
    if (url.pathname.endsWith('/notification_prefs')) {
      await route.fulfill({ status: 200, headers, body: JSON.stringify({ messages: false, friend_requests: false, likes: false, comments: false, drops: false }) }); return;
    }
    if (url.pathname.includes('/auth/v1/user')) {
      await route.fulfill({ status: 200, headers, body: JSON.stringify(user) }); return;
    }
    await route.fulfill({ status: 200, headers, body: '[]' });
  });
  await page.goto('/settings');
  await expect(page.getByText('Privacy & safety', { exact: true })).toBeVisible();
  const privacy = page.getByRole('switch').first();
  await privacy.check();
  await expect(privacy).toBeChecked();
  await expect.poll(() => privateAccount).toBe(true);
  rejectSave = true;
  await privacy.uncheck();
  await expect(privacy).toBeChecked();
  expect(privateAccount).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `.qa/settings-${test.info().project.name}.png`, fullPage: true });
});

test('welcome, sign-in, back, refresh, and empty form', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Peek it. Share it.', { exact: false })).toBeVisible();
  await page.screenshot({ path: `.qa/welcome-${test.info().project.name}.png`, fullPage: true });
  await page.getByRole('button', { name: 'I already have an account', exact: true }).click();
  await expect(page.getByText('Welcome back!')).toBeVisible();
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByText('Type your email or username, and your password.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Welcome back!')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('bad credentials stay logged out, hostile text stays text', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByPlaceholder('you@example.com or coolname').fill("<script>window.__xss=1</script>😈' OR 1=1--");
  await page.getByPlaceholder('Your password').fill('wrong-password');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByText('Wrong username or password.', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(page.url()).toContain('sign-in');
});

test('sign-up empty input, username normalization, and username-only mode', async ({ page }) => {
  await page.goto('/sign-up');
  await page.getByRole('button', { name: "Let's go!", exact: true }).click();
  await expect(page.getByText('Pick a username.', { exact: true })).toBeVisible();
  await expect(page.getByText('You need to be 13 or older to use Peekaboo.')).toBeVisible();
  await page.getByPlaceholder('coolname', { exact: true }).fill('ABC 😀 <script> 123');
  await expect(page.getByPlaceholder('coolname', { exact: true })).toHaveValue('abcscript123');
  await expect(page.getByText('@abcscript123 is free!', { exact: false })).toBeVisible();
  await page.getByPlaceholder('coolname', { exact: true }).fill('qa_taken');
  await expect(page.getByText('Taken! Try another one.', { exact: true })).toBeVisible();
  await page.getByRole('radio', { name: 'Just a username', exact: false }).click();
  await expect(page.getByPlaceholder('you@example.com', { exact: true })).toHaveCount(0);
  await expect(page.getByText('No email means you log in with your username', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('protected deep links cannot show private content while logged out', async ({ page }) => {
  for (const route of ['/chat/00000000-0000-4000-8000-000000000001', '/keeps', '/settings']) {
    await page.goto(route);
    await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeVisible();
  }
});

test('network timeout gives an error and allows retry', async ({ page }) => {
  await page.route('https://qa-backend.invalid/functions/v1/username-auth', route => route.abort('timedout'));
  await page.goto('/sign-in');
  await page.getByPlaceholder('you@example.com or coolname').fill('qa_user');
  await page.getByPlaceholder('Your password').fill('wrong-pass1');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeEnabled();
  await expect(page.getByText(/Failed to send|Couldn.t|Something went wrong|network|connect/i)).toBeVisible();
});
