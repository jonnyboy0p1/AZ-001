# FUSE v001 — live data + theory

The FUSE suite (`fuse-ixd`, `fuse-ibd`, `fuse-anti`, `fuse-obd`, `fuse-cdt`) with
the weight-heat + close-out (RTD) ETA theory wired in and a Tampermonkey
**collector** that fills all five pages from the live Amazon sources.

## Files

| File | Purpose |
|------|---------|
| `fuse-ixd.html` … `fuse-cdt.html` | The five dashboards (read `localStorage` keys `ff.*`) |
| `fuse-theory.js`        | Shared theory: `weightHeat()`, close-out ETA, `cdtRisk()`, `parseCsv()` |
| `fuse-collector.user.js`| Tampermonkey bridge: scrapes sources → GM storage → FUSE pages |

## The theory (`fuse-theory.js`)

Loaded by the CDT pages (`<script src="fuse-theory.js">`) and inlined in the
collector. Pure, also runs in Node.

- **`weightHeat(weight,{target:40000,floor:28000})`** → `{bg,fg,pct,label}` —
  trailer payload as a dispatch-window heat colour: grey 0 → green filling →
  **yellow at 28k (READY)** → **red at 40k (CUBE-OUT)**.
- **`closeoutEta(load,model)` / `enrichWithCloseout(loads,metrics)`** → predicts
  when a trailer finishes loading (RTD) and `slackMin`/`risk` vs SDT
  (`ON_TRACK` / `AT_RISK` / `MISS`). Time-based from YMS `OB_DOCK_STARTED` +
  avg `startToFinish`; weight-based when payload+rate are present.
- **`cdtRisk(minRemaining,weight)`** → `urgent` / `warn` / `ok`.

### Wired into the pages
`fuse-cdt.html` and `fuse-obd.html` now:
- prefer collector data (`ff.cdt`) over the hard-coded sample,
- colour each trailer's weight with `weightHeat` (dispatch window),
- derive card status from `cdtRisk`, and
- show a **Close-out** line (ETA + ± minutes vs CDT) when the collector supplies it.

Everything is guarded (`window.FUSE_THEORY ? …`) so the pages still work if the
script or collector isn't present.

## The collector (`fuse-collector.user.js`)

```
 SOURCE TABS                      GM storage            FUSE TABS
 ───────────                      ──────────            ─────────
 YMS shipclerk  ─ trailers,doors,events ─┐
 SSP OB         ─ loads (status/route/SDT/wt) ─┤  GM.setValue   ┌─ ff.trailersCsv
 NEO planning   ─ goals (TODO) ───────────┼───────────────────┤─ ff.doorsCsv
 DockFlow       ─ divert/weight (TODO) ───┘                    ├─ ff.goalsCsv
                                                               ├─ ff.cdt  (＝ SSP + events
                                                               │           run through the theory)
                                                               └─ ff.dockHubCapture / ff.liveFeed
```

**Install**
1. Confirm userscripts are allowed on your managed machine.
2. Tampermonkey → new script → paste `fuse-collector.user.js`.
3. Edit the `@match` for where you open the FUSE board (a hosted URL, or
   `file:///…/fuse-*.html`), and set `SITE` if not `RFD2`.
4. Keep a **YMS shipclerk** tab and an **SSP OB** tab open (pinned). Open a FUSE
   page — the badge bottom-right turns green and the board fills itself, refreshing
   every 60 s. The page's existing **▶ Pull** buttons are intercepted to serve the
   collected data too.

**What's live now vs. TODO**
- ✅ **YMS** — trailers, doors, and OB loading-duration events (token + `getEventReport`,
  reusing the proven nIXD calls).
- ✅ **SSP OB** — loads (status, route, SDT) → `ff.cdt` with close-out ETA + risk.
  ⚠️ Confirm the SSP **weight** field name (marked TODO in `sspSource()`); until then
  the weight heat shows EMPTY for loads with no weight.
- 🛠️ **NEO** (goals) and **DockFlow** (divert / sorter weight) ship as best-effort
  DOM scrapers with clear TODO markers — drop in the real selectors/JSON once you
  capture one response.

## Notes
- GM storage is shared cross-origin within Tampermonkey, which is how the source
  tabs feed the FUSE tabs without a server.
- `closeout-eta.js` (repo root) is the standalone version of the same close-out
  logic for the nIXD OB Insights script.
