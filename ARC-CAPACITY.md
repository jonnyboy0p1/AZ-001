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

## Blending in DockFlow (userscript v2)

The Tampermonkey userscript also runs on **DockFlow**
(`*.dockflow.robotics.a2z.com`) and blends live sortation data into the same
view:

- **Sorter Arc utilization** (MainSorter/Sorter) — per-Arc Utilization + Recircs,
  overlaid as **live actual** on the current hour's cell in the heaviness grid
  (marked with a gold ring), with an *actual − plan* delta. Also shown as a
  per-Arc bar list.
- **Allocation plan by destination** (IxdOutbound) — planned outbound allocation
  per destination.
- **Routing profiles & load doors** (IxdOutbound) — top routing profiles by PID
  total and fluid load doors by recircs.

Captures are shared across the Crossdock and DockFlow tabs via Tampermonkey
storage, so the panel fuses everything regardless of which tab you open it on.
The Summary KPIs become **plan vs. live**: live Arc utilization, planned
heaviness for the current hour, the actual−plan delta, the peak live Arc, and
total live recircs.

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
   - Crossdock Manager **arc-capacity**
     (`…/#/dice/na/arc-capacity?...&nodes=RFD2&startDate=…&endDate=…`)
   - DockFlow **MainSorter/Sorter** (`…/RFD2/wc/MainSorter/Sorter`)
   - DockFlow **IxdOutbound** (`…/RFD2/ap/IxdOutbound/IxdOutbound`)
4. Click the floating **📊 ARC** button (bottom-right). The badge shows how many
   of the five sources have been captured; the Summary lists which
   (`Crossdock ✓ · Sorter ✓ · Alloc ✓ · Profiles ✓ · Doors ✓`).

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
