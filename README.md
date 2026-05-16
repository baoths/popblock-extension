# PopBlock

Lightweight MV3 browser extension that blocks popup ads, tab hijacks, overlay ads, and redirect traps while keeping user-initiated navigation intact.

## Features

- Blocks script-driven popups and suspicious new tabs.
- Tracks user gestures so legitimate new tabs are allowed.
- Uses declarative net request rules to block known ad domains.
- Removes overlay ads and meta refresh redirects.
- Per-site pause toggle (allowlist) in the popup.
- Simple stats + badge counter.

## Install (Chrome / Chromium)

1. Download or clone this repo to your machine.
2. Open chrome://extensions (Edge: edge://extensions).
3. Turn on Developer mode (top-right toggle).
4. Click "Load unpacked".
5. Select the folder that contains manifest.json (the root of this project).
	- Do not select a parent folder.
	- Do not select a subfolder like icons/ or tests/.
6. The PopBlock card should appear in the extensions list.
7. If you update files later, click the refresh icon on the PopBlock card to reload it.

## Usage

- Use the main toggle to enable/disable the extension.
- Use "Pause on this site" to allow behavior on the current hostname.
- Stats update in the popup; the badge shows total blocks.

Note: Pausing a site relaxes on-page blockers for that site, but cross-site popups without a user gesture are still blocked. The declarative net request rules still block known ad domains.

## Tests

Run the background logic tests with Node:

```
node tests/background.test.js
```

## Project Structure

- background.js: tab creation guard, stats, gesture tracking.
- content.js: window.open guard, overlay and redirect blocking.
- rules.json: declarative net request rules.
- popup.html / popup.js: popup UI and controls.
- icons/: extension icons.

## Privacy

All settings and stats are stored locally using chrome.storage. No data is sent anywhere.


