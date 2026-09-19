'use strict';

/* —— 小工具 —— */
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 日期运算（UTC 正午锚点，与后端一致）
function addDays(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function dowIdx(s) {
  const [y, m, d] = s.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay() + 6) % 7;
}
const WEEKDAY = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const weekStartOf = (s) => addDays(s, -dowIdx(s));
const fmtShort = (s) => s.slice(5).replace('-', '/');
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const state = {
  token: localStorage.getItem('ot_token') || '',
  me: null,
  weekStart: null,
  data: null,        // 当前周排班响应
  config: null,
  stats: null,
  statsMode: 'all',
  suggestions: null,
  logs: null,
  tab: 'schedule',
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let j = null;
  try { j = await res.json(); } catch { /* 非 JSON */ }
  if (res.status === 401) {
    if (state.token) { state.token = ''; localStorage.removeItem('ot_token'); renderLogin(); }
    throw new Error((j && j.error) || '请先登录');
  }
  if (!res.ok) throw new Error((j && j.error) || ('请求失败 ' + res.status));
  return j;
}

function logout() {
  api('/api/logout', { method: 'POST' }).catch(() => {});
  state.token = '';
  state.me = null;
  localStorage.removeItem('ot_token');
  renderLogin();
}

/* —— Toast / 弹窗 —— */
function toast(msg, type = 'info', ms = 3200) {
  const root = $('#toastRoot');
  if (!root) { alert(msg); return; }
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, ms);
}

function showModal(title, bodyHtml) {
  $('#modalRoot').innerHTML = `
    <div class="modal-mask" id="modalMask">
      <div class="modal">
        <div class="modal-head"><h3>${title}</h3><button id="modalX">✕</button></div>
        <div class="modal-body">${bodyHtml}</div>
      </div>
    </div>`;
  $('#modalX').onclick = closeModal;
  $('#modalMask').onclick = (e) => { if (e.target.id === 'modalMask') closeModal(); };
}
const closeModal = () => { $('#modalRoot').innerHTML = ''; };
function confirmModal(html) {
  return new Promise((resolve) => {
    showModal('请确认', `
      <p>${html}</p>
      <div class="rowbtns"><button id="cYes" class="danger">确认</button><button id="cNo" class="ghost">取消</button></div>`);
    $('#cYes').onclick = () => { closeModal(); resolve(true); };
    $('#cNo').onclick = () => { closeModal(); resolve(false); };
  });
}
function afterMutation(r) {
  if (r && r.webhookConfigured) toast('已保存，飞书排班表将自动重发 ✅', 'ok');
  else toast('已保存（飞书 webhook 未配置，暂不发送）', 'warn');
}

/* —— 登录页 —— */
async function renderLogin() {
  let names = [];
  try { names = (await api('/api/people')).people; } catch { /* 忽略 */ }
  $('#app').innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <h1>📅 加班排班表</h1>
        <div class="sub">登录后可查看排班、发起换班</div>
        <label>我是</label>
        <div class="row">
          <select id="loginName">
            ${names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}
            <option value="admin">管理员</option>
          </select>
        </div>
        <label>密码</label>
        <input id="loginPass" type="password" placeholder="请输入密码" autocomplete="current-password">
        <div style="height:16px"></div>
        <button id="btnLogin" class="primary big">登 录</button>
        <p class="hint" style="text-align:center;margin-top:14px">测试阶段初始密码：成员 123456 / 管理员 admin123<br>登录后请到「密码」页修改</p>
      </div>
    </div>`;
  $('#btnLogin').onclick = doLogin;
  $('#loginPass').onkeydown = (e) => { if (e.key === 'Enter') doLogin(); };
}

async function doLogin() {
  const name = $('#loginName').value;
  const password = $('#loginPass').value;
  if (!password) return toast('请输入密码', 'warn');
  try {
    const r = await api('/api/login', { method: 'POST', body: { name, password } });
    state.token = r.token;
    state.me = r.me;
    state.weekStart = weekStartOf(todayStr());
    state.tab = 'schedule';
    localStorage.setItem('ot_token', r.token);
    renderShell();
    loadTab();
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* —— 主框架 —— */
function renderShell() {
  const isAdmin = state.me.role === 'admin';
  const tabs = [
    ['schedule', '📅 排班'],
    ...(isAdmin ? [
      ['stats', '📊 统计'],
      ['ai', '🤖 AI建议'],
      ['settings', '⚙️ 设置'],
      ['logs', '📝 日志'],
    ] : []),
    ['password', '🔑 密码'],
  ];
  $('#app').innerHTML = `
    <header class="topbar">
      <div class="brand">📅 加班排班表</div>
      <div class="user">
        <span class="chip">${esc(state.me.name)}${isAdmin ? ' · 管理员' : ''}</span>
        <button id="btnLogout" class="ghost">退出</button>
      </div>
    </header>
    <nav class="tabs">
      ${tabs.map(([k, l]) => `<button class="tab ${k === state.tab ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}
    </nav>
    <main id="view"></main>
    <div id="modalRoot"></div>
    <div id="toastRoot"></div>`;
  $('#btnLogout').onclick = logout;
  $$('.tab').forEach((b) => {
    b.onclick = () => { state.tab = b.dataset.tab; renderShell(); loadTab(); };
  });
}

function loadTab() {
  switch (state.tab) {
    case 'schedule': return loadSchedule();
    case 'stats': return loadStats();
    case 'ai': return loadAi();
    case 'settings': return loadSettings();
    case 'logs': return loadLogs();
    case 'password': return loadPassword();
  }
}

/* ================= 排班 ================= */
async function loadSchedule() {
  const d = await api('/api/schedule?week=' + state.weekStart);
  state.data = d;
  const curWs = weekStartOf(todayStr());
  const isAdmin = state.me.role === 'admin';

  const cards = d.days.map((day) => {
    const mine = state.me.role === 'user' && day.personId === state.me.userId;
    const today = day.date === d.today;
    const cls = ['day', today && 'is-today', mine && 'is-mine', !day.name && 'is-empty']
      .filter(Boolean).join(' ');
    return `
      <div class="${cls}" data-date="${day.date}">
        ${mine ? '<span class="badge">我的班</span>' : (!day.name ? '<span class="badge empty">空缺</span>' : '')}
        <div class="day-head"><span>${day.weekday}</span><span>${fmtShort(day.date)}</span></div>
        <div class="day-name">${day.name ? esc(day.name) : '待认领'}</div>
        <div class="day-meta">${day.name ? `${day.hours}h${day.note ? ' · ' + esc(day.note) : ''}` : '点击认领'}</div>
      </div>`;
  }).join('');

  $('#view').innerHTML = `
    <div class="weeknav">
      <button id="wPrev">◀ 上周</button>
      <div class="weektitle">${fmtShort(d.weekStart)} – ${fmtShort(addDays(d.weekStart, 6))}
        <small>${d.isoWeek.year}年第${d.isoWeek.week}周${d.weekStart === curWs ? ' · 本周' : ''}${d.config.generated ? '' : ' · 未生成'}</small>
      </div>
      <button id="wNext">下周 ▶</button>
      <button id="wToday" class="ghost">回到本周</button>
    </div>
    <div class="daygrid">${cards}</div>
    <div class="sendbar">${sendBarHtml(d)}</div>
    ${isAdmin ? '<p class="hint">管理员提示：点击日期可指派/清空/备注；换班记录见「日志」。</p>' : '<p class="hint">提示：点击自己的班可换班/弃班，点击空缺的日期可认领。</p>'}`;

  $('#wPrev').onclick = () => { state.weekStart = addDays(state.weekStart, -7); loadSchedule(); };
  $('#wNext').onclick = () => { state.weekStart = addDays(state.weekStart, 7); loadSchedule(); };
  $('#wToday').onclick = () => { state.weekStart = weekStartOf(todayStr()); loadSchedule(); };
  $$('.day').forEach((el) => { el.onclick = () => openDayModal(el.dataset.date); });
}

function sendBarHtml(d) {
  if (!d.webhookConfigured) return '📧 飞书推送：未配置 webhook（请联系管理员在设置中填写）';
  const s = d.lastSend;
  if (!s) return '📧 飞书推送：已连接，尚未发送过';
  return `📧 飞书推送：已连接 · 上次发送 ${esc(s.time)}（${esc(s.trigger || '')}）
    ${s.ok ? '<span class="ok">成功</span>' : `<span class="bad">失败：${esc(s.error || '')}</span>`}`;
}

function openDayModal(date) {
  const day = state.data.days.find((x) => x.date === date);
  if (!day) return;
  const isAdmin = state.me.role === 'admin';
  const mine = state.me.role === 'user' && day.personId === state.me.userId;
  const info = `<div class="dayinfo"><b>${day.weekday} ${day.date}</b> · ${day.name ? `当前：<b>${esc(day.name)}</b>（${day.hours}h${day.note ? '，' + esc(day.note) : ''}）` : '当前：空缺'}</div>`;

  if (isAdmin) return openAdminDayModal(day, info);

  let body;
  if (mine) {
    body = `${info}
      <div class="rowbtns">
        <button id="aSwap" class="primary">🔄 和别人换班</button>
        <button id="aRelease" class="danger">🚫 弃班（留空待认领）</button>
      </div>`;
    showModal(day.date + ' · 我的班', body);
    $('#aSwap').onclick = () => openSwapPicker(date);
    $('#aRelease').onclick = async () => {
      if (await confirmModal(`确认放弃 <b>${day.weekday} ${day.date}</b> 的班？<br>放弃后该天空缺，其他人可认领。`)) {
        afterMutation(await api('/api/release', { method: 'POST', body: { date } }));
        loadSchedule();
      }
    };
  } else if (day.personId) {
    body = `${info}
      <div class="rowbtns">
        <button id="aSwap" class="primary">🔄 和 ${esc(day.name)} 换班</button>
      </div>`;
    showModal(day.date + ' · 排班详情', body);
    $('#aSwap').onclick = () => openSwapPicker(date);
  } else {
    body = `${info}
      <div class="rowbtns">
        <button id="aClaim" class="primary">✋ 认领这个班</button>
      </div>`;
    showModal(day.date + ' · 空缺', body);
    $('#aClaim').onclick = async () => {
      afterMutation(await api('/api/claim', { method: 'POST', body: { date } }));
      loadSchedule();
    };
  }
}

async function openSwapPicker(targetDate) {
  let days;
  try { days = (await api('/api/my-days')).days; } catch (e) { return toast(e.message, 'error'); }
  const opts = days.filter((x) => x.date !== targetDate);
  if (!opts.length) return toast('你没有其他班可以换', 'warn');
  showModal('选择我要换出的日期', `
    <p class="hint">用我的哪个班，和 <b>${targetDate}</b> 的班交换？</p>
    <div class="picklist">
      ${opts.map((o) => `
        <button data-date="${o.date}">
          <span>${WEEKDAY[dowIdx(o.date)]} ${o.date}（${o.hours}h）</span>
          <span class="r">当前：${esc(o.name)}</span>
        </button>`).join('')}
    </div>`);
  $$('.picklist button').forEach((b) => {
    b.onclick = async () => {
      const fromDate = b.dataset.date;
      if (await confirmModal(`确认交换？<br><b>${fromDate}</b> ⇄ <b>${targetDate}</b><br>交换后飞书会自动重发新排班。`)) {
        try {
          afterMutation(await api('/api/swap', { method: 'POST', body: { fromDate, toDate: targetDate } }));
          loadSchedule();
        } catch (e) { toast(e.message, 'error'); }
      }
    };
  });
}

function openAdminDayModal(day, info) {
  const peopleOpts = ['<option value="">— 空缺 —</option>']
    .concat(state.data.people.map((p) =>
      `<option value="${p.id}" ${p.id === day.personId ? 'selected' : ''}>${esc(p.name)}</option>`))
    .join('');
  showModal(`管理员编辑 · ${day.date}`, `
    ${info}
    <label>指派人员</label>
    <select id="mPerson">${peopleOpts}</select>
    <label>工时（留空 = 默认 ${state.data.config.shiftHours}h）</label>
    <input id="mHours" type="number" step="0.5" min="0.5" max="24" value="${day.hours ?? ''}">
    <label>备注（可选）</label>
    <input id="mNote" maxlength="100" value="${esc(day.note)}">
    <div class="rowbtns">
      <button id="mSave" class="primary">保存</button>
      <button id="mClear" class="ghost">清空此天</button>
      <button id="mRegen" class="ghost">重新生成本周</button>
    </div>`);
  $('#mSave').onclick = async () => {
    try {
      const r = await api('/api/set', {
        method: 'POST',
        body: {
          date: day.date,
          personId: $('#mPerson').value || null,
          hours: $('#mHours').value || undefined,
          note: $('#mNote').value.trim(),
        },
      });
      afterMutation(r);
      loadSchedule();
    } catch (e) { toast(e.message, 'error'); }
  };
  $('#mClear').onclick = async () => {
    try {
      afterMutation(await api('/api/set', { method: 'POST', body: { date: day.date, personId: null } }));
      loadSchedule();
    } catch (e) { toast(e.message, 'error'); }
  };
  $('#mRegen').onclick = async () => {
    if (await confirmModal('重新生成本周会<b>清空本周全部排班</b>并按轮换规则重排，确认？')) {
      try {
        afterMutation(await api('/api/regen', { method: 'POST', body: { weekStart: state.data.weekStart } }));
        loadSchedule();
      } catch (e) { toast(e.message, 'error'); }
    }
  };
}

/* ================= 统计（管理员） ================= */
async function loadStats() {
  const s = await api('/api/stats');
  state.stats = s;
  renderStats();
}

function renderStats() {
  const s = state.stats;
  const modes = [
    ['all', '全部（含未来已排）'],
    ['past', '仅已发生'],
    ['month', '本月'],
  ];
  const get = (p) => {
    if (state.statsMode === 'past') return { shifts: p.pastShifts, hours: p.pastHours, avg: p.pastAvgWeek };
    if (state.statsMode === 'month') return { shifts: p.monthShifts, hours: p.monthHours, avg: null };
    return { shifts: p.shifts, hours: p.hours, avg: p.avgWeek };
  };
  const rows = s.people.map((p) => ({ ...get(p), name: p.name }));
  const maxH = Math.max(1, ...rows.map((r) => r.hours));
  const weeksLabel = state.statsMode === 'past' ? s.weeksPast : state.statsMode === 'month' ? '—' : s.weeksAll;

  $('#view').innerHTML = `
    <div class="card">
      <h3>人均工时统计</h3>
      <p class="hint">统计起始：${s.since || '暂无数据'} · 覆盖 ${weeksLabel} 周 · 每班默认 ${s.shiftHours}h（${esc('9:00-18:00 类班次')}，个别班次可按天覆盖工时）</p>
      <div class="seg">
        ${modes.map(([k, l]) => `<button class="${state.statsMode === k ? 'active' : ''}" data-mode="${k}">${l}</button>`).join('')}
      </div>
      <table>
        <thead><tr><th>姓名</th><th>班次</th><th>工时</th><th>周均工时</th><th style="width:30%">占比</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td><b>${esc(r.name)}</b></td>
              <td>${r.shifts}</td>
              <td>${r.hours}h</td>
              <td>${r.avg === null ? '—' : r.avg + 'h'}</td>
              <td><div class="bar-wrap"><div class="bar" style="width:${Math.round(r.hours / maxH * 100)}%"></div></div></td>
            </tr>`).join('')}
        </tbody>
      </table>
      ${fairnessNote(rows)}
    </div>`;
  $$('.seg button').forEach((b) => {
    b.onclick = () => { state.statsMode = b.dataset.mode; renderStats(); };
  });
}

function fairnessNote(rows) {
  if (!rows.length) return '';
  const hs = rows.map((r) => r.hours);
  const max = Math.max(...hs), min = Math.min(...hs);
  const diff = max - min;
  const level = diff <= 8 ? '均衡 ✅' : diff <= 16 ? '略有差距' : '差距较大 ⚠️';
  const maxP = rows.find((r) => r.hours === max);
  const minP = rows.find((r) => r.hours === min);
  return `<p class="hint">公平性：最多 ${esc(maxP.name)} ${max}h / 最少 ${esc(minP.name)} ${min}h，相差 ${diff}h —— ${level}</p>`;
}

/* ================= AI 建议（管理员） ================= */
async function loadAi() {
  const [r, c] = await Promise.all([api('/api/ai/suggestions'), api('/api/config')]);
  state.suggestions = r.suggestions;
  state.config = c;
  renderAi();
}

function renderAi() {
  const sug = state.suggestions || [];
  $('#view').innerHTML = `
    <div class="card">
      <h3>🤖 DeepSeek 夜间检查</h3>
      <p class="hint">每晚 ${state.config ? state.config.aiCheckHour : '21'}:00 自动检查未来 ${state.config ? state.config.aiCheckDays : 14} 天排班：出现<b>空班</b>或<b>班次不均</b>时，由 DeepSeek 分析并给出最小改动建议。${
        state.config && state.config.aiApplyMode === 'auto' ? '当前模式：<b style="color:var(--ok)">自动应用</b>（应用后自动重发飞书）' : '当前模式：<b>通知确认</b>（建议会发到飞书，需在这里确认应用）'
      }</p>
      <button id="btnAiCheck" class="primary">⚡ 立即运行 AI 检查</button>
      <span class="inline-note" id="aiCheckHint"></span>
    </div>
    ${sug.length ? sug.map(renderSug).join('') : '<div class="card"><p class="hint">暂无 AI 建议。排班均衡时夜检只记日志，不打扰。</p></div>'}`;
  $('#btnAiCheck').onclick = async () => {
    $('#btnAiCheck').disabled = true;
    $('#aiCheckHint').textContent = '正在分析中，约需几秒…';
    try {
      const r = await api('/api/ai/check-now', { method: 'POST', body: {} });
      if (r.skipped) toast('未配置 DeepSeek API Key，请先在「设置」中填写', 'warn');
      else if (r.needChange) toast(`AI 建议：${r.auto ? '已自动应用 ✅' : '已生成，请确认应用'}`, r.auto ? 'ok' : 'info');
      else toast('AI 分析：排班无需变动 ✅', 'ok');
      loadAi();
    } catch (e) {
      toast(e.message, 'error');
      $('#aiCheckHint').textContent = '';
      $('#btnAiCheck').disabled = false;
    }
  };
  $$('.sug-apply').forEach((b) => {
    b.onclick = async () => {
      if (await confirmModal('应用这条 AI 建议？应用后飞书会自动重发受影响的周。')) {
        try {
          await api('/api/ai/apply', { method: 'POST', body: { id: b.dataset.id } });
          toast('已应用，飞书将自动重发 ✅', 'ok');
          loadAi();
        } catch (e) { toast(e.message, 'error'); }
      }
    };
  });
  $$('.sug-ignore').forEach((b) => {
    b.onclick = async () => {
      try {
        await api('/api/ai/ignore', { method: 'POST', body: { id: b.dataset.id } });
        toast('已忽略该建议');
        loadAi();
      } catch (e) { toast(e.message, 'error'); }
    };
  });
}

function renderSug(s) {
  return `
    <div class="card">
      <h3>建议 #${esc(s.id)} <span class="status-pill ${s.status}">${s.status === 'pending' ? '待确认' : s.status === 'applied' ? '已应用' : '已忽略'}</span></h3>
      <p class="hint">${esc(s.time)} · 触发：${esc(s.trigger)}</p>
      <p><b>原因：</b>${esc(s.reason)}</p>
      <div class="sug-changes">
        ${s.changes.map((c) => `<div>${WEEKDAY[dowIdx(c.date)]} ${esc(c.date)}：${c.fromName ? esc(c.fromName) : '空缺'} → <b>${c.toName ? esc(c.toName) : '清空'}</b></div>`).join('')}
      </div>
      ${s.explanation ? `<p class="hint">${esc(s.explanation)}</p>` : ''}
      ${s.status === 'pending' ? `
        <div class="rowbtns">
          <button class="primary sug-apply" data-id="${esc(s.id)}">✔ 应用建议</button>
          <button class="ghost sug-ignore" data-id="${esc(s.id)}">忽略</button>
        </div>` : `<p class="hint">${s.status === 'applied' ? '应用于 ' + esc(s.appliedTime || '') + '（' + esc(s.appliedBy || '') + '）' : '忽略于 ' + esc(s.appliedTime || '')}</p>`}
    </div>`;
}

/* ================= 设置（管理员） ================= */
async function loadSettings() {
  const c = await api('/api/config');
  state.config = c;
  const num = (v) => String(v ?? '');
  $('#view').innerHTML = `
    <div class="card">
      <h3>📨 飞书推送</h3>
      <div class="form-grid">
        <div class="full">
          <label>飞书自定义机器人 Webhook 地址</label>
          <input id="cfgWebhook" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…" value="${esc(c.webhookUrl)}">
        </div>
        <div>
          <label>签名密钥（机器人未开启签名校验则留空）</label>
          <input id="cfgSecret" type="password" value="${esc(c.webhookSecret)}">
        </div>
        <div>
          <label>网页访问地址（附在飞书卡片里）</label>
          <input id="cfgPublicUrl" placeholder="http://服务器IP:8787" value="${esc(c.publicUrl)}">
        </div>
        <div>
          <label>每周一发送时刻（时）</label>
          <input id="cfgSendHour" type="number" min="0" max="23" value="${num(c.sendHour)}">
        </div>
        <div>
          <label>分</label>
          <input id="cfgSendMinute" type="number" min="0" max="59" value="${num(c.sendMinute)}">
        </div>
        <div>
          <label>班次开始时间</label>
          <input id="cfgShiftStart" type="time" value="${esc(c.shiftStart)}">
        </div>
        <div>
          <label>班次结束时间</label>
          <input id="cfgShiftEnd" type="time" value="${esc(c.shiftEnd)}">
        </div>
        <div>
          <label>每班默认工时（小时）</label>
          <input id="cfgShiftHours" type="number" step="0.5" min="0.5" max="24" value="${num(c.shiftHours)}">
        </div>
        <div>
          <label>修改后重发防抖（毫秒）</label>
          <input id="cfgResendDelay" type="number" min="0" max="60000" step="500" value="${num(c.resendDelayMs)}">
        </div>
        <div>
          <label>时区</label>
          <input id="cfgTimezone" value="${esc(c.timezone)}">
        </div>
      </div>
      <div class="section">
        <h3>🤖 DeepSeek 夜检</h3>
        <div class="form-grid">
          <div class="full">
            <label>API Key${c.hasAiKey ? `（已配置 ${esc(c.aiKeyMask)}，输入新值覆盖，输入 CLEAR 删除）` : '（未配置）'}</label>
            <input id="cfgAiKey" type="password" placeholder="${c.hasAiKey ? '留空保持不变' : 'sk-…'}" autocomplete="off">
          </div>
          <div>
            <label>模型</label>
            <input id="cfgAiModel" value="${esc(c.aiModel)}">
          </div>
          <div>
            <label>接口地址</label>
            <input id="cfgAiBase" value="${esc(c.aiBaseUrl)}">
          </div>
          <div>
            <label>每晚检查时刻（时）</label>
            <input id="cfgAiHour" type="number" min="0" max="23" value="${num(c.aiCheckHour)}">
          </div>
          <div>
            <label>分</label>
            <input id="cfgAiMinute" type="number" min="0" max="59" value="${num(c.aiCheckMinute)}">
          </div>
          <div>
            <label>检查未来天数</label>
            <input id="cfgAiDays" type="number" min="1" max="60" value="${num(c.aiCheckDays)}">
          </div>
          <div>
            <label>建议处理方式</label>
            <select id="cfgAiMode">
              <option value="notify" ${c.aiApplyMode !== 'auto' ? 'selected' : ''}>通知管理员确认（推荐）</option>
              <option value="auto" ${c.aiApplyMode === 'auto' ? 'selected' : ''}>自动应用并重发</option>
            </select>
          </div>
        </div>
      </div>
      <div class="rowbtns"><button id="btnSaveCfg" class="primary">保存设置</button></div>
      <p class="hint">保存后如刚配置好 webhook，本周排班会立即补发一次。</p>
    </div>

    <div class="card">
      <h3>📤 手动发送</h3>
      <p class="hint">把当前浏览的周（本周）排班立即发到飞书，用于测试 webhook 配置。</p>
      <button id="btnSendNow" class="primary">立即发送本周到飞书</button>
      <p class="inline-note ${c.lastSend && c.lastSend.ok ? 'ok' : c.lastSend ? 'bad' : ''}" id="sendState">
        ${c.lastSend ? `上次发送 ${esc(c.lastSend.time)}（${esc(c.lastSend.trigger || '')}）${c.lastSend.ok ? ' ✅ 成功' : ' ❌ ' + esc(c.lastSend.error)}` : '尚未发送过'}
      </p>
    </div>

    <div class="card">
      <h3>📥 批量导入排班</h3>
      <p class="hint">每行一条：<code>日期 姓名</code>（空格/逗号分隔），姓名填 <code>-</code> 表示清空该天。导入后自动重发飞书。给到具体排班表时用这个最快。</p>
      <textarea id="impText" rows="6" placeholder="2026-09-21 A&#10;2026-09-22 B"></textarea>
      <div class="rowbtns"><button id="btnImport" class="primary">导入</button></div>
      <div id="impResult" class="inline-note"></div>
    </div>

    <div class="card">
      <h3 style="color:var(--danger)">⚠️ 危险区</h3>
      <p class="hint">清空全部排班数据（然后自动重排未来 4 周占位）。输入 <code>CLEAR</code> 确认。</p>
      <input id="clearConfirm" placeholder="CLEAR">
      <div class="rowbtns"><button id="btnClear" class="danger">清空全部排班</button></div>
    </div>`;

  $('#btnSaveCfg').onclick = async () => {
    const body = {
      webhookUrl: $('#cfgWebhook').value.trim(),
      webhookSecret: $('#cfgSecret').value,
      publicUrl: $('#cfgPublicUrl').value.trim(),
      sendHour: Number($('#cfgSendHour').value),
      sendMinute: Number($('#cfgSendMinute').value),
      shiftStart: $('#cfgShiftStart').value || '09:00',
      shiftEnd: $('#cfgShiftEnd').value || '18:00',
      shiftHours: Number($('#cfgShiftHours').value),
      resendDelayMs: Number($('#cfgResendDelay').value),
      timezone: $('#cfgTimezone').value.trim() || 'Asia/Shanghai',
      aiModel: $('#cfgAiModel').value.trim() || 'deepseek-chat',
      aiBaseUrl: $('#cfgAiBase').value.trim() || 'https://api.deepseek.com',
      aiCheckHour: Number($('#cfgAiHour').value),
      aiCheckMinute: Number($('#cfgAiMinute').value),
      aiCheckDays: Number($('#cfgAiDays').value),
      aiApplyMode: $('#cfgAiMode').value,
    };
    const key = $('#cfgAiKey').value.trim();
    if (key) body.aiApiKey = key;
    try {
      await api('/api/config', { method: 'POST', body });
      toast('设置已保存 ✅', 'ok');
      loadSettings();
    } catch (e) { toast(e.message, 'error'); }
  };

  $('#btnSendNow').onclick = async () => {
    $('#btnSendNow').disabled = true;
    try {
      const r = await api('/api/send-now', { method: 'POST', body: {} });
      if (r.ok) toast('已发送到飞书 ✅', 'ok');
      else toast('发送失败：' + (r.error || '未知错误'), 'error');
    } catch (e) { toast(e.message, 'error'); }
    loadSettings();
  };

  $('#btnImport').onclick = async () => {
    const text = $('#impText').value;
    if (!text.trim()) return toast('请先填写导入内容', 'warn');
    try {
      const r = await api('/api/import', { method: 'POST', body: { text } });
      $('#impResult').innerHTML = `生效 ${r.applied.length} 条${r.errors.length ? `，失败 ${r.errors.length} 条：<br>${r.errors.map(esc).join('<br>')}` : ' ✅'}`;
      toast(`导入完成：生效 ${r.applied.length} 条`, r.errors.length ? 'warn' : 'ok');
    } catch (e) { toast(e.message, 'error'); }
  };

  $('#btnClear').onclick = async () => {
    if ($('#clearConfirm').value !== 'CLEAR') return toast('请先输入 CLEAR 确认', 'warn');
    try {
      await api('/api/clear', { method: 'POST', body: { confirm: 'CLEAR' } });
      toast('已清空并重排未来 4 周', 'ok');
    } catch (e) { toast(e.message, 'error'); }
  };
}

/* ================= 日志（管理员） ================= */
async function loadLogs() {
  const r = await api('/api/logs?limit=200');
  state.logs = r.logs;
  $('#view').innerHTML = `
    <div class="card">
      <h3>变更日志（最近 200 条）</h3>
      <table>
        <thead><tr><th style="width:150px">时间</th><th style="width:120px">操作人</th><th style="width:90px">动作</th><th>内容</th></tr></thead>
        <tbody>
          ${r.logs.map((l) => `
            <tr>
              <td>${esc(l.time)}</td>
              <td>${esc(l.actor)}<span class="hint">（${esc(l.role === 'admin' ? '管理员' : l.role === 'user' ? '成员' : '系统')}）</span></td>
              <td>${esc(l.action)}</td>
              <td>${esc(l.detail)}</td>
            </tr>`).join('') || '<tr><td colspan="4" class="hint">暂无日志</td></tr>'}
        </tbody>
      </table>
    </div>`;
}

/* ================= 修改密码 ================= */
function loadPassword() {
  const isAdmin = state.me.role === 'admin';
  $('#view').innerHTML = `
    <div class="card" style="max-width:440px;margin:0 auto">
      <h3>修改密码</h3>
      <label>原密码</label>
      <input id="pwOld" type="password" autocomplete="current-password">
      <label>新密码（至少 4 位）</label>
      <input id="pwNew" type="password" autocomplete="new-password">
      <label>再次输入新密码</label>
      <input id="pwNew2" type="password" autocomplete="new-password">
      <div class="rowbtns"><button id="btnPw" class="primary">修改密码</button></div>
      ${isAdmin ? '<p class="hint">当前修改的是管理员密码（登录名 admin）。</p>' : '<p class="hint">修改的是自己的登录密码。</p>'}
    </div>`;
  $('#btnPw').onclick = async () => {
    const oldPassword = $('#pwOld').value;
    const newPassword = $('#pwNew').value;
    if (newPassword.length < 4) return toast('新密码至少 4 位', 'warn');
    if (newPassword !== $('#pwNew2').value) return toast('两次输入的新密码不一致', 'warn');
    try {
      await api('/api/password', { method: 'POST', body: { oldPassword, newPassword } });
      toast('密码已修改 ✅ 下次登录请使用新密码', 'ok');
      $('#pwOld').value = $('#pwNew').value = $('#pwNew2').value = '';
    } catch (e) { toast(e.message, 'error'); }
  };
}

/* —— 启动 —— */
(async function init() {
  if (!state.token) return renderLogin();
  try {
    const { me } = await api('/api/me');
    state.me = me;
    state.weekStart = weekStartOf(todayStr());
    renderShell();
    loadTab();
  } catch (e) {
    toast(e.message, 'error');
  }
})();
