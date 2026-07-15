# Decision: multi-stop.js and routes/routing.js were dropped (not ported)

Source files:
- `src/routes/multi-stop.js` (900 lines) — managed `order_stops`: multiple geographic
  stops (pickup/delivery/return) within a single delivery order, with per-stop GPS
  coordinates, sequencing, COD-per-stop, and a driver's "aggregated route across all
  assigned stops" view. It also depended on `optimizeStops`/`getRouteMulti` for
  waypoint-sequencing.
- `src/routes/routing.js` — a thin Express proxy in front of OSRM (open-source routing
  engine) exposing `/route`, `/route-multi`, `/distance`, `/matrix` for road-distance
  and multi-waypoint route geometry, used exclusively to support delivery dispatch
  and the multi-stop feature above.

## Why dropped instead of repurposed

A car-workshop work order is not a multi-stop geographic delivery route — a mechanic
works on one stationary vehicle inside a physical service bay. There is no analogous
"sequence of GPS stops per work order" concept. The one piece of this logic that DOES
still make sense for a workshop (estimating road distance/ETA for a mobile-mechanic or
tow pickup of a customer's vehicle) is covered separately and more simply by
`getRoadDistance()` in the trimmed `src/lib/routing.js` (see that file's top comment),
which is consumed directly by `vehicle-pickup.js` and `service-status.js` where needed.
That single function made the rest of this OSRM-proxy/multi-stop machinery redundant,
so the full multi-waypoint optimizer, stop-sequencing CRUD, and the `order_stops`
table were intentionally not ported.

If a future requirement needs multiple line items/checkpoints inside one work order
(e.g. multiple inspection checkpoints), that would be modeled as a new, much simpler
feature rather than reviving this file.
