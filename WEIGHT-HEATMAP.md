# Trailer Weight Heat Map

Live, colour-coded view of how full each outbound trailer is **by payload weight**,
driven by the trailer's payload weight and the destination ARC's live rate from Dockflow.

Grey = 0% (empty) → Green (light) → Yellow (~half) → **Red = 100% (cube / weight-out)**,
in 5% bands, auto-refreshing every 1–3 minutes.

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

- **`targetWeight`** is the weight that equals **100%** (red). Default `45000` lb
  (a typical dry-van max payload). Override per row, or change the default in
  **⚙ Source / Settings**. Set it to the legal/loadout max, a planned target,
  or `forecastUnits × weightPerUnit` — whatever "full" means for you.
- The **live rate makes the % "run"**: between server refreshes the page
  extrapolates the weight forward every second using `fillRate`, so the tile
  climbs toward 100% in real time. Each refresh (1–3 min) replaces it with the
  true Dockflow snapshot.

### Heat colour

```
bucket = floor(pct / 5) * 5
if bucket == 0:  grey  (#a0aec0)
else:            hue = 120 * (1 - (bucket - 5) / 95)   → HSL(hue, 72%, 45%)
                 # 5% = 120° green, ~52% = 60° yellow, 100% = 0° red
```

Worked example (the trailer in the screenshot):
`36953.9 / 45000 = 82.1%` → bucket **80%** → orange-red.
At 772 jobs/hr and `36953.9/1760 = 21.0 lb/job`, fill rate ≈ **16,200 lb/hr**,
so ETA to full ≈ `(45000 − 36953.9) / 16200` ≈ **0.5 h**.

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
SBN1,YTF21313988237,36953.9,1760,772,45000
```

---

## 3. Excel version

The dashboard's **⬇ Export CSV** opens directly in Excel. To make a live,
auto-refreshing Excel sheet instead:

**Columns** (`A:destination  B:trailerId  C:liveRate  D:contentCount  E:payloadWeight  F:targetWeight`)

| Cell | Formula |
|------|---------|
| `G` Fill %       | `=IF(F2=0,0,E2/F2)` (format as %) |
| `H` 5% bucket    | `=FLOOR(G2,0.05)` |
| `I` Fill rate    | `=IF(D2=0,0,C2*(E2/D2))`  (lb/hr) |
| `J` ETA to full  | `=IF(I2=0,"",(F2-E2)/I2)` (hours) |

**Heat colour (grey → green → yellow → red):**
Select `G2:G…` → **Home → Conditional Formatting → Color Scales → New Rule →
3-Color Scale**:
- Min `0` → grey `#A0AEC0`
- Mid `0.5` (50%) → yellow `#ECC94B`
- Max `1` (100%) → red `#E53E3E`

Then add one more rule on top for the green low-end:
**New Rule → Format only cells that contain → between 0.05 and 0.40 → green `#38A169`**
(or use a 4-stop scale if your Excel supports it). For exact 0% = grey, add a
rule: *equal to* `0` → fill grey, and put it first / "Stop If True".

**Auto-refresh every 1–3 min:**
**Data → Get Data → From Web** (point at the proxy:
`http://localhost:8765/fetch?url=<dockflow-url>`) **or From Text/CSV** (the
exported CSV). Then **Data → Queries & Connections → right-click the query →
Properties → ✔ Refresh every `2` minutes** (and ✔ *Refresh data when opening
the file*). The formulas + colour scale recompute on every refresh.

> Tip: Power Query → From Web won't carry your Midway cookie on its own, which is
> why it points at the **local proxy** rather than Dockflow directly.

---

## Files

| File | Purpose |
|------|---------|
| `weight-heatmap.html` | The live heat-map dashboard |
| `proxy.py`            | Midway-authenticated proxy: `/api/*` (FCLM) + `/fetch?url=*` (Dockflow / any `*.amazon.com`) |
| `WEIGHT-HEATMAP.md`   | This document |
