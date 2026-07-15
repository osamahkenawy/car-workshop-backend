/**
 * OSRM Routing Service (REDUCED for car-workshop domain)
 * ────────────────────────────────────────────────────────
 * DECISION NOTE: The original delivery-service backend used this module for
 * road-distance/route-matrix/multi-stop-TSP optimization across many
 * concurrent delivery stops assigned to a driver (getRoute, getRouteMulti,
 * getDistanceMatrix, optimizeStops). A car workshop does not dispatch drivers
 * across multi-stop delivery routes — the only routing-adjacent need is
 * `vehicle-pickup.js`: estimating drive time/distance when a mechanic (or a
 * tow/pickup partner) needs to travel to a customer to collect their vehicle,
 * or when quoting a pickup fee based on distance from the workshop.
 *
 * Kept:
 *   - getRoadDistance(...) — simple point-to-point distance/duration lookup,
 *     used by vehicle-pickup.js scheduling and pricing estimates.
 *
 * Dropped:
 *   - getRoute (full route geometry/polyline) — no map/live-tracking polyline
 *     rendering need for a single vehicle pickup leg in this domain yet.
 *   - getRouteMulti (multi-waypoint route) — no multi-stop delivery run to
 *     sequence.
 *   - getDistanceMatrix (N x M matrix) — was used for bulk dispatch
 *     optimization across many drivers/orders simultaneously; not applicable
 *     to a single-workshop pickup scheduling flow.
 *   - optimizeStops (OSRM /trip TSP solver) — no multi-stop route to
 *     optimize; a mechanic doing a pickup has at most one stop per trip.
 *
 * If a future need arises (e.g. a mobile "tow fleet" with multi-pickup
 * routing), the dropped functions can be restored from the original
 * delivery-service-backend/src/lib/routing.js with the same OSRM wrapper
 * pattern used below.
 */

const OSRM_BASE = process.env.OSRM_URL || 'http://localhost:5000';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}

function cacheSet(key, data) {
  cache.set(key, { data, ts: Date.now() });
  // Periodic cleanup: keep cache under 5000 entries
  if (cache.size > 5000) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.ts > CACHE_TTL) cache.delete(k);
    }
  }
}

/**
 * Round coords to ~11m precision for cache key dedup
 */
function roundCoord(v) {
  return parseFloat(parseFloat(v).toFixed(4));
}

/**
 * Get road distance between two points (simple wrapper for vehicle-pickup
 * scheduling/pricing estimates).
 * Returns { distance_km, duration_min }
 */
export async function getRoadDistance(fromLat, fromLng, toLat, toLng) {
  const key = `dist:${roundCoord(fromLng)},${roundCoord(fromLat)};${roundCoord(toLng)},${roundCoord(toLat)}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const url = `${OSRM_BASE}/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=false`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!resp.ok) throw new Error(`OSRM distance error: ${resp.status}`);
  const data = await resp.json();
  if (data.code !== 'Ok' || !data.routes?.[0]) throw new Error(`OSRM: ${data.code || 'no route'}`);

  const result = {
    distance_km: Math.round(data.routes[0].distance / 10) / 100,
    duration_min: Math.round(data.routes[0].duration / 6) / 10,
  };
  cacheSet(key, result);
  return result;
}
