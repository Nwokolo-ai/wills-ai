// ═══════════════════════════════════════════════════════════
//  ffScraper.js — Biquote + Fair Economy merged → Supabase
//
//  · Biquote: actual values + forecast + previous (major events)
//  · Fair Economy: broader coverage (smaller countries)
//  · Merged by date+currency+title
//  · Full refresh on every event-triggered timer
// ═══════════════════════════════════════════════════════════

const BiquoteModule = require('biquote');
const Biquote = BiquoteModule.Biquote || BiquoteModule.default || BiquoteModule;
const { admin } = require('./db');

const MODE = process.env.MODE || 'scrape';
let nextTimer = null;

// FF's free CDN (Forex Factory's own calendar feed)
const FF_THIS_WEEK = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const FF_NEXT_WEEK = 'https://nfs.faireconomy.media/ff_calendar_nextweek.json';

// Track previous actuals to detect new ones
let previousActuals = new Map();

// ────────────────────────────────────────────────────────────
//  Helpers
// ────────────────────────────────────────────────────────────
function parseNumber(v) {
  if (v == null || v === '') return null;
  const s = String(v).replace(/[^\d.\-]/g, '');
  if (!s) return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function beatMiss(actual, forecast) {
  const a = parseNumber(actual);
  const f = parseNumber(forecast);
  if (a == null || f == null) return null;
  if (a > f) return 'BEAT';
  if (a < f) return 'MISS';
  return 'IN_LINE';
}

function normalizeImpact(s) {
  const v = String(s || '').toLowerCase();
  if (v === 'high') return 'high';
  if (v === 'medium') return 'medium';
  if (v === 'low') return 'low';
  return 'none';
}

function toIsoDate(isoTime) {
  if (!isoTime) return null;
  const d = new Date(isoTime);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function toTimeString(isoTime) {
  if (!isoTime) return '';
  const d = new Date(isoTime);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC',
  }).toLowerCase().replace(/\s+/g, '');
}

// Normalize key for matching across sources
function makeKey(isoTimeOrDate, timeStr, currency, name) {
  const t = (isoTimeOrDate || '').toLowerCase();
  const tm = (timeStr || '').toLowerCase().replace(/\s+/g, '');
  const c = (currency || '').toLowerCase();
  const n = (name || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `${t}|${tm}|${c}|${n}`;
}

// ────────────────────────────────────────────────────────────
//  BIQUOTE — source of truth for actuals
// ────────────────────────────────────────────────────────────
function biquoteToRow(e) {
  const isoTime = e.time || null;
  const name = (e.name || '').trim();
  const currency = (e.currency || '').toUpperCase().trim();
  return {
    event_key: makeKey(isoTime, '', currency, name),
    event_date: toIsoDate(isoTime),
    event_time: toTimeString(isoTime),
    event_timestamp: isoTime,
    currency,
    impact: normalizeImpact(e.importance),
    title: name,
    actual: e.actual != null ? String(e.actual) : null,
    forecast: e.forecast != null ? String(e.forecast) : null,
    previous: e.previous != null ? String(e.previous) : null,
    beat_miss: beatMiss(e.actual, e.forecast),
    source: e.source || 'biquote',
    updated_at: new Date().toISOString(),
  };
}

async function fetchBiquote() {
  const bq = new Biquote();
  const now = new Date();
  const from = now.toISOString().slice(0, 10);
  const to = new Date(now.getTime() + 14 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  console.log(`[ff] biquote fetch ${from} → ${to}`);
  const events = await bq.calendar({ from, to, limit: 500 });
  if (!Array.isArray(events)) throw new Error('Biquote returned non-array');
  console.log(`[ff] biquote returned ${events.length}`);
  return events.map(biquoteToRow);
}

// ────────────────────────────────────────────────────────────
//  FAIR ECONOMY (FF CDN) — broader coverage, no actuals
// ────────────────────────────────────────────────────────────
function fairEconomyToRow(e) {
  // FF date format: "Mon Oct 7" + time "1:30pm"
  const dateStr = e.date || '';
  const timeStr = e.time || '';
  const currency = (e.country || '').toUpperCase().trim();
  const title = (e.title || '').trim();

  // Build ISO timestamp
  let isoTime = null;
  if (dateStr && timeStr) {
    const lowerTime = timeStr.toLowerCase();
    if (!lowerTime.includes('tentative') && !lowerTime.includes('all day')) {
      const year = new Date().getFullYear();
      const d = new Date(`${dateStr} ${year} ${timeStr}`);
      if (!isNaN(d.getTime())) isoTime = d.toISOString();
    }
  }

  return {
    // Key includes date since FF CDN gives us "Mon Oct 7"
    event_key: makeKey(dateStr, timeStr, currency, title),
    event_date: isoTime ? toIsoDate(isoTime) : null,
    event_time: isoTime ? toTimeString(isoTime) : timeStr,
    event_timestamp: isoTime,
    currency,
    impact: normalizeImpact(e.impact),
    title,
    actual: e.actual || null,
    forecast: e.forecast || null,
    previous: e.previous || null,
    beat_miss: beatMiss(e.actual, e.forecast),
    source: 'fair_economy',
    updated_at: new Date().toISOString(),
  };
}

async function fetchFairEconomy() {
  console.log('[ff] fair economy fetch');
  const [thisWeek, nextWeek] = await Promise.all([
    fetch(FF_THIS_WEEK).then(r => r.ok ? r.json() : []),
    fetch(FF_NEXT_WEEK).then(r => r.ok ? r.json() : []),
  ]);
  const all = [...thisWeek, ...nextWeek];
  console.log(`[ff] fair economy returned ${all.length}`);
  return all.map(fairEconomyToRow);
}

// ────────────────────────────────────────────────────────────
//  MERGE — Biquote wins for actuals, Fair Economy fills gaps
// ────────────────────────────────────────────────────────────
function mergeSources(biquoteRows, feRows) {
  // Build lookup by (date+currency+title) — ignore time differences
  const byDayKey = new Map();

  function dayKey(row) {
    const d = (row.event_date || '').toLowerCase();
    const c = (row.currency || '').toLowerCase();
    const t = (row.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return `${d}|${c}|${t}`;
  }

  // Start with Fair Economy (broader coverage)
  for (const row of feRows) {
    if (!row.event_date || !row.currency || !row.title) continue;
    const k = dayKey(row);
    byDayKey.set(k, { ...row });
  }

  // Overlay Biquote (has actuals, more precise time)
  for (const row of biquoteRows) {
    if (!row.event_date || !row.currency || !row.title) continue;
    const k = dayKey(row);
    const existing = byDayKey.get(k);
    if (existing) {
      // Biquote wins — has better data
      existing.actual = row.actual || existing.actual;
      existing.forecast = row.forecast || existing.forecast;
      existing.previous = row.previous || existing.previous;
      existing.beat_miss = row.beat_miss || existing.beat_miss;
      existing.event_time = row.event_time || existing.event_time;
      existing.event_timestamp = row.event_timestamp || existing.event_timestamp;
      existing.event_key = row.event_key; // use Biquote's key
      existing.source = 'biquote+fe';
    } else {
      byDayKey.set(k, { ...row });
    }
  }

  return [...byDayKey.values()];
}

function validateRows(rows) {
  return rows.filter(r => {
    if (!r.event_key || r.event_key.length < 5) return false;
    if (!r.event_date) return false;
    if (!r.currency || r.currency.length < 2) return false;
    if (!r.title || r.title.length < 2) return false;
    return true;
  });
}

async function pushToSupabase(rows) {
  if (!rows.length) return 0;
  const BATCH = 200;
  let total = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await admin
      .from('calendar_events')
      .upsert(batch, { onConflict: 'event_key' });
    if (error) throw new Error('Upsert failed: ' + error.message);
    total += batch.length;
  }
  return total;
}

// ────────────────────────────────────────────────────────────
//  Detect newly-arrived actuals (for post-event notifications)
// ────────────────────────────────────────────────────────────
function detectNewActuals(rows) {
  const fresh = [];
  for (const row of rows) {
    const previous = previousActuals.get(row.event_key);
    if (row.actual && !previous) {
      fresh.push(row);
    } else if (row.actual && previous && row.actual !== previous) {
      fresh.push({ ...row, revised: true });
    }
  }
  for (const row of rows) {
    if (row.actual) previousActuals.set(row.event_key, row.actual);
  }
  return fresh;
}

// ────────────────────────────────────────────────────────────
//  MAIN SCRAPE
// ────────────────────────────────────────────────────────────
async function scrape() {
  if (MODE === 'read') {
    console.log('[ff] MODE=read — skip');
    return { skipped: true };
  }

  const t0 = Date.now();
  try {
    // Fetch both in parallel
    const [biquoteRows, feRows] = await Promise.all([
      fetchBiquote().catch(err => {
        console.error('[ff] biquote failed:', err.message);
        return [];
      }),
      fetchFairEconomy().catch(err => {
        console.error('[ff] fair economy failed:', err.message);
        return [];
      }),
    ]);

    const merged = mergeSources(biquoteRows, feRows);
    const valid = validateRows(merged);

    console.log(`[ff] merged: ${biquoteRows.length} biquote + ${feRows.length} FE = ${valid.length} unique`);

    const newActuals = detectNewActuals(valid);

    await pushToSupabase(valid);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`[ff] pushed ${valid.length} events — ${elapsed}s`);

    if (newActuals.length) {
      console.log(`[ff] ${newActuals.length} new actuals detected`);
      try {
        const { notifyNewActuals } = require('./alerts');
        if (notifyNewActuals) await notifyNewActuals(newActuals);
      } catch (e) {
        console.error('[ff] notify failed:', e.message);
      }
    }

    scheduleNextEventRefresh();
  } catch (err) {
    console.error('[ff] error:', err.message);
    if (nextTimer) clearTimeout(nextTimer);
    nextTimer = setTimeout(scrape, 5 * 60 * 1000);
  }
}

// ────────────────────────────────────────────────────────────
//  Next event timer
// ────────────────────────────────────────────────────────────
async function scheduleNextEventRefresh() {
  if (nextTimer) clearTimeout(nextTimer);
  if (MODE === 'read') return;

  try {
    const nowIso = new Date().toISOString();
    const { data } = await admin.from('calendar_events')
      .select('event_timestamp, title, currency')
      .is('actual', null)
      .gt('event_timestamp', nowIso)
      .order('event_timestamp', { ascending: true })
      .limit(1);

    if (!data?.length) {
      console.log('[ff] no upcoming events — checking again in 6h');
      nextTimer = setTimeout(scrape, 6 * 3600 * 1000);
      return;
    }

    const next = data[0];
    const targetMs = new Date(next.event_timestamp).getTime() + 1000;
    const delay = targetMs - Date.now();

    if (delay < 0) {
      nextTimer = setTimeout(scrape, 10000);
      return;
    }

    const capped = Math.min(delay, 6 * 3600 * 1000);
    const minUntil = Math.round(capped / 60000);
    console.log(`[ff] next refresh for ${next.currency} ${next.title} in ${minUntil} min`);

    nextTimer = setTimeout(async () => {
      console.log('[ff] TIMER fired — full refresh');
      await scrape();
    }, capped);
  } catch (err) {
    console.error('[ff] schedule error:', err.message);
  }
}

async function cleanup() {
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  await admin.from('calendar_events').delete().lt('event_date', cutoff);
  console.log(`[ff] cleanup done`);
}

module.exports = { scrape, cleanup, scheduleNextEventRefresh };
