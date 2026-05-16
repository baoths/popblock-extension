// PopBlock - Popup Script

const els = {
  toggle:    document.getElementById('main-toggle'),
  label:     document.getElementById('toggle-label'),
  dot:       document.getElementById('status-dot'),
  statusTxt: document.getElementById('status-text'),
  clearBtn:  document.getElementById('clear-btn'),
  siteRow:   document.getElementById('site-row'),
  siteHost:  document.getElementById('site-host'),
  siteToggle: document.getElementById('site-toggle'),
  popups:    document.getElementById('stat-popups'),
  redirects: document.getElementById('stat-redirects'),
  overlays:  document.getElementById('stat-overlays'),
  ads:       document.getElementById('stat-ads'),
  total:     document.getElementById('stat-total'),
};

let currentHost = '';
let allowlist = [];
let latestEnabled = true;

function updateUI({ stats, enabled }) {
  // Stats
  setNum(els.popups,    stats.popups    || 0);
  setNum(els.redirects, stats.redirects || 0);
  setNum(els.overlays,  stats.overlays  || 0);
  setNum(els.ads,       stats.ads       || 0);

  const total = (stats.popups||0) + (stats.redirects||0) + (stats.overlays||0) + (stats.ads||0);
  setNum(els.total, total);

  // Toggle state
  latestEnabled = enabled;
  els.toggle.checked = enabled;
  els.label.textContent = enabled ? 'ON' : 'OFF';
  els.label.classList.toggle('on', enabled);
  els.dot.classList.toggle('active', enabled);
  els.statusTxt.textContent = enabled ? 'Active' : 'Paused';
  document.body.classList.toggle('disabled', !enabled);

  updateSiteUI();
}

function setNum(el, val) {
  if (el.textContent !== String(val)) {
    el.textContent = val;
    el.classList.remove('bump');
    void el.offsetWidth; // reflow
    el.classList.add('bump');
  }
}

// Load initial state
chrome.runtime.sendMessage({ type: 'GET_STATS' }, (response) => {
  if (response) updateUI(response);
});

chrome.storage.local.get(['allowlist'], (data) => {
  if (Array.isArray(data.allowlist)) allowlist = data.allowlist;
  updateSiteUI();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes.allowlist) {
    allowlist = changes.allowlist.newValue || [];
    updateSiteUI();
  }
});

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs && tabs[0];
  const url = tab?.url || tab?.pendingUrl || '';
  currentHost = getHostname(url);
  updateSiteUI();
});

// Toggle
els.toggle.addEventListener('change', () => {
  const enabled = els.toggle.checked;
  chrome.runtime.sendMessage({ type: 'SET_ENABLED', value: enabled }, () => {
    els.label.textContent = enabled ? 'ON' : 'OFF';
    els.label.classList.toggle('on', enabled);
    els.dot.classList.toggle('active', enabled);
    els.statusTxt.textContent = enabled ? 'Active' : 'Paused';
    document.body.classList.toggle('disabled', !enabled);
  });
});

els.siteToggle.addEventListener('change', () => {
  if (!currentHost) return;
  const shouldPause = els.siteToggle.checked;
  const normalized = currentHost.toLowerCase();
  if (shouldPause) {
    if (!allowlist.some((entry) => String(entry || '').toLowerCase() === normalized)) {
      allowlist = [...allowlist, normalized];
    }
  } else {
    const match = findAllowEntryForHost(currentHost);
    if (match) {
      allowlist = allowlist.filter((entry) => String(entry || '').toLowerCase() !== match);
    }
  }
  chrome.storage.local.set({ allowlist });
});

// Clear stats
els.clearBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_STATS' }, () => {
    updateUI({ stats: { popups: 0, redirects: 0, overlays: 0, ads: 0 }, enabled: els.toggle.checked });
  });
});

// Auto-refresh stats every second while popup is open
setInterval(() => {
  chrome.runtime.sendMessage({ type: 'GET_STATS' }, (response) => {
    if (response) updateUI(response);
  });
}, 1000);

function updateSiteUI() {
  if (!els.siteRow || !els.siteToggle || !els.siteHost) return;
  if (!currentHost) {
    els.siteRow.classList.add('disabled');
    els.siteToggle.disabled = true;
    els.siteToggle.checked = false;
    els.siteHost.textContent = 'Unavailable';
    return;
  }

  els.siteRow.classList.remove('disabled');
  els.siteToggle.disabled = !latestEnabled;
  els.siteHost.textContent = currentHost;
  els.siteToggle.checked = isHostAllowed(currentHost, allowlist);
}

function getHostname(url) {
  try {
    return new URL(url).hostname || '';
  } catch (_) {
    return '';
  }
}

function isHostAllowed(hostname, list) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  return list.some((entry) => {
    const allowed = String(entry || '').toLowerCase();
    return allowed && (host === allowed || host.endsWith(`.${allowed}`));
  });
}

function findAllowEntryForHost(hostname) {
  const host = String(hostname || '').toLowerCase();
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
