# RFD2 Quality Metrics Bridge

Tampermonkey userscript + local Node server that scrapes three quality data sources
and aggregates them into a single dashboard.

## Sources

| Source | URL | Data |
|--------|-----|------|
| **Piles** | ont-base.corp.amazon.com/RFD2/icqa/piles | Pile counts, aging, table |
| **EPP Compliance** | QuickSight `0243f5c0-...` | Compliance %, breakdown |
| **PPA Compliance** | QuickSight `839b4877-...` | Compliance % (shift-aware: FH/BH) |

## Setup

### 1. Start the server
```bash
cd C:\Users\jonavroa\Desktop\Quality
node server.js
```
Server runs at `http://127.0.0.1:4800`.

### 2. Install the userscript
1. Open Tampermonkey in Edge
2. Create new script (or import `quality-bridge.user.js`)
3. Paste the contents of `quality-bridge.user.js`
4. **Ctrl+S** to save

### 3. Open the source pages
Open each of these in a tab (the script auto-detects which page it's on):
- https://ont-base.corp.amazon.com/RFD2/icqa/piles?locale=en
- https://us-east-1.quicksight.aws.amazon.com/sn/account/amazonbi/dashboards/0243f5c0-7de1-4ee2-ba5e-de2948e0802f/sheets/0243f5c0-7de1-4ee2-ba5e-de2948e0802f_03cfd49c-877f-405e-ae54-5aae61ccfe2d?sso_login=true
- https://us-east-1.quicksight.aws.amazon.com/sn/account/amazonbi/dashboards/839b4877-6557-4e6b-a9d5-d3df4e36ff9f

You'll see an orange "Quality Bridge: XXX" badge in the bottom-right of each page.

### 4. View aggregated data
- **Dashboard UI**: http://127.0.0.1:4800/
- **Raw JSON**: http://127.0.0.1:4800/quality-data
- **Text report**: http://127.0.0.1:4800/quality-report

## Shift Logic (PPA)

PPA Compliance is shift-dependent:
- **Front Half (FH)**: Sun night, Mon night, Tue night, Wed night (start)
- **Back Half (BH)**: Wed night (end), Thu night, Fri night, Sat night

The script auto-detects the current shift based on Central Time.
Night shift = 19:00–06:30 CT. If it's before 06:30, the shift "day" is the
previous calendar day.

## Tuning

The QuickSight scraper uses generic selectors since QS DOM is dynamic.
After first run, check `http://127.0.0.1:4800/quality-data` — if the data
is incomplete, open DevTools on the QS page and look for:
- Table cells: `[role="gridcell"]`, `[role="cell"]`
- KPI values: elements with large font-size containing percentages
- Visual titles: text in header areas of each chart/table block

Then update the selectors in the userscript accordingly.

## Files

```
Quality/
├── quality-bridge.user.js   — Tampermonkey userscript (install this)
├── server.js                — Local Node aggregation server
├── quality-log/             — Daily JSONL logs (auto-created)
└── README.md                — This file
```

## Environment Variables

| Var | Default | Purpose |
|-----|---------|---------|
| `QUALITY_PORT` | `4800` | Server port |

## FHNs Quality page integration

`fhns-quality.html` (repo root) plugs into this bridge — no userscript changes needed:

- **Live Bridge tab** polls `http://127.0.0.1:4800/quality-data` every 15s and shows
  the latest Piles / EPP / PPA scrape with online/offline status per source.
- **By Day tab → "Pull piles into slot"** grabs the latest piles scrape and fills the
  chosen shift column (SOS / 2nd / 3rd / 4th / EOS) for the selected date. Area names
  are fuzzy-matched (e.g. scraped "Amnesty" fills "Amnesty Pallets"); unmatched areas
  are listed so you can add them with "+ Add area".

Two ways to open the page:

1. **Directly as a file** — double-click `fhns-quality.html`. Works because the server
   sends `Access-Control-Allow-Origin: *` on `/quality-data`.
2. **From the server** — copy `fhns-quality.html` next to `server.js` and browse to
   `http://127.0.0.1:4800/fhns` (route added in this version of server.js).

If the server runs on a different port, change the Server URL on the Live Bridge tab
(it's remembered in the browser).
