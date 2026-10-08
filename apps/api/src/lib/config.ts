const jwtSecret = process.env.JWT_SECRET ?? '';
if (jwtSecret.length < 16) throw new Error('JWT_SECRET must be set (16+ characters). See apps/api/.env.example');
if (process.env.NODE_ENV === 'production' && jwtSecret.startsWith('change-me')) {
  throw new Error('JWT_SECRET still has the example value. Set a long random string.');
}

export const config = {
  // Decides "today" for date locks, warranty status and due dates.
  timezone: process.env.APP_TIMEZONE ?? 'Asia/Kolkata',
  jwtSecret,
  webOrigin: process.env.WEB_ORIGIN,
  // Session length in hours. Long enough for a shift.
  sessionHours: Number(process.env.SESSION_HOURS ?? 12),
  // Only true when the site is served over HTTPS (demo). On-prem LAN over plain HTTP needs false.
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  // Wrong passwords allowed for one login before it is locked for a while (brute-force protection).
  loginMaxFailures: Number(process.env.LOGIN_MAX_FAILURES ?? 5),
  loginLockMinutes: Number(process.env.LOGIN_LOCK_MINUTES ?? 15),
  // Proxy hops in front of the API, so req.ip (audit log) is the real client.
  trustProxy: Number(process.env.TRUST_PROXY ?? 1),
};
