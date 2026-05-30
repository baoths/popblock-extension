// tests/background.test.js
// Run with: node tests/background.test.js

// ─── Minimal test framework ───────────────────────────────────────────────────
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    → ${e.message}`); failed++; }
}
function expect(val) {
  return {
    toBe: (expected) => { if (val !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(val)}`); },
    toBeTrue: () => { if (val !== true) throw new Error(`Expected true, got ${JSON.stringify(val)}`); },
    toBeFalse: () => { if (val !== false) throw new Error(`Expected false, got ${JSON.stringify(val)}`); },
  };
}
function group(name, fn) { console.log(`\n${name}`); fn(); }

// ─── Inline implementation of the gesture tracker (mirrors background.js) ────
const GESTURE_TIMEOUT = {
  click:        1500,
  auxclick:     1500,
  contextmenu:  8000,   // humans are slow with context menus
};

const AD_DOMAIN_RE = /\b(doubleclick\.net|googlesyndication\.com|adnxs\.com|rubiconproject\.com|openx\.net|pubmatic\.com|casalemedia\.com|criteo\.com|taboola\.com|outbrain\.com|zedo\.com|adform\.net|trafficjunky\.net|exoclick\.com|propellerads\.com|adsterra\.com|popcash\.net|popads\.net|yllix\.com|exo\.click)\b/i;

const GESTURE_WINDOW_MS = {
  click: 1500,
  auxclick: 1500,
  contextmenu: 8000,
  default: 2000,
};

class GestureTracker {
  constructor(clock = Date) {
    this._gestures = new Map(); // tabId → { expiresAt }
    this._clock = clock;
  }

  record(tabId, gestureType) {
    const timeout = GESTURE_TIMEOUT[gestureType] ?? 1500;
    this._gestures.set(tabId, {
      expiresAt: this._clock.now() + timeout,
      type: gestureType,
    });
  }

  consume(tabId) {
    const entry = this._gestures.get(tabId);
    if (!entry) return false;
    if (this._clock.now() > entry.expiresAt) {
      this._gestures.delete(tabId);
      return false;
    }
    this._gestures.delete(tabId);
    return true;
  }

  hasValid(tabId) {
    const entry = this._gestures.get(tabId);
    if (!entry) return false;
    if (this._clock.now() > entry.expiresAt) {
      this._gestures.delete(tabId);
      return false;
    }
    return true;
  }
}

function shouldBlockTab({ url, openerTabId, gestureTracker, enabled, allowEntry, hasPersistedGesture }) {
  if (!enabled) return false;
  if (!openerTabId) return false; // Ctrl+T, bookmarks, address bar — never block

  // Always block known ad domains regardless of gesture
  if (url && AD_DOMAIN_RE.test(url)) return true;

  const targetHost = getHostnameFromUrl(url);
  const allowSameSite = allowEntry && (!targetHost || isHostCoveredByEntry(targetHost, allowEntry));
  if (allowSameSite) return false;

  // Block if no valid gesture from opener tab
  if (gestureTracker.consume(openerTabId)) return false;
  if (hasPersistedGesture) return false;
  return true;
}

function isHostnameAllowed(hostname, allowlist) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  return (allowlist || []).some((entry) => {
    const allowed = String(entry || '').toLowerCase();
    return allowed && (host === allowed || host.endsWith(`.${allowed}`));
  });
}

function isHostCoveredByEntry(hostname, entry) {
  const host = String(hostname || '').toLowerCase();
  const allowed = String(entry || '').toLowerCase();
  if (!host || !allowed) return false;
  return host === allowed || host.endsWith(`.${allowed}`);
}

function getHostnameFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (_) {
    return '';
  }
}

function createFakeTimer() {
  let tasks = [];
  let nextId = 1;
  return {
    setTimeout: (fn, _ms) => {
      const id = nextId++;
      tasks.push({ id, fn });
      return id;
    },
    clearTimeout: (id) => {
      tasks = tasks.filter((task) => task.id !== id);
    },
    runAll: () => {
      const toRun = tasks;
      tasks = [];
      toRun.forEach((task) => task.fn());
    },
    pendingCount: () => tasks.length,
  };
}

function createAdsBatcher({ flushMs = 1000, setTimeoutImpl, clearTimeoutImpl, recordCount }) {
  let pendingAds = 0;
  let timer = null;

  function queueAdsBlock() {
    pendingAds += 1;
    if (timer) return;
    timer = setTimeoutImpl(() => {
      const count = pendingAds;
      pendingAds = 0;
      timer = null;
      if (count > 0) recordCount(count);
    }, flushMs);
  }

  function reset() {
    pendingAds = 0;
    if (timer) {
      clearTimeoutImpl(timer);
      timer = null;
    }
  }

  return { queueAdsBlock, reset };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

group('GestureTracker — click', () => {
  test('records a click gesture', () => {
    const t = new GestureTracker();
    t.record(1, 'click');
    expect(t.hasValid(1)).toBeTrue();
  });

  test('consume() removes the gesture after use', () => {
    const t = new GestureTracker();
    t.record(1, 'click');
    t.consume(1);
    expect(t.hasValid(1)).toBeFalse();
  });

  test('click gesture expires after 1500ms', () => {
    let now = 0;
    const clock = { now: () => now };
    const t = new GestureTracker(clock);
    t.record(1, 'click');
    now = 1501;
    expect(t.hasValid(1)).toBeFalse();
  });

  test('click gesture still valid at 1499ms', () => {
    let now = 0;
    const clock = { now: () => now };
    const t = new GestureTracker(clock);
    t.record(1, 'click');
    now = 1499;
    expect(t.hasValid(1)).toBeTrue();
  });
});

group('GestureTracker — contextmenu (right-click)', () => {
  test('contextmenu gesture lasts 8000ms (user navigates menu slowly)', () => {
    let now = 0;
    const clock = { now: () => now };
    const t = new GestureTracker(clock);
    t.record(1, 'contextmenu');
    now = 7999;
    expect(t.hasValid(1)).toBeTrue();
  });

  test('contextmenu gesture expires after 8000ms', () => {
    let now = 0;
    const clock = { now: () => now };
    const t = new GestureTracker(clock);
    t.record(1, 'contextmenu');
    now = 8001;
    expect(t.hasValid(1)).toBeFalse();
  });

  test('contextmenu at 1600ms still valid (would fail with old 1500ms timeout)', () => {
    let now = 0;
    const clock = { now: () => now };
    const t = new GestureTracker(clock);
    t.record(1, 'contextmenu');
    now = 1600; // old code would have expired this — new code keeps it alive
    expect(t.hasValid(1)).toBeTrue();
  });
});

group('GestureTracker — auxclick (middle-click)', () => {
  test('middle-click records a gesture', () => {
    const t = new GestureTracker();
    t.record(1, 'auxclick');
    expect(t.hasValid(1)).toBeTrue();
  });

  test('middle-click without gesture tracker entry → no gesture', () => {
    const t = new GestureTracker();
    expect(t.hasValid(99)).toBeFalse();
  });
});

group('shouldBlockTab — allow cases', () => {
  test('allow: no openerTabId (Ctrl+T, bookmarks, address bar)', () => {
    const t = new GestureTracker();
    const block = shouldBlockTab({ url: 'https://example.com', openerTabId: null, gestureTracker: t, enabled: true });
    expect(block).toBeFalse();
  });

  test('allow: left-click on link (click gesture present)', () => {
    const t = new GestureTracker();
    t.record(5, 'click');
    const block = shouldBlockTab({ url: 'https://example.com', openerTabId: 5, gestureTracker: t, enabled: true, allowEntry: '', hasPersistedGesture: false });
    expect(block).toBeFalse();
  });

  test('allow: right-click → open in new tab (contextmenu gesture present)', () => {
    const t = new GestureTracker();
    t.record(5, 'contextmenu');
    const block = shouldBlockTab({ url: 'https://example.com', openerTabId: 5, gestureTracker: t, enabled: true, allowEntry: '', hasPersistedGesture: false });
    expect(block).toBeFalse();
  });

  test('allow: middle-click on link (auxclick gesture present)', () => {
    const t = new GestureTracker();
    t.record(5, 'auxclick');
    const block = shouldBlockTab({ url: 'https://example.com', openerTabId: 5, gestureTracker: t, enabled: true, allowEntry: '', hasPersistedGesture: false });
    expect(block).toBeFalse();
  });

  test('allow: extension is disabled', () => {
    const t = new GestureTracker();
    const block = shouldBlockTab({ url: 'https://ads.com', openerTabId: 5, gestureTracker: t, enabled: false, allowEntry: '', hasPersistedGesture: false });
    expect(block).toBeFalse();
  });

  test('allow: opener is on allowlist for same-site target', () => {
    const t = new GestureTracker();
    const block = shouldBlockTab({ url: 'https://blog.example.com', openerTabId: 5, gestureTracker: t, enabled: true, allowEntry: 'example.com', hasPersistedGesture: false });
    expect(block).toBeFalse();
  });

  test('allow: persisted gesture fallback', () => {
    const t = new GestureTracker();
    const block = shouldBlockTab({ url: 'https://example.com', openerTabId: 5, gestureTracker: t, enabled: true, allowEntry: '', hasPersistedGesture: true });
    expect(block).toBeFalse();
  });

  test('allow: allowlisted opener with unknown target (pending)', () => {
    const t = new GestureTracker();
    const block = shouldBlockTab({ url: '', openerTabId: 5, gestureTracker: t, enabled: true, allowEntry: 'example.com', hasPersistedGesture: false });
    expect(block).toBeFalse();
  });
});

group('shouldBlockTab — block cases', () => {
  test('block: tab opened by script with no user gesture', () => {
    const t = new GestureTracker();
    const block = shouldBlockTab({ url: 'https://example.com', openerTabId: 5, gestureTracker: t, enabled: true, allowEntry: '', hasPersistedGesture: false });
    expect(block).toBeTrue();
  });

  test('block: ad domain URL even with a gesture (safety net)', () => {
    const t = new GestureTracker();
    t.record(5, 'click');
    const block = shouldBlockTab({ url: 'https://doubleclick.net/ad', openerTabId: 5, gestureTracker: t, enabled: true, allowEntry: 'example.com', hasPersistedGesture: true });
    expect(block).toBeTrue();
  });

  test('block: script-opened tab after gesture has expired', () => {
    let now = 0;
    const clock = { now: () => now };
    const t = new GestureTracker(clock);
    t.record(5, 'click');
    now = 2000; // gesture expired
    const block = shouldBlockTab({ url: 'https://example.com', openerTabId: 5, gestureTracker: t, enabled: true, allowEntry: '', hasPersistedGesture: false });
    expect(block).toBeTrue();
  });

  test('block: second tab opened from same gesture (gesture consumed)', () => {
    const t = new GestureTracker();
    t.record(5, 'click');
    shouldBlockTab({ url: 'https://example.com', openerTabId: 5, gestureTracker: t, enabled: true, allowEntry: '', hasPersistedGesture: false }); // first tab OK
    const block = shouldBlockTab({ url: 'https://example.com', openerTabId: 5, gestureTracker: t, enabled: true, allowEntry: '', hasPersistedGesture: false }); // second = block
    expect(block).toBeTrue();
  });

  test('block: allowlisted opener but cross-site with no gesture', () => {
    const t = new GestureTracker();
    const block = shouldBlockTab({ url: 'https://malicious.test', openerTabId: 5, gestureTracker: t, enabled: true, allowEntry: 'example.com', hasPersistedGesture: false });
    expect(block).toBeTrue();
  });
});

group('window.open — allow/block logic', () => {
  // Mirrors the logic in content.js window.open
  function windowOpenShouldBlock({ target, url, lastGesture, now, enabled, allowEntry }) {
    if (!enabled) return false;
    if (target === '_self' || target === '_parent' || target === '_top') return false;
    if (url && AD_DOMAIN_RE.test(url)) return true;
    const targetHost = getHostnameFromUrl(url);
    const allowSameSite = allowEntry && (!targetHost || isHostCoveredByEntry(targetHost, allowEntry));
    if (allowSameSite) return false;
    const timeout = GESTURE_WINDOW_MS[lastGesture.type] ?? GESTURE_WINDOW_MS.default;
    const hasGesture = (now - lastGesture.at) < timeout;
    return !hasGesture;
  }

  test('allow: window.open _self (same tab)', () => {
    expect(windowOpenShouldBlock({ target: '_self', url: 'https://example.com', lastGesture: { at: 0, type: 'click' }, now: 5000, enabled: true, allowEntry: '' })).toBeFalse();
  });

  test('block: window.open to new tab with no user gesture', () => {
    expect(windowOpenShouldBlock({ target: '_blank', url: 'https://example.com', lastGesture: { at: 0, type: 'click' }, now: 3000, enabled: true, allowEntry: '' })).toBeTrue();
  });

  test('allow: window.open to new tab WITH click gesture within 1500ms', () => {
    expect(windowOpenShouldBlock({ target: '_blank', url: 'https://accounts.google.com/oauth', lastGesture: { at: 1000, type: 'click' }, now: 2400, enabled: true, allowEntry: '' })).toBeFalse();
  });

  test('block: window.open to ad domain even with gesture', () => {
    expect(windowOpenShouldBlock({ target: '_blank', url: 'https://doubleclick.net/popup', lastGesture: { at: 1000, type: 'click' }, now: 1400, enabled: true, allowEntry: '' })).toBeTrue();
  });

  test('block: window.open with expired click gesture', () => {
    expect(windowOpenShouldBlock({ target: '_blank', url: 'https://example.com', lastGesture: { at: 0, type: 'click' }, now: 2000, enabled: true, allowEntry: '' })).toBeTrue();
  });

  test('allow: window.open with contextmenu gesture within 8000ms', () => {
    expect(windowOpenShouldBlock({ target: '_blank', url: 'https://example.com', lastGesture: { at: 0, type: 'contextmenu' }, now: 7000, enabled: true, allowEntry: '' })).toBeFalse();
  });

  test('block: window.open with expired contextmenu gesture', () => {
    expect(windowOpenShouldBlock({ target: '_blank', url: 'https://example.com', lastGesture: { at: 0, type: 'contextmenu' }, now: 9000, enabled: true, allowEntry: '' })).toBeTrue();
  });

  test('allow: window.open when site is paused and target is same-site', () => {
    expect(windowOpenShouldBlock({ target: '_blank', url: 'https://shop.example.com', lastGesture: { at: 0, type: 'click' }, now: 5000, enabled: true, allowEntry: 'example.com' })).toBeFalse();
  });

  test('block: window.open when site is paused but target is cross-site (no gesture)', () => {
    expect(windowOpenShouldBlock({ target: '_blank', url: 'https://malicious.test', lastGesture: { at: 0, type: 'click' }, now: 5000, enabled: true, allowEntry: 'example.com' })).toBeTrue();
  });

  test('allow: window.open when extension is disabled', () => {
    expect(windowOpenShouldBlock({ target: '_blank', url: 'https://example.com', lastGesture: { at: 0, type: 'click' }, now: 5000, enabled: false, allowEntry: '' })).toBeFalse();
  });
});

group('DNR batching — ads counter', () => {
  test('batches multiple ad hits into one flush', () => {
    const timer = createFakeTimer();
    const calls = [];
    const batcher = createAdsBatcher({
      flushMs: 1000,
      setTimeoutImpl: timer.setTimeout,
      clearTimeoutImpl: timer.clearTimeout,
      recordCount: (count) => calls.push(count),
    });

    batcher.queueAdsBlock();
    batcher.queueAdsBlock();
    expect(timer.pendingCount()).toBe(1);
    expect(calls.length).toBe(0);

    timer.runAll();
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(2);
  });

  test('reset clears pending batch without recording', () => {
    const timer = createFakeTimer();
    const calls = [];
    const batcher = createAdsBatcher({
      flushMs: 1000,
      setTimeoutImpl: timer.setTimeout,
      clearTimeoutImpl: timer.clearTimeout,
      recordCount: (count) => calls.push(count),
    });

    batcher.queueAdsBlock();
    batcher.reset();
    expect(timer.pendingCount()).toBe(0);

    timer.runAll();
    expect(calls.length).toBe(0);
  });
});

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

// ─── Regression tests ────────────────────────────────────────────────────────
group('Regression — bugs fixed in v1.0.1', () => {
  test('AD_DOMAIN_RE declared exactly once in content.js (no duplicate const)', () => {
    const fs = require('fs');
    const src = fs.readFileSync(__dirname + '/../content.js', 'utf8');
    const declarations = src.match(/\bconst AD_DOMAIN_RE\b/g) || [];
    if (declarations.length !== 1) throw new Error(`Expected 1 declaration, found ${declarations.length}`);
  });

  test('content.js has no duplicate addEventListener for click', () => {
    const fs = require('fs');
    const src = fs.readFileSync(__dirname + '/../content.js', 'utf8');
    const clickListeners = src.match(/addEventListener\('click'/g) || [];
    if (clickListeners.length !== 1) throw new Error(`Expected 1 click listener, found ${clickListeners.length}`);
  });

  test('content.js has no duplicate addEventListener for contextmenu', () => {
    const fs = require('fs');
    const src = fs.readFileSync(__dirname + '/../content.js', 'utf8');
    const listeners = src.match(/addEventListener\('contextmenu'/g) || [];
    if (listeners.length !== 1) throw new Error(`Expected 1 contextmenu listener, found ${listeners.length}`);
  });

  test('manifest.json does not declare unused webNavigation permission', () => {
    const fs = require('fs');
    const manifest = JSON.parse(fs.readFileSync(__dirname + '/../manifest.json', 'utf8'));
    if (manifest.permissions.includes('webNavigation')) {
      throw new Error('webNavigation permission should be removed (unused)');
    }
  });

  test('location overrides are wrapped in try-catch (sandboxed frame safety)', () => {
    const fs = require('fs');
    const src = fs.readFileSync(__dirname + '/../content.js', 'utf8');
    const hasTryCatch = /try\s*\{[\s\S]*location\.assign\s*=/.test(src);
    if (!hasTryCatch) throw new Error('location overrides must be inside try-catch');
  });

  test('manifest.json host permissions are limited to http/https', () => {
    const fs = require('fs');
    const manifest = JSON.parse(fs.readFileSync(__dirname + '/../manifest.json', 'utf8'));
    const hostPerms = manifest.host_permissions || [];
    if (hostPerms.includes('<all_urls>')) {
      throw new Error('host_permissions should not include <all_urls>');
    }
  });
});
