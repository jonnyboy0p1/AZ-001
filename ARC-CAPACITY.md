# ARC Capacity — load median & heaviness by hour

A local tool that turns Crossdock Manager (Harmony) **arc-capacity** data for a
node (e.g. RFD2) into two views:

- **ARC load median, hour by hour** — the median load across the selected days
  for each hour of day, with the day-to-day spread (min→max band). This is the
  typical hourly ARC load profile.
- **How heavy is the ARC — by day & hour** — a day × hour heatmap of
  `heaviness = load ÷ capacity`. Darker blue = closer to capacity;
  **red = over capacity (>100%)**.

Plus a summary (peak load hour, peak heaviness, hours over capacity, busiest
day) and a full data table.

Same local-proxy pattern as the RC Sort dashboard in this repo — nothing leaves
your machine except the authenticated request to the internal endpoint.

## Quick start

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
