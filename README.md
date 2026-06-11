# FUSE OBD — East/West Predictive Door Board (RFD2)

Predicts **when each outbound dock door will close** by combining three live sources and
checking the projection against **SDT** (finish-loading) and **CDT** (latest legal departure).

| Source | Provides | Keyed by |
|---|---|---|
| **DockFlow** (MainSorter *Arcs*) | ARC **Rate (jobs/hr)** + **Future forecast** curve (15m→24h) | ARC name (`CMH1_TOTE`) |
| **SSP** (OB dock) | **payload weight**, current jobs, **SDT**, **CDT** | **VRID** |
| **YMS** (yard) | DD ↔ **VRID** ↔ **Owner/trailer type** ↔ **Vehicle ID** ↔ `RFD2->DEST` (ARC) | Dock door |

The join: **YMS** ties door ↔ VRID ↔ ARC; **SSP** attaches payload/CDT by VRID; **DockFlow**
attaches the forecast by ARC. Projection = SSP current weight + DockFlow inflow → time to the
40K close target (and to the 33K band floor), compared to SDT/CDT.

## Pieces

- **`obd-east-west.html`** — the dashboard. East DD104–126, West DD334–355. Open it in a browser
  (double-click, or serve it). Ships with sample data until live data arrives.
- **`proxy.py`** — local bridge. Two jobs: (1) proxy Midway-authed GETs to FCLM/DockFlow/YMS;
  (2) a **`/collect`** store that the userscript pushes to and the dashboard reads.
- **`fuse-obd-collector.user.js`** — Tampermonkey script. Runs inside the authenticated
  YMS/SSP/DockFlow tabs, scrapes the data, and POSTs it to the proxy. **No credentials leave
  your browser.**

## Setup

1. **Auth + proxy** (in a terminal):
   ```
   mwinit
   python proxy.py            # listens on http://localhost:8765
   ```
2. **Install the userscript**: Tampermonkey → Create new script → paste
   `fuse-obd-collector.user.js` → save. (It only runs on the three FUSE hosts.)
3. **Open the pages** (logged in): YMS yard, SSP OB dock, DockFlow Arcs/Sorter. A small
   **FUSE COLLECTOR** panel appears bottom-right showing what it captured. Leave **auto** on,
   or click **⤴ Send now**.
4. **Open `obd-east-west.html`** → **⤓ Collector Sync** (or tick **auto**). Done.

If a page is a single-page app and the scraper misses a field, the dashboard's **⚙ Endpoints**
path (capture the XHR URL in DevTools) and **Paste CSV** remain as fallbacks.

## How the prediction works

- **Inflow**: DockFlow ARC `Rate (jobs/hr)` and the `Future` forecast curve (cumulative jobs by
  horizon). If several open doors share a destination, the inflow is split between them.
- **Jobs → weight**: `lbs/job` (auto-derived per trailer from SSP `weight ÷ jobs`, else the
  configurable default) converts forecast jobs to pounds.
- **Close projection**: time for `current weight + forecast inflow` to reach the 40K target →
  **projected close time**. A separate projection to the 33K band floor judges CDT (make-weight).
- **Verdicts**: ✓/✗ against **SDT** (full by scheduled departure) and **CDT** (at least in-band by
  the latest legal departure). Side cards count doors projected to miss CDT/SDT.

## Bands

Door **payload** band: **33K–40K** hard, **exception to 42K**, over >42K, under <33K.
(The CDT·WM *sorter* weight monitor keeps its own 32–40K belt band — different measurement.)

## Privacy

`proxy.py` reads your local `~/.midway/cookie`; the userscript uses your existing browser
session. **Never paste a Midway cookie or credential into the dashboard, the repo, or chat.**

## Security note on capture

The proxy's `/collect` store holds whatever the userscript scrapes (door/VRID/weights). It binds
to `localhost` only. It is operational data for your shift — treat the exported CSVs accordingly.
