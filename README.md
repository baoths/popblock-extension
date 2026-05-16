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

1. Open chrome://extensions.
2. Enable Developer mode.
3. Click "Load unpacked" and select this folder.

## Usage

- Use the main toggle to enable/disable the extension.
- Use "Pause on this site" to allow behavior on the current hostname.
- Stats update in the popup; the badge shows total blocks.

Note: Pausing a site disables the script-based blockers for that site. The declarative net request rules still block known ad domains.

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

## License

Add a LICENSE file if you plan to open-source this project.
