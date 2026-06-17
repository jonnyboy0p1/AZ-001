# Trailer Weight Heat Map

Live, colour-coded view of how full each outbound trailer is **by payload weight**,
driven by the trailer's payload weight and the destination ARC's live rate from Dockflow.

Tuned for a real dispatch window — trucks get kicked between **28,000 lb (dispatch
floor)** and **40,000 lb (cube-out)**:

Grey = empty → Green = filling → **Yellow = 28k dispatch floor** → **Red = 40k**,
in 5% bands, auto-refreshing every 1–3 minutes. The number on each tile is % of 40k.

---

## 1. The equation

For each trailer / destination ARC:

```
fillPct        = payloadWeight / targetWeight * 100        ← the headline %
bucket (5%)    = floor(fillPct / 5) * 5                    ← 0, 5, 10, … , 100

weightPerUnit  = payloadWeight / contentCount              ← lb per job/unit
fillRate(lb/hr)= liveRate(jobs/hr) * weightPerUnit         ← weight flowing into the trailer
projWeight(t)  = payloadWeight + fillRate * hoursSinceSnapshot   ← the "running" weight
etaToFull(hr)  = (targetWeight - projWeight) / fillRate
```

- **`targetWeight`** = the weight that equals **100%** (red / cube-out). Default
  `40000` lb. Override per row or in **⚙ Source / Settings**.
- **`dispatchFloor`** = the lowest weight you kick a truck at = the **yellow line**.
  Default `28000` lb. Below it a truck is still "filling"; at/above it it is
  "dispatch-ready". This is what stops a lower-middle weight bell curve from
  showing up as all-red (see Heat colour below).
- The **live rate makes the % "run"**: between server refreshes the page
  extrapolates the weight forward every second using `fillRate`, so the tile
  climbs toward 100% in real time. Each refresh (1–3 min) replaces it with the
  true Dockflow snapshot.

### Heat colour (two-segment, anchored on the dispatch floor)

```
floorPct = dispatchFloor / targetWeight * 100              # 28000/40000 = 70%
bucket   = floor(pct / 5) * 5

if   bucket == 0:        grey   #a0aec0                     # empty
elif bucket >= 100:      red    HSL(0)                      # at/over 40k — cube-out
elif bucket <  floorPct: hue = 140 - 70*(bucket/floorPct)              # green → yellow-green (filling)
else:                    hue = 60  - 60*((bucket-floorPct)/(100-floorPct))   # yellow → red (dispatch zone)
```

The ramp is spread across the **28k–40k** range instead of crammed into the top
of a flat 0–40k scale (which would paint a lower-middle bell curve all-red):

| Payload | % of 40k | Colour | Status |
|--------:|---------:|--------|--------|
| 0       | 0%   | grey         | EMPTY |
| 22,500  | 56%  | yellow-green | FILLING |
| 28,000  | 70%  | **yellow**   | READY (just eligible) |
| 34,000  | 85%  | orange       | READY |
| 36,954  | 92%  | orange-red   | READY |
| 40,000+ | 100% | **red**      | OVER MAX — dispatch now |

Worked example (the screenshot trailer): `36953.9 / 40000 = 92.4%`.
At 772 jobs/hr and `36953.9/1760 = 21.0 lb/job`, fill rate ≈ **16,200 lb/hr**,
so ETA to 40k ≈ `(40000 − 36953.9)/16200` ≈ **11 min**.

---

## 2. Live HTML dashboard (recommended)

`weight-heatmap.html` — open it in a browser. True 1-second running %, 1–3 min
auto-refresh, heat tiles + detail table, CSV export.

**Live data via the proxy (Dockflow uses Midway, so a proxy is needed):**

1. `mwinit` (refresh your Midway session).
2. `python proxy.py` (no external packages; serves on `http://localhost:8765`).
3. Open Dockflow in your browser, DevTools → **Network**, find the request that
   returns the ARC/container data, and copy its full URL.
4. In the dashboard → **⚙ Source / Settings**, paste that URL and Save.
   The proxy forwards it with your cookie (`/fetch?url=…`, restricted to
   `*.amazon.com`).
5. If the table stays empty, the field names differ — edit `mapDockflow()` in
   the HTML so the right-hand side of each `||` matches Dockflow's JSON keys.

**No proxy?** Leave the URL blank and paste JSON or CSV into the manual box, or
click **Load sample**. Manual CSV header:

```
destination,trailerId,payloadWeight,contentCount,liveRate,targetWeight
SBN1,YTF21313988237,36953.9,1760,772,40000
```

---

## 2a. Testing it at work (no live hookup needed)

You don't need a live Dockflow connection to trust the colours:

1. **Simulate a fleet.** Open `weight-heatmap.html` and click **🎲 Simulate
   fleet** — it generates ~12 trailers on a skewed bell curve (peak ~30–32k,
   tail to 40k+, one light, one empty) and "runs" them live. Watch tiles climb
   green → yellow → red and Status flip FILLING → READY → OVER MAX.
2. **Set your real thresholds** in ⚙ (floor `28000` / max `40000`) and confirm a
   28k truck turns yellow and a 40k truck turns red.
3. **Spot-check against trucks you actually dispatched today.** Paste a few real
   rows (Manual data box, CSV header above) and confirm the % + Status match the
   call you made. If a 30k truck you'd kick shows "FILLING", nudge the floor
   down; if 28k feels too light, nudge it up.
4. **Then go live** via the proxy or the Tampermonkey overlay (below).

---

## 3. Excel version

**Ready-made mock:** open **`weight-heatmap-mock.xlsx`** — it already has the
formulas and the grey→green→yellow→red heat scale wired up, with **100% =
40,000 lb** (column F). Change any Payload in column E and the % + colour
recalculate on the spot. Regenerate it any time with `python build_mock_xlsx.py`
(pure standard library, no add-ins).

The dashboard's **⬇ Export CSV** also opens directly in Excel. To build a live,
auto-refreshing Excel sheet from scratch:

**Columns** (`A:destination  B:trailerId  C:liveRate  D:contentCount  E:payloadWeight  F:targetWeight`)

| Cell | Formula |
|------|---------|
| `G` Fill %       | `=IF(F2=0,0,E2/F2)` (format as %) |
| `H` 5% bucket    | `=FLOOR(G2,0.05)` |
| `I` Fill rate    | `=IF(D2=0,0,C2*(E2/D2))`  (lb/hr) |
| `J` ETA to full  | `=IF(I2=0,"",(F2-E2)/I2)` (hours) |

**Heat colour (grey → green → yellow → red), anchored on the 28k floor:**
Select `G2:G…` → **Home → Conditional Formatting → New Rule → 3-Color Scale**:
- Min  type *Number* `0.05` → green  `#38A169`
- Mid  type *Number* `0.70` (= 28k / 40k, the dispatch floor) → yellow `#F6E05E`
- Max  type *Number* `1.00` → red    `#E53E3E`

Then for exact 0% = grey, add another rule **above** it: *Cell Value equal to*
`0` → grey fill `#A0AEC0`, tick **Stop If True**. (The ready-made
`weight-heatmap-mock.xlsx` already has both rules wired with these values.)

**Auto-refresh every 1–3 min:**
**Data → Get Data → From Web** (point at the proxy:
`http://localhost:8765/fetch?url=<dockflow-url>`) **or From Text/CSV** (the
exported CSV). Then **Data → Queries & Connections → right-click the query →
Properties → ✔ Refresh every `2` minutes** (and ✔ *Refresh data when opening
the file*). The formulas + colour scale recompute on every refresh.

> Tip: Power Query → From Web won't carry your Midway cookie on its own, which is
> why it points at the **local proxy** rather than Dockflow directly.

---

## 4. Tampermonkey overlay (easiest live option)

`dockflow-heatmap.user.js` runs **inside your already-logged-in Dockflow tab**,
so there's **no proxy, no `mwinit`, no CORS** — it reads the data your browser
already has and paints a floating heat-map panel on the page, refreshing every
1–3 min.

**Install**
1. Install the Tampermonkey browser extension (confirm your site allows
   userscripts/extensions on managed machines first).
2. Tampermonkey → **Create a new script** → paste `dockflow-heatmap.user.js`,
   save. (Or drag the `.user.js` file onto the Tampermonkey dashboard.)
3. Edit the `@match` lines at the top to your real Dockflow host (copy it from
   your address bar), then reload Dockflow.

**How it gets data** (tries these in order, so it works even before you configure
anything):
1. **API URL** — set via the panel's ⚙ (the JSON request URL from DevTools →
   Network). Same-origin `fetch(url, {credentials:"include"})` sends your cookie.
2. **Interceptor** — hooks `window.fetch` and captures Dockflow's *own* data
   calls, so often no URL is needed.
3. **DOM scrape** — reads the Container Hierarchy table by column header
   (Container Id / Content Count / Weight). Adjust `scrapeDOM()` if labels differ.
4. **Simulate** — 🎲 button, to test the overlay anywhere.

The panel's ⚙ also sets max (40k), floor (28k) and refresh minutes; settings
persist via Tampermonkey storage.

> Cross-tool note: weights live in one view and the ARC rate (jobs/hr) in
> another. The script grabs the rate if it's visible on the page; to pull it from
> a different host use `GM_xmlhttpRequest` (the `@connect amazon.com` grant is
> already declared).

---

## Files

| File | Purpose |
|------|---------|
| `weight-heatmap.html`       | Live heat-map dashboard (proxy / manual / simulate) |
| `dockflow-heatmap.user.js`  | Tampermonkey overlay — live heat map inside the Dockflow tab |
| `weight-heatmap-mock.xlsx`  | Ready-to-test Excel mock (formulas + heat scale; 100% = 40k, yellow = 28k) |
| `build_mock_xlsx.py`        | Regenerates the mock `.xlsx` (stdlib only) |
| `proxy.py`                  | Midway-authenticated proxy: `/api/*` (FCLM) + `/fetch?url=*` (Dockflow / any `*.amazon.com`) |
| `WEIGHT-HEATMAP.md`         | This document |
