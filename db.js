require('dotenv').config({ path: './.env.local' });
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const PUBLISHABLE = process.env.SUPABASE_PUBLISHABLE_KEY;
const SECRET = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !PUBLISHABLE || !SECRET) {
  throw new Error('db.js: missing SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, or SUPABASE_SECRET_KEY');
}

const admin = createClient(SUPABASE_URL, SECRET, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function anonClient() {
  return createClient(SUPABASE_URL, PUBLISHABLE, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function userClient(accessToken) {
  return createClient(SUPABASE_URL, PUBLISHABLE, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

module.exports = { admin, anonClient, userClient, SUPABASE_URL, PUBLISHABLE };
