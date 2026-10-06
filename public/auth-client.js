// auth-client.js — session management for the browser
const AUTH_KEYS = {
  access: 'wills_access',
  refresh: 'wills_refresh',
  expires: 'wills_exp',
  profile: 'wills_profile',
};

const Auth = {
  get accessToken() { return localStorage.getItem(AUTH_KEYS.access); },
  get refreshToken() { return localStorage.getItem(AUTH_KEYS.refresh); },
  get expiresAt() { return parseInt(localStorage.getItem(AUTH_KEYS.expires) || '0'); },
  get profile() {
    try { return JSON.parse(localStorage.getItem(AUTH_KEYS.profile) || 'null'); }
    catch { return null; }
  },
  get isLoggedIn() { return !!(this.accessToken && this.profile); },

  saveSession(session, profile) {
    localStorage.setItem(AUTH_KEYS.access, session.accessToken);
    localStorage.setItem(AUTH_KEYS.refresh, session.refreshToken);
    localStorage.setItem(AUTH_KEYS.expires, String(session.expiresAt || 0));
    if (profile) localStorage.setItem(AUTH_KEYS.profile, JSON.stringify(profile));
  },
  saveProfile(profile) {
    localStorage.setItem(AUTH_KEYS.profile, JSON.stringify(profile));
  },
  clear() {
    Object.values(AUTH_KEYS).forEach(k => localStorage.removeItem(k));
  },

  async signup(username, pin, email) {
    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, pin, email }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Signup failed');
    const profile = await this.fetchProfile(data.session.accessToken);
    this.saveSession(data.session, profile);
    return { user: data.user, profile };
  },

  async login(username, pin) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, pin }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    const profile = await this.fetchProfile(data.session.accessToken);
    this.saveSession(data.session, profile);
    return { session: data.session, profile };
  },

  async fetchProfile(token) {
    const res = await fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${token || this.accessToken}` },
    });
    if (!res.ok) throw new Error('Could not load profile');
    const data = await res.json();
    return data.profile;
  },

  async updateProfile(updates) {
    const res = await fetch('/api/auth/profile', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify(updates),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Update failed');
    this.saveProfile(data.profile);
    return data.profile;
  },

  async refreshSession() {
    if (!this.refreshToken) return false;
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: this.refreshToken }),
      });
      if (!res.ok) throw new Error('Refresh failed');
      const data = await res.json();
      this.saveSession(data.session, this.profile);
      return true;
    } catch {
      this.clear();
      return false;
    }
  },

  logout() { this.clear(); },

  async ensureFresh() {
    if (!this.isLoggedIn) return;
    const now = Math.floor(Date.now() / 1000);
    if (this.expiresAt && this.expiresAt - now < 300) {
      await this.refreshSession();
    }
  },
};

window.Auth = Auth;
