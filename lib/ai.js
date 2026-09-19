'use strict';
// DeepSeek 排班 AI：
//  1) 夜间检查（按组）：发现空班/工时不均时给出最小改动建议
//  2) Prompt 规则排班：按 prompt_md/prompt.md 的规则（可叠加临时指令）生成一段时间的排班
const fs = require('fs');
const path = require('path');
const {
  addDays, dowIndex, weekStartOf, todayStr, nowDisplay, entryHours, computeStats,
  WEEKDAY_CN, peopleOf, groupById, slotOf, setSlot, genWeeks,
} = require('./scheduler');
const feishu = require('./feishu');

const PROMPT_DIR = path.join(__dirname, '..', 'prompt_md');
const PROMPT_PATH = path.join(PROMPT_DIR, 'prompt.md');

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

// —— 排班规则 Prompt（prompt_md/prompt.md，可在网页「AI排班」页编辑）——
function readPromptMd() {
  try {
    return fs.readFileSync(PROMPT_PATH, 'utf8');
  } catch {
    return '';
  }
}

function writePromptMd(md) {
  fs.mkdirSync(PROMPT_DIR, { recursive: true });
  fs.writeFileSync(PROMPT_PATH, String(md == null ? '' : md));
}

// 收集某组检查范围内的排班信息
function scopeInfo(db, startDay, days, groupId) {
  const members = peopleOf(db, groupId);
  const per = {};
  for (const p of members) per[p.id] = { shifts: 0, hours: 0 };
  const dayList = [];
  const emptyDays = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(startDay, i);
    const e = slotOf(db, day, groupId);
    const p = e ? members.find((x) => x.id === e.personId) : null;
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
    perName: Object.fromEntries(members.map((p) => [p.name, per[p.id]])),
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

function resolvePerson(db, groupId, v) {
  if (v === null || v === undefined || v === '' || v === 'null') return null;
  const s = String(v).trim().toLowerCase();
  return peopleOf(db, groupId).find((p) => p.id === v || p.name.toLowerCase() === s) || null;
}

// 校验 AI 输出：日期必须在范围内、人员必须是该组成员；返回有效改动（与现状相同的自动跳过）
function validateChanges(db, groupId, rawChanges, startDay, days) {
  const end = addDays(startDay, days - 1);
  const seen = new Set();
  const out = [];
  for (const c of Array.isArray(rawChanges) ? rawChanges.slice(0, 60) : []) {
    if (!c || typeof c !== 'object') continue;
    const date = String(c.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < startDay || date > end) continue;
    const gaveEmpty = c.person === null || c.person === '' || c.person === 'null' || c.person === undefined;
    const toPerson = gaveEmpty ? null : resolvePerson(db, groupId, c.person);
    if (!gaveEmpty && toPerson === null) continue; // 给了人名但对不上本组成员
    if (seen.has(date)) continue;
    seen.add(date);
    const cur = slotOf(db, date, groupId);
    const fromPersonId = cur ? cur.personId : null;
    if (toPerson && fromPersonId === toPerson.id) continue; // 没有实际变化
    out.push({ date, toPersonId: toPerson ? toPerson.id : null, fromPersonId });
  }
  return out;
}

// 宽松解析 AI 返回的 JSON
function parseAiJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    const m = String(content).match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* null */ }
    }
  }
  return null;
}

function pushSuggestion(db, suggestion) {
  db.aiSuggestions.unshift(suggestion);
  if (db.aiSuggestions.length > 50) db.aiSuggestions.length = 50;
}

// —— 夜间检查：逐组独立检查（互不干扰）——
async function checkGroup(store, group, { force = false } = {}) {
  const db = store.data;
  const cfg = db.config;
  const today = todayStr(cfg.timezone);
  const startDay = addDays(today, 1);
  const days = Math.max(1, Math.min(60, Number(cfg.aiCheckDays) || 14));
  const groupId = group.id;
  const members = peopleOf(db, groupId);

  const info = scopeInfo(db, startDay, days, groupId);
  const trig = heuristic(info);

  if (!trig.needCheck && !force) {
    store.addLog('系统', 'system', 'AI夜检', `${group.name}：检查未来 ${days} 天（${startDay} 起）：排班均衡，无需变动`);
    return { groupId, name: group.name, needChange: false };
  }

  // 组装给 AI 的上下文
  const stats = computeStats(db);
  const gstats = stats.groups.find((x) => x.id === groupId) || { members: [], weeksAll: 0 };
  const data = {
    说明: `${group.name}共 ${members.length} 人轮班，每班 ${cfg.shiftStart}-${cfg.shiftEnd}，默认 ${cfg.shiftHours} 小时/班。只调整「${group.name}」的排班，不影响其他组。`,
    检查范围: { 起: startDay, 止: addDays(startDay, days - 1), 天数: days },
    人员: members.map((p) => p.name),
    范围内排班: info.dayList,
    范围内每人班次: Object.fromEntries(Object.entries(info.perName).map(([n, v]) => [n, `${v.shifts} 班/${v.hours} 小时`])),
    历史周均工时: Object.fromEntries(gstats.members.map((m) => [m.name, m.avgWeek])),
    触发原因: force && !trig.needCheck ? ['手动强制检查'] : trig.reasons,
  };
  const messages = [
    {
      role: 'system',
      content: `你是加班排班助手。根据提供的排班数据分析是否需要调整，如需调整给出「最小改动」方案：优先补齐空班，让每人在检查范围内的班次与工时尽量均衡，不得改动检查范围外的日期。只能安排「人员」名单里的成员。必须严格输出 JSON，格式：{"needChange": boolean, "reason": "一句话中文原因", "explanation": "每条变动的具体理由", "changes": [{"date": "YYYY-MM-DD", "person": "人员姓名或 null"}]}。若无需变动，needChange 为 false 且 changes 为 []。person 填 null 表示清空该天。`,
    },
    { role: 'user', content: JSON.stringify(data, null, 1) },
  ];

  let content;
  try {
    content = await aiChat(db, messages);
  } catch (e) {
    store.addLog('系统', 'system', 'AI夜检', `${group.name}：调用失败：${e.message}`);
    return { groupId, name: group.name, error: e.message };
  }

  const parsed = parseAiJson(content);
  if (!parsed || typeof parsed !== 'object') {
    store.addLog('系统', 'system', 'AI夜检', `${group.name}：AI 返回内容无法解析为 JSON，已忽略`);
    return { groupId, name: group.name, error: 'AI 返回无法解析' };
  }

  const changes = validateChanges(db, groupId, parsed.changes, startDay, days);
  if (!parsed.needChange || changes.length === 0) {
    store.addLog('系统', 'system', 'AI夜检', `${group.name}：AI 分析结论：无需变动${parsed.reason ? `（${parsed.reason}）` : ''}`);
    return { groupId, name: group.name, needChange: false, reason: parsed.reason || '' };
  }

  const suggestion = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    time: nowDisplay(cfg.timezone),
    groupId,
    scopeStart: startDay,
    scopeDays: days,
    trigger: (force && !trig.needCheck ? '手动检查' : trig.reasons.join('；')),
    reason: String(parsed.reason || '').slice(0, 200),
    explanation: String(parsed.explanation || '').slice(0, 1000),
    changes,
    status: 'pending',
  };
  pushSuggestion(db, suggestion);

  if (cfg.aiApplyMode === 'auto') {
    store.addLog('系统', 'system', 'AI夜检', `${group.name}：AI 建议自动应用：${suggestion.reason}（${changes.length} 处调整）`);
    store.save();
    await applySuggestion(store, suggestion.id, 'AI自动应用');
    return { groupId, name: group.name, needChange: true, suggestionId: suggestion.id, auto: true };
  }

  store.addLog('系统', 'system', 'AI夜检', `${group.name}：生成建议 #${suggestion.id}：${suggestion.reason}（${changes.length} 处调整），等待管理员确认`);
  store.save();
  await feishu.sendSuggestionNotice(store, suggestion, false);
  return { groupId, name: group.name, needChange: true, suggestionId: suggestion.id, auto: false };
}

async function nightlyCheck(store, { force = false } = {}) {
  const db = store.data;
  if (!aiEnabled(db)) {
    store.addLog('系统', 'system', 'AI夜检', '未配置 DeepSeek API Key，跳过');
    store.save();
    return { ok: false, skipped: true, reason: '未配置 AI Key' };
  }
  const results = [];
  for (const g of db.groups) {
    if (!peopleOf(db, g.id).length) continue; // 空组没有排班，跳过
    results.push(await checkGroup(store, g, { force }));
  }
  store.save();
  return { ok: true, results, needChange: results.some((r) => r.needChange) };
}

// —— Prompt 规则排班：按 md 规则（+可选临时指令）生成一段时间的排班 ——
const GEN_FORMAT = '必须严格输出 JSON，格式：{"reason":"一句话中文说明本次排班思路","explanation":"关键安排的具体理由（多行文本）","assignments":[{"date":"YYYY-MM-DD","person":"成员姓名或 null"}]}。日期范围内的每个日期必须且只能出现一次；某天不安排任何人时 person 填 null。';

async function generateSchedule(store, { groupId, weekStart, weeks, instruction, actor } = {}) {
  const db = store.data;
  const cfg = db.config;
  const group = groupById(db, groupId);
  if (!group) throw new Error('分组不存在');
  const members = peopleOf(db, groupId);
  if (!members.length) throw new Error('「' + group.name + '」暂无成员，请先在设置中添加');
  if (!aiEnabled(db)) throw new Error('未配置 AI API Key，请先在「设置」中填写');

  const days = Math.max(7, Math.min(28, Math.round((Number(weeks) || 1)) * 7));
  const startDay = weekStartOf(String(weekStart)); // 自动归一到周一
  const endDay = addDays(startDay, days - 1);

  const md = readPromptMd().trim();
  const extra = String(instruction || '').trim().slice(0, 2000);
  if (!md && !extra) {
    throw new Error('还没有排班规则：请先在上方编写规则并保存（prompt_md/prompt.md），或在「补充要求」输入框里直接写排班要求');
  }

  // 范围内当前排班 + 每人历史班次（公平衔接用）
  const cur = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(startDay, i);
    const e = slotOf(db, day, groupId);
    const p = e ? members.find((m) => m.id === e.personId) : null;
    cur.push({ date: day, 星期: WEEKDAY_CN[dowIndex(day)], person: p ? p.name : null });
  }
  const stats = computeStats(db);
  const gstats = stats.groups.find((x) => x.id === groupId) || { members: [] };

  const data = {
    任务: `为「${group.name}」重新安排 ${startDay}（${WEEKDAY_CN[dowIndex(startDay)]}）至 ${endDay} 共 ${days} 天的加班排班。`,
    本组成员名单: members.map((m) => m.name),
    日期范围: { 起: startDay, 止: endDay, 天数: days },
    范围内当前排班: cur,
    每人历史班次与工时: gstats.members.map((m) => ({
      姓名: m.name, 总班次: m.shifts, 总工时: m.hours,
      已发生班次: m.pastShifts, 本月班次: m.monthShifts, 周均工时: m.avgWeek,
    })),
    班次时间: `${cfg.shiftStart}-${cfg.shiftEnd}，每班默认 ${cfg.shiftHours} 小时`,
  };

  const systemParts = [];
  if (md) {
    systemParts.push(`以下是本团队的排班规则（Markdown），请严格遵守：\n\n${md}`);
  }
  systemParts.push('硬性约束：只能使用「本组成员名单」中的人，不得编造名单外的姓名；只能安排「日期范围」内的日期。');
  systemParts.push(GEN_FORMAT);
  const messages = [
    { role: 'system', content: systemParts.join('\n\n') },
    {
      role: 'user',
      content: (extra ? `【补充要求（优先级最高，可覆盖以上规则中冲突的部分）】\n${extra}\n\n` : '') + JSON.stringify(data, null, 1),
    },
  ];

  const content = await aiChat(db, messages);
  const parsed = parseAiJson(content);
  if (!parsed || typeof parsed !== 'object') {
    store.addLog(actor || '系统', 'admin', 'AI排班', 'AI 返回内容无法解析为 JSON，已忽略');
    store.save();
    return { ok: false, error: 'AI 返回无法解析' };
  }

  const changes = validateChanges(db, groupId, parsed.assignments || parsed.changes || parsed.schedule, startDay, days);
  const reason = String(parsed.reason || '').slice(0, 200);
  if (!changes.length) {
    store.addLog(actor || '管理员', 'admin', 'AI排班', `${group.name} ${startDay} 起 ${days} 天：AI 认为当前排班已符合规则`);
    store.save();
    return { ok: true, needChange: false, reason: reason || 'AI 认为当前排班已符合规则' };
  }

  const suggestion = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    time: nowDisplay(cfg.timezone),
    groupId,
    scopeStart: startDay,
    scopeDays: days,
    trigger: `Prompt 排班：${group.name} ${startDay} 起 ${days} 天${extra ? '（含补充要求）' : ''}`,
    reason,
    explanation: String(parsed.explanation || '').slice(0, 1000),
    changes,
    status: 'pending',
  };
  pushSuggestion(db, suggestion);

  if (cfg.aiApplyMode === 'auto') {
    store.addLog(actor || '管理员', 'admin', 'AI排班', `${group.name}：AI 排班已自动应用：${reason}（${changes.length} 处调整）`);
    store.save();
    await applySuggestion(store, suggestion.id, actor || 'AI自动应用');
    return { ok: true, needChange: true, suggestionId: suggestion.id, auto: true, reason };
  }

  store.addLog(actor || '管理员', 'admin', 'AI排班',
    `${group.name}：生成排班建议 #${suggestion.id}：${reason}（${changes.length} 处调整），等待确认`);
  store.save();
  return { ok: true, needChange: true, suggestionId: suggestion.id, auto: false, reason };
}

async function applySuggestion(store, id, actor) {
  const db = store.data;
  const s = db.aiSuggestions.find((x) => x.id === id);
  if (!s) throw new Error('建议不存在');
  if (s.status !== 'pending') throw new Error('该建议已处理过');
  const groupId = s.groupId || 'g1';
  const weeks = new Set();
  const done = [];
  for (const c of s.changes) {
    if (c.toPersonId && !db.people.find((p) => p.id === c.toPersonId)) continue; // 人员已被移除，跳过该条
    setSlot(db, c.date, groupId, c.toPersonId ? { personId: c.toPersonId } : null);
    const ws = weekStartOf(c.date);
    if (!genWeeks(db, groupId).includes(ws)) genWeeks(db, groupId).push(ws); // 防止自动回填覆盖 AI 决定留空的日子
    weeks.add(ws);
    done.push(c.date);
  }
  s.status = 'applied';
  s.appliedTime = nowDisplay(db.config.timezone);
  s.appliedBy = actor;
  store.addLog(actor, 'admin', '应用AI建议',
    `建议 #${id}：${done.length} 处调整（${done.join('、')}）`);
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

module.exports = {
  aiEnabled, aiChat, nightlyCheck, generateSchedule, applySuggestion, ignoreSuggestion,
  readPromptMd, writePromptMd, PROMPT_PATH,
};
