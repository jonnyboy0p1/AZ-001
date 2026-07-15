# ARC Capacity — load median & heaviness (Crossdock + DockFlow)

A local tool that turns Crossdock Manager (Harmony) **arc-capacity** data for a
node (e.g. RFD2) into:

- **ARC load median, hour by hour** — the median load across the selected days
  for each hour of day, with the day-to-day spread (min→max band). This is the
  typical hourly ARC load profile.
- **How heavy is the ARC — by day & hour** — a day × hour heatmap of
  `heaviness = load ÷ capacity`. Darker blue = closer to capacity;
  **red = over capacity (>100%)**.

Plus a summary (peak load hour, peak heaviness, hours over capacity, busiest
day) and a full data table.

## Predictive Arc heaviness (userscript v3)

The unit of analysis is the **destination Arc** (`DTW1`, `LUK2`, `KRB6`,
`MSP1`, …) — the shared key across Crossdock Manager, DockFlow, and the DDs.
The userscript runs on Crossdock **and** DockFlow (`*.dockflow.robotics.a2z.com`)
and forecasts **which Arc will be extremely heavy in which upcoming hour**,
using the live **inbound throw** as the leading signal.

### The model

For each Arc and each upcoming hour:

```
predicted heaviness = plan heaviness × inbound-surge   (lead-time shifted)
plan heaviness      = Crossdock arc-capacity  load ÷ capacity   (per Arc, per hour)
inbound-surge       = this Arc's live inbound share ÷ its planned share
```

- **Plan** comes from Crossdock Manager `arc-capacity` (per-Arc load & capacity).
- **Inbound throw** is blended from DockFlow **IXDInbound** routing profiles +
  fluid load doors and the **Command Center (cc)** per-Arc counts. An Arc pulling
  a bigger share of inbound than its plan expects gets a surge multiplier > 1.
- **Lead time** shifts that surge forward — inbound now lands on the outbound Arc
  ~N minutes later — so it's applied to the hours *after* the lead.
- **Current backlog** = live outbound Arc utilization + recircs from the
  **Sorter** (IxdOutbound), used as the floor for the current hour.

### The view (three tabs)

- **Forecast**
  - **Predicted heaviness — Arc × upcoming hour** grid: rows = Arcs (sorted by
    peak predicted heaviness), columns = the next *N* hours. Darker = heavier;
    **red = over capacity**; a **gold border** marks the hours the surge is applied.
  - **Predicted hotspots** — the Arc/hours expected to exceed the threshold, worst
    first (e.g. `Arc ATL6 · 15:00 · 126% (plan 100%, surge ×1.26)`).
  - **Forecast KPIs** — hottest Arc/period, Arc-hours over capacity, biggest
    inbound surge, live inbound total.
- **By Arc** — a line chart per Arc (small multiples, sorted heaviest-first)
  showing that Arc's *gravity*: **plan vs. predicted** heaviness across the day,
  the inbound-surge band, a 100%-capacity reference, and a "now" marker.
- **Signals** — the supporting cards: live inbound throw by Arc, live outbound
  Arc utilization, allocation by destination, routing profiles & load doors.

### Tunable (in-panel sliders)

- **Lead** — inbound → outbound lag (default 90 min).
- **Horizon** — how many hours ahead to project (default 6).
- **Heavy ≥** — the "extremely heavy" threshold (default 100% of capacity).
- **Top arcs** — how many Arc rows to show (default 15).

Captures are shared across the Crossdock and DockFlow tabs via Tampermonkey
storage, so the forecast fuses everything regardless of which tab you open it on.
Nothing leaves your machine except the authenticated requests the pages already
make in your session.

## Two ways to run it

| | Best for | Setup |
|---|---|---|
| **Tampermonkey userscript** (`arc-capacity.user.js`) | **Recommended.** Runs right on the Crossdock Manager page, auto-captures the data, no proxy/cookie work. | Install once in Tampermonkey. |
| **Standalone page + proxy** (`arc-capacity.html` + `arc_proxy.py`) | Viewing/analyzing outside the Crossdock Manager tab, or scripting. | Run the proxy, open the page. |

Both share the exact same analysis (hourly median + heaviness) and the same
tolerant field normalizer.

## Option A — Tampermonkey userscript (recommended)

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Open `arc-capacity.user.js` → Tampermonkey will offer to install it (or
   create a new script and paste the file contents).
3. Open the views you want blended, for your node:
   - Crossdock Manager **arc-capacity** — per-Arc plan
     (`…/#/dice/na/arc-capacity?...&nodes=RFD2&startDate=…&endDate=…`)
   - DockFlow **IXDInbound** — inbound throw (`…/RFD2/ap/IXDInbound/IXDInbound`)
   - DockFlow **Command Center** — per-Arc counts (`…/RFD2/cc`)
   - DockFlow **MainSorter/Sorter** — live outbound (`…/RFD2/wc/MainSorter/Sorter`)
   - DockFlow **IxdOutbound** — allocation & routing (`…/RFD2/ap/IxdOutbound/IxdOutbound`)
4. Click the floating **📊 ARC** button (bottom-right). The badge shows how many
   sources have been captured; the Summary groups them
   (`Plan ✓ · Inbound ✓ · CC ✓ · Live out ✓ · Alloc/Routing ✓`). It captures
   inbound vs. outbound routing/doors automatically by which page they came from.

Because it runs inside your logged-in session, there's no Midway cookie handling
and no need to know the data APIs — it watches `fetch`/`XHR` and routes each
response to the right source by its fields. Node and dates are read from the
page URL. **✨ Demo** previews the whole blended layout with synthetic data,
**📋 Paste JSON** analyzes a response you copied, and **↗ Dashboard** posts the
captured data to the local `server.py` bridge (port 5220).

> **Field mapping:** each source has a tolerant normalizer that matches common
> column names case/whitespace-insensitively (`Utilization`, `PID Total`,
> `Recircs\n15min`, `arcLoad`/`arcCapacity`, `Destination`, …). If a live
> response uses a name it doesn't know, Paste JSON will say so — the fix is
> adding the name to the relevant `*_KEYS` array near the top of the script.

## Option B — Standalone page + proxy

### Quick start

```bash
# 1. (optional) refresh your Midway session
mwinit

# 2. start the proxy
python arc_proxy.py            # http://localhost:8770

# 3. open arc-capacity.html in a browser
#    (double-click it, or serve the folder with `python server.py` on :5220)
```

Then pick one of three data sources in the page:

| Button | What it does |
|---|---|
| **✨ Demo data** | Renders a realistic synthetic RFD2-style load curve so you can see the charts immediately. No proxy needed. |
| **📋 Paste JSON** | Paste the arc-capacity JSON response straight from your browser and analyze it. No proxy needed. |
| **⟳ Fetch live** | Fetches through `arc_proxy.py` using your Midway cookie. Paste the data-request URL first (see below). |

## Getting the live data-request URL

Because the Crossdock Manager data API isn't hard-coded here, you point the tool
at the exact request your browser already makes:

1. Open the arc-capacity view in Crossdock Manager while logged in.
2. DevTools → **Network** tab → refresh.
3. Find the request that returns the capacity/load numbers (filter by `Fetch/XHR`,
   look for JSON with load/capacity values).
4. **Copy link address** and paste it into the **Data request URL** field, then
   click **⟳ Fetch live**.

The proxy replays that URL with your Midway cookie attached. It only forwards to
`*.a2z.com` / `*.amazon.com` hosts, so your cookie is never sent elsewhere.

## Field mapping

`arc-capacity.html` normalizes the response into
`{ date, hour, load, capacity }` records and tolerates many common field names
(`arcLoad`, `volume`, `units`, `arcCapacity`, `maxCapacity`, timestamps vs.
explicit `hour`, parallel arrays, node-keyed maps, …). See the `*_KEYS` arrays
near the top of the script.

If a real response uses names not in those lists, the page shows an "I couldn't
find load/capacity/hour fields" banner — **paste one sample record via 📋 Paste
JSON and add its field names to the `*_KEYS` arrays** (a one-line change each).

## Definitions

- **Median load for hour H** = median, across all selected days, of that day's
  load in hour H.
- **Heaviness** = `load ÷ capacity` for a given day and hour (utilization %);
  `>100%` means demand exceeded ARC capacity in that hour.
