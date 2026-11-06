// shared/strategy-runner.mjs
import { createClient } from '@supabase/supabase-js';
import { createRequire } from 'node:module';
import path from 'node:path';

// This allows us to load the creator's CommonJS strategy file
const require = createRequire(import.meta.url);

const STRATEGY_FILE = process.env.STRATEGY_FILE;
const STRATEGY_ID = process.env.STRATEGY_ID;
const POLL_MS = Number(process.env.POLL_MS || 60000);

if (!STRATEGY_FILE || !STRATEGY_ID) {
  console.error('[Runner] Missing STRATEGY_FILE or STRATEGY_ID');
  process.exit(1);
}

// Initialize Supabase Admin (passed from Orchestrator)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

console.log(`[Runner] Starting strategy: ${path.basename(STRATEGY_FILE)}`);
console.log(`[Runner] Poll interval: ${POLL_MS}ms`);

// ── INTERCEPT LOGS ──
// We override console.log so when the SDK calls sendSignal(), we catch it.
const originalLog = console.log;
console.log = async function (...args) {
  const msg = args.join(' ');
  originalLog(msg);

  // Catch signals emitted by the SDK
  if (msg.startsWith('[SIGNAL_EMIT] ')) {
    try {
      const signalData = JSON.parse(msg.replace('[SIGNAL_EMIT] ', ''));
      
      // Save to Supabase `signals` table
      const { error } = await supabase.from('signals').insert({
        strategy_id: STRATEGY_ID,
        action: signalData.action,
        symbol: signalData.symbol,
        price: signalData.price,
        reason: signalData.reason,
      });

      if (error) originalLog(`[Runner] Failed to save signal: ${error.message}`);
      else originalLog(`[Runner] ✅ Signal saved to DB: ${signalData.action} ${signalData.symbol}`);
      
    } catch (e) {
      originalLog(`[Runner] Error parsing signal: ${e.message}`);
    }
  }
};

// ── EXECUTION LOOP ──
let isRunning = false;

async function tick() {
  if (isRunning) return; // Prevent overlap if a run takes longer than POLL_MS
  isRunning = true;

  try {
    // 1. Clear require cache so we always run the latest code
    delete require.cache[require.resolve(STRATEGY_FILE)];
    
    // 2. Load the strategy
    const strategy = require(STRATEGY_FILE);
    
    // 3. Execute the main function (expects an exported `run` function)
    if (typeof strategy.run === 'function') {
      await strategy.run();
    } else if (typeof strategy === 'function') {
      await strategy();
    } else {
      originalLog('[Runner] Strategy file does not export a run() function.');
    }
  } catch (err) {
    originalLog(`[Runner] ❌ Execution Error: ${err.message}`);
    // Optionally, update strategy status to 'error' in DB here
  } finally {
    isRunning = false;
  }
}

// Start the loop
tick();
setInterval(tick, POLL_MS);
