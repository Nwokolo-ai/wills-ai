require('dotenv').config({ path: './.env.local' });

const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const cron = require('node-cron');
const vm = require('node:vm'); // For running strategies safely

const auth = require('./auth');
const db = require('./db');
const alerts = require('./alerts');
const tg = require('./telegram');

const app = express();
const PORT = process.env.PORT || 3500;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(PUBLIC_DIR));

// Ensure data folder exists for strategies
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function formatDateLabel(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

// ═══════════════════════════════════════════════════════════
//  CORE APIs
// ═══════════════════════════════════════════════════════════

app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: db.SUPABASE_URL,
    supabasePublishableKey: db.PUBLISHABLE,
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
  });
});

app.get('/api/calendar', async (req, res) => {
  try {
    const now = new Date();
    const from = new Date(now); from.setDate(from.getDate() - 1);
    const to = new Date(now); to.setDate(to.getDate() + 14);

    const { data, error } = await db.admin.from('calendar_events')
      .select('*')
      .gte('event_date', from.toISOString().slice(0, 10))
      .lte('event_date', to.toISOString().slice(0, 10))
      .order('event_timestamp', { ascending: true, nullsFirst: false });

    if (error) throw error;

    const events = (data || []).map(e => ({
      date: formatDateLabel(e.event_date),
      time: e.event_time || '—',
      timestamp: e.event_timestamp,
      currency: e.currency,
      impact: e.impact,
      event: e.title,
      actual: e.actual,
      forecast: e.forecast,
      previous: e.previous,
      beatMiss: e.beat_miss,
    }));

    res.json({ count: events.length, events });
  } catch (err) {
    res.status(500).json({ error: err.message, events: [] });
  }
});

// ── Biquote News API with Caching ──
let newsCache = { data: [], timestamp: 0 };
const NEWS_CACHE_MS = 15 * 60 * 1000; // 15 minutes

app.get('/api/news', async (req, res) => {
  try {
    const now = Date.now();
    if (newsCache.data.length > 0 && (now - newsCache.timestamp) < NEWS_CACHE_MS) {
      return res.json({ items: newsCache.data });
    }

    const response = await fetch(`https://biquote.io/api/news/market?maxResults=30`);
    const data = await response.json();

    if (!Array.isArray(data)) return res.json({ items: [] });

    const formattedNews = data.map(item => ({
      title: item.title || 'Market Update',
      link: item.url || '#',
      pubDate: item.publishedDate || new Date().toISOString(),
      snippet: item.description || '',
      category: 'forex' 
    }));

    newsCache = { data: formattedNews, timestamp: now };
    res.json({ items: formattedNews });
  } catch (err) {
    console.error('[news] Biquote API error:', err.message);
    res.json({ items: newsCache.data || [] });
  }
});

// ═══════════════════════════════════════════════════════════
//  AUTH APIs
// ═══════════════════════════════════════════════════════════

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { username, pin, email } = req.body || {};
    res.json(await auth.signup({ username, pin, email }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, pin } = req.body || {};
    res.json({ session: await auth.login({ username, pin }) });
  } catch (err) { res.status(401).json({ error: err.message }); }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    res.json({ profile: await auth.getProfile(token) });
  } catch (err) { res.status(401).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════
//  STRATEGY MARKETPLACE APIs
// ═══════════════════════════════════════════════════════════

app.get('/api/strategies', async (req, res) => {
  try {
    const { is_public, type } = req.query;
    let query = db.admin.from('strategies').select('*, profiles(username)');
    
    if (is_public === 'true') {
      query = query.eq('is_public', true);
    } else {
      const token = (req.headers.authorization || '').replace('Bearer ', '');
      if (!token) return res.status(401).json({ error: 'Unauthorized' });
      const { data: { user } } = await db.admin.auth.getUser(token);
      if (!user) return res.status(401).json({ error: 'Invalid session' });
      query = query.eq('creator_id', user.id);
    }

    if (type) query = query.eq('strategy_type', type);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ strategies: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/strategies', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const { data: { user } } = await db.admin.auth.getUser(token);
    
    const { name, description, is_public, strategy_type, code } = req.body;
    
    const { data, error } = await db.admin.from('strategies').insert({
      creator_id: user.id, name, description, is_public, strategy_type, code, status: 'inactive'
    }).select().single();

    if (error) throw error;
    res.json({ strategy: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/strategies/:id/toggle', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const { error } = await db.admin.from('strategies').update({ status }).eq('id', id);
    if (error) throw error;
    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  THE CRON ENGINE (Runs every minute)
// ═══════════════════════════════════════════════════════════

cron.schedule('* * * * *', async () => {
  try {
    const { data: strategies } = await db.admin.from('strategies').select('*').eq('status', 'running');
    if (!strategies || strategies.length === 0) return;

    for (const strat of strategies) {
      try {
        const sandbox = {
          console,
          process,
          require,
          __dirname: path.join(DATA_DIR, 'strategies'),
          
          getMarketData: async (symbol, tf, limit) => {
            const Biquote = require('biquote');
            const bq = new Biquote.Biquote ? new Biquote.Biquote() : new Biquote();
            const candles = await bq.ohlcv({ symbol: symbol.replace('/', ''), interval: tf, limit });
            return candles.map(c => ({ time: c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5] }));
          },
          openTrade: async (symbol, direction, entryPrice) => {
            const { data } = await db.admin.from('trades').insert({
              strategy_id: strat.id, symbol, direction, entry_price: entryPrice, status: 'OPEN'
            }).select().single();
            return data.id;
          },
          sendSignal: (action, symbol, price, reason) => {
            db.admin.from('signals').insert({ strategy_id: strat.id, action, symbol, price, reason }).then();
            console.log(`[Signal] ${strat.name}: ${action} ${symbol} @ ${price}`);
          }
        };

        const context = vm.createContext(sandbox);
        const script = new vm.Script(strat.code);
        await script.runInContext(context);

      } catch (err) {
        console.error(`[Engine] Error in ${strat.name}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Engine] Cron error:', err.message);
  }
});

// ═══════════════════════════════════════════════════════════
//  CRON & BOOT
// ═══════════════════════════════════════════════════════════

cron.schedule('0 4 * * *', async () => {
  try { const { scrape } = require('./ffScraper'); await scrape(); } catch (e) {}
});

cron.schedule('* * * * *', () => {
  alerts.runAll().catch(e => console.error('[cron] alerts:', e.message));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Will's AI → http://localhost:${PORT}`);
  
  // Run initial calendar scrape on boot
  setTimeout(async () => {
    try { 
      const { scrape } = require('./ffScraper'); 
      await scrape(); 
      console.log('[boot] calendar scraped'); 
    } catch (e) { console.error('[boot] calendar error:', e.message); }
  }, 5000);
});
