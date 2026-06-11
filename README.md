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

- **`obd-east-west.html`** — the dashboard / board. East DD104–126, West DD334–355. Open it in a
  browser. Ships with sample data until live data arrives. Exposes `window.fuseIngest(...)` so the
  terminal can fill it directly.
- **`fuse-obd-terminal.user.js`** — Tampermonkey **terminal** (modeled on the OBR002 bridge):
  **pulls, doesn't scrape**. On each source page it watches the page's own data request (the JSON
  the SPA fetches) and "learns" it; on the board it replays all learned requests **at once** via
  `GM_xmlhttpRequest` (auth'd by your live session) and fills the board. No credentials leave the browser.
- **`proxy.py`** — optional. Midway-cookie proxy for the manual per-source pull buttons, plus a
  `/collect` store. Not required when you use the terminal.

## Setup (terminal — recommended)

1. **Install** `fuse-obd-terminal.user.js` in Tampermonkey (Create new script → paste → save).
2. **Visit each source once** while logged in — YMS yard, SSP OB dock, DockFlow Sorter/Arcs. The
   script silently records the data request each page makes (a small `[FUSE-TERM]` log appears).
   This is the one-time "learn" step.
3. **Open `obd-east-west.html`.** The **FUSE OBD TERMINAL** panel (bottom-right, draggable) lists the
   four feeds. Click **⟳ Pull All** — it replays every learned request at once and fills the board.
   Tick **auto** for a 15-minute refresh. Use **Open source tabs** if a feed shows `unlearned`.

The join: **VRID** links SSP→door (set from YMS), **ARC** links DockFlow forecast→door.

### Manual fallback (no terminal)

`mwinit` → `python proxy.py`, open the board, set the data-request URLs under **⚙ Endpoints**
(DevTools → Network), and use the per-source pull buttons or **Paste CSV**.

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
