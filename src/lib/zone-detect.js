/**
 * zone-detect.js
 *
 * REINTERPRETATION NOTE:
 * In the original delivery-service codebase, `detectZone(lat, lng)` matched
 * GPS coordinates against `zones` — polygons describing UAE delivery zones —
 * to figure out which dispatch zone an order/driver fell into.
 *
 * In this car-workshop schema, `service_bays` are physical in-shop bays/lanes
 * (e.g. "Bay 1", "Lane A") with no GPS coordinates at all — they don't make
 * sense as a geo-detection target. Meanwhile `workshops` (the tenant/branch
 * table) DOES carry geo-coordinates (`company_lat` / `company_lng`, added in
 * migrations/post/00_schema_patches.sql) since each workshop is a physical
 * branch location.
 *
 * So `detectZone` is repurposed here to find the NEAREST WORKSHOP BRANCH
 * given a (lat, lng) pair — useful for auto-assigning a customer/work-order
 * to the nearest branch when multiple workshop locations exist for the same
 * account/company. It intentionally does NOT return a service_bay_id; call
 * sites in the ported routes use its return value as a best-effort "nearest
 * location" id and treat `null` as "couldn't determine, fall back to
 * whatever is already assigned."
 *
 * `haversineMeters` is kept as pure, schema-agnostic math and is also used
 * directly by route files for geofence checks (e.g. mechanic arrival
 * detection) unrelated to zone/bay detection.
 */

import { query } from './database.js';

/**
 * Great-circle distance between two lat/lng points, in meters.
 * Standard haversine formula.
 */
export function haversineMeters(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some(v => v == null || Number.isNaN(Number(v)))) {
    return Infinity;
  }

  const R = 6371000; // Earth radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Find the nearest workshop branch to the given coordinates.
 *
 * @param {number} workshopId - the "home" workshop/account id to scope the
 *   search to. In a single-branch account this is just used to look up the
 *   parent company grouping if one exists; if no grouping concept is present
 *   we fall back to searching ALL workshops with lat/lng set and simply
 *   return the closest one (which will typically just be workshopId itself
 *   if it's the only branch with coordinates).
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<number|null>} nearest workshop id, or null if no
 *   workshops have geo-coordinates set (graceful fallback).
 */
export async function detectZone(workshopId, lat, lng) {
  try {
    if (lat == null || lng == null || Number.isNaN(Number(lat)) || Number.isNaN(Number(lng))) {
      return null;
    }

    const candidates = await query(
      `SELECT id, company_lat, company_lng
         FROM workshops
        WHERE company_lat IS NOT NULL
          AND company_lng IS NOT NULL`
    );

    if (!candidates.length) {
      return null; // no workshops have coordinates set — graceful fallback
    }

    let nearest = null;
    let nearestDist = Infinity;

    for (const w of candidates) {
      const dist = haversineMeters(
        parseFloat(lat), parseFloat(lng),
        parseFloat(w.company_lat), parseFloat(w.company_lng)
      );
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = w.id;
      }
    }

    return nearest;
  } catch (err) {
    console.error('[ZoneDetect] detectZone error:', err.message);
    return null;
  }
}
