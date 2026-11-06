// Peekaboo+ buying (src/lib/plus.ts) with a pretend RevenueCat library: setting it up (also after an app
// update reloads the app), cancelling, Ask to Buy, store errors, Plus that didn't switch on, account switches,
// a missing monthly package, logging out, the server re-checks after a purchase, asking the server again, and
// "Manage subscription". The real error numbers come from RevenueCat's own package.
import { PURCHASES_ERROR_CODE } from '@revenuecat/purchases-typescript-internal';
import { beforeEach, expect, it, vi } from 'vitest';
import { loadLibrary } from './libHarness.mjs';

const SOON = new Date(Date.now() + 30 * 24 * 3600_000).toISOString();
const info = (plus) => ({ entitlements: { active: plus ? { plus: { identifier: 'plus', isActive: true } } : {} } });
const storeError = (code, message = 'RevenueCat said no') => Object.assign(new Error(message), { code, userCancelled: code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR });

const MONTHLY = { identifier: '$rc_monthly', packageType: 'MONTHLY', product: { identifier: 'peekaboo_plus_monthly', priceString: '$6.99' } };
const ANNUAL = { identifier: '$rc_annual', packageType: 'ANNUAL', product: { identifier: 'peekaboo_plus_yearly', priceString: '$59.99' } };
const offeringsWith = (offering) => ({ all: { default: offering }, current: offering });
const WITH_MONTHLY = offeringsWith({ identifier: 'default', monthly: MONTHLY, availablePackages: [MONTHLY] });

// A pretend RevenueCat: remembers which account it's using, who bought, and every call.
function fakeRevenueCat({ offerings = WITH_MONTHLY, configured = false, appUserId = null } = {}) {
  const store = { configured, appUserId, owners: new Set(), boughtBy: [], listeners: [], failLogIns: 0, failConfigures: 0, calls: [] };
  const track = (name, fn) => vi.fn(async (...args) => { store.calls.push(name); return fn(...args); });
  const Purchases = {
    PURCHASES_ERROR_CODE,
    configure: vi.fn(({ appUserID }) => {
      store.calls.push('configure');
      if (store.failConfigures > 0) { store.failConfigures--; throw new Error('RevenueCat could not start'); }
      store.configured = true;
      store.appUserId = appUserID;
    }),
    isConfigured: vi.fn(async () => store.configured),
    getAppUserID: vi.fn(async () => store.appUserId),
    isAnonymous: vi.fn(async () => String(store.appUserId).startsWith('$RCAnonymousID')),
    logIn: track('logIn', async (id) => {
      if (store.failLogIns > 0) { store.failLogIns--; throw storeError(PURCHASES_ERROR_CODE.NETWORK_ERROR, 'The Internet connection appears to be offline.'); }
      store.appUserId = id;
      return { customerInfo: info(store.owners.has(id)), created: false };
    }),
    logOut: track('logOut', async () => { store.appUserId = '$RCAnonymousID:phone'; return info(false); }),
    addCustomerInfoUpdateListener: vi.fn((listener) => { store.listeners.push(listener); }),
    getCustomerInfo: vi.fn(async () => info(store.owners.has(store.appUserId))),
    getOfferings: track('getOfferings', async () => offerings),
    purchasePackage: track('purchasePackage', async (pack) => {
      store.boughtBy.push([store.appUserId, pack.identifier]);
      store.owners.add(store.appUserId);
      return { customerInfo: info(true), productIdentifier: pack.product.identifier };
    }),
    restorePurchases: track('restorePurchases', async () => info(store.owners.has(store.appUserId))),
    // Apple's own subscriptions sheet.
    showManageSubscriptions: track('showManageSubscriptions', async () => {
      if (!store.configured) throw new Error('There is no singleton instance. Make sure you configure Purchases before trying to get the default instance.');
    }),
  };
  // RevenueCat telling the app that something changed.
  const tell = (plus) => store.listeners.forEach((listener) => listener(info(plus)));
  return { store, Purchases, tell };
}

// A pretend Supabase with public.plus_members rows (user id → expires_at).
function fakeServer() {
  const rows = new Map();
  const reads = [];
  const supabase = {
    from: () => {
      const filters = {};
      const query = {
        select: () => query,
        eq: (column, value) => { filters[column] = value; return query; },
        in: () => query,
        gt: () => query,
        maybeSingle: async () => {
          reads.push(filters.user_id);
          const until = rows.get(filters.user_id);
          return { data: until ? { expires_at: until } : null, error: null };
        },
        then: (resolve) => resolve({ data: [], error: null }),
      };
      return query;
    },
  };
  return { rows, reads, supabase };
}

function loadPlus({ revenueCat = fakeRevenueCat(), server = fakeServer(), signedIn = 'alice' } = {}) {
  const afterSignOut = [];
  const timers = [];
  const opened = [];
  const me = { userId: signedIn };
  const lib = loadLibrary('plus', {
    supabase: server.supabase,
    mocks: {
      'expo-constants': { __esModule: true, default: { executionEnvironment: 'standalone' }, ExecutionEnvironment: { StoreClient: 'store-client' } },
      'react-native': {
        Platform: { OS: 'ios' }, NativeModules: { RNPurchases: {} }, TurboModuleRegistry: { get: () => null },
        Linking: { openURL: async (url) => { opened.push(url); } },
      },
      'react-native-purchases': { __esModule: true, default: revenueCat.Purchases, PURCHASES_ERROR_CODE },
      './auth': { useMe: () => ({ userId: me.userId }), runAfterSignOut: (step) => { afterSignOut.push(step); return () => {}; } },
      // Just enough React for the hooks to be called outside a screen.
      react: { useEffect() {}, useState: (value) => [value, () => {}], useSyncExternalStore: (_watch, snapshot) => snapshot() },
    },
    globals: {
      process: { env: { EXPO_PUBLIC_REVENUECAT_IOS_KEY: 'appl_test_key' } },
      // Timers are only written down, so a test can run them when it wants ("2 seconds later").
      setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length; },
      clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    },
  });
  const serverChecks = () => timers.filter((timer) => !timer.cleared && [2_000, 5_000, 10_000].includes(timer.ms));
  return { lib, revenueCat, server, afterSignOut, me, serverChecks, opened };
}

// Lets every waiting promise finish.
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

it('sets up RevenueCat once, with the Peekaboo account id, even if asked twice at the same time', async () => {
  const { lib, revenueCat } = loadPlus();
  expect(lib.CAN_BUY_PLUS).toBe(true);
  await Promise.all([lib.configurePurchases('alice'), lib.configurePurchases('alice')]);
  expect(revenueCat.Purchases.configure).toHaveBeenCalledTimes(1);
  expect(revenueCat.Purchases.configure.mock.calls[0][0]).toMatchObject({ apiKey: 'appl_test_key', appUserID: 'alice' });
  expect(revenueCat.Purchases.addCustomerInfoUpdateListener).toHaveBeenCalledTimes(1);
  expect(revenueCat.Purchases.logIn).not.toHaveBeenCalled();
});

// After an app update reloads the app, RevenueCat on the phone is still set up from before, but its line back to
// the old code is gone. The new code must set it up again, or RevenueCat's news (bought, renewed, ran out…)
// never reaches the app.
it('after an app update reloads the app, RevenueCat is set up again once, so its news reaches the new code', async () => {
  for (const before of ['alice', '$RCAnonymousID:phone', 'bob']) {
    const reloaded = loadPlus({ revenueCat: fakeRevenueCat({ configured: true, appUserId: before }) });
    const { Purchases } = reloaded.revenueCat;
    await reloaded.lib.configurePurchases('alice');
    expect(Purchases.configure, `RevenueCat was on ${before}`).toHaveBeenCalledTimes(1);
    expect(Purchases.configure.mock.calls[0][0]).toMatchObject({ apiKey: 'appl_test_key', appUserID: 'alice' });
    // Setting it up with Alice's id already puts RevenueCat on her account.
    expect(Purchases.logIn).not.toHaveBeenCalled();
    expect(reloaded.revenueCat.store.appUserId).toBe('alice');
    expect(Purchases.addCustomerInfoUpdateListener).toHaveBeenCalledTimes(1);
    // RevenueCat's news reaches the new code.
    reloaded.revenueCat.tell(true);
    expect(reloaded.lib.hasPlus('alice')).toBe(true);
    // Only once per start of the code: the next check doesn't set it up again.
    await reloaded.lib.configurePurchases('alice');
    expect(Purchases.configure).toHaveBeenCalledTimes(1);
  }
});

it('a set-up that failed is tried again the next time', async () => {
  const revenueCat = fakeRevenueCat();
  revenueCat.store.failConfigures = 1;
  const { lib } = loadPlus({ revenueCat });
  await expect(lib.configurePurchases('alice')).resolves.toBeUndefined();
  expect(revenueCat.store.configured).toBe(false);
  await lib.configurePurchases('alice');
  expect(revenueCat.Purchases.configure).toHaveBeenCalledTimes(2);
  expect(revenueCat.store.appUserId).toBe('alice');
  revenueCat.store.owners.add('alice');
  await expect(lib.buyPlus()).resolves.toBe('bought');
  expect(revenueCat.store.boughtBy).toEqual([['alice', '$rc_monthly']]);
});

it('closing Apple\'s sheet is quiet: "cancelled", no Plus, no server checks', async () => {
  const { lib, revenueCat, serverChecks } = loadPlus();
  await lib.configurePurchases('alice');
  revenueCat.Purchases.purchasePackage.mockRejectedValueOnce(storeError(PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR, 'Purchase was cancelled.'));
  await expect(lib.buyPlus()).resolves.toBe('cancelled');
  expect(lib.hasPlus('alice')).toBe(false);
  expect(serverChecks()).toHaveLength(0);
});

it('Ask to Buy gives "pending", and Plus switches on by itself once a parent says yes', async () => {
  const { lib, revenueCat, serverChecks } = loadPlus();
  await lib.configurePurchases('alice');
  revenueCat.Purchases.purchasePackage.mockRejectedValueOnce(storeError(PURCHASES_ERROR_CODE.PAYMENT_PENDING_ERROR, 'The payment is pending.'));
  await expect(lib.buyPlus()).resolves.toBe('pending');
  expect(lib.hasPlus('alice')).toBe(false);
  expect(lib.WAITING_FOR_PARENT).toBe("Waiting for a parent to approve. You'll get Peekaboo+ as soon as it's approved.");
  // Later: the parent says yes, and RevenueCat tells the app.
  revenueCat.tell(true);
  expect(lib.hasPlus('alice')).toBe(true);
  expect(lib.useStorePlus()).toBe(true);
  expect(serverChecks().map((timer) => timer.ms)).toEqual([2_000, 5_000, 10_000]);
});

it('store problems become plain messages (by RevenueCat\'s error numbers, not its English)', async () => {
  const cases = [
    [PURCHASES_ERROR_CODE.PRODUCT_ALREADY_PURCHASED_ERROR, 'You already have Peekaboo+ – tap Restore purchases.'],
    [PURCHASES_ERROR_CODE.RECEIPT_ALREADY_IN_USE_ERROR, "This Apple Account's Peekaboo+ is on another Peekaboo account."],
    [PURCHASES_ERROR_CODE.RECEIPT_IN_USE_BY_OTHER_SUBSCRIBER_ERROR, "This Apple Account's Peekaboo+ is on another Peekaboo account."],
    [PURCHASES_ERROR_CODE.PURCHASE_BELONGS_TO_OTHER_USER, "This Apple Account's Peekaboo+ is on another Peekaboo account."],
    [PURCHASES_ERROR_CODE.PURCHASE_NOT_ALLOWED_ERROR, 'Purchases are turned off on this iPhone (Screen Time).'],
    [PURCHASES_ERROR_CODE.NETWORK_ERROR, 'No internet – try again.'],
    [PURCHASES_ERROR_CODE.OFFLINE_CONNECTION_ERROR, 'No internet – try again.'],
    [PURCHASES_ERROR_CODE.STORE_PROBLEM_ERROR, "The App Store couldn't complete this. Try again in a minute."],
    [PURCHASES_ERROR_CODE.CONFIGURATION_ERROR, "The App Store couldn't complete this. Try again in a minute."],
    [PURCHASES_ERROR_CODE.UNKNOWN_ERROR, "The App Store couldn't complete this. Try again in a minute."],
    ['99', "The App Store couldn't complete this. Try again in a minute."],
  ];
  const { lib, revenueCat } = loadPlus();
  await lib.configurePurchases('alice');
  for (const [code, text] of cases) {
    revenueCat.Purchases.purchasePackage.mockRejectedValueOnce(storeError(code, 'There is an issue with your configuration.'));
    await expect(lib.buyPlus(), `error ${code}`).rejects.toThrow(text);
  }
  expect(lib.hasPlus('alice')).toBe(false);
});

it('a purchase where Plus didn\'t switch on is "not-active", never "bought"', async () => {
  const { lib, revenueCat } = loadPlus();
  await lib.configurePurchases('alice');
  revenueCat.Purchases.purchasePackage.mockResolvedValueOnce({ customerInfo: info(false), productIdentifier: 'peekaboo_plus_monthly' });
  await expect(lib.buyPlus()).resolves.toBe('not-active');
  expect(lib.hasPlus('alice')).toBe(false);
  expect(lib.useStorePlus()).toBe(false);
});

it('a real purchase is "bought", and the server is asked again after about 2, 5 and 10 seconds', async () => {
  const { lib, revenueCat, server, serverChecks } = loadPlus();
  await lib.configurePurchases('alice');
  await settle();
  const before = server.reads.length;
  await expect(lib.buyPlus()).resolves.toBe('bought');
  expect(revenueCat.store.boughtBy).toEqual([['alice', '$rc_monthly']]);
  expect(lib.hasPlus('alice')).toBe(true);
  expect(lib.useStorePlus()).toBe(true);
  await settle();
  expect(lib.useServerPlus()).toBe(false);

  const checks = serverChecks();
  expect(checks.map((timer) => timer.ms)).toEqual([2_000, 5_000, 10_000]);
  checks[0].callback(); await settle(); // 2 s: the webhook hasn't arrived yet
  server.rows.set('alice', SOON); // the webhook arrives
  checks[1].callback(); await settle(); // 5 s: the server knows now
  expect(lib.useServerPlus()).toBe(true);
  checks[2].callback(); await settle(); // 10 s: no need to ask again
  expect(server.reads.length - before).toBe(3); // right after buying, at 2 s and at 5 s
});

it('an account switch that failed is tried again before buying, so the purchase goes to the right person', async () => {
  const { lib, revenueCat, me } = loadPlus();
  await lib.configurePurchases('alice');
  revenueCat.store.owners.add('alice'); // Alice pays for Plus on this phone
  // Bob logs in, but RevenueCat can't switch (no internet).
  me.userId = 'bob';
  revenueCat.store.failLogIns = 1;
  await lib.configurePurchases('bob');
  expect(revenueCat.store.appUserId).toBe('alice');
  // RevenueCat still talks about Alice's Plus: it must not count as Bob's.
  revenueCat.tell(true);
  expect(lib.hasPlus('bob')).toBe(false);
  expect(lib.useStorePlus()).toBe(false);
  // Bob taps Subscribe: RevenueCat logs in as Bob first.
  await expect(lib.buyPlus()).resolves.toBe('bought');
  expect(revenueCat.store.boughtBy).toEqual([['bob', '$rc_monthly']]);
  const calls = revenueCat.store.calls;
  expect(calls.lastIndexOf('logIn')).toBeLessThan(calls.indexOf('purchasePackage'));
});

it('if RevenueCat still can\'t switch accounts, nothing is bought', async () => {
  const { lib, revenueCat, me } = loadPlus();
  await lib.configurePurchases('alice');
  me.userId = 'bob';
  revenueCat.store.failLogIns = 2;
  await lib.configurePurchases('bob');
  await expect(lib.buyPlus()).rejects.toThrow('No internet – try again.');
  expect(revenueCat.Purchases.purchasePackage).not.toHaveBeenCalled();
});

it('Restore purchases also makes sure RevenueCat is on the logged-in account first', async () => {
  const { lib, revenueCat, me, serverChecks } = loadPlus();
  await lib.configurePurchases('alice');
  me.userId = 'bob';
  revenueCat.store.failLogIns = 1;
  await lib.configurePurchases('bob');
  revenueCat.store.owners.add('bob'); // Bob paid on another phone
  await expect(lib.restorePurchases()).resolves.toBe('restored');
  const calls = revenueCat.store.calls;
  expect(calls.lastIndexOf('logIn')).toBeLessThan(calls.indexOf('restorePurchases'));
  expect(lib.hasPlus('bob')).toBe(true);
  expect(serverChecks().length).toBeGreaterThan(0);
});

it('Restore purchases: nothing found, cancelled, or a plain message', async () => {
  const { lib, revenueCat } = loadPlus();
  await lib.configurePurchases('alice');
  await expect(lib.restorePurchases()).resolves.toBe('not-found');
  revenueCat.Purchases.restorePurchases.mockRejectedValueOnce(storeError(PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR));
  await expect(lib.restorePurchases()).resolves.toBe('cancelled');
  revenueCat.Purchases.restorePurchases.mockRejectedValueOnce(storeError(PURCHASES_ERROR_CODE.RECEIPT_ALREADY_IN_USE_ERROR));
  await expect(lib.restorePurchases()).rejects.toThrow("This Apple Account's Peekaboo+ is on another Peekaboo account.");
});

it('without a monthly package there is no price and nothing to buy (never another package)', async () => {
  const revenueCat = fakeRevenueCat({ offerings: offeringsWith({ identifier: 'default', monthly: null, availablePackages: [ANNUAL] }) });
  const { lib } = loadPlus({ revenueCat });
  await lib.configurePurchases('alice');
  await expect(lib.getPlusPrice()).resolves.toBeNull();
  await expect(lib.buyPlus()).rejects.toThrow("Peekaboo+ isn't for sale right now. Please try again later.");
  expect(revenueCat.Purchases.purchasePackage).not.toHaveBeenCalled();

  const missing = loadPlus({ revenueCat: fakeRevenueCat({ offerings: { all: {}, current: null } }) });
  await missing.lib.configurePurchases('alice');
  await expect(missing.lib.getPlusPrice()).resolves.toBeNull();
});

it('the price is the monthly package\'s own App Store price', async () => {
  const { lib } = loadPlus();
  await lib.configurePurchases('alice');
  await expect(lib.getPlusPrice()).resolves.toBe('$6.99');
});

it('logging out of Peekaboo logs RevenueCat out too, only when it is set up and on an account', async () => {
  const { lib, revenueCat, afterSignOut } = loadPlus();
  expect(afterSignOut).toHaveLength(1);
  // Not set up yet: nothing to log out of.
  afterSignOut[0]('alice');
  await settle();
  expect(revenueCat.Purchases.logOut).not.toHaveBeenCalled();

  await lib.configurePurchases('alice');
  revenueCat.store.owners.add('alice');
  revenueCat.tell(true);
  expect(lib.hasPlus('alice')).toBe(true);
  afterSignOut[0]('alice');
  await settle();
  expect(revenueCat.Purchases.logOut).toHaveBeenCalledTimes(1);
  expect(lib.hasPlus('alice')).toBe(false);
  // RevenueCat is anonymous now: logging out again would be an error, so it isn't tried.
  afterSignOut[0]('alice');
  await settle();
  expect(revenueCat.Purchases.logOut).toHaveBeenCalledTimes(1);
  // The next person who logs in gets their own RevenueCat account.
  await lib.configurePurchases('bob');
  expect(revenueCat.Purchases.logIn).toHaveBeenLastCalledWith('bob');
});

it('logging out right after an app update reloads the app, before this code set RevenueCat up, is quiet', async () => {
  const { lib, revenueCat, afterSignOut } = loadPlus({ revenueCat: fakeRevenueCat({ configured: true, appUserId: 'alice' }) });
  afterSignOut[0]('alice');
  await settle();
  expect(revenueCat.Purchases.logOut).not.toHaveBeenCalled();
  // The next person to log in gets RevenueCat set up with their own account.
  await lib.configurePurchases('bob');
  expect(revenueCat.Purchases.configure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ appUserID: 'bob' }));
  expect(revenueCat.store.appUserId).toBe('bob');
});

it('a RevenueCat problem while logging out never breaks the logout', async () => {
  const { lib, revenueCat, afterSignOut } = loadPlus();
  await lib.configurePurchases('alice');
  revenueCat.Purchases.logOut.mockRejectedValueOnce(storeError(PURCHASES_ERROR_CODE.NETWORK_ERROR));
  expect(() => afterSignOut[0]('alice')).not.toThrow();
  await expect(lib.logOutPurchases('alice')).resolves.toBeUndefined();
});

it('Android, Expo Go or no key: buying is off and nothing touches RevenueCat', async () => {
  const opened = [];
  const lib = loadLibrary('plus', {
    supabase: fakeServer().supabase,
    mocks: {
      './auth': { useMe: () => ({ userId: 'alice' }), runAfterSignOut: () => () => {} },
      'react-native': {
        Platform: { OS: 'android' }, NativeModules: {}, TurboModuleRegistry: { get: () => null },
        Linking: { openURL: async (url) => { opened.push(url); } },
      },
    },
  });
  expect(lib.CAN_BUY_PLUS).toBe(false);
  await lib.configurePurchases('alice');
  await expect(lib.getPlusPrice()).resolves.toBeNull();
  await expect(lib.buyPlus()).rejects.toThrow('Peekaboo+ is coming soon.');
  await expect(lib.restorePurchases()).resolves.toBe('not-found');
  // "Manage subscription" opens Apple's page.
  await lib.openManageSubscription();
  expect(opened).toEqual(['https://apps.apple.com/account/subscriptions']);
});

it('"Manage subscription" opens Apple\'s own sheet in the app (it also shows test purchases)', async () => {
  const { lib, revenueCat, opened } = loadPlus();
  await lib.configurePurchases('alice');
  await lib.openManageSubscription();
  expect(revenueCat.Purchases.showManageSubscriptions).toHaveBeenCalledTimes(1);
  expect(opened).toEqual([]);
});

it('"Manage subscription" opens Apple\'s page when the sheet can\'t open, and never throws', async () => {
  const { lib, revenueCat, opened } = loadPlus();
  await lib.configurePurchases('alice');
  revenueCat.Purchases.showManageSubscriptions.mockRejectedValueOnce(new Error('No active window scene'));
  await expect(lib.openManageSubscription()).resolves.toBeUndefined();
  expect(opened).toEqual(['https://apps.apple.com/account/subscriptions']);

  // RevenueCat isn't set up (no one has logged in yet): Apple's page too.
  const fresh = loadPlus();
  await expect(fresh.lib.openManageSubscription()).resolves.toBeUndefined();
  expect(fresh.opened).toEqual(['https://apps.apple.com/account/subscriptions']);
});

it('asking the server again turns server Plus on, and screens asking at the same time share one question', async () => {
  const { lib, server } = loadPlus();
  await lib.configurePurchases('alice');
  await settle();
  expect(lib.useServerPlus()).toBe(false);
  const before = server.reads.length;
  server.rows.set('alice', SOON); // the webhook arrives
  await Promise.all([lib.refreshServerPlus(), lib.refreshServerPlus(), lib.refreshServerPlus()]);
  expect(server.reads.length - before).toBe(1);
  expect(lib.useServerPlus()).toBe(true);
  expect(lib.hasPlus('alice')).toBe(true);
  // Later questions are asked again (not the old answer).
  await lib.refreshServerPlus();
  expect(server.reads.length - before).toBe(2);
});

it('asking the server again does nothing when nobody is logged in', async () => {
  const { lib, server } = loadPlus();
  await expect(lib.refreshServerPlus()).resolves.toBeUndefined();
  expect(server.reads).toEqual([]);
});
