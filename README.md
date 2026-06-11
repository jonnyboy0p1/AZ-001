# AZ-001 — OB Period Report Card (OB02)

Shift planner / report card dashboard for RFD2 OB, with background data pulls
from FCLM and MonitorPortal.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The OB Period Report Card dashboard (copy to `Desktop/OB02/index.html`). |
| `monitor-metrics-bridge.user.js` | Tampermonkey userscript: CORS fetch bridge for the Live Metrics pull. |
| `dashboard.html` / `proxy.py` | Earlier RC Sort / FCLM proxy experiment (kept for reference). |

## Live Metrics — Search API (new)

The old background pull fetched the MonitorPortal **iGraph page** and looked for
the pie-chart labels. That can't work in the background: the page is a
JavaScript app shell — the numbers are drawn client-side and are not in the raw
HTML (confirmed by the Monitor Pull Diagnostic: 65k chars, no labels).

The new pull goes to MonitorPortal's **data endpoint** instead — the same
backend the "Search for Metrics" UI uses — and parses raw series data:

1. `index.html` builds the same Search patterns / time windows it already uses
   for the graph links (FL Utilization MP/FL/RWC, Battle of the Belt East/West;
   per period P1/P2/P3(/MET) plus Full Shift).
2. For each window it tries data-endpoint variants in order, remembering which
   one works:
   - `https://monitorportal.amazon.com/mws?Action=GetGraph&Format=JSON&…`
   - `https://monitorportal.amazon.com/mws?Action=GetGraph&Format=CSV&…`
   - `https://monitorportal.amazon.com/igraph?…&Action=GetGraph&Format=JSON`
3. Responses are parsed in the dashboard (JSON tree-walk or CSV), series are
   matched by label (`TOTAL MP/FL/RWC`, `West/East Side`, with raw-metric
   fallbacks), datapoints are summed into totals.
4. Totals flow into the existing bridge payload (`monitorPeriods` /
   `monitorFull`) so all current panels, manual-override locks, and age chips
   keep working unchanged.
5. Auto pulls are **clock-aligned to the quarter hour** (:00, :15, :30, :45 —
   a few seconds after the mark), plus on the "Pull FL Utilization",
   "Pull Battle of the Belt", "Pull All Sources", and "Pull Live Metrics Now"
   buttons.

### Hourly Pull Tracker (FL Utilization)

Each quarter-hour pull also queries an **hour-aligned FL Utilization window**
(top of the hour → now). Example for the 9 o'clock hour: the 9:15 / 9:30 / 9:45
pulls show the hour-to-date count, and the 10:00 pull queries the full
9:00–10:00 window, locks that hour into the completed-hours table, and the
next hour starts over from zero. If a :00 pull is missed (machine asleep,
browser closed), the next pull backfills the missed hour as a full-hour query
so the history stays accurate.

The tracker panel (under **Goals view → MonitorPortal Windows → Live
Metrics – Search API**) shows:

- **This hour** — the quarter-hour samples so far with MP/FL/RWC breakdown.
- **Completed hours** — per-hour pulled-in totals (MP / FL / RWC / Total), CT.
- **Per period** — P1/P2/P3(/MET)/Full totals from the same pulls plus a
  per-hour run rate (total ÷ elapsed hours in the window).

Status + a per-window diagnostic live in the same panel. If a pull fails, open
the diagnostic and screenshot it — it shows every endpoint attempt and why it
failed.

### Setup (one time)

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. In `chrome://extensions` → Tampermonkey → Details, enable
   **Allow access to file URLs** (needed because the dashboard is a local file).
3. Create a new userscript and paste in `monitor-metrics-bridge.user.js`.
4. Be logged into MonitorPortal (Midway) in the same browser.
5. Open `index.html`. The Live Metrics bar should show
   "Userscript bridge v1.0.0 connected", and the first pull runs a few seconds
   after load.

The fetch bridge is intentionally dumb: it only forwards requests to
`monitorportal.amazon.com` and returns the raw text. All URL building and
parsing lives in `index.html`, so future fixes rarely require touching the
userscript. It runs alongside the existing OB hybrid bridge script without
conflict.

If the userscript is missing, the dashboard falls back to a direct `fetch()`
(usually blocked by CORS from `file://`) and reports exactly what happened in
the status line.
