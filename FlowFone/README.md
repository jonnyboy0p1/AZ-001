# FlowFone — Dockflow → Google Sheets live feed

Pulls **Dock Door · Utilization · Recirc · Cause** from the Dockflow page and
pushes it to a Google Sheet **every 1 minute**, so the sheet always shows live
data (no manual refresh needed by viewers).

```
Dockflow page (your browser, your Midway session)
        │  Tampermonkey scrapes the table every 60s
        ▼
Google Apps Script Web App (tied to your sheet)
        │  writes instantly
        ▼
Google Sheet
   ├─ Live  → current snapshot, one row per door, color-coded by recirc
   └─ Log   → append-only history (handoff data log / trends)
```

## Setup (one time, ~5 minutes)

### 1. Google Sheet + Apps Script

1. Create a new Google Sheet (e.g. **"FlowFone"**).
2. **Extensions → Apps Script**, delete the placeholder code, paste in
   [`google-apps-script.gs`](google-apps-script.gs).
3. Change `SHARED_SECRET` at the top to any random string you like.
4. **Deploy → New deployment → Web app**:
   - *Execute as:* **Me**
   - *Who has access:* **Anyone**  (the shared secret gates writes)
5. Click **Deploy**, authorize it, and **copy the Web App URL** (ends in `/exec`).

### 2. Tampermonkey

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Create a new script and paste in
   [`flowfone.user.js`](flowfone.user.js).
3. Edit two things in the script:
   - The `@match` lines at the top → set to your actual Dockflow URL
     (copy it from your address bar, keep a `/*` on the end).
   - `SHARED_SECRET` → the same string you set in the Apps Script.
4. Save, then open Dockflow. You'll see a small **"FlowFone"** badge in the
   bottom-right corner.
5. Click the Tampermonkey icon → **Set Sheets Web App URL** → paste the `/exec`
   URL from step 1.5.

That's it. The badge turns green and shows `N doors pushed · <time>` after each
successful push.

## How freshness works

- The userscript scrapes and pushes every **60 seconds** (`PUSH_INTERVAL_MS`).
- If Dockflow doesn't live-update its own page, the script also hard-reloads
  the tab every **10 minutes** (`RELOAD_EVERY_MS`) so the scraped numbers can't
  go stale. Set it to `0` to disable.
- Google Sheets shows pushed data to viewers within ~1 second — people watching
  the sheet never need to refresh.
- The Dockflow tab must stay **open** on a logged-in machine (a wall monitor or
  a pinned tab works well). The browser can be minimized, but Chrome throttles
  background tabs less if the tab is in its own window.

## Live tab color coding

Rows are colored by recirc severity (thresholds at the top of the Apps Script —
tune them to your building):

| Recirc | Color |
| ------ | ------ |
| ≥ 120  | 🔴 Red |
| ≥ 90   | 🟡 Yellow |
| ≥ 70   | 🟠 Orange |
| < 70   | 🟢 Green |

## Troubleshooting

| Badge says | Fix |
| ---------- | --- |
| `no endpoint` | Tampermonkey menu → Set Sheets Web App URL |
| `no data table found` | The page layout differs — adjust `COLUMN_PATTERNS` in the userscript to match Dockflow's column headers (right-click a header → Inspect to see the text). |
| `push failed (HTTP 401/403)` | Re-deploy the Apps Script ("Anyone" access) or check the secrets match. |
| Badge never appears | The `@match` lines don't match your Dockflow URL — fix them in the Tampermonkey editor. |

Use **Tampermonkey menu → Push to Sheets now** to test instantly; the scraped
payload is also logged to the browser console (F12).

> **Note:** this sends operational data to a Google account outside the
> corporate network. Make sure that's OK under your site's data handling
> policies before pointing it at a personal sheet.
