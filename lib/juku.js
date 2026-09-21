'use strict';
// 果果剧库联动：排班站加成员时自动建短剧账号 + 存量成员一键同步补建。
// 只依赖剧库原生管理接口（登录 → 会话身份 → 建/列账号），剧库不可达时不阻塞排班站主流程。
const crypto = require('crypto');

// 剧库密码规则 10–128 位；生成 16 位随机（去掉易混字符）
function genPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function configured(db) {
  const c = db.config;
  return !!(c.jukuBaseUrl && c.jukuAdminUser && c.jukuAdminPassword);
}

class Client {
  constructor(cfg) {
    this.base = String(cfg.jukuBaseUrl || '').replace(/\/+$/, '');
    this.adminUser = String(cfg.jukuAdminUser || '');
    this.adminPass = String(cfg.jukuAdminPassword || '');
    this.jar = {}; // cookie 名 → 值（需同时携带"浏览器身份"与"登录会话"两类 Cookie）
    this.viewerId = '';
    this.sourceChoices = [];
  }

  cookieHeader() {
    return Object.entries(this.jar)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  async req(method, path, body) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.cookieHeader() ? { Cookie: this.cookieHeader() } : {}),
        ...(this.viewerId ? { 'X-Juku-Viewer': this.viewerId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const setCookies = (typeof res.headers.getSetCookie === 'function')
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    for (const sc of setCookies) {
      const [pair] = String(sc).split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) {
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (value) this.jar[name] = value;
        else delete this.jar[name];
      }
    }
    let j = null;
    try { j = await res.json(); } catch { /* 非 JSON */ }
    if (!res.ok) {
      const msg = j && (j.error || j.code) ? String(j.error || j.code) : `HTTP ${res.status}`;
      throw new Error(`剧库：${msg}`);
    }
    return j;
  }

  async login() {
    // 剧库的完整登录时序（与浏览器一致）：
    // ① 建立"浏览器身份"Cookie → ② 确认身份拿匿名 ID（登录接口要求带 X-Juku-Viewer 头）
    // ③ 登录 → ④ 登录后身份切换为账号 ID（后续管理操作的头必须与其一致）
    await this.req('GET', '/api/ui/viewer');
    let v = await this.req('GET', '/api/ui/viewer?confirm=1');
    if (!v || !v.ready) v = await this.req('GET', '/api/ui/viewer');
    if (!v || !v.ready || !v.id) throw new Error('无法建立剧库浏览器身份');
    this.viewerId = v.id;
    const r = await this.req('POST', '/api/ui/account/login', {
      username: this.adminUser, password: this.adminPass,
    });
    if (!r || r.ok !== true) throw new Error('剧库管理员登录失败，请检查地址/账号/密码');
    v = await this.req('GET', '/api/ui/viewer');
    if (!v || !v.ready) v = await this.req('GET', '/api/ui/viewer?confirm=1');
    if (!v || !v.ready || !/^[a-f0-9]{64}$/.test(v.id || '')) {
      throw new Error('无法获取剧库会话身份');
    }
    this.viewerId = v.id;
  }

  async listAccounts() {
    const r = await this.req('GET', '/api/ui/admin/accounts');
    // sourceChoices 是 [{id, name}] 对象数组，建号接口要的是 id 字符串数组
    if (Array.isArray(r.sourceChoices)) {
      this.sourceChoices = r.sourceChoices
        .map((s) => (typeof s === 'string' ? s : s && s.id))
        .filter((x) => typeof x === 'string' && x);
    }
    return Array.isArray(r.data) ? r.data : [];
  }

  async setPolicy(requireLogin, allowRegistration) {
    await this.req('POST', '/api/ui/admin/settings', {
      requireLogin: !!requireLogin, allowRegistration: !!allowRegistration,
    });
  }

  async createAccount(username, password, onlineOnly) {
    await this.req('POST', '/api/ui/admin/accounts', {
      username,
      password,
      sources: this.sourceChoices.length ? this.sourceChoices : ['hongguo'],
      onlineOnly: !!onlineOnly,
    });
  }
}

async function connect(db) {
  const c = new Client(db.config);
  await c.login();
  return c;
}

// 加成员时自动建短剧号：{created:true,password} / {existed:true} / {skipped:true} / {error}
async function ensureAccount(store, { username }) {
  const db = store.data;
  if (!configured(db)) return { skipped: true, reason: '未配置剧库联动' };
  try {
    const c = await connect(db);
    const accounts = await c.listAccounts();
    const uname = String(username || '').trim().toLowerCase();
    if (accounts.some((a) => String(a.username || '').toLowerCase() === uname)) {
      return { existed: true };
    }
    const password = genPassword();
    await c.createAccount(username, password, true); // 默认仅在线观看，保护服务器
    return { created: true, password };
  } catch (e) {
    return { error: e.message };
  }
}

// 存量同步：给所有还没有短剧账号的成员补建，返回一次性密码列表
async function syncAll(store, actor, { initPolicy = false } = {}) {
  const db = store.data;
  if (!configured(db)) throw new Error('请先保存剧库地址与管理员账号密码');
  const c = await connect(db);
  const accounts = await c.listAccounts();
  const existing = new Set(accounts.map((a) => String(a.username || '').toLowerCase()));
  const created = [];
  const failed = [];
  for (const p of db.people) {
    const uname = String(p.name || '').trim().toLowerCase();
    if (!uname || existing.has(uname)) continue;
    const password = genPassword();
    try {
      await c.createAccount(p.name, password, true);
      existing.add(uname);
      created.push({ name: p.name, password });
    } catch (e) {
      failed.push({ name: p.name, error: e.message });
    }
  }
  let policyError = '';
  if (initPolicy) {
    try {
      await c.setPolicy(true, false); // 必须登录、关闭自助注册
    } catch (e) {
      policyError = e.message;
    }
  }
  store.addLog(actor, 'admin', '短剧账号同步',
    `补建 ${created.length} 个${failed.length ? `，失败 ${failed.length} 个` : ''}${initPolicy ? '；已开启剧库必须登录/关闭注册' : ''}`);
  store.save();
  return { ok: failed.length === 0 && !policyError, created, failed, policyError, total: db.people.length };
}

module.exports = { configured, ensureAccount, syncAll, genPassword };
