// ═══════════════════════════════════════════════════════════
//  ffScraper.js — Biquote → Supabase
//
//  · Startup: fetch full 2-week range → Supabase
//  · Timer: fires 1s after each event, does a FULL refresh
//  · Detects new actuals and notifies via alerts.js
// ═══════════════════════════════════════════════════════════

const BiquoteModule = require('biquote');
const Biquote = BiquoteModule.Biquote || BiquoteModule.default || BiquoteModule;
const { admin } = require('./db');

const MODE = process.env.MODE || 'scrape';
let nextTimer = null;

// Track previous actuals to detect new arrivals
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

function makeKey(isoTime, currency, name) {
  const t = (isoTime || '').toLowerCase();
  const c = (currency || '').toLowerCase();
  const n = (name || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `${t}|${c}|${n}`;
}

function toDbRow(e) {
  const isoTime = e.time || null;
  const name = (e.name || '').trim();
  const currency = (e.currency || '').toUpperCase().trim();
  return {
    event_key: makeKey(isoTime, currency, name),
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

function validateRows(rows) {
  return rows.filter(r => {
    if (!r.event_key || r.event_key.length < 8) return false;
    if (!r.event_date) return false;
    if (!r.currency || r.currency.length < 3) return false;
    if (!r.title || r.title.length < 2) return false;
    if (!/^[A-Z]{2,4}$/.test(r.currency) && r.currency !== 'ALL') return false;
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
//  Biquote fetch — 2 weeks ahead
// ────────────────────────────────────────────────────────────
async function fetchBiquote() {
  const bq = new Biquote();
  const now = new Date();
  const from = now.toISOString().slice(0, 10);
  const to = new Date(now.getTime() + 14 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  console.log(`[ff] biquote fetch ${from} → ${to}`);
  const events = await bq.calendar({ from, to, limit: 500 });
  if (!Array.isArray(events)) throw new Error('Biquote returned non-array');
  console.log(`[ff] biquote returned ${events.length}`);
  return events.map(toDbRow);
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
    const allRows = await fetchBiquote();
    if (!allRows.length) {
      console.warn('[ff] no events');
      scheduleNextEventRefresh();
      return;
    }

    const deduped = [...new Map(allRows.map(r => [r.event_key, r])).values()];
    const valid = validateRows(deduped);

    console.log(`[ff] ${valid.length} valid rows`);

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
  console.log('[ff] cleanup done');
}

module.exports = { scrape, cleanup, scheduleNextEventRefresh };
