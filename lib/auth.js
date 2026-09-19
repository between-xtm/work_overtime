'use strict';
const crypto = require('crypto');
const { hashPassword } = require('./store');

const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;

function verifyPassword(password, salt, storedHash) {
  const h = Buffer.from(hashPassword(password, salt), 'hex');
  const s = Buffer.from(storedHash, 'hex');
  return h.length === s.length && crypto.timingSafeEqual(h, s);
}

// —— 登录限速：同一 用户名+IP 一分钟内最多失败 5 次 ——
const fails = new Map();
function loginThrottled(key) {
  const rec = fails.get(key);
  return !!rec && rec.count >= 5 && Date.now() - rec.time < 60_000;
}
function recordFail(key) {
  const rec = fails.get(key) || { count: 0, time: Date.now() };
  rec.count += 1;
  rec.time = Date.now();
  fails.set(key, rec);
}
function clearFails(key) { fails.delete(key); }

function createSession(store, { role, userId, name }) {
  const token = crypto.randomBytes(32).toString('hex');
  store.sessions[token] = { role, userId, name, expires: Date.now() + TOKEN_TTL_MS };
  for (const [t, s] of Object.entries(store.sessions)) {
    if (s.expires < Date.now()) delete store.sessions[t];
  }
  store.saveSessions();
  return token;
}

function destroySession(store, token) {
  if (token && store.sessions[token]) {
    delete store.sessions[token];
    store.saveSessions();
  }
}

function middleware(store) {
  return (req, res, next) => {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    req.token = token;
    req.auth = null;
    if (token && store.sessions[token]) {
      const s = store.sessions[token];
      // 会话过期，或成员已被管理员移除（账号不存在了）→ 立即失效
      const personGone = s.role === 'user' && !store.personById(s.userId);
      if (s.expires <= Date.now() || personGone) {
        destroySession(store, token);
      } else {
        req.auth = s;
      }
    }
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.auth) return res.status(401).json({ error: '请先登录' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.auth) return res.status(401).json({ error: '请先登录' });
  if (req.auth.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}

module.exports = {
  verifyPassword, createSession, destroySession, middleware,
  requireAuth, requireAdmin, loginThrottled, recordFail, clearFails,
};
