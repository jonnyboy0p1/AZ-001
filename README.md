# OB02 — Outbound Period Report Card

Self-contained release of the OB Period Report Card dashboard with the merged Pace tracker, Shift Source Data hub, collapsible panels, and expanded live status tiles.

## What's In OB02

- **Overview**: Quick snapshot plus **Shift Source Data** (FCLM full-shift inputs that feed JPLH and the rest of the page)
- **Goals**: NEO shift goals, MonitorPortal links, quick tools, and collapsible FCLM Source panel
- **Periods**: Collapsible close checklist, workboards, and detailed period tables
- **Pace**: Merged hourly pace table with OB / Fluid / RWC / MP tabs plus collapsible **Pace Live Status**
- **Handoff / Logs**: Generated copy blocks and saved shift history

## Pace Live Status (new in OB02)

Collapsible status section with MET-aware labels when shift mode is on:

| Tile | Regular shift | MET shift |
|------|---------------|-----------|
| Pace / clock / catch-up | Standard shift language | MET extension language through 06:30 |
| Shift JPLH | Regular shift hours in required calc | MET hours included |
| Bypass / downtime | Full clock through 05:30 | Full MET clock through 06:30 |
| Next period preview | Next P1–P3 window | Includes MET extension window when upcoming |
| Bridge freshness | FCLM / Monitor / NEO pull age | Same, with MET schedule note |
| Stream capture mix | OB, Fluid, RWC, MP % row | Same row, MET goals in denominator |

## Run

From this folder:

```bash
npm start
```

Open:

```text
http://localhost:5173
```

Pace-only shortcut:

```text
http://localhost:5173/index.html?view=pace
```

## Bridge

1. Install `OB Period Report Card V2.1 Hybrid Bridge-2026-04-20.7.txt` in Tampermonkey (or use `ob-period-report-card-bridge.user.js`).
2. Keep this dashboard open while collecting NEO, FCLM, and MonitorPortal data.
3. Use **Collect Data From Bridge** and **Pull FCLM** from the Goals quick tools as needed.

## Folder Layout

```text
OB02/
  index.html          Dashboard shell and views
  app.js              Calculations, pace engine, bridge import, collapse state
  styles.css          Layout, pace table, status tiles, themes
  pace.html           Redirect to Pace view
  server.js           Local static server (port 5173)
  package.json        OB02 package metadata
  ob-period-report-card-bridge.user.js
  OB Period Report Card V2.1 Hybrid Bridge-2026-04-20.7.txt
  support-scripts/    Optional helper scripts
```

## Notes

- Collapse preferences (FCLM Source, checklist, Pace Live Status) persist in browser local storage.
- Pace stream tab selection (OB / Fluid / RWC / MP) also persists between visits.
- Toggle **MET Shift** in the top setup bar to switch all MET-aware labels and period windows.
