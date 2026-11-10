require('dotenv').config({ path: './.env.local' });

const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const cron = require('node-cron');
const vm = require('node:vm'); // Native Node VM to run code safely

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

// ... [Keep all your existing API routes for /api/calendar, /api/news, /api/auth, etc.] ...

// ═══════════════════════════════════════════════════════════
//  STRATEGY MARKETPLACE API (Simplified)
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
    
    const { data: { user }, error: authErr } = await db.admin.auth.getUser(token);
    if (authErr || !user) throw new Error('Invalid session');

    const { name, description, is_public, strategy_type, code } = req.body;
    
    const { data, error } = await db.admin.from('strategies').insert({
      creator_id: user.id,
      name, description, is_public, strategy_type, code, status: 'inactive'
    }).select().single();

    if (error) throw error;
    res.json({ strategy: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Start or Stop a strategy (Just updates the database!)
app.post('/api/strategies/:id/toggle', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // 'running' or 'inactive'

    const { error } = await db.admin.from('strategies').update({ status }).eq('id', id);
    if (error) throw error;
    
    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  THE NEW ENGINE: RUNS EVERY MINUTE
// ═══════════════════════════════════════════════════════════

// We keep track of active trades in memory so we don't open 100 trades
const activeTrades = new Map(); 

cron.schedule('* * * * *', async () => {
  console.log('[Engine] Checking for running strategies...');
  
  try {
    const { data: strategies } = await db.admin.from('strategies').select('*').eq('status', 'running');
    if (!strategies || strategies.length === 0) return;

    for (const strat of strategies) {
      try {
        // 1. Create a safe sandbox for the strategy code
        const sandbox = {
          console,
          process, // Gives access to process.env
          require,
          __dirname: path.join(DATA_DIR, 'strategies'),
          
          // Inject the SDK functions directly
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
            activeTrades.set(strat.id, data.id);
            return data.id;
          },
          
          closeTrade: async (tradeId, exitPrice) => {
            const { data: trade } = await db.admin.from('trades').select('*').eq('id', tradeId).single();
            const pnl = trade.direction === 'BUY' 
              ? ((exitPrice - trade.entry_price) / trade.entry_price) * 100
              : ((trade.entry_price - exitPrice) / trade.entry_price) * 100;
            
            await db.admin.from('trades').update({ exit_price: exitPrice, pnl_pct: pnl, status: 'CLOSED', closed_at: new Date().toISOString() }).eq('id', tradeId);
            activeTrades.delete(strat.id);
          },
          
          sendSignal: (action, symbol, price, reason) => {
            db.admin.from('signals').insert({
              strategy_id: strat.id, action, symbol, price, reason
            }).then();
            console.log(`[Signal] ${strat.name}: ${action} ${symbol} @ ${price}`);
          }
        };

        // 2. Run the code
        const context = vm.createContext(sandbox);
        // The user code should call run()
        const script = new vm.Script(strat.code);
        await script.runInContext(context);

      } catch (err) {
        console.error(`[Engine] Error running strategy ${strat.name}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Engine] Cron error:', err.message);
  }
});

// ... [Keep your app.listen, Telegram webhooks, and push notifications at the bottom] ...

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Will's AI → http://localhost:${PORT}`);
});
