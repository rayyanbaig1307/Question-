import { test, expect, type Page } from '@playwright/test';
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

// A pretend signed-in user and a pretend backend for them (nothing leaves this computer).
// `privateAccount` is what the pretend database has saved; set `rejectSave` to make the next saves fail.
async function signInWithFakeBackend(page: Page) {
  const id = '00000000-0000-4000-8000-000000000001';
  const user = { id, aud: 'authenticated', role: 'authenticated', email: 'qa@example.invalid', app_metadata: {}, user_metadata: {} };
  const jwtPart = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const accessToken = `${jwtPart({ alg: 'HS256', typ: 'JWT' })}.${jwtPart({ sub: id, exp: Math.floor(Date.now()/1000)+3600 })}.fake-qa-signature`;
  await page.addInitScript(({ session }) => localStorage.setItem('sb-qa-backend-auth-token', JSON.stringify(session)), {
    session: { user, access_token: accessToken, refresh_token: 'qa-refresh-no-access', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now()/1000)+3600 },
  });
  const state = { privateAccount: false, rejectSave: false };
  const profile = () => ({ id, username: 'qa_user', display_name: 'QA User', bio: '', avatar_path: null, is_private: state.privateAccount, location_sharing: false, hit_ups_from: 'everyone' });
  await page.route('https://qa-backend.invalid/**', async route => {
    const url = new URL(route.request().url());
    // Like the real backend, let the app read the row count (content-range) across origins.
    const headers = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range', 'content-type': 'application/json', 'content-range': '0-0/1' };
    if (url.pathname.endsWith('/profiles')) {
      if (route.request().method() === 'PATCH') {
        if (state.rejectSave) { await route.fulfill({ status: 503, headers, body: JSON.stringify({ message: 'Local simulated database outage' }) }); return; }
        const change = route.request().postDataJSON();
        state.privateAccount = change.is_private ?? state.privateAccount;
      }
      await route.fulfill({ status: 200, headers, body: JSON.stringify(profile()) }); return;
    }
    if (url.pathname.endsWith('/legal_acceptances')) {
      await route.fulfill({ status: 200, headers, body: route.request().method() === 'HEAD' ? '' : '[]' }); return;
    }
    if (url.pathname.endsWith('/age_checks')) {
      // The QA user already saved a birthday, so the app doesn't jump to the one-time birthday question.
      await route.fulfill({ status: 200, headers, body: JSON.stringify([{ birthday: '2000-01-01' }]) }); return;
    }
    if (url.pathname.endsWith('/notification_prefs')) {
      await route.fulfill({ status: 200, headers, body: JSON.stringify({ messages: false, friend_requests: false, likes: false, comments: false, drops: false }) }); return;
    }
    if (url.pathname.includes('/auth/v1/user')) {
      await route.fulfill({ status: 200, headers, body: JSON.stringify(user) }); return;
    }
    await route.fulfill({ status: 200, headers, body: '[]' });
  });
  return { id, state };
}

const homeTab = (page: Page, name: 'Chat' | 'Camera' | 'Home') => page.getByRole('tab', { name, exact: true });

// The Chat, Camera and Home pages sit side by side in one sideways scroller. While it is still sliding, the
// web app treats a tap on a button inside it as part of the swipe and drops it (the button only gets focus).
// "Fully on screen" is not enough: a button is fully on screen while the page still has 10–40px to go.
// So: note every scroll (call before page.goto), then wait until the scroller sits exactly on the page and
// has not moved for 300 ms (longer than the 120 ms the pager itself waits before it calls a swipe "done").
async function noteScrolling(page: Page) {
  await page.addInitScript(() => document.addEventListener('scroll', () => {
    (window as unknown as { __qaLastScroll?: number }).__qaLastScroll = performance.now();
  }, true));
}
async function waitForPagesToStop(page: Page, pageNumber: number) {
  await expect.poll(() => page.evaluate(index => {
    const pager = [...document.querySelectorAll<HTMLElement>('*')].find(element => {
      const style = getComputedStyle(element);
      return (style.overflowX === 'auto' || style.overflowX === 'scroll') && style.overscrollBehaviorX === 'contain';
    });
    if (!pager) return 'no pages yet';
    const target = index * pager.clientWidth;
    if (Math.abs(pager.scrollLeft - target) >= 1) return `still moving (at ${pager.scrollLeft}px, page starts at ${target}px)`;
    const quietFor = performance.now() - ((window as unknown as { __qaLastScroll?: number }).__qaLastScroll ?? 0);
    return quietFor >= 300 ? 'stopped' : `still moving (last moved ${Math.round(quietFor)} ms ago)`;
  }, pageNumber), { message: `home page ${pageNumber} should stop sliding`, intervals: [50] }).toBe('stopped');
}

test('signed-in settings preserve privacy after a failed save', async ({ page }) => {
  page.on('pageerror', error => console.log('Signed-in browser error:', error.message));
  const { id, state } = await signInWithFakeBackend(page);
  await noteScrolling(page);
  // Open Settings the way a person does: home → my profile → Settings.
  // (Opening /settings straight from a link is checked separately below.)
  await page.goto('/');
  await homeTab(page, 'Chat').click();
  await expect(page.getByLabel('Search friends', { exact: true })).toBeInViewport({ ratio: 1 });
  // Wait until the Chat page has stopped sliding (Chat is the first page): see waitForPagesToStop.
  await waitForPagesToStop(page, 0);
  // The Chat page comes first, so its "My profile" button is the first one. Tapping it must open your own
  // profile. If a tap is still dropped, tap again like a person would (only while we are not there yet);
  // a note on the test says how many taps it took.
  const myProfile = page.getByLabel('My profile', { exact: true }).first();
  const myProfileAddress = new RegExp(`/profile/${id}$`);
  let taps = 0;
  await expect(async () => {
    if (!myProfileAddress.test(new URL(page.url()).pathname)) { taps += 1; await myProfile.click({ timeout: 2_000 }); }
    await expect(page).toHaveURL(myProfileAddress, { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  if (taps > 1) test.info().annotations.push({ type: 'note', description: `"My profile" needed ${taps} taps` });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByText('Privacy & safety', { exact: true })).toBeVisible();
  const privacy = page.getByRole('switch').first();
  // The row around the switch is not marked "disabled", so a normal click works (and screen readers don't
  // call the switch disabled).
  await expect(privacy).toBeEnabled();
  await expect(page.locator('[aria-disabled="true"]').filter({ has: privacy })).toHaveCount(0);
  // A plain click, not check(): the switch only flips once the save has worked, so check() would give up
  // before the answer comes back. The result is checked right after.
  await expect(privacy).not.toBeChecked();
  await privacy.click();
  await expect(privacy).toBeChecked();
  await expect.poll(() => state.privateAccount).toBe(true);
  state.rejectSave = true;
  const failedSave = page.waitForResponse(response =>
    response.url().includes('/profiles') && response.request().method() === 'PATCH' && response.status() === 503);
  await privacy.click();
  // The app really tried to save "public", and the save failed…
  await failedSave;
  // …so the switch stays on "private", and so does the saved account.
  await expect(privacy).toBeChecked();
  expect(state.privateAccount).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `.qa/settings-${test.info().project.name}.png`, fullPage: true });
});

test('signed-in home renders and the bottom tabs switch Chat, Camera and Home', async ({ page }) => {
  // Any crash in the page fails this test.
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await signInWithFakeBackend(page);
  await noteScrolling(page);
  await page.goto('/');

  // The home screen opens on the camera. (Which page shows is checked by what is on screen: the web
  // version doesn't mark the picked tab as "selected" for screen readers yet – reported separately.)
  const shutter = page.getByLabel('Take photo, or hold to record a video', { exact: true });
  const chatSearch = page.getByLabel('Search friends', { exact: true });
  // (The button's name also holds its icon, so find it by its words.)
  const homeTakePhoto = page.getByText('Take a photo', { exact: true });
  await expect(shutter).toBeInViewport();
  await expect(chatSearch).not.toBeInViewport();

  // A sideways swipe past the first or last page stays inside the pages: on a touch screen it must not
  // turn into the browser's "swipe back" gesture and leave the app.
  expect(await page.evaluate(() => [...document.querySelectorAll('*')].some(element => {
    const style = getComputedStyle(element);
    return (style.overflowX === 'auto' || style.overflowX === 'scroll') && style.overscrollBehaviorX === 'contain';
  }))).toBe(true);

  // Tap Chat: the chat page slides into view.
  await homeTab(page, 'Chat').click();
  await expect(chatSearch).toBeInViewport();
  await expect(shutter).not.toBeInViewport();

  // Tap Home (two pages over): the home feed slides into view.
  await homeTab(page, 'Home').click();
  await expect(homeTakePhoto).toBeInViewport();
  await expect(chatSearch).not.toBeInViewport();

  // Tap Camera: back to the camera.
  await homeTab(page, 'Camera').click();
  await expect(shutter).toBeInViewport();
  await expect(homeTakePhoto).not.toBeInViewport();

  // "Take a photo" on the Home page also jumps back to the camera.
  await homeTab(page, 'Home').click();
  await expect(homeTakePhoto).toBeInViewport({ ratio: 1 });
  // Home is the third page: wait until it has stopped sliding, or the tap is dropped (see waitForPagesToStop).
  await waitForPagesToStop(page, 2);
  await homeTakePhoto.click();
  await expect(shutter).toBeInViewport();

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `.qa/home-${test.info().project.name}.png` });
  expect(pageErrors).toEqual([]);
});

// Moves to another page inside the running app, the way a tap on a link does (no reload).
async function openInsideApp(page: Page, path: string) {
  await page.evaluate(target => {
    history.pushState({}, '', target);
    dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  }, path);
}

test('signed-in photo editor on the web says Send and Save need the phone app', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await signInWithFakeBackend(page);
  await page.goto('/');
  await expect(homeTab(page, 'Camera')).toBeVisible();
  // A browser has no camera here, so open the editor with a tiny made-up photo (1×1 pixel).
  // (Inside the app, not by typing the address: see the deep-link check below.)
  const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
  await openInsideApp(page, `/editor?uri=${encodeURIComponent(photo)}`);
  const sendTo = page.getByRole('button', { name: /^\W*Send to\W*$/ });
  const save = page.getByRole('button', { name: 'Save to Photos and Keeps', exact: true });
  await expect(sendTo).toBeVisible();

  // The web can't make the finished picture yet, so it must say so – not fail silently and leave you stuck.
  const message = page.getByText("Sending and saving from the web isn't ready yet. Please use the Peekaboo phone app.", { exact: true });
  await sendTo.click();
  await expect(message).toBeVisible();
  await expect(page).toHaveURL(/\/editor\?/);
  await expect(message).toBeHidden({ timeout: 10_000 });
  await save.click();
  await expect(message).toBeVisible();
  await expect(page).toHaveURL(/\/editor\?/);
  expect(pageErrors).toEqual([]);
});

test('signed-in deep link opens that page, not home', async ({ page }) => {
  // While the saved login is still loading, the app must not treat you as logged out: that used to send a
  // link like /settings (or a tapped notification when the app is closed, on phones too) to /welcome and
  // then to home. src/app/_layout.tsx now waits for the saved login before it shows any screen.
  await signInWithFakeBackend(page);
  await page.goto('/settings');
  // Wait until the app has finished loading (it shows either Settings or the home tabs)…
  await expect(page.getByText('Privacy & safety', { exact: true }).or(homeTab(page, 'Camera'))).toBeVisible();
  // …then it must be on Settings, not home ('/').
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByText('Privacy & safety', { exact: true })).toBeVisible();
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
  // Once the icon font has loaded, the button's name starts with its ✨ icon, so match the words at the end.
  await page.getByRole('button', { name: /^\W*Let's go!$/ }).click();
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
