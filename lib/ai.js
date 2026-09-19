'use strict';
// DeepSeek 夜间排班检查：发现空班/工时不均时让 AI 分析并给出最小改动建议
const {
  addDays, dowIndex, weekStartOf, todayStr, nowDisplay, entryHours, computeStats,
} = require('./scheduler');
const feishu = require('./feishu');

function aiEnabled(db) {
  return !!db.config.aiApiKey;
}

// OpenAI 兼容接口调用（DeepSeek）
async function aiChat(db, messages) {
  const cfg = db.config;
  const base = String(cfg.aiBaseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.aiApiKey },
    body: JSON.stringify({
      model: cfg.aiModel || 'deepseek-chat',
      messages,
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || !j.choices || !j.choices[0]) {
    const msg = j && j.error && j.error.message ? j.error.message : `HTTP ${res.status}`;
    throw new Error(`DeepSeek 接口错误：${msg}`);
  }
  return j.choices[0].message.content;
}

// 收集检查范围内的排班信息
function scopeInfo(db, startDay, days) {
  const per = {};
  for (const p of db.people) per[p.id] = { shifts: 0, hours: 0 };
  const dayList = [];
  const emptyDays = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(startDay, i);
    const e = db.schedule[day];
    const p = e && e.personId ? db.people.find((x) => x.id === e.personId) : null;
    dayList.push({ date: day, person: p ? p.name : null });
    if (p) {
      per[p.id].shifts += 1;
      per[p.id].hours += entryHours(db, e);
    } else {
      emptyDays.push(day);
    }
  }
  return {
    dayList, emptyDays, per,
    perName: Object.fromEntries(db.people.map((p) => [p.name, per[p.id]])),
  };
}

// 本地启发式：什么情况值得让 AI 分析
function heuristic(info) {
  const reasons = [];
  if (info.emptyDays.length) {
    reasons.push(`存在空班 ${info.emptyDays.length} 天（${info.emptyDays.slice(0, 3).join('、')}${info.emptyDays.length > 3 ? '…' : ''}）`);
  }
  const counts = Object.values(info.per).map((v) => v.shifts);
  if (counts.length) {
    const max = Math.max(...counts), min = Math.min(...counts);
    if (max - min >= 2) reasons.push(`范围内班次不均（最多 ${max} 班 / 最少 ${min} 班）`);
  }
  return { needCheck: reasons.length > 0, reasons };
}

function resolvePerson(db, v) {
  if (v === null || v === undefined || v === '' || v === 'null') return null;
  const s = String(v).trim().toLowerCase();
  return db.people.find((p) => p.id === v || p.name.toLowerCase() === s) || null;
}

// 校验 AI 输出的 changes：日期必须在范围内、人员必须存在
function validateChanges(db, rawChanges, startDay, days) {
  const end = addDays(startDay, days - 1);
  const seen = new Set();
  const out = [];
  for (const c of Array.isArray(rawChanges) ? rawChanges.slice(0, 30) : []) {
    if (!c || typeof c !== 'object') continue;
    const date = String(c.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < startDay || date > end) continue;
    const toPerson = resolvePerson(db, c.person);
    if (toPerson === null && c.person !== null && c.person !== '' && c.person !== 'null' && c.person !== undefined) {
      continue; // 给了人名但对不上
    }
    if (seen.has(date)) continue;
    seen.add(date);
    const cur = db.schedule[date];
    const fromPersonId = cur && cur.personId ? cur.personId : null;
    if (toPerson && fromPersonId === toPerson.id) continue; // 没有实际变化
    out.push({ date, toPersonId: toPerson ? toPerson.id : null, fromPersonId });
  }
  return out;
}

async function nightlyCheck(store, { force = false } = {}) {
  const db = store.data;
  const cfg = db.config;
  const today = todayStr(cfg.timezone);
  const startDay = addDays(today, 1);
  const days = Math.max(1, Math.min(60, Number(cfg.aiCheckDays) || 14));

  if (!aiEnabled(db)) {
    store.addLog('系统', 'system', 'AI夜检', '未配置 DeepSeek API Key，跳过');
    store.save();
    return { ok: false, skipped: true, reason: '未配置 AI Key' };
  }

  const info = scopeInfo(db, startDay, days);
  const trig = heuristic(info);

  if (!trig.needCheck && !force) {
    store.addLog('系统', 'system', 'AI夜检', `检查未来 ${days} 天（${startDay} 起）：排班均衡，无需变动`);
    store.save();
    return { ok: true, needChange: false, checkedDays: days };
  }

  // 组装给 AI 的上下文
  const stats = computeStats(db);
  const data = {
    说明: `团队共 ${db.people.length} 人轮班，每班 ${cfg.shiftStart}-${cfg.shiftEnd}，默认 ${cfg.shiftHours} 小时/班。`,
    检查范围: { 起: startDay, 止: addDays(startDay, days - 1), 天数: days },
    人员: db.people.map((p) => p.name),
    范围内排班: info.dayList,
    范围内每人班次: Object.fromEntries(Object.entries(info.perName).map(([n, v]) => [n, `${v.shifts} 班/${v.hours} 小时`])),
    历史周均工时: Object.fromEntries(stats.people.map((p) => [p.name, p.avgWeek])),
    触发原因: force && !trig.needCheck ? ['手动强制检查'] : trig.reasons,
  };
  const messages = [
    {
      role: 'system',
      content: '你是加班排班助手。根据提供的排班数据分析是否需要调整，如需调整给出「最小改动」方案：优先补齐空班，让每人在检查范围内的班次与工时尽量均衡，不得改动检查范围外的日期。必须严格输出 JSON，格式：{"needChange": boolean, "reason": "一句话中文原因", "explanation": "每条变动的具体理由", "changes": [{"date": "YYYY-MM-DD", "person": "人员姓名或 null"}]}。若无需变动，needChange 为 false 且 changes 为 []。person 填 null 表示清空该天。',
    },
    { role: 'user', content: JSON.stringify(data, null, 1) },
  ];

  let content;
  try {
    content = await aiChat(db, messages);
  } catch (e) {
    store.addLog('系统', 'system', 'AI夜检', `调用失败：${e.message}`);
    store.save();
    return { ok: false, error: e.message };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    const m = String(content).match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch { /* null */ } }
  }
  if (!parsed || typeof parsed !== 'object') {
    store.addLog('系统', 'system', 'AI夜检', 'AI 返回内容无法解析为 JSON，已忽略');
    store.save();
    return { ok: false, error: 'AI 返回无法解析' };
  }

  const changes = validateChanges(db, parsed.changes, startDay, days);
  if (!parsed.needChange || changes.length === 0) {
    store.addLog('系统', 'system', 'AI夜检', `AI 分析结论：无需变动${parsed.reason ? `（${parsed.reason}）` : ''}`);
    store.save();
    return { ok: true, needChange: false, reason: parsed.reason || '' };
  }

  const suggestion = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    time: nowDisplay(cfg.timezone),
    scopeStart: startDay,
    scopeDays: days,
    trigger: (force && !trig.needCheck ? '手动检查' : trig.reasons.join('；')),
    reason: String(parsed.reason || '').slice(0, 200),
    explanation: String(parsed.explanation || '').slice(0, 1000),
    changes,
    status: 'pending',
  };
  db.aiSuggestions.unshift(suggestion);
  if (db.aiSuggestions.length > 50) db.aiSuggestions.length = 50;

  const auto = cfg.aiApplyMode === 'auto';
  if (auto) {
    store.addLog('系统', 'system', 'AI夜检', `AI 建议自动应用：${suggestion.reason}（${changes.length} 处调整）`);
    store.save();
    await applySuggestion(store, suggestion.id, 'AI自动应用');
    return { ok: true, needChange: true, suggestionId: suggestion.id, auto: true };
  }

  store.addLog('系统', 'system', 'AI夜检', `生成建议 #${suggestion.id}：${suggestion.reason}（${changes.length} 处调整），等待管理员确认`);
  store.save();
  await feishu.sendSuggestionNotice(store, suggestion, false);
  return { ok: true, needChange: true, suggestionId: suggestion.id, auto: false };
}

async function applySuggestion(store, id, actor) {
  const db = store.data;
  const s = db.aiSuggestions.find((x) => x.id === id);
  if (!s) throw new Error('建议不存在');
  if (s.status !== 'pending') throw new Error('该建议已处理过');
  const weeks = new Set();
  for (const c of s.changes) {
    if (c.toPersonId) db.schedule[c.date] = { personId: c.toPersonId };
    else delete db.schedule[c.date];
    const ws = weekStartOf(c.date);
    if (!db.weeksGenerated.includes(ws)) db.weeksGenerated.push(ws); // 防止自动回填覆盖 AI 决定留空的日子
    weeks.add(ws);
  }
  s.status = 'applied';
  s.appliedTime = nowDisplay(db.config.timezone);
  s.appliedBy = actor;
  store.addLog(actor, 'admin', '应用AI建议',
    `建议 #${id}：${s.changes.length} 处调整（${s.changes.map((c) => c.date).join('、')}）`);
  store.save();
  for (const w of weeks) feishu.queueResend(store, w, `${actor}应用AI建议后自动重发`);
  return s;
}

function ignoreSuggestion(store, id, actor) {
  const db = store.data;
  const s = db.aiSuggestions.find((x) => x.id === id);
  if (!s) throw new Error('建议不存在');
  if (s.status !== 'pending') throw new Error('该建议已处理过');
  s.status = 'ignored';
  s.appliedTime = nowDisplay(db.config.timezone);
  s.appliedBy = actor;
  store.addLog(actor, 'admin', '忽略AI建议', `建议 #${id}：${s.reason}`);
  store.save();
  return s;
}

module.exports = { aiEnabled, aiChat, nightlyCheck, applySuggestion, ignoreSuggestion };
