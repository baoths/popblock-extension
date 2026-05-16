// PopBlock - Background Service Worker

let stats = { popups: 0, redirects: 0, overlays: 0, ads: 0 };
let enabled = true;
let allowlist = [];

chrome.storage.local.get(['stats', 'enabled', 'allowlist'], (data) => {
  if (data.stats) stats = data.stats;
  if (data.enabled !== undefined) enabled = data.enabled;
  if (Array.isArray(data.allowlist)) allowlist = data.allowlist;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes.enabled) enabled = changes.enabled.newValue;
  if (changes.allowlist) allowlist = changes.allowlist.newValue || [];
});

// ─── Gesture Tracker ─────────────────────────────────────────────────────────
// Different input methods need different timeouts:
//   click       → 1500ms  (immediate, fast)
//   auxclick    → 1500ms  (middle-click, also fast)
//   contextmenu → 8000ms  (right-click: user still has to navigate the menu)
const GESTURE_TIMEOUT = {
  click:       1500,
  auxclick:    1500,
  contextmenu: 8000,
};

const AD_DOMAIN_RE = /\b(doubleclick\.net|googlesyndication\.com|adnxs\.com|rubiconproject\.com|openx\.net|pubmatic\.com|casalemedia\.com|criteo\.com|taboola\.com|outbrain\.com|zedo\.com|adform\.net|trafficjunky\.net|exoclick\.com|propellerads\.com|adsterra\.com|popcash\.net|popads\.net|yllix\.com|exo\.click)\b/i;

const GESTURE_SESSION_PREFIX = 'gesture:';

const gestures = new Map(); // tabId → { expiresAt, type }

function recordGesture(tabId, type) {
  const timeout = GESTURE_TIMEOUT[type] ?? 1500;
  const entry = { expiresAt: Date.now() + timeout, type };
  gestures.set(tabId, entry);
  // Persist only contextmenu gestures so they survive service worker restarts.
  if (type === 'contextmenu') persistGesture(tabId, entry);
}

function consumeGestureSync(tabId) {
  const entry = gestures.get(tabId);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    gestures.delete(tabId);
    clearPersistedGesture(tabId);
    return false;
  }
  gestures.delete(tabId);
  clearPersistedGesture(tabId);
  return true;
}

function persistGesture(tabId, entry) {
  if (!chrome.storage?.session) return;
  const key = `${GESTURE_SESSION_PREFIX}${tabId}`;
  chrome.storage.session.set({ [key]: entry });
}

function clearPersistedGesture(tabId) {
  if (!chrome.storage?.session) return;
  const key = `${GESTURE_SESSION_PREFIX}${tabId}`;
  chrome.storage.session.remove(key);
}

function consumePersistedGesture(tabId, callback) {
  if (!chrome.storage?.session) return callback(false);
  const key = `${GESTURE_SESSION_PREFIX}${tabId}`;
  chrome.storage.session.get(key, (data) => {
    const entry = data?.[key];
    if (!entry) return callback(false);
    if (Date.now() > entry.expiresAt) {
      chrome.storage.session.remove(key);
      return callback(false);
    }
    chrome.storage.session.remove(key);
    return callback(true);
  });
}

// ─── Tab creation guard ───────────────────────────────────────────────────────
chrome.tabs.onCreated.addListener((tab) => {
  if (!enabled) return;
  if (!tab.openerTabId) return; // Ctrl+T / bookmarks / address bar — never block

  const url = tab.pendingUrl || tab.url || '';

  // Always block known ad domains
  if (url && AD_DOMAIN_RE.test(url)) {
    chrome.tabs.remove(tab.id, () => { chrome.runtime.lastError; });
    recordBlock('redirects');
    return;
  }

  isOpenerAllowed(tab.openerTabId, (isAllowed) => {
    if (isAllowed) return;

    // Block if no valid gesture from the opener tab
    if (consumeGestureSync(tab.openerTabId)) return;

    // Fallback: service worker may have restarted between contextmenu and tab create.
    consumePersistedGesture(tab.openerTabId, (hasGesture) => {
      if (hasGesture) return;
      chrome.tabs.remove(tab.id, () => { chrome.runtime.lastError; });
      recordBlock('redirects');
    });
  });
});

// ─── Message handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'USER_GESTURE') {
    // Content script reports a user input event with its type
    // (click, auxclick, contextmenu)
    if (sender.tab?.id) {
      recordGesture(sender.tab.id, msg.gestureType || 'click');
    }
  }

  if (msg.type === 'BLOCK_EVENT') {
    recordBlock(msg.category);
  }

  if (msg.type === 'GET_STATS') {
    sendResponse({ stats, enabled });
  }

  if (msg.type === 'SET_ENABLED') {
    enabled = msg.value;
    chrome.storage.local.set({ enabled });
    sendResponse({ ok: true });
  }

  if (msg.type === 'CLEAR_STATS') {
    stats = { popups: 0, redirects: 0, overlays: 0, ads: 0 };
    chrome.storage.local.set({ stats });
    sendResponse({ ok: true });
  }

  return true;
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function recordBlock(category) {
  if (stats[category] === undefined) stats[category] = 0;
  stats[category]++;
  chrome.storage.local.set({ stats });

  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  chrome.action.setBadgeText({ text: total > 999 ? '999+' : String(total) });
  chrome.action.setBadgeBackgroundColor({ color: '#e63946' });
}

function isOpenerAllowed(openerTabId, callback) {
  chrome.tabs.get(openerTabId, (openerTab) => {
    if (chrome.runtime.lastError) return callback(false);
    const hostname = getHostname(openerTab?.url || openerTab?.pendingUrl || '');
    return callback(isHostnameAllowed(hostname));
  });
}

function getHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (_) {
    return '';
  }
}

function isHostnameAllowed(hostname) {
  if (!hostname) return false;
  return allowlist.some((entry) => {
    const allowed = String(entry || '').toLowerCase();
    return allowed && (hostname === allowed || hostname.endsWith(`.${allowed}`));
  });
}
