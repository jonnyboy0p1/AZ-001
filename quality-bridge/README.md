# RFD2 Quality Metrics Bridge

Tampermonkey userscript + local Node server that scrapes three quality data sources
and aggregates them into a single dashboard.

## Sources

| Source | URL | Data |
|--------|-----|------|
| **Piles** | ont-base.corp.amazon.com/RFD2/icqa/piles | Pile counts, aging, table |
| **EPP Compliance** | QuickSight `0243f5c0-...` | Compliance %, breakdown |
| **PPA Compliance** | QuickSight `839b4877-...` | Compliance % (shift-aware: FH/BH) |

## Your setup (RFD2 nights)

Everything lives in `C:\Users\jonavroa\Desktop\Quality`:

```
Quality/
+-- server.js             - bridge server (node server.js)
+-- fhnsquality.html      - FHNs Quality page (tabs, By Day tracker, Live Bridge)
+-- start-quality.bat     - double-click: starts the server + opens the page
+-- quality-log/          - daily JSONL history (auto-created)
```

Start of shift: double-click `start-quality.bat` (or `node server.js`, then open
`http://127.0.0.1:4800/fhns#byday` - opening `fhnsquality.html` directly also works).
Keep the ont-base report + QuickSight tabs open with Tampermonkey running.

The By Day date defaults to the **shift day** (Central Time): before 7:00 AM it
still counts as the previous day, same rule the userscript uses for FH/BH.
Pulling piles from the bridge auto-adds any Area Breakdown areas the tracker
doesn't have yet, so the area list tailors itself to the building.

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

## Piles report scraper (v2)

For the audit report page
(`/RFD2/icqa/piles/report?audit_date=...&audit_number=...&audit_shift=...`)
the userscript uses a dedicated parser instead of the generic one:

- Expands rowspan/colspan merged cells, then reads the **Area Breakdown**
  tables via their `Physical Area` / `Physical Location` / `Total` /
  `Adjusted Total` headers.
- Prefers an area's subtotal row when present; otherwise sums its location
  rows (so nothing is double-counted).
- Reads the page's own "Piles Total" / "Adjusted Total" and cross-checks the
  per-area sum against it. The badge shows `PILES ✓ 5625` when they match and
  a red `⚠ sum X ≠ Y` when they don't; the mismatch flag also travels in the
  payload (`sumMatchesReported`) and is surfaced in fhns-quality.html.
- Payload gains `areaTotals` / `areaAdjusted` maps, `areaRows` detail,
  `departmentOverview`, audit params from the URL, and per-table `diagnostics`
  (detected headers and column indexes) for troubleshooting.

The "Pull piles into slot" button in fhns-quality.html uses `areaTotals`
(adjusted value preferred) when present, and only falls back to the old
generic `tableRows` heuristics for non-report pages.

## Two nightly counts (#1 and #2)

RFD2 runs more than one piles audit per shift. Each `/piles/report` scrape
carries its audit identity (`auditDate` / `auditShift` / `auditNumber`), and:

- **server.js** keeps every distinct count in `store.pilesCounts`, keyed by
  `date|shift|number`, so count #2 no longer overwrites count #1. `/quality-data`
  exposes both (plus `piles` = most-recent, for back-compat).
- The **landing-page watcher** in the userscript fetches every completed count
  and posts each one, so both counts land on the bridge on their own.
- The dashboard's **By Day** tab has a **Count** selector (Audit #1 / #2 / Latest)
  next to the slot picker. "Pull piles into slot" fills the chosen slot from the
  chosen count's exact Area Breakdown totals — so pulling is always accurate and
  the placed total matches that count's page total. Typical use: pull Audit #1
  into SOS, pull Audit #2 into 2nd, etc.
- **Accurate matching:** report areas map to rows by exact name first, then by an
  *unambiguous* substring (only when exactly one existing row is involved), so a
  value can never be mis-assigned. With "Auto-add areas from report" on, any new
  area (e.g. a renamed location) is added as its own row automatically.

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
