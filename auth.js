const { admin, anonClient } = require('./db');
const { sendEmail, welcomeEmail } = require('./mailer');

const WEAK_PINS = new Set([
  '000000','111111','222222','333333','444444','555555','666666','777777','888888','999999',
  '123456','654321','121212','112233','123123','123321','102030','147258','159357','789456','456789',
  '0000','1234','4321','1111','2222','3333','4444','5555','6666','7777','8888','9999',
]);

function isWeakPin(pin) {
  if (WEAK_PINS.has(pin)) return true;
  if (/^(\d)\1+$/.test(pin)) return true;
  const digits = pin.split('').map(Number);
  const asc = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
  const desc = digits.every((d, i) => i === 0 || d === digits[i - 1] - 1);
  return asc || desc;
}

function validateUsername(u) {
  if (!u) return 'Username is required';
  if (u.length < 3) return 'Username must be at least 3 characters';
  if (u.length > 20) return 'Username must be 20 characters or less';
  if (!/^[a-zA-Z0-9_-]+$/.test(u)) return 'Only letters, numbers, _ and - allowed';
  return null;
}

function validatePin(pin) {
  if (!pin) return 'PIN is required';
  if (!/^\d+$/.test(pin)) return 'PIN must be digits only';
  if (pin.length < 6) return 'PIN must be at least 6 digits';
  if (pin.length > 12) return 'PIN must be 12 digits or less';
  if (isWeakPin(pin)) return 'That PIN is too common';
  return null;
}

function validateEmail(email) {
  if (!email) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Invalid email';
  return null;
}

async function getUpcomingEvents(limit = 3) {
  try {
    const nowIso = new Date().toISOString();
    const { data } = await admin
      .from('calendar_events')
      .select('title, currency, impact, event_timestamp')
      .in('impact', ['high', 'medium'])
      .gt('event_timestamp', nowIso)
      .order('event_timestamp', { ascending: true })
      .limit(limit);
    return data || [];
  } catch { return []; }
}

async function signup({ username, pin, email }) {
  const uErr = validateUsername(username);
  if (uErr) throw new Error(uErr);
  const pErr = validatePin(pin);
  if (pErr) throw new Error(pErr);
  const eErr = validateEmail(email);
  if (eErr) throw new Error(eErr);

  const { data: avail } = await admin.rpc('username_available', { name: username });
  if (!avail) throw new Error('Username is already taken');

  const internalEmail = `${username.toLowerCase()}@wills-ai.local`;
  const { data: created, error: authErr } = await admin.auth.admin.createUser({
    email: internalEmail, password: pin, email_confirm: true,
    user_metadata: { username },
  });

  if (authErr) {
    if (authErr.message.includes('already registered')) throw new Error('Username is already taken');
    throw new Error('Signup failed: ' + authErr.message);
  }

  const userId = created.user.id;
  const { error: profErr } = await admin.from('profiles').insert({
    id: userId, username, email: email || null,
  });

  if (profErr) {
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    throw new Error('Could not create profile: ' + profErr.message);
  }

  const session = await login({ username, pin });

  if (email) {
    (async () => {
      try {
        const profile = { username, email, timezone: 'UTC' };
        const events = await getUpcomingEvents(3);
        const { subject, html } = welcomeEmail(profile, events);
        await sendEmail({ to: email, subject, html });
      } catch (err) { console.error('[auth] welcome failed:', err.message); }
    })();
  }

  return { user: { id: userId, username, email: email || null }, session };
}

async function login({ username, pin }) {
  if (!username || !pin) throw new Error('Username and PIN required');
  const internalEmail = `${username.toLowerCase()}@wills-ai.local`;
  const supabase = anonClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email: internalEmail, password: pin });
  if (error) throw new Error('Invalid username or PIN');
  return {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: data.session.expires_at,
    userId: data.user.id,
  };
}

async function refresh(refreshToken) {
  const supabase = anonClient();
  const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
  if (error) throw new Error('Session expired');
  return {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: data.session.expires_at,
    userId: data.user.id,
  };
}

async function getProfile(accessToken) {
  const { data: userData, error: uErr } = await admin.auth.getUser(accessToken);
  if (uErr || !userData?.user) throw new Error('Invalid session');
  const { data, error } = await admin.from('profiles').select('*').eq('id', userData.user.id).single();
  if (error) throw new Error('Profile not found');
  return data;
}

async function updateProfile(accessToken, updates) {
  const { data: userData, error: uErr } = await admin.auth.getUser(accessToken);
  if (uErr || !userData?.user) throw new Error('Invalid session');

  const allowed = ['phone','country','timezone','email_alerts','alert_minutes',
    'currencies','alert_impact','news_categories','email','alert_channels'];

  const clean = {};
  for (const key of allowed) if (key in updates) clean[key] = updates[key];
  if (!Object.keys(clean).length) throw new Error('No valid fields');

  const { data, error } = await admin.from('profiles').update(clean)
    .eq('id', userData.user.id).select('*').single();
  if (error) throw new Error('Update failed: ' + error.message);
  return data;
}

module.exports = { signup, login, refresh, getProfile, updateProfile };
