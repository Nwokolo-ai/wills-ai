const { admin, anonClient } = require('./db');
const { sendEmail, welcomeEmail } = require('./mailer');

// ... [Keep your existing WEAK_PINS, isWeakPin, validateUsername, validatePin, validateEmail functions here] ...

async function signup({ username, pin, email }) {
  const uErr = validateUsername(username);
  if (uErr) throw new Error(uErr);
  const pErr = validatePin(pin);
  if (pErr) throw new Error(pErr);
  const eErr = validateEmail(email);
  if (eErr) throw new Error(eErr);
  if (!email) throw new Error('Email is required for account recovery');

  const { data: avail } = await admin.rpc('username_available', { name: username });
  if (!avail) throw new Error('Username is already taken');

  const internalEmail = `${username.toLowerCase()}@wills-ai.local`;
  const { data: created, error: authErr } = await admin.auth.admin.createUser({
    email: internalEmail, password: pin, email_confirm: true, user_metadata: { username },
  });

  if (authErr) throw new Error('Signup failed: ' + authErr.message);

  const userId = created.user.id;
  await admin.from('profiles').insert({ id: userId, username, email });

  const session = await login({ username, pin });

  if (email) {
    (async () => {
      try {
        const events = await getUpcomingEvents(3);
        const { subject, html } = welcomeEmail({ username, email }, events);
        await sendEmail({ to: email, subject, html });
      } catch (err) {}
    })();
  }

  return { user: { id: userId, username, email }, session };
}

async function login({ username, pin }) {
  if (!username || !pin) throw new Error('Username and PIN required');
  const internalEmail = `${username.toLowerCase()}@wills-ai.local`;
  const supabase = anonClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email: internalEmail, password: pin });
  if (error) throw new Error('Invalid username or PIN');
  
  return {
    accessToken: data.session.access_token, refreshToken: data.session.refresh_token,
    expiresAt: data.session.expires_at, userId: data.user.id,
  };
}

// NEW: Forgot PIN function
async function forgotPin(username) {
  if (!username) throw new Error('Username is required');
  
  // 1. Look up the user's real email in the profiles table
  const { data: profile } = await admin.from('profiles').select('email').eq('username', username).maybeSingle();
  if (!profile || !profile.email) throw new Error('No account found with that username, or no email on file.');

  const internalEmail = `${username.toLowerCase()}@wills-ai.local`;
  
  // 2. Generate Supabase reset link
  const { data, error } = await admin.auth.admin.generateLink({
    type: 'recovery',
    email: internalEmail,
    options: { redirectTo: `${process.env.PUBLIC_URL}/` } 
  });
  if (error) throw new Error('Could not generate reset link');

  // 3. Extract the OTP token from the link and send it to their real email
  const link = data.properties.action_link;
  const { sendEmail, resetPinEmail } = require('./mailer');
  const { subject, html } = resetPinEmail(username, link);
  
  const r = await sendEmail({ to: profile.email, subject, html });
  if (!r.ok) throw new Error('Failed to send email. Please try again later.');
  
  return { success: true };
}

// Add this function to auth.js

async function resetPinWithToken(accessToken, newPin) {
  if (!accessToken || !newPin) throw new Error('Missing token or PIN');
  if (newPin.length < 6 || newPin.length > 12) throw new Error('PIN must be 6-12 digits');

  // 1. Verify the token and get the user
  const { data: userData, error: uErr } = await admin.auth.getUser(accessToken);
  if (uErr || !userData?.user) throw new Error('Reset link expired or invalid');

  // 2. Update their password (PIN)
  const { error: updateErr } = await admin.auth.admin.updateUserById(userData.user.id, {
    password: newPin
  });
  
  if (updateErr) throw new Error('Failed to update PIN: ' + updateErr.message);
  return { success: true };
}

// Add it to your exports:
module.exports = { signup, login, forgotPin, resetPinWithToken, refresh, getProfile, updateProfile };
