/**
 * generate-historical-kpi.js — models Jan–Jun 2026 technician KPI reports
 * from the one real report we have (scripts/data/technicians_kpi_2026-07.csv),
 * for the same 83 technicians, so the Technician KPI page has a trend to show
 * instead of a single flat month.
 *
 * These are NOT real historical records — no attendance export exists for
 * those months. Each is a deterministic, seeded walk backward from July's
 * real numbers per technician (small bounded month-to-month drift on
 * utilization/productivity, days present scaled by that technician's real
 * July attendance ratio applied to each month's calendar length). Imported
 * rows are tagged with source=kpi_report_YYYY-MM_estimated (vs the real
 * July rows' kpi_report_2026-07) so the two are never confused in the DB.
 *
 * Re-running this script produces byte-identical output (seeded PRNG per
 * technician+month), so it's safe to regenerate.
 *
 * Usage: node scripts/generate-historical-kpi.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const SRC = path.join(DATA_DIR, 'technicians_kpi_2026-07.csv');
const RATE = 85; // flat shop billing rate/hr, confirmed from source: billed_value / billed_hrs === 85 on every July row
const MONTHS_DESC = [6, 5, 4, 3, 2, 1]; // walk backward from July (7) to January

const HEADER = 'sno,technician,designation,tn_code,days_present,avail_hrs,ot,total_hrs,worked_hrs,prod_hrs_pct,idle_hrs_pct,billed_value,billed_hrs,billed_hours,u_pct,p_pct,e_pct';

function parseCsv(text) {
  const lines = text.trim().split('\n');
  const header = lines[0].split(',');
  return lines.slice(1).map(line => {
    const cells = line.split(',');
    const row = {};
    header.forEach((h, i) => { row[h.trim()] = (cells[i] ?? '').trim(); });
    return row;
  });
}

const daysInMonth = (year, month1based) => new Date(year, month1based, 0).getDate();

// Deterministic PRNG (mulberry32), seeded per technician+month so re-runs are stable.
function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const jitter = (rand, spread) => (rand() * 2 - 1) * spread;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function main() {
  const julyRows = parseCsv(fs.readFileSync(SRC, 'utf8'));
  const julyDays = daysInMonth(2026, 7);

  // Running per-technician state, starting at July's real values, drifting backward.
  const state = new Map();
  for (const r of julyRows) {
    state.set(r.tn_code, {
      p: Number(r.prod_hrs_pct),
      u: Number(r.u_pct),
      attendanceRatio: clamp(Number(r.days_present) / julyDays, 0, 1),
    });
  }

  for (const m of MONTHS_DESC) {
    const monthStr = `2026-${String(m).padStart(2, '0')}`;
    const dim = daysInMonth(2026, m);
    const outLines = [HEADER];

    julyRows.forEach((r, idx) => {
      const s = state.get(r.tn_code);
      const rand = mulberry32(hashSeed(`${r.tn_code}|${monthStr}`));

      const p = clamp(s.p + jitter(rand, 0.05), 0.35, 1.30);
      const u = clamp(s.u + jitter(rand, 6), 40, 135);
      const e = Math.round(clamp((u + p * 100) / 2 + jitter(rand, 4), 30, 140));

      const daysPresent = Math.round(clamp(dim * s.attendanceRatio * (1 + jitter(rand, 0.06)), 0, dim));
      const availHrs = daysPresent * 8;
      const totalHrs = availHrs; // no OT modeled, matching the source's mostly-blank ot column
      const workedHrs = Math.round((availHrs * p + jitter(rand, 1)) * 100) / 100;
      const idle = Math.round((1 - p) * 10000) / 10000;
      const billedHrs = workedHrs;
      const billedHours = Math.round((workedHrs + 2 * daysPresent) * 100) / 100; // matches source's fixed +2hrs/day-present offset
      const billedValue = Math.round(billedHrs * RATE * 100) / 100;

      outLines.push([
        idx + 1, r.technician, r.designation, r.tn_code,
        daysPresent, availHrs, '', totalHrs, workedHrs,
        p.toFixed(4), idle, billedValue, billedHrs, billedHours,
        Math.round(u), Math.round(p * 100), e,
      ].join(','));

      state.set(r.tn_code, { ...s, p, u });
    });

    const outPath = path.join(DATA_DIR, `technicians_kpi_${monthStr}.csv`);
    fs.writeFileSync(outPath, outLines.join('\n') + '\n');
    console.log(`Wrote ${outPath} (${julyRows.length} rows)`);
  }
}

main();
