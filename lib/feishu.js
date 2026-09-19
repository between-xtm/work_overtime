'use strict';
const crypto = require('crypto');
const {
  addDays, dowIndex, WEEKDAY_CN, nowDisplay, entryHours,
  peopleOf, groupById, slotOf,
} = require('./scheduler');

function fmtShort(s) { return s.slice(5).replace('-', '/'); }

// 飞书自定义机器人签名（开启「签名校验」的机器人必须带）
function feishuSign(secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = crypto.createHmac('sha256', stringToSign).update('').digest('base64');
  return { timestamp: String(timestamp), sign };
}

async function postWebhook(cfg, payload) {
  if (!cfg.webhookUrl) return { ok: false, error: '未配置飞书 webhook' };
  const body = cfg.webhookSecret ? { ...feishuSign(cfg.webhookSecret), ...payload } : payload;
  try {
    const res = await fetch(cfg.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const j = await res.json().catch(() => null);
    if (j && (j.code === 0 || j.StatusCode === 0)) return { ok: true };
    return {
      ok: false,
      error: j ? `飞书返回 ${j.code ?? j.StatusCode}：${j.msg || '未知错误'}` : `HTTP ${res.status}`,
    };
  } catch (e) {
    return { ok: false, error: `发送失败：${e.message || e}` };
  }
}

// 一周的排班卡片（每天每组 0~N 人，分开显示）
function scheduleCard(db, weekStart) {
  const cfg = db.config;
  const end = addDays(weekStart, 6);
  // 只显示有成员的分组；两组都空时全部显示
  const withMembers = db.groups.filter((g) => peopleOf(db, g.id).length);
  const showGroups = withMembers.length ? withMembers : db.groups;
  const lines = [];
  for (let i = 0; i < 7; i++) {
    const day = addDays(weekStart, i);
    const parts = showGroups.map((g) => {
      const list = slotOf(db, day, g.id)
        .map((e) => {
          const p = e && e.personId ? db.people.find((x) => x.id === e.personId) : null;
          return p ? { p, e } : null;
        })
        .filter(Boolean);
      if (!list.length) return `${g.name}：⚠️ 空缺`;
      const names = list.map(({ p, e }) => `**${p.name}**（${entryHours(db, e, day)}h${e.note ? `，${e.note}` : ''}）`);
      return `${g.name}：${names.join('、')}`;
    });
    lines.push(`${WEEKDAY_CN[i]} ${fmtShort(day)}｜${parts.join('｜')}`);
  }
  const elements = [{ tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } }];
  const foot = [];
  if (cfg.publicUrl) foot.push(`[登录网页查看/修改排班](${cfg.publicUrl})`);
  foot.push(`每班 ${cfg.shiftStart}-${cfg.shiftEnd} · 更新于 ${nowDisplay(cfg.timezone)}，排班变动后自动重发`);
  elements.push({ tag: 'hr' });
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: foot.join(' · ') }] });
  return {
    msg_type: 'interactive',
    card: {
      header: {
        title: { tag: 'plain_text', content: `加班排班表（${fmtShort(weekStart)} - ${fmtShort(end)}）` },
        template: 'blue',
      },
      elements,
    },
  };
}

// AI 建议通知卡片（按天整组名单替换：a、b → x、y）
function suggestionCard(db, s, applied) {
  const cfg = db.config;
  const gname = s.groupId ? ((groupById(db, s.groupId) || {}).name || '') : '';
  const lines = [];
  for (const c of s.changes) {
    const before = (c.fromPeopleIds || [])
      .map((id) => (db.people.find((x) => x.id === id) || {}).name).filter(Boolean).join('、') || '原为空缺';
    const after = (c.toPeopleIds || [])
      .map((id) => (db.people.find((x) => x.id === id) || {}).name).filter(Boolean).join('、') || '清空';
    lines.push(`- ${gname ? gname + ' · ' : ''}${WEEKDAY_CN[dowIndex(c.date)]} ${fmtShort(c.date)}：${before} → **${after}**`);
  }
  const elements = [
    { tag: 'div', text: { tag: 'lark_md', content: `**原因**：${s.reason || '—'}\n${lines.join('\n')}\n${s.explanation ? `\n**说明**：${s.explanation}` : ''}` } },
  ];
  const foot = applied
    ? `已自动应用并重发最新排班 · ${nowDisplay(cfg.timezone)}`
    : `请管理员登录网页确认是否应用 · ${nowDisplay(cfg.timezone)}`;
  elements.push({ tag: 'hr' });
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: foot }] });
  return {
    msg_type: 'interactive',
    card: {
      header: {
        title: { tag: 'plain_text', content: applied ? '🤖 AI 排班调整（已自动应用）' : '🤖 AI 排班调整建议' },
        template: applied ? 'green' : 'orange',
      },
      elements,
    },
  };
}

// —— 变更后防抖自动重发 ——
const timers = new Map();

function queueResend(store, weekStart, trigger) {
  const db = store.data;
  const label = trigger || '排班修改后自动重发';
  if (!db.config.webhookUrl) {
    db.lastSend = {
      time: nowDisplay(db.config.timezone), ok: false, error: '未配置飞书 webhook，跳过发送',
      week: weekStart, trigger: label,
    };
    store.save();
    return;
  }
  if (timers.has(weekStart)) clearTimeout(timers.get(weekStart));
  const t = setTimeout(() => {
    timers.delete(weekStart);
    sendWeekNow(store, weekStart, label);
  }, Number(db.config.resendDelayMs) || 3000);
  timers.set(weekStart, t);
}

async function sendWeekNow(store, weekStart, trigger) {
  const db = store.data;
  let result;
  if (!db.config.webhookUrl) {
    result = { ok: false, error: '未配置飞书 webhook' };
  } else {
    result = await postWebhook(db.config, scheduleCard(db, weekStart));
  }
  db.lastSend = {
    time: nowDisplay(db.config.timezone),
    ok: result.ok,
    error: result.ok ? '' : result.error,
    week: weekStart,
    trigger: trigger || '手动发送',
  };
  store.save();
  return result;
}

async function sendSuggestionNotice(store, suggestion, applied) {
  const db = store.data;
  if (!db.config.webhookUrl) {
    db.lastSend = {
      time: nowDisplay(db.config.timezone), ok: false,
      error: '未配置飞书 webhook，跳过 AI 建议通知',
      week: suggestion.scopeStart, trigger: 'AI 建议',
    };
    store.save();
    return { ok: false, error: '未配置飞书 webhook' };
  }
  const result = await postWebhook(db.config, suggestionCard(db, suggestion, applied));
  db.lastSend = {
    time: nowDisplay(db.config.timezone), ok: result.ok,
    error: result.ok ? '' : result.error,
    week: suggestion.scopeStart,
    trigger: `AI 建议${applied ? '（自动应用）' : ''}`,
  };
  store.save();
  return result;
}

module.exports = {
  scheduleCard, suggestionCard, postWebhook,
  queueResend, sendWeekNow, sendSuggestionNotice,
};
