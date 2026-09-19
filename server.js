'use strict';
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Store, hashPassword } = require('./lib/store');
const auth = require('./lib/auth');
const sch = require('./lib/scheduler');
const feishu = require('./lib/feishu');
const ai = require('./lib/ai');
const cronJob = require('./lib/cron');

const store = new Store();
const app = express();
const PORT = Number(process.env.PORT) || 8787;

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(auth.middleware(store));

// 统一捕获 async 异常
const ah = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error('[error]', e);
    res.status(500).json({ error: '服务器内部错误' });
  });
};

const cfg = () => store.data.config;
const nameOf = (id) => {
  const p = id ? store.personById(id) : null;
  return p ? p.name : null;
};

// —— 公共辅助 ——
function weekOrCurrent(req) {
  const w = String(req.query.week || (req.body && req.body.weekStart) || '');
  if (sch.isDateStr(w) && sch.weekStartOf(w) === w) return w;
  return sch.weekStartOf(sch.todayStr(cfg().timezone));
}

// 自动生成：本周起 4 周（只填空缺；已人工弃班/导入的不会被动）
function ensureHorizon() {
  const db = store.data;
  const cur = sch.weekStartOf(sch.todayStr(db.config.timezone));
  let changed = false;
  for (let i = 0; i < 4; i++) changed = sch.ensureWeekGenerated(db, sch.addDays(cur, 7 * i)) || changed;
  if (changed) store.save();
}

function sendStatus(db) {
  return { webhookConfigured: !!db.config.webhookUrl, lastSend: db.lastSend };
}

function queueResendsFor(dates, trigger) {
  const weeks = new Set(dates.map((d) => sch.weekStartOf(d)));
  for (const w of weeks) feishu.queueResend(store, w, trigger);
}

function viewWeek(db, ws) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = sch.addDays(ws, i);
    const e = db.schedule[date];
    const p = e && e.personId ? db.people.find((x) => x.id === e.personId) : null;
    days.push({
      date,
      weekday: sch.WEEKDAY_CN[i],
      personId: p ? p.id : null,
      name: p ? p.name : null,
      hours: p ? sch.entryHours(db, e) : null,
      note: (e && e.note) || '',
    });
  }
  return days;
}

// —— 登录 / 会话 ——
app.get('/api/people', (req, res) => {
  res.json({ people: store.data.people.map((p) => p.name) });
});

app.post('/api/login', (req, res) => {
  const { name, password } = req.body || {};
  if (!name || !password) return res.status(400).json({ error: '请输入姓名和密码' });
  const key = `${String(name).toLowerCase()}|${req.ip}`;
  if (auth.loginThrottled(key)) return res.status(429).json({ error: '失败次数过多，请 1 分钟后再试' });

  const person = store.personByName(name);
  if (person && auth.verifyPassword(password, person.salt, person.passwordHash)) {
    auth.clearFails(key);
    const token = auth.createSession(store, { role: 'user', userId: person.id, name: person.name });
    return res.json({ token, me: { role: 'user', name: person.name } });
  }
  if (/^admin$/i.test(String(name)) && auth.verifyPassword(password, cfg().adminSalt, cfg().adminPasswordHash)) {
    auth.clearFails(key);
    const token = auth.createSession(store, { role: 'admin', userId: 'admin', name: '管理员' });
    return res.json({ token, me: { role: 'admin', name: '管理员' } });
  }
  auth.recordFail(key);
  res.status(401).json({ error: '姓名或密码错误' });
});

app.post('/api/logout', (req, res) => {
  auth.destroySession(store, req.token);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.auth) return res.status(401).json({ error: '请先登录' });
  res.json({ me: req.auth });
});

// —— 修改自己的密码（管理员则是管理员密码）——
app.post('/api/password', auth.requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (typeof newPassword !== 'string' || newPassword.length < 4) {
    return res.status(400).json({ error: '新密码至少 4 位' });
  }
  if (req.auth.role === 'admin') {
    if (!auth.verifyPassword(oldPassword, cfg().adminSalt, cfg().adminPasswordHash)) {
      return res.status(400).json({ error: '原密码错误' });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    cfg().adminSalt = salt;
    cfg().adminPasswordHash = hashPassword(newPassword, salt);
  } else {
    const p = store.personById(req.auth.userId);
    if (!p || !auth.verifyPassword(oldPassword, p.salt, p.passwordHash)) {
      return res.status(400).json({ error: '原密码错误' });
    }
    p.salt = crypto.randomBytes(16).toString('hex');
    p.passwordHash = hashPassword(newPassword, p.salt);
  }
  store.addLog(req.auth.name, req.auth.role, '修改密码', '修改了自己的登录密码');
  store.save();
  res.json({ ok: true });
});

// —— 排班查询 ——
app.get('/api/schedule', auth.requireAuth, (req, res) => {
  ensureHorizon();
  const db = store.data;
  const ws = weekOrCurrent(req);
  res.json({
    weekStart: ws,
    isoWeek: sch.isoWeek(ws),
    days: viewWeek(db, ws),
    today: sch.todayStr(db.config.timezone),
    people: db.people.map((p) => ({ id: p.id, name: p.name })),
    config: {
      shiftStart: db.config.shiftStart,
      shiftEnd: db.config.shiftEnd,
      shiftHours: db.config.shiftHours,
      publicUrl: db.config.publicUrl,
      generated: db.weeksGenerated.includes(ws),
    },
    me: req.auth,
    ...sendStatus(db),
  });
});

// 我的全部排班日（换班弹窗用）
app.get('/api/my-days', auth.requireAuth, (req, res) => {
  const db = store.data;
  const mine = req.auth.role === 'admin' ? null : req.auth.userId;
  const out = [];
  for (const [date, e] of Object.entries(db.schedule).sort()) {
    if (!e || !e.personId) continue;
    if (mine && e.personId !== mine) continue;
    out.push({ date, name: nameOf(e.personId), hours: sch.entryHours(db, e) });
  }
  res.json({ days: out });
});

// —— 排班变更（普通成员：换班 / 认领 / 弃班）——
app.post('/api/swap', auth.requireAuth, ah(async (req, res) => {
  const { fromDate, toDate } = req.body || {};
  if (!sch.isDateStr(fromDate) || !sch.isDateStr(toDate) || fromDate === toDate) {
    return res.status(400).json({ error: '日期参数不正确' });
  }
  const db = store.data;
  const a = db.schedule[fromDate];
  const b = db.schedule[toDate];
  if (!a || !a.personId || !b || !b.personId) {
    return res.status(400).json({ error: '两个日期都需要已有人排班才能互换' });
  }
  if (req.auth.role !== 'admin' && a.personId !== req.auth.userId) {
    return res.status(403).json({ error: '只能换自己的班，请先选择自己的日期' });
  }
  db.schedule[fromDate] = { ...b };
  db.schedule[toDate] = { ...a };
  store.addLog(req.auth.name, req.auth.role, '换班',
    `${nameOf(b.personId) || '?'}（${fromDate}）与 ${nameOf(a.personId) || '?'}（${toDate}）互换`);
  store.save();
  queueResendsFor([fromDate, toDate], `${req.auth.name}换班后自动重发`);
  res.json({ ok: true, ...sendStatus(db) });
}));

app.post('/api/claim', auth.requireAuth, (req, res) => {
  const { date } = req.body || {};
  if (!sch.isDateStr(date)) return res.status(400).json({ error: '日期不正确' });
  const db = store.data;
  const e = db.schedule[date];
  if (e && e.personId) return res.status(400).json({ error: '该天已有人排班，不能认领' });
  if (req.auth.role !== 'user') return res.status(403).json({ error: '管理员请使用「指派」功能' });
  db.schedule[date] = { personId: req.auth.userId };
  store.addLog(req.auth.name, req.auth.role, '认领空班', `认领 ${date} 的空缺班次`);
  store.save();
  queueResendsFor([date], `${req.auth.name}认领空班后自动重发`);
  res.json({ ok: true, ...sendStatus(db) });
});

app.post('/api/release', auth.requireAuth, (req, res) => {
  const { date } = req.body || {};
  if (!sch.isDateStr(date)) return res.status(400).json({ error: '日期不正确' });
  const db = store.data;
  const e = db.schedule[date];
  if (!e || !e.personId) return res.status(400).json({ error: '该天没有排班' });
  if (e.personId !== req.auth.userId) return res.status(403).json({ error: '只能放弃自己的班' });
  delete db.schedule[date];
  store.addLog(req.auth.name, req.auth.role, '弃班', `放弃 ${date} 的班次，该天空缺待认领`);
  store.save();
  queueResendsFor([date], `${req.auth.name}弃班后自动重发`);
  res.json({ ok: true, ...sendStatus(db) });
});

// —— 管理员：指派 / 重新生成 / 批量导入 / 清空 ——
app.post('/api/set', auth.requireAdmin, (req, res) => {
  const { date, personId, hours, note } = req.body || {};
  if (!sch.isDateStr(date)) return res.status(400).json({ error: '日期不正确' });
  const db = store.data;
  if (personId === null || personId === '' || personId === undefined) {
    delete db.schedule[date];
    store.addLog(req.auth.name, 'admin', '修改排班', `${date} 清空`);
  } else {
    if (!store.personById(personId)) return res.status(400).json({ error: '人员不存在' });
    const entry = { personId };
    if (hours !== undefined && hours !== null && hours !== '') {
      const h = Number(hours);
      if (!Number.isFinite(h) || h <= 0 || h > 24) return res.status(400).json({ error: '工时需在 0-24 之间' });
      entry.hours = h;
    }
    if (note) entry.note = String(note).slice(0, 100);
    db.schedule[date] = entry;
    store.addLog(req.auth.name, 'admin', '修改排班',
      `${date} 指派给 ${nameOf(personId)}${entry.hours ? `（${entry.hours}h）` : ''}${entry.note ? ` 备注：${entry.note}` : ''}`);
  }
  store.save();
  queueResendsFor([date], '管理员修改排班后自动重发');
  res.json({ ok: true, ...sendStatus(db) });
});

app.post('/api/regen', auth.requireAdmin, (req, res) => {
  const ws = String((req.body || {}).weekStart || '');
  if (!sch.isDateStr(ws) || sch.weekStartOf(ws) !== ws) return res.status(400).json({ error: '需要有效的周一日期' });
  const db = store.data;
  for (let i = 0; i < 7; i++) delete db.schedule[sch.addDays(ws, i)];
  db.weeksGenerated = db.weeksGenerated.filter((w) => w !== ws);
  sch.ensureWeekGenerated(db, ws);
  store.addLog(req.auth.name, 'admin', '重新生成', `按轮换规则重新生成 ${ws} 起的一周`);
  store.save();
  feishu.queueResend(store, ws, '管理员重新生成排班后自动重发');
  res.json({ ok: true, ...sendStatus(db) });
});

app.post('/api/import', auth.requireAdmin, (req, res) => {
  const text = String((req.body || {}).text || '');
  const db = store.data;
  const applied = [];
  const errors = [];
  const weeks = new Set();
  text.split(/\r?\n/).forEach((line, idx) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const m = t.match(/^(\d{4}-\d{2}-\d{2})[\s,，\t]+(.+)$/);
    if (!m) { errors.push(`第 ${idx + 1} 行无法解析：${t.slice(0, 40)}`); return; }
    const date = m[1];
    const personName = m[2].trim();
    if (!sch.isDateStr(date)) { errors.push(`第 ${idx + 1} 行日期无效：${date}`); return; }
    if (personName === '-' || personName === '空') {
      delete db.schedule[date];
      applied.push(`${date} 清空`);
      weeks.add(sch.weekStartOf(date));
      return;
    }
    const p = store.personByName(personName);
    if (!p) { errors.push(`第 ${idx + 1} 行人员不存在：${personName}`); return; }
    db.schedule[date] = { personId: p.id };
    applied.push(`${date} → ${p.name}`);
    weeks.add(sch.weekStartOf(date));
  });
  for (const w of weeks) if (!db.weeksGenerated.includes(w)) db.weeksGenerated.push(w); // 导入视为权威，防自动回填
  store.addLog(req.auth.name, 'admin', '批量导入', `${applied.length} 条生效${errors.length ? `，${errors.length} 条失败` : ''}`);
  store.save();
  for (const w of weeks) feishu.queueResend(store, w, '管理员批量导入排班后自动重发');
  res.json({ ok: true, applied, errors, ...sendStatus(db) });
});

app.post('/api/clear', auth.requireAdmin, (req, res) => {
  if ((req.body || {}).confirm !== 'CLEAR') return res.status(400).json({ error: '请输入 CLEAR 确认清空' });
  const db = store.data;
  db.schedule = {};
  db.weeksGenerated = [];
  store.addLog(req.auth.name, 'admin', '清空排班', '清空全部排班后重新生成了未来 4 周占位');
  store.save();
  ensureHorizon();
  res.json({ ok: true });
});

// —— 管理员：统计 / 日志 / 配置 ——
app.get('/api/stats', auth.requireAdmin, (req, res) => {
  ensureHorizon();
  res.json(sch.computeStats(store.data));
});

app.get('/api/logs', auth.requireAdmin, (req, res) => {
  const limit = Math.min(300, Number(req.query.limit) || 100);
  res.json({ logs: store.data.logs.slice(0, limit) });
});

const CONFIG_EDITABLE = [
  'webhookUrl', 'webhookSecret', 'publicUrl', 'timezone',
  'sendHour', 'sendMinute', 'shiftStart', 'shiftEnd', 'shiftHours', 'resendDelayMs',
  'aiBaseUrl', 'aiModel', 'aiCheckHour', 'aiCheckMinute', 'aiCheckDays', 'aiApplyMode',
];

app.get('/api/config', auth.requireAdmin, (req, res) => {
  const c = { ...store.data.config };
  const key = String(c.aiApiKey || '');
  c.hasAiKey = !!key;
  c.aiKeyMask = key ? `${key.slice(0, 5)}…${key.slice(-4)}` : '';
  c.lastSend = store.data.lastSend;
  delete c.aiApiKey;
  delete c.adminPasswordHash;
  delete c.adminSalt;
  res.json(c);
});

app.post('/api/config', auth.requireAdmin, (req, res) => {
  const body = req.body || {};
  const c = store.data.config;
  const touched = [];
  for (const k of CONFIG_EDITABLE) {
    if (body[k] !== undefined) { c[k] = body[k]; touched.push(k); }
  }
  // aiApiKey 特殊处理：不传=保持不变；'CLEAR'=删除；非空=更新（接口永不回显）
  if (body.aiApiKey !== undefined) {
    const v = String(body.aiApiKey).trim();
    if (v === 'CLEAR') { c.aiApiKey = ''; touched.push('aiApiKey(删除)'); }
    else if (v) { c.aiApiKey = v; touched.push('aiApiKey'); }
  }
  c.sendHour = Math.min(23, Math.max(0, c.sendHour | 0));
  c.sendMinute = Math.min(59, Math.max(0, c.sendMinute | 0));
  c.aiCheckHour = Math.min(23, Math.max(0, c.aiCheckHour | 0));
  c.aiCheckMinute = Math.min(59, Math.max(0, c.aiCheckMinute | 0));
  c.aiCheckDays = Math.min(60, Math.max(1, c.aiCheckDays | 0 || 14));
  c.shiftHours = Math.min(24, Math.max(0.5, Number(c.shiftHours) || 8));
  c.resendDelayMs = Math.min(60_000, Math.max(0, c.resendDelayMs | 0));
  if (c.aiApplyMode !== 'auto') c.aiApplyMode = 'notify';
  store.addLog(req.auth.name, 'admin', '修改设置', touched.length ? `更新：${touched.join('、')}` : '无变更');
  store.save();
  cronJob.reschedule(store);   // 发送时刻可能变了
  cronJob.catchup(store);      // 补发判断（如刚配好 webhook）
  res.json({ ok: true });
});

app.post('/api/send-now', auth.requireAdmin, ah(async (req, res) => {
  ensureHorizon();
  const ws = weekOrCurrent(req);
  const result = await feishu.sendWeekNow(store, ws, `管理员（${req.auth.name}）手动发送`);
  res.json({ ok: result.ok, error: result.error || '', ...sendStatus(store.data) });
}));

// —— 管理员：AI 建议 ——
app.post('/api/ai/check-now', auth.requireAdmin, ah(async (req, res) => {
  const result = await ai.nightlyCheck(store, { force: true });
  res.json(result);
}));

app.get('/api/ai/suggestions', auth.requireAdmin, (req, res) => {
  res.json({
    suggestions: store.data.aiSuggestions.map((s) => ({
      ...s,
      changes: s.changes.map((c) => ({
        ...c,
        toName: nameOf(c.toPersonId),
        fromName: nameOf(c.fromPersonId),
      })),
    })),
  });
});

app.post('/api/ai/apply', auth.requireAdmin, ah(async (req, res) => {
  const s = await ai.applySuggestion(store, String((req.body || {}).id || ''), req.auth.name);
  res.json({ ok: true, suggestion: s });
}));

app.post('/api/ai/ignore', auth.requireAdmin, (req, res) => {
  ai.ignoreSuggestion(store, String((req.body || {}).id || ''), req.auth.name);
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

// —— 启动 ——
ensureHorizon();
cronJob.start(store);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`加班排班服务已启动: http://0.0.0.0:${PORT}`);
  console.log(`周一发送时刻: ${cfg().sendHour}:${String(cfg().sendMinute).padStart(2, '0')}（${cfg().timezone}），AI夜检: ${cfg().aiCheckHour}:${String(cfg().aiCheckMinute).padStart(2, '0')}`);
});
