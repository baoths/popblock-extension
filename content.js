// PopBlock - Content Script
// Injected at document_start into every frame

(function () {
  'use strict';

  let enabled = true;
  let allowlist = [];
  let siteAllowed = false;

  // ─── Shared constants ────────────────────────────────────────────────────────
  // Declared ONCE here — used by window.open guard and location guard below.
  const AD_DOMAIN_RE = /\b(doubleclick\.net|googlesyndication\.com|adnxs\.com|rubiconproject\.com|openx\.net|pubmatic\.com|casalemedia\.com|criteo\.com|taboola\.com|outbrain\.com|zedo\.com|adform\.net|trafficjunky\.net|exoclick\.com|propellerads\.com|adsterra\.com|popcash\.net|popads\.net|yllix\.com|exo\.click)\b/i;

  // ─── 1. Gesture tracking ─────────────────────────────────────────────────────
  // Single set of listeners — does two things at once:
  //   a) updates lastGestureAt  (used by window.open guard below)
  //   b) sends USER_GESTURE msg (used by background tab-creation guard)
  //
  // Three gesture types matter:
  //   click       → left-click on a link
  //   auxclick    → middle-click on a link  (opens new tab natively)
  //   contextmenu → right-click; user then picks "Open in new tab" from menu
  //                 background uses an 8s timeout for this one
  const GESTURE_WINDOW_MS = {
    click: 1500,
    auxclick: 1500,
    contextmenu: 8000,
    default: 2000,
  };

  let lastGesture = { at: 0, type: 'click' };

  function onGesture(type) {
    lastGesture = { at: Date.now(), type };
    chrome.runtime.sendMessage({ type: 'USER_GESTURE', gestureType: type });
  }

  document.addEventListener('click',       () => onGesture('click'),       true);
  document.addEventListener('auxclick',    () => onGesture('auxclick'),     true);
  document.addEventListener('contextmenu', () => onGesture('contextmenu'),  true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') onGesture('click');
  }, true);

  // ─── 2. window.open guard ────────────────────────────────────────────────────
  // Allow:  _self/_parent/_top (same-tab), gesture + legit URL (OAuth, PayPal...)
  // Block:  ad domain URLs, script-triggered popups with no gesture
  const _originalOpen = window.open.bind(window);
  window.open = function (url, target, features) {
    if (!enabled) return _originalOpen(url, target, features);

    if (target === '_self' || target === '_parent' || target === '_top') {
      return _originalOpen(url, target, features);
    }

    if (url && AD_DOMAIN_RE.test(url)) {
      console.debug('[PopBlock] Blocked ad window.open →', url);
      chrome.runtime.sendMessage({ type: 'BLOCK_EVENT', category: 'popups' });
      return null;
    }

    const allowEntry = findAllowEntryForHost(location.hostname || '');
    const targetHost = getHostnameFromUrl(url);
    const allowSameSite = allowEntry && (!targetHost || isHostCoveredByEntry(targetHost, allowEntry));
    if (allowSameSite) return _originalOpen(url, target, features);

    const timeout = GESTURE_WINDOW_MS[lastGesture.type] ?? GESTURE_WINDOW_MS.default;
    const hasGesture = (Date.now() - lastGesture.at) < timeout;
    if (hasGesture) return _originalOpen(url, target, features);

    console.debug('[PopBlock] Blocked script window.open →', url);
    chrome.runtime.sendMessage({ type: 'BLOCK_EVENT', category: 'popups' });
    return null;
  };

  // ─── 3. location.assign / location.replace guard ─────────────────────────────
  // Only intercept navigations to known ad domains.
  // Wrapped in try-catch — some pages (sandboxed iframes, etc.) throw on override.
  try {
    const _origAssign  = location.assign.bind(location);
    const _origReplace = location.replace.bind(location);

    location.assign = function (url) {
      if (shouldBlock() && url && AD_DOMAIN_RE.test(url)) {
        console.debug('[PopBlock] Blocked location.assign →', url);
        chrome.runtime.sendMessage({ type: 'BLOCK_EVENT', category: 'redirects' });
        return;
      }
      return _origAssign(url);
    };

    location.replace = function (url) {
      if (shouldBlock() && url && AD_DOMAIN_RE.test(url)) {
        console.debug('[PopBlock] Blocked location.replace →', url);
        chrome.runtime.sendMessage({ type: 'BLOCK_EVENT', category: 'redirects' });
        return;
      }
      return _origReplace(url);
    };
  } catch (_) {
    // Sandboxed or cross-origin frames — skip silently
  }

  // ─── 4. DOM mutation observer — injected overlays & meta-refresh ─────────────
  const observer = new MutationObserver((mutations) => {
    if (!shouldBlock()) return;
    let needsSweep = false;
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) needsSweep = true;
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;

        if (isInvisibleOverlay(node)) {
          node.remove();
          chrome.runtime.sendMessage({ type: 'BLOCK_EVENT', category: 'overlays' });
          continue;
        }

        if (node.tagName === 'META' &&
            node.httpEquiv &&
            node.httpEquiv.toLowerCase() === 'refresh') {
          node.remove();
          chrome.runtime.sendMessage({ type: 'BLOCK_EVENT', category: 'redirects' });
        }
      }
    }
    if (needsSweep) scheduleSweep();
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  // ─── 5. DOMContentLoaded — sweep existing meta-refresh & overlay ads ─────────
  document.addEventListener('DOMContentLoaded', () => {
    if (!shouldBlock()) return;
    document.querySelectorAll('meta[http-equiv="refresh"]').forEach(el => {
      el.remove();
      chrome.runtime.sendMessage({ type: 'BLOCK_EVENT', category: 'redirects' });
    });
    removeOverlayAds();
  });

  // ─── 6. Debounced overlay sweeper ────────────────────────────────────────────
  let sweepScheduled = false;
  let lastSweepAt = 0;
  const SWEEP_COOLDOWN_MS = 1500;

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  function isInvisibleOverlay(el) {
    if (!el.style) return false;
    const s = el.style;
    const isFixed       = s.position === 'fixed' || s.position === 'absolute';
    const isFullScreen  = (s.width === '100%' || s.width === '100vw') &&
                          (s.height === '100%' || s.height === '100vh');
    const isTransparent = s.opacity === '0' || s.background === 'transparent';
    const isHighZ       = parseInt(s.zIndex) > 9000;

    if (isFixed && isFullScreen && (isTransparent || isHighZ) && el.tagName === 'A') return true;
    if (el.tagName === 'IFRAME' && isFixed && isFullScreen) return true;
    return false;
  }

  const OVERLAY_SELECTORS = [
    '[id*="pop-ad"]', '[id*="popup-ad"]', '[id*="popunder"]',
    '[class*="pop-ad"]', '[class*="popup-ad"]', '[class*="popunder"]',
    '[id*="modal-ad"]', '[class*="modal-ad"]',
    '[id*="interstitial"]', '[class*="interstitial"]',
    'div[style*="z-index: 99999"][style*="position: fixed"]',
    'div[style*="z-index:99999"][style*="position:fixed"]',
    '#ad-overlay', '#adOverlay', '.ad-overlay', '.adOverlay',
    '#overlay-ad', '.overlay-ad'
  ];

  function removeOverlayAds() {
    if (!shouldBlock()) return;
    let removed = 0;
    for (const sel of OVERLAY_SELECTORS) {
      try {
        document.querySelectorAll(sel).forEach(el => { el.remove(); removed++; });
      } catch (_) {}
    }
    if (removed > 0) {
      chrome.runtime.sendMessage({ type: 'BLOCK_EVENT', category: 'overlays' });
    }
  }

  function scheduleSweep() {
    if (sweepScheduled) return;
    sweepScheduled = true;
    const now = Date.now();
    const delay = Math.max(0, SWEEP_COOLDOWN_MS - (now - lastSweepAt));
    setTimeout(() => {
      sweepScheduled = false;
      if (!shouldBlock()) return;
      lastSweepAt = Date.now();
      removeOverlayAds();
    }, delay);
  }

  // ─── Enable/disable sync ──────────────────────────────────────────────────────
  chrome.storage.local.get(['enabled', 'allowlist'], (data) => {
    if (data.enabled !== undefined) enabled = data.enabled;
    if (Array.isArray(data.allowlist)) allowlist = data.allowlist;
    updateSiteAllowed();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.enabled) enabled = changes.enabled.newValue;
    if (changes.allowlist) allowlist = changes.allowlist.newValue || [];
    updateSiteAllowed();
    if (shouldBlock()) scheduleSweep();
  });

  function updateSiteAllowed() {
    siteAllowed = isHostnameAllowed(location.hostname || '');
  }

  function shouldBlock() {
    return enabled && !siteAllowed;
  }

  function isHostnameAllowed(hostname) {
    return !!findAllowEntryForHost(hostname);
  }

  function findAllowEntryForHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (!host) return '';
    let match = '';
    for (const entry of allowlist) {
      const allowed = String(entry || '').toLowerCase();
      if (!allowed) continue;
      if (host === allowed || host.endsWith(`.${allowed}`)) {
        if (allowed.length > match.length) match = allowed;
      }
    }
    return match;
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

})();
