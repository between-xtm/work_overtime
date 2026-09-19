'use strict';
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Store, hashPassword, makePerson, DEFAULT_USER_PASSWORD } = require('./lib/store');
const auth = require('./lib/auth');
const sch = require('./lib/scheduler');
const feishu = require('./lib/feishu');
const ai = require('./lib/ai');
const cronJob = require('./lib/cron');

const store = new Store();
const app = express();
const PORT = Number(process.env.PORT) || 8787;

app.use(express.json({ limit: '256kb' }));
// 静态文件必须每次向服务器校验（no-cache：改动立即生效；未改动 304），
// 否则成员浏览器缓存旧版 app.js 会读不懂新接口结构，排班表显示成全空
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));
// 接口响应一律不缓存
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(auth.middleware(store));

// 统一捕获 async 异常
const ah = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error('[error]', e);
    res.status(500).json({ error: '服务器内部错误' });
  });
};

const cfg = () => store.data.config;
const gname = (id) => {
  const g = sch.groupById(store.data, id);
  return g ? g.name : '';
};
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

// 自动生成：本周起 4 周，逐组只填整天空缺；已人工弃班/导入的不会被动
function ensureHorizon() {
  const db = store.data;
  const cur = sch.weekStartOf(sch.todayStr(db.config.timezone));
  let changed = false;
  for (let i = 0; i < 4; i++) changed = sch.ensureWeekAllGroups(db, sch.addDays(cur, 7 * i)) || changed;
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
    const dayEntry = db.schedule[date] || {};
    const groups = {};
    for (const g of db.groups) {
      groups[g.id] = {
        people: sch.slotOf(db, date, g.id).map((e) => {
          const p = e && e.personId ? db.people.find((x) => x.id === e.personId) : null;
          return p
            ? {
                personId: p.id, name: p.name,
                hours: sch.entryHours(db, e, date),       // 展示口径（周六双倍已计入）
                rawHours: e && e.hours != null ? e.hours : null, // 原始存储值（编辑用）
                note: (e && e.note) || '',
              }
            : null;
        }).filter(Boolean),
      };
    }
    days.push({ date, weekday: sch.WEEKDAY_CN[i], groups });
  }
  return days;
}

// —— 登录 / 会话 ——
app.get('/api/people', (req, res) => {
  const db = store.data;
  res.json({
    people: db.people.map((p) => ({ name: p.name, group: gname(p.groupId) })),
  });
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
    groups: db.groups.map((g) => ({ id: g.id, name: g.name, memberCount: sch.peopleOf(db, g.id).length, autoRotate: g.autoRotate !== false })),
    people: db.people.map((p) => ({ id: p.id, name: p.name, groupId: p.groupId })),
    generatedMap: Object.fromEntries(db.groups.map((g) => [g.id, sch.genWeeks(db, g.id).includes(ws)])),
    config: {
      shiftStart: db.config.shiftStart,
      shiftEnd: db.config.shiftEnd,
      shiftHours: db.config.shiftHours,
      saturdayDouble: !!db.config.saturdayDouble,
      publicUrl: db.config.publicUrl,
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
  for (const [date, day] of Object.entries(db.schedule).sort()) {
    if (!day) continue;
    for (const g of db.groups) {
      for (const e of sch.slotOf(db, date, g.id)) {
        if (!e || !e.personId) continue;
        if (mine && e.personId !== mine) continue;
        out.push({ date, groupId: g.id, name: nameOf(e.personId), hours: sch.entryHours(db, e, date) });
      }
    }
  }
  res.json({ days: out });
});

// —— 排班变更（普通成员：换班 / 认领 / 弃班，均只作用于本人所在组）——
app.post('/api/swap', auth.requireAuth, ah(async (req, res) => {
  const { fromDate, toDate, withPersonId } = req.body || {};
  if (!sch.isDateStr(fromDate) || !sch.isDateStr(toDate) || fromDate === toDate) {
    return res.status(400).json({ error: '日期参数不正确' });
  }
  if (req.auth.role !== 'user') return res.status(403).json({ error: '管理员请通过「指派」调整' });
  const db = store.data;
  const me = store.personById(req.auth.userId);
  if (!me) return res.status(403).json({ error: '账号不存在' });
  const gid = me.groupId;
  const fromList = sch.slotOf(db, fromDate, gid);
  const toList = sch.slotOf(db, toDate, gid);
  const myEntry = fromList.find((e) => e.personId === me.id);
  if (!myEntry) return res.status(403).json({ error: '起始日期不是你的班，请先选择自己的日期' });
  const target = withPersonId
    ? toList.find((e) => e.personId === withPersonId)
    : toList.find((e) => e.personId !== me.id);
  if (!target) return res.status(400).json({ error: `目标日期「${gname(gid)}」没有可交换的人` });
  const targetEntry = { ...target };
  sch.setSlot(db, fromDate, gid, fromList.map((e) => (e.personId === me.id ? targetEntry : e)));
  sch.setSlot(db, toDate, gid, toList.map((e) => (e.personId === target.personId ? { ...myEntry } : e)));
  store.addLog(req.auth.name, req.auth.role, '换班',
    `${gname(gid)}：${me.name}（${fromDate}）与 ${nameOf(target.personId) || '?'}（${toDate}）互换`);
  store.save();
  queueResendsFor([fromDate, toDate], `${req.auth.name}换班后自动重发`);
  res.json({ ok: true, ...sendStatus(db) });
}));

app.post('/api/claim', auth.requireAuth, (req, res) => {
  const { date } = req.body || {};
  if (!sch.isDateStr(date)) return res.status(400).json({ error: '日期不正确' });
  if (req.auth.role !== 'user') return res.status(403).json({ error: '管理员请使用「指派」功能' });
  const db = store.data;
  const me = store.personById(req.auth.userId);
  if (!me) return res.status(403).json({ error: '账号不存在' });
  const list = sch.slotOf(db, date, me.groupId);
  if (list.some((e) => e.personId === me.id)) {
    return res.status(400).json({ error: `你已在 ${date}「${gname(me.groupId)}」的名单中` });
  }
  sch.setSlot(db, date, me.groupId, [...list, { personId: me.id }]);
  store.addLog(req.auth.name, req.auth.role, '认领空班', `认领 ${date}「${gname(me.groupId)}」的班次`);
  store.save();
  queueResendsFor([date], `${req.auth.name}认领空班后自动重发`);
  res.json({ ok: true, ...sendStatus(db) });
});

app.post('/api/release', auth.requireAuth, (req, res) => {
  const { date } = req.body || {};
  if (!sch.isDateStr(date)) return res.status(400).json({ error: '日期不正确' });
  const db = store.data;
  const me = req.auth.role === 'user' ? store.personById(req.auth.userId) : null;
  if (!me) return res.status(403).json({ error: '管理员请通过指派功能清空班次' });
  const list = sch.slotOf(db, date, me.groupId);
  if (!list.some((e) => e.personId === me.id)) {
    return res.status(400).json({ error: `该天「${gname(me.groupId)}」没有你的班` });
  }
  sch.setSlot(db, date, me.groupId, list.filter((e) => e.personId !== me.id));
  store.addLog(req.auth.name, req.auth.role, '弃班', `放弃 ${date}「${gname(me.groupId)}」的班次，留空待认领`);
  store.save();
  queueResendsFor([date], `${req.auth.name}弃班后自动重发`);
  res.json({ ok: true, ...sendStatus(db) });
});

// —— 管理员：按组指派（整天名单）/ 重新生成 / 批量导入 / 清空 ——
app.post('/api/set', auth.requireAdmin, (req, res) => {
  const { date, groupId, entries } = req.body || {};
  if (!sch.isDateStr(date)) return res.status(400).json({ error: '日期不正确' });
  const db = store.data;
  if (!sch.groupById(db, groupId)) return res.status(400).json({ error: '分组不正确' });

  const list = [];
  if (Array.isArray(entries)) {
    for (const raw of entries) {
      if (!raw || !raw.personId) continue;
      const p = store.personById(raw.personId);
      if (!p) return res.status(400).json({ error: '人员不存在' });
      if (p.groupId !== groupId) return res.status(400).json({ error: `${p.name} 不在「${gname(groupId)}」中` });
      const entry = { personId: p.id };
      if (raw.hours !== undefined && raw.hours !== null && raw.hours !== '') {
        const h = Number(raw.hours);
        if (!Number.isFinite(h) || h <= 0 || h > 24) return res.status(400).json({ error: '工时需在 0-24 之间' });
        entry.hours = h;
      }
      if (raw.note) entry.note = String(raw.note).slice(0, 100);
      if (list.some((e) => e.personId === entry.personId)) {
        return res.status(400).json({ error: `${p.name} 在同一天被安排了两次` });
      }
      list.push(entry);
    }
  }
  const before = sch.slotOf(db, date, groupId).map((e) => nameOf(e.personId)).filter(Boolean).join('、') || '空缺';
  const after = list.map((e) => nameOf(e.personId)).filter(Boolean).join('、') || '空缺';
  sch.setSlot(db, date, groupId, list);
  store.addLog(req.auth.name, 'admin', '修改排班',
    `${gname(groupId)} ${date}：${before} → ${after}${list.length > 1 ? `（${list.length} 人）` : ''}`);
  store.save();
  queueResendsFor([date], '管理员修改排班后自动重发');
  res.json({ ok: true, ...sendStatus(db) });
});

app.post('/api/regen', auth.requireAdmin, (req, res) => {
  const { weekStart, groupId } = req.body || {};
  if (!sch.isDateStr(weekStart) || sch.weekStartOf(weekStart) !== weekStart) {
    return res.status(400).json({ error: '需要有效的周一日期' });
  }
  const db = store.data;
  const grp = sch.groupById(db, groupId);
  if (!grp) return res.status(400).json({ error: '分组不正确' });
  if (grp.autoRotate === false) {
    return res.status(400).json({ error: `「${grp.name}」已关闭自动轮换（由 AI/手动排班），“按轮换重排”不可用；请到「AI排班」生成` });
  }
  for (let i = 0; i < 7; i++) sch.setSlot(db, sch.addDays(weekStart, i), groupId, []);
  db.weeksGenerated[groupId] = sch.genWeeks(db, groupId).filter((w) => w !== weekStart);
  sch.ensureWeekGenerated(db, weekStart, groupId);
  store.addLog(req.auth.name, 'admin', '重新生成', `按轮换规则重新生成「${gname(groupId)}」${weekStart} 起的一周`);
  store.save();
  feishu.queueResend(store, weekStart, '管理员重新生成排班后自动重发');
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
    if (!sch.isDateStr(date)) { errors.push(`第 ${idx + 1} 行日期无效：${date}`); return; }
    const rest = m[2].trim();
    if (rest === '-' || rest === '空') {
      for (const g of db.groups) sch.setSlot(db, date, g.id, []); // '-' 表示清空整天（两组都清）
      applied.push(`${date} 清空`);
      weeks.add(sch.weekStartOf(date));
      for (const g of db.groups) {
        if (!sch.genWeeks(db, g.id).includes(sch.weekStartOf(date))) sch.genWeeks(db, g.id).push(sch.weekStartOf(date));
      }
      return;
    }
    const names = rest.split(/[,，、\s]+/).filter(Boolean);
    if (!names.length) { errors.push(`第 ${idx + 1} 行没有人员姓名`); return; }
    const byGroup = {};
    for (const nm of names) {
      // 优先按姓名匹配，匹配不到再按代号（方便直接粘贴规则里的 a/b/c）
      const p = store.personByName(nm)
        || db.people.find((x) => x.code && x.code.toLowerCase() === nm.toLowerCase());
      if (!p) { errors.push(`第 ${idx + 1} 行人员不存在：${nm}`); return; }
      (byGroup[p.groupId] = byGroup[p.groupId] || []).push(p);
    }
    for (const [gid, ps] of Object.entries(byGroup)) {
      sch.setSlot(db, date, gid, ps.map((p) => ({ personId: p.id })));
      if (!sch.genWeeks(db, gid).includes(sch.weekStartOf(date))) sch.genWeeks(db, gid).push(sch.weekStartOf(date));
    }
    applied.push(`${date}：${names.join('、')}`);
    weeks.add(sch.weekStartOf(date));
  });
  store.addLog(req.auth.name, 'admin', '批量导入', `${applied.length} 条生效${errors.length ? `，${errors.length} 条失败` : ''}`);
  store.save();
  for (const w of weeks) feishu.queueResend(store, w, '管理员批量导入排班后自动重发');
  res.json({ ok: true, applied, errors, ...sendStatus(db) });
});

app.post('/api/clear', auth.requireAdmin, (req, res) => {
  if ((req.body || {}).confirm !== 'CLEAR') return res.status(400).json({ error: '请输入 CLEAR 确认清空' });
  const keepEmpty = (req.body || {}).keepEmpty !== false; // 默认保持全空（清空即归零）
  const db = store.data;
  db.schedule = {};
  for (const g of db.groups) db.weeksGenerated[g.id] = [];
  // 清空排班后，旧的待处理建议全部失效（防止应用到已不存在的旧排班上）
  let ignored = 0;
  for (const s of db.aiSuggestions) {
    if (s.status === 'pending') {
      s.status = 'ignored';
      s.appliedTime = sch.nowDisplay(db.config.timezone);
      s.appliedBy = '系统（清空排班时自动忽略）';
      ignored += 1;
    }
  }
  if (keepEmpty) {
    // 保持全空必须顺带关闭自动轮换占位，否则下次打开排班页又会自动补占位
    for (const g of db.groups) g.autoRotate = false;
    store.addLog(req.auth.name, 'admin', '清空排班',
      `清空全部排班并保持全空、统计归零；已自动关闭各组的自动轮换占位（之后排班只来自 AI 生成或手动指派，可在「成员管理」重新开启）${ignored ? `；自动忽略了 ${ignored} 条待处理 AI 建议` : ''}`);
  } else {
    ensureHorizon();
    const rotated = db.groups
      .filter((g) => g.autoRotate !== false && sch.peopleOf(db, g.id).length)
      .map((g) => g.name);
    store.addLog(req.auth.name, 'admin', '清空排班',
      `清空全部排班并重排轮换占位：${rotated.join('、') || '无（各组自动轮换均已关闭，保持全空）'}${ignored ? `；自动忽略了 ${ignored} 条待处理 AI 建议` : ''}`);
  }
  store.save();
  res.json({ ok: true, keepEmpty, ignored });
});

// —— 管理员：成员管理（增减 / 改名 / 换组）——
app.get('/api/members', auth.requireAdmin, (req, res) => {
  const db = store.data;
  res.json({
    groups: db.groups.map((g) => ({ id: g.id, name: g.name, autoRotate: g.autoRotate !== false })),
    people: db.people.map((p) => ({ id: p.id, name: p.name, code: p.code || '', groupId: p.groupId })),
    defaultPassword: DEFAULT_USER_PASSWORD,
  });
});

// 组设置：自动轮换占位开关（关闭后该组排班只来自 AI 生成或手动指派，清空后保持全空）
app.post('/api/groups', auth.requireAdmin, (req, res) => {
  const { groupId, autoRotate } = req.body || {};
  const db = store.data;
  const g = sch.groupById(db, groupId);
  if (!g) return res.status(400).json({ error: '分组不存在' });
  const val = !!autoRotate;
  if (g.autoRotate === val) return res.status(400).json({ error: '没有变化' });
  g.autoRotate = val;
  store.addLog(req.auth.name, 'admin', '调整分组设置',
    `「${g.name}」自动轮换占位：${val ? '开启（未排班的日子自动按轮换补 1 人保底）' : '关闭（排班只来自 AI 生成或手动指派，清空后保持全空）'}`);
  store.save();
  res.json({ ok: true, autoRotate: val });
});

// 组内下一个未用的字母代号（a~z）
function nextCode(db, groupId) {
  const used = new Set(db.people
    .filter((p) => p.groupId === groupId && p.code)
    .map((p) => p.code.toLowerCase()));
  for (const ch of 'abcdefghijklmnopqrstuvwxyz') {
    if (!used.has(ch)) return ch;
  }
  return '';
}

function codeClash(db, groupId, code, exceptId) {
  const c = String(code || '').trim().toLowerCase();
  if (!c) return null;
  return db.people.find((p) => p.id !== exceptId && p.groupId === groupId
    && p.code && p.code.toLowerCase() === c) || null;
}

app.post('/api/members/add', auth.requireAdmin, (req, res) => {
  const { name, groupId, password, code } = req.body || {};
  const n = String(name || '').trim();
  if (!n) return res.status(400).json({ error: '请输入姓名' });
  if (n.length > 20) return res.status(400).json({ error: '姓名过长（20 字以内）' });
  const db = store.data;
  if (!sch.groupById(db, groupId)) return res.status(400).json({ error: '请选择分组' });
  if (store.personByName(n)) return res.status(400).json({ error: `姓名「${n}」已存在` });
  const pwd = password ? String(password) : DEFAULT_USER_PASSWORD;
  if (pwd.length < 4) return res.status(400).json({ error: '初始密码至少 4 位' });
  let cd = String(code || '').trim();
  if (cd) {
    if (cd.length > 10) return res.status(400).json({ error: '代号过长（10 字以内）' });
    if (codeClash(db, groupId, cd, null)) return res.status(400).json({ error: `代号「${cd}」已在本组使用` });
  } else {
    cd = nextCode(db, groupId);
  }
  const person = makePerson(n, pwd, groupId, cd);
  db.people.push(person);
  store.addLog(req.auth.name, 'admin', '添加成员',
    `${n}（代号 ${cd || '无'}）加入「${gname(groupId)}」（初始密码：${password ? '已单独设置' : '默认 ' + DEFAULT_USER_PASSWORD}，请登录后修改）`);
  store.save();
  res.json({ ok: true, person: { id: person.id, name: person.name, code: cd, groupId } });
});

// 改名：姓名（登录/显示）与代号（规则 md / AI 识别）分开；排班存的是内部 ID，改名自动生效
app.post('/api/members/rename', auth.requireAdmin, (req, res) => {
  const { personId, name, code } = req.body || {};
  const db = store.data;
  const p = store.personById(personId);
  if (!p) return res.status(400).json({ error: '人员不存在' });
  const newName = String(name || '').trim();
  if (!newName || newName.length > 20) return res.status(400).json({ error: '姓名需 1-20 字' });
  const clash = db.people.find((x) => x.id !== personId && x.name.toLowerCase() === newName.toLowerCase());
  if (clash) return res.status(400).json({ error: `姓名「${newName}」已存在` });
  const newCode = String(code ?? '').trim();
  if (newCode && newCode.length > 10) return res.status(400).json({ error: '代号过长（10 字以内）' });
  if (newCode && codeClash(db, p.groupId, newCode, personId)) {
    return res.status(400).json({ error: `代号「${newCode}」已在本组使用` });
  }
  const affected = sch.personDates(db, personId); // 名下有排班的日期（重发飞书用）
  const changes = [];
  if (p.name !== newName) changes.push(`姓名：${p.name} → ${newName}`);
  if ((p.code || '') !== newCode) changes.push(`代号：${p.code || '（无）'} → ${newCode || '（无）'}`);
  if (!changes.length) return res.status(400).json({ error: '没有变化' });
  p.name = newName;
  p.code = newCode;
  let sess = 0; // 同步该用户在线会话里的显示名
  for (const s of Object.values(store.sessions)) {
    if (s.role === 'user' && s.userId === personId) { s.name = newName; sess += 1; }
  }
  store.saveSessions();
  store.addLog(req.auth.name, 'admin', '成员改名',
    `${newName}（${gname(p.groupId)}，代号 ${newCode || '无'}）：${changes.join('；')}，排班显示自动更新`);
  store.save();
  if (affected.length) queueResendsFor(affected, '成员改名后自动重发');
  res.json({ ok: true, sessions: sess });
});

app.post('/api/members/remove', auth.requireAdmin, (req, res) => {
  const { personId } = req.body || {};
  const db = store.data;
  const p = store.personById(personId);
  if (!p) return res.status(400).json({ error: '人员不存在' });
  const glabel = gname(p.groupId);
  const cleared = sch.clearPersonSlots(db, personId); // 其名下排班全部清空
  db.people = db.people.filter((x) => x.id !== personId);
  store.addLog(req.auth.name, 'admin', '移除成员',
    `${p.name}（${glabel}）已移除：账号删除、立即下线，名下 ${cleared.length} 天排班已清空`);
  store.save();
  if (cleared.length) queueResendsFor(cleared, '管理员移除成员后自动重发');
  res.json({ ok: true, cleared: cleared.length });
});

app.post('/api/members/move', auth.requireAdmin, (req, res) => {
  const { personId, groupId } = req.body || {};
  const db = store.data;
  const p = store.personById(personId);
  if (!p) return res.status(400).json({ error: '人员不存在' });
  if (!sch.groupById(db, groupId)) return res.status(400).json({ error: '分组不正确' });
  if (p.groupId === groupId) return res.status(400).json({ error: '该成员已在此组' });
  const from = gname(p.groupId);
  const cleared = sch.clearPersonSlots(db, personId); // 换组后原组排班不再有效，全部清空
  p.groupId = groupId;
  store.addLog(req.auth.name, 'admin', '调整分组',
    `${p.name}：「${from}」→「${gname(groupId)}」（原排班 ${cleared.length} 天已清空，后续按新组轮换）`);
  store.save();
  if (cleared.length) queueResendsFor(cleared, '管理员调整分组后自动重发');
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
  'sendHour', 'sendMinute', 'shiftStart', 'shiftEnd', 'shiftHours', 'saturdayDouble', 'resendDelayMs',
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
  if (body.saturdayDouble !== undefined) c.saturdayDouble = !!body.saturdayDouble;
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

// —— 管理员：AI 排班（Prompt 规则，按组）+ 夜检建议 ——
app.get('/api/ai/prompt', auth.requireAdmin, (req, res) => {
  res.json({ files: ai.readAllPromptMd() });
});

app.post('/api/ai/prompt', auth.requireAdmin, (req, res) => {
  const { group, md } = req.body || {};
  const gid = String(group || 'g1');
  if (!sch.groupById(store.data, gid)) return res.status(400).json({ error: '分组不正确' });
  const text = String(md ?? '');
  if (text.length > 20000) return res.status(400).json({ error: '规则内容过长（上限 20000 字）' });
  ai.writePromptMd(gid, text);
  store.addLog(req.auth.name, 'admin', '修改排班规则',
    `${gname(gid)} 规则已更新（${text.length} 字，prompt_md/${gid === 'g1' ? 'prompt.md' : 'prompt_b.md'}）`);
  store.save();
  res.json({ ok: true, md: text });
});

app.post('/api/ai/generate', auth.requireAdmin, ah(async (req, res) => {
  const { groupId, weekStart, weeks, instruction } = req.body || {};
  if (!sch.isDateStr(String(weekStart || ''))) {
    return res.status(400).json({ error: '请选择有效的开始日期（周一起）' });
  }
  try {
    const result = await ai.generateSchedule(store, {
      groupId: String(groupId || ''),
      weekStart,
      weeks: Number(weeks) || 1,
      instruction: String(instruction || '').slice(0, 2000),
      actor: req.auth.name,
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post('/api/ai/check-now', auth.requireAdmin, ah(async (req, res) => {
  const result = await ai.nightlyCheck(store, { force: true });
  res.json(result);
}));

app.get('/api/ai/suggestions', auth.requireAdmin, (req, res) => {
  res.json({
    suggestions: store.data.aiSuggestions.map((s) => ({
      ...s,
      groupName: gname(s.groupId),
      changes: s.changes.map((c) => ({
        ...c,
        // 兼容旧版单人格式
        toNames: (c.toPeopleIds || (c.toPersonId ? [c.toPersonId] : [])).map((id) => nameOf(id)).filter(Boolean),
        fromNames: (c.fromPeopleIds || (c.fromPersonId ? [c.fromPersonId] : [])).map((id) => nameOf(id)).filter(Boolean),
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
