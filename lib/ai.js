'use strict';
// DeepSeek 排班 AI：
//  1) 夜间检查（按组）：发现空班/工时不均时给出最小改动建议（附该组规则 md）
//  2) Prompt 规则排班：按各组的 prompt_md 规则（可叠加临时指令）生成一段时间的排班
//     - 一组规则：prompt_md/prompt.md   - 二组规则：prompt_md/prompt_b.md
const fs = require('fs');
const path = require('path');
const {
  addDays, dowIndex, weekStartOf, todayStr, nowDisplay, entryHours, computeStats,
  WEEKDAY_CN, peopleOf, groupById, slotOf, setSlot, genWeeks,
} = require('./scheduler');
const feishu = require('./feishu');

const PROMPT_DIR = path.join(__dirname, '..', 'prompt_md');
const PROMPT_FILES = { g1: 'prompt.md', g2: 'prompt_b.md' };

function promptPath(groupId) {
  return path.join(PROMPT_DIR, PROMPT_FILES[groupId] || PROMPT_FILES.g1);
}

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

// —— 排班规则 Prompt（按组存放，可在网页「AI排班」页编辑）——
function readPromptMd(groupId) {
  try {
    return fs.readFileSync(promptPath(groupId), 'utf8');
  } catch {
    return '';
  }
}

function readAllPromptMd() {
  const out = {};
  for (const gid of Object.keys(PROMPT_FILES)) out[gid] = readPromptMd(gid);
  return out;
}

function writePromptMd(groupId, md) {
  fs.mkdirSync(PROMPT_DIR, { recursive: true });
  fs.writeFileSync(promptPath(groupId), String(md == null ? '' : md));
}

// 收集某组检查范围内的排班信息（每天 0~N 人）
function scopeInfo(db, startDay, days, groupId) {
  const members = peopleOf(db, groupId);
  const per = {};
  for (const p of members) per[p.id] = { shifts: 0, hours: 0 };
  const dayList = [];
  const emptyDays = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(startDay, i);
    const names = [];
    for (const e of slotOf(db, day, groupId)) {
      const p = members.find((x) => x.id === e.personId);
      if (p) {
        names.push(p.name);
        per[p.id].shifts += 1;
        per[p.id].hours += entryHours(db, e, day);
      }
    }
    dayList.push({ date: day, people: names });
    if (!names.length) emptyDays.push(day);
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
    reasons.push(`存在无人排班 ${info.emptyDays.length} 天（${info.emptyDays.slice(0, 3).join('、')}${info.emptyDays.length > 3 ? '…' : ''}）`);
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

const isNullish = (v) => v === null || v === undefined || v === '' || v === 'null';

// 各种 AI 返回形态统一取成 [{date, people: [...]}]
function extractAssignments(parsed, startDay) {
  if (!parsed || typeof parsed !== 'object') return null;
  for (const key of ['assignments', 'changes', 'schedule']) {
    if (Array.isArray(parsed[key])) return parsed[key];
  }
  // 规则 md 常见的 {schedule:{monday:["x","y"], ...}} / {"周一":[...]} 格式（只适合一次一周）
  const WD = {
    monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6,
    '周一': 0, '周二': 1, '周三': 2, '周四': 3, '周五': 4, '周六': 5, '周日': 6,
  };
  const map = (parsed.schedule && typeof parsed.schedule === 'object') ? parsed.schedule : parsed;
  const out = [];
  for (const [k, v] of Object.entries(map)) {
    const idx = WD[String(k).toLowerCase()] ?? WD[k];
    if (idx === undefined) continue;
    out.push({ date: addDays(startDay, idx), people: Array.isArray(v) ? v : [v] });
  }
  return out.length ? out : null;
}

// 校验 AI 输出：日期必须在范围内、人员必须是该组成员；按「整天名单」与现状 diff
function validateChanges(db, groupId, rawList, startDay, days) {
  const end = addDays(startDay, days - 1);
  const seen = new Set();
  const out = [];
  for (const c of Array.isArray(rawList) ? rawList.slice(0, 120) : []) {
    if (!c || typeof c !== 'object') continue;
    const date = String(c.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < startDay || date > end) continue;
    const names = Array.isArray(c.people) ? c.people
      : Array.isArray(c.persons) ? c.persons
        : Array.isArray(c.members) ? c.members
          : (c.person !== undefined ? [c.person] : []);
    let bad = false;
    const ids = [];
    for (const n of names.slice(0, 12)) {
      if (isNullish(n)) continue;
      const p = resolvePerson(db, groupId, n);
      if (!p) { bad = true; break; } // 名单外的人 → 该天不动，等管理员处理
      if (!ids.includes(p.id)) ids.push(p.id);
    }
    if (bad) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    const from = slotOf(db, date, groupId).map((e) => e.personId);
    const same = from.length === ids.length && from.every((id) => ids.includes(id));
    if (same) continue; // 名单没变
    out.push({ date, toPeopleIds: ids, fromPeopleIds: from });
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

// —— 夜间检查：逐组独立检查（互不干扰），带上该组规则 md ——
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

  const stats = computeStats(db);
  const gstats = stats.groups.find((x) => x.id === groupId) || { members: [], weeksAll: 0 };
  const data = {
    说明: `${group.name}共 ${members.length} 人轮班。只调整「${group.name}」的排班，不影响其他组。`,
    检查范围: { 起: startDay, 止: addDays(startDay, days - 1), 天数: days },
    人员: members.map((p) => p.name),
    范围内排班: info.dayList,
    范围内每人班次: Object.fromEntries(Object.entries(info.perName).map(([n, v]) => [n, `${v.shifts} 班/${v.hours} 小时`])),
    历史周均工时: Object.fromEntries(gstats.members.map((m) => [m.name, m.avgWeek])),
    触发原因: force && !trig.needCheck ? ['手动强制检查'] : trig.reasons,
  };
  const md = readPromptMd(groupId).trim();
  const messages = [
    {
      role: 'system',
      content: [
        '你是加班排班助手，负责检查并修复排班。',
        ...(md ? ['以下是该组的排班规则，判断是否需要调整、以及如何调整时必须遵守（规则定义的休息日与每日出勤人数都不得违反；休息日无人不算空班）：', '', md, ''] : []),
        '根据提供的排班数据分析是否需要调整，如需调整给出「最小改动」方案：优先补齐空班、修正与规则不符的天数，让每人在检查范围内的班次与工时尽量均衡，不得改动检查范围外的日期。只能安排「人员」名单里的成员。必须严格输出 JSON，格式：{"needChange": boolean, "reason": "一句话中文原因", "explanation": "每条变动的具体理由", "changes": [{"date": "YYYY-MM-DD", "people": ["人员姓名"]}]}。changes 只列出需要变动的日期，people 是该日调整后应出勤的完整名单（空数组表示该天无人）。若无需变动，needChange 为 false 且 changes 为 []。',
      ].join('\n'),
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

  const changes = validateChanges(db, groupId, extractAssignments(parsed, startDay), startDay, days);
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

// —— Prompt 规则排班：按组规则 md（+可选临时指令）生成一段时间的排班 ——
const GEN_FORMAT = '最终输出必须是合法 JSON（不要 Markdown 代码块包裹、不要解释文字），结构为：{"reason":"一句话中文说明排班思路","explanation":"关键安排理由（多行文本）","assignments":[{"date":"YYYY-MM-DD","people":["成员姓名"]}]}。日期范围内的每个日期必须且只能出现一次；people 是该日应出勤人员的完整名单（无人出勤则为空数组 []）。若以上规则中另有输出格式说明，以本条为准；规则中的「下周」等相对时间，一律以数据中的「日期范围」为准。';

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

  const md = readPromptMd(groupId).trim();
  const extra = String(instruction || '').trim().slice(0, 2000);
  if (!md && !extra) {
    throw new Error('该组还没有排班规则：请先在上方编写规则并保存（' + (PROMPT_FILES[groupId] || 'prompt.md') + '），或在「补充要求」输入框里直接写排班要求');
  }

  // 范围内当前排班 + 每人历史班次（公平衔接用）
  const cur = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(startDay, i);
    cur.push({
      date: day,
      星期: WEEKDAY_CN[dowIndex(day)],
      people: slotOf(db, day, groupId)
        .map((e) => {
          const p = members.find((m) => m.id === e.personId);
          return p ? p.name : null;
        })
        .filter(Boolean),
    });
  }
  const stats = computeStats(db);
  const gstats = stats.groups.find((x) => x.id === groupId) || { members: [] };

  const data = {
    任务: `为「${group.name}」安排 ${startDay}（${WEEKDAY_CN[dowIndex(startDay)]}）至 ${endDay} 共 ${days} 天的加班排班，给出每天应出勤人员的完整名单。`,
    本组成员名单: members.map((m) => m.name),
    日期范围: { 起: startDay, 止: endDay, 天数: days },
    范围内当前排班: cur,
    每人历史班次与工时: gstats.members.map((m) => ({
      姓名: m.name, 总班次: m.shifts, 总工时: m.hours,
      已发生班次: m.pastShifts, 本月班次: m.monthShifts, 周均工时: m.avgWeek,
    })),
    班次时间: `${cfg.shiftStart}-${cfg.shiftEnd}，每班默认 ${cfg.shiftHours} 小时` +
      (cfg.saturdayDouble ? '；周六加班按双倍工时计入（上方历史工时已按此口径统计）' : ''),
  };

  const systemParts = [];
  if (md) {
    systemParts.push(`以下是「${group.name}」的排班规则（Markdown），请严格遵守：\n\n${md}`);
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

  const changes = validateChanges(db, groupId, extractAssignments(parsed, startDay), startDay, days);
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
    const cur = slotOf(db, c.date, groupId);
    // 应用整天名单；已在名单上的人保留原工时/备注，新进来的人用默认
    const kept = (c.toPeopleIds || [])
      .filter((pid) => db.people.some((p) => p.id === pid))
      .map((pid) => {
        const old = cur.find((e) => e.personId === pid);
        return old ? { ...old } : { personId: pid };
      });
    setSlot(db, c.date, groupId, kept);
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
  readPromptMd, readAllPromptMd, writePromptMd, PROMPT_DIR,
};
