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
  members: null,     // /api/members 响应（管理员）
  promptMd: {},      // { g1: md, g2: md }
  promptGroup: 'g1',
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
  let people = [];
  try { people = (await api('/api/people')).people; } catch { /* 忽略 */ }
  $('#app').innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <h1>📅 加班排班表</h1>
        <div class="sub">登录后可查看排班、发起换班</div>
        <label>我是</label>
        <div class="row">
          <select id="loginName">
            ${people.map((n) => `<option value="${esc(n.name)}">${esc(n.name)}${n.group ? '（' + esc(n.group) + '）' : ''}</option>`).join('')}
            <option value="admin">管理员</option>
          </select>
        </div>
        <label>密码</label>
        <input id="loginPass" type="password" placeholder="请输入密码" autocomplete="current-password">
        <div style="height:16px"></div>
        <button id="btnLogin" class="primary big">登 录</button>
        <p class="hint" style="text-align:center;margin-top:14px">成员由管理员在「设置→成员管理」增减<br>新成员初始密码默认 123456，登录后请到「密码」页修改</p>
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
      ['ai', '🪄 AI排班'],
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

/* —— 当前登录成员所在组 / 组名 —— */
function myPerson() {
  if (!state.data || state.me.role !== 'user') return null;
  return state.data.people.find((p) => p.id === state.me.userId) || null;
}
function groupName(id) {
  if (!state.data || !Array.isArray(state.data.groups)) return '';
  const g = state.data.groups.find((x) => x.id === id);
  return g ? g.name : '';
}
function dayPeople(day, gid) {
  const slot = day && day.groups ? day.groups[gid] : null;
  return (slot && slot.people) || [];
}
// 显示用组列表：只显示有成员的组（没人=没人能认领，显示"待认领"是误导）；全都没成员时兜底全显示
function visibleGroups() {
  const gs = (state.data && state.data.groups) || [];
  const withMembers = gs.filter((g) => g.memberCount > 0);
  return withMembers.length ? withMembers : gs;
}

/* ================= 排班 ================= */
async function loadSchedule() {
  const d = await api('/api/schedule?week=' + state.weekStart);
  state.data = d;
  // 用会话里的最新身份兜底（含 userId；改名后 name 也会同步）
  if (d.me && d.me.userId) state.me = d.me;
  const curWs = weekStartOf(todayStr());
  const isAdmin = state.me.role === 'admin';

  // 本周完全没排班而下周已排（AI 生成的排班通常在下周）→ 自动切到下周，避免"重进看到全空"的误会
  if (!state.weekJumped && d.weekStart === curWs && d.nextWeekHasSchedule) {
    const weekHas = (dd) => (dd.groups || []).some((g) => g.memberCount > 0
      && dd.days.some((day) => ((day.groups[g.id] || {}).people || []).length > 0));
    if (!weekHas(d)) {
      state.weekJumped = true; // 每次进入页面只自动跳一次
      toast('本周暂无排班，下周已排——已切到下周查看（点「回到本周」可返回）', 'info', 5000);
      state.weekStart = addDays(curWs, 7);
      return loadSchedule();
    }
  }

  const cards = d.days.map((day) => {
    const today = day.date === d.today;
    const myP = myPerson();
    const myList = myP ? dayPeople(day, myP.groupId) : [];
    const mine = myP && myList.some((p) => p.personId === state.me.userId);
    const cls = ['day', today && 'is-today', mine && 'is-mine'].filter(Boolean).join(' ');
    const rows = visibleGroups().map((g, gi) => {
      const people = dayPeople(day, g.id);
      const rowMine = myP && g.id === myP.groupId && people.some((x) => x.personId === state.me.userId);
      const title = people.length
        ? `${g.name}：${people.map((p) => `${p.name}（${p.hours}h${p.note ? '，' + p.note : ''}）`).join('、')}`
        : `${g.name}：空缺`;
      const meta = people.length > 1 ? `${people.length}人` : (people.length === 1 ? `${people[0].hours}h` : '');
      return `
        <div class="g-row ${rowMine ? 'is-mine' : ''} ${!people.length ? 'is-empty' : ''}" title="${esc(title)}">
          <span class="g-tag gtag-${gi % 2}">${esc(g.name)}</span>
          <span class="g-name">${people.length ? people.map((p) => esc(p.name)).join('、') : '空缺'}</span>
          <span class="g-meta">${meta}</span>
        </div>`;
    }).join('');
    return `
      <div class="${cls}" data-date="${day.date}">
        ${mine ? '<span class="badge">我的班</span>' : ''}
        <div class="day-head"><span>${day.weekday}</span><span>${fmtShort(day.date)}</span></div>
        ${rows}
      </div>`;
  }).join('');

  // 「未生成」只提示开了自动轮换的组（关轮换的组本来就不自动生成，提示会永远挂着）
  const ungen = (d.groups || []).filter((g) => g.memberCount > 0 && g.autoRotate !== false && d.generatedMap && !d.generatedMap[g.id]);

  $('#view').innerHTML = `
    <div class="weeknav">
      <button id="wPrev">◀ 上周</button>
      <div class="weektitle">${fmtShort(d.weekStart)} – ${fmtShort(addDays(d.weekStart, 6))}
        <small>${d.isoWeek.year}年第${d.isoWeek.week}周${d.weekStart === curWs ? ' · 本周' : ''}${ungen.length ? ' · 未生成：' + ungen.map((g) => esc(g.name)).join('、') : ''}${d.config.saturdayDouble ? ' · 周六双倍' : ''}</small>
      </div>
      <button id="wNext">下周 ▶</button>
      <button id="wToday" class="ghost">回到本周</button>
    </div>
    <div class="daygrid">${cards}</div>
    <div class="sendbar">${sendBarHtml(d)}</div>
    ${isAdmin
      ? '<p class="hint">管理员提示：点击日期可按组编辑当天出勤名单（可多人）；两组互不影响，各排各的。</p>'
      : '<p class="hint">提示：每天两组各有 0~N 人出勤。点击日期可处理<b>自己组</b>的班：换班 / 弃班 / 认领加入。</p>'}`;

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

function dayInfoHtml(day) {
  const parts = visibleGroups().map((g) => {
    const people = dayPeople(day, g.id);
    return `${esc(g.name)}：${people.length
      ? people.map((p) => `<b>${esc(p.name)}</b>（${p.hours}h${p.note ? '，' + esc(p.note) : ''}）`).join('、')
      : '空缺'}`;
  }).join(' · ');
  return `<div class="dayinfo"><b>${day.weekday} ${day.date}</b><br>${parts}</div>`;
}

function openDayModal(date) {
  const day = state.data.days.find((x) => x.date === date);
  if (!day) return;
  const isAdmin = state.me.role === 'admin';
  const info = dayInfoHtml(day);

  if (isAdmin) return openAdminDayModal(day, info);

  const myP = myPerson();
  if (!myP) return showModal(day.date + ' · 排班详情', info + '<p class="hint">账号信息异常，请联系管理员。</p>');
  const gName = groupName(myP.groupId);
  const myList = dayPeople(day, myP.groupId);
  const mine = myList.some((p) => p.personId === state.me.userId);

  let body;
  if (mine) {
    body = `${info}
      <p class="hint">你在 ${date}「${esc(gName)}」的出勤名单中。</p>
      <div class="rowbtns">
        <button id="aSwap" class="primary">🔄 和别人换班</button>
        <button id="aRelease" class="danger">🚫 弃班（留空待认领）</button>
      </div>`;
    showModal(day.date + ' · 我的班', body);
    $('#aSwap').onclick = () => openSwapPicker(date);
    $('#aRelease').onclick = async () => {
      if (await confirmModal(`确认放弃 <b>${day.weekday} ${day.date}</b>（${esc(gName)}）的班？<br>放弃后你不在当天名单中，空位待认领。`)) {
        afterMutation(await api('/api/release', { method: 'POST', body: { date } }));
        loadSchedule();
      }
    };
  } else {
    body = `${info}
      <p class="hint">你不在 ${date}「${esc(gName)}」的出勤名单中。</p>
      <div class="rowbtns">
        <button id="aClaim" class="primary">✋ 认领加入（${esc(gName)}）</button>
        ${myList.length ? '<button id="aSwap" class="ghost">🔄 和本组某人换班</button>' : ''}
      </div>`;
    showModal(day.date + ' · 排班详情', body);
    $('#aClaim').onclick = async () => {
      afterMutation(await api('/api/claim', { method: 'POST', body: { date } }));
      loadSchedule();
    };
    if (myList.length) $('#aSwap').onclick = () => openSwapPicker(date);
  }
}

/* 换班两步：先选我让出的日期，再选对方（目标日当天我组里的人） */
async function openSwapPicker(targetDate) {
  let days;
  try { days = (await api('/api/my-days')).days; } catch (e) { return toast(e.message, 'error'); }
  const opts = days.filter((x) => x.date !== targetDate);
  if (!opts.length) return toast('你没有其他班可以换', 'warn');
  showModal('换班 · 第 1 步：选择我让出的日期', `
    <p class="hint">用我的哪个班，去换 <b>${targetDate}</b> 上别人的班？（只能和本组成员互换）</p>
    <div class="picklist">
      ${opts.map((o) => `
        <button data-date="${o.date}">
          <span>${WEEKDAY[dowIdx(o.date)]} ${o.date}（${o.hours}h${o.groupId ? ' · ' + esc(groupName(o.groupId)) : ''}）</span>
          <span class="r">当前：${esc(o.name)}</span>
        </button>`).join('')}
    </div>`);
  $$('.picklist button').forEach((b) => {
    b.onclick = () => openSwapTarget(targetDate, b.dataset.date);
  });
}

function openSwapTarget(targetDate, fromDate) {
  const day = state.data.days.find((x) => x.date === targetDate);
  const myP = myPerson();
  const cands = myP ? dayPeople(day, myP.groupId).filter((p) => p.personId !== state.me.userId) : [];
  if (!cands.length) {
    closeModal();
    return toast(`${targetDate} 你的组里没有可交换的人`, 'warn');
  }
  showModal('换班 · 第 2 步：选择交换对象', `
    <p class="hint">用 <b>${fromDate}</b> 的班，和 <b>${targetDate}</b> 上的谁交换？</p>
    <div class="picklist">
      ${cands.map((p) => `
        <button data-pid="${p.personId}">
          <span>${esc(p.name)}</span>
          <span class="r">${p.hours}h</span>
        </button>`).join('')}
    </div>`);
  $$('.picklist button').forEach((b) => {
    b.onclick = async () => {
      const pid = b.dataset.pid;
      const name = (cands.find((x) => x.personId === pid) || {}).name || '';
      if (await confirmModal(`确认交换？<br><b>${fromDate}</b>（你的班）⇄ <b>${targetDate}</b>（${esc(name)} 的班）<br>交换后飞书会自动重发新排班。`)) {
        try {
          afterMutation(await api('/api/swap', { method: 'POST', body: { fromDate, toDate: targetDate, withPersonId: pid } }));
          closeModal();
          loadSchedule();
        } catch (e) { toast(e.message, 'error'); }
      }
    };
  });
}

/* 管理员：按组编辑当天出勤名单（动态行） */
function slotRowHtml(g, entry) {
  const members = state.data.people.filter((p) => p.groupId === g.id);
  const opts = ['<option value="">— 选择人员 —</option>']
    .concat(members.map((p) => {
      const label = p.code && p.code !== p.name ? `${esc(p.name)}（${esc(p.code)}）` : esc(p.name);
      return `<option value="${p.id}" ${entry && entry.personId === p.id ? 'selected' : ''}>${label}</option>`;
    }))
    .join('');
  return `
    <div class="slot-row">
      <select class="sr-person">${opts}</select>
      <input class="sr-hours" type="number" step="0.5" min="0.5" max="24" placeholder="工时" value="${entry && entry.rawHours != null ? entry.rawHours : ''}" title="留空 = 默认 ${state.data.config.shiftHours}h${state.data.config.saturdayDouble ? '（周六自动双倍计入）' : ''}">
      <input class="sr-note" maxlength="100" placeholder="备注" value="${entry ? esc(entry.note) : ''}">
      <button class="sr-del btn-sm softdanger">删</button>
    </div>`;
}

function bindSlotRows(gid) {
  const box = $('#rows_' + gid);
  $$('.sr-del', box).forEach((b) => {
    b.onclick = () => b.closest('.slot-row').remove();
  });
}

function openAdminDayModal(day, info) {
  const groups = visibleGroups();
  const blocks = groups.map((g) => {
    const people = dayPeople(day, g.id);
    return `
      <div class="grp-edit">
        <label><b>${esc(g.name)}</b> · 当天出勤名单（${people.length} 人，可增减）</label>
        <div class="slot-rows" id="rows_${g.id}">
          ${people.map((p) => slotRowHtml(g, p)).join('')}
        </div>
        <div class="grp-tools">
          <button class="ghost btn-sm row-add" data-g="${g.id}">➕ 加一人</button>
          <button class="primary btn-sm grp-save" data-g="${g.id}">保存「${esc(g.name)}」</button>
        </div>
      </div>`;
  }).join('');

  showModal(`管理员编辑 · ${day.date}`, `
    ${info}
    ${blocks}
    <div class="rowbtns">
      ${groups.filter((g) => g.autoRotate !== false)
        .map((g) => `<button class="ghost mRegen" data-gid="${g.id}">按轮换重排本周·${esc(g.name)}</button>`).join('')}
    </div>`);

  groups.forEach((g) => bindSlotRows(g.id));

  $$('.row-add').forEach((b) => {
    b.onclick = () => {
      const gid = b.dataset.g;
      const g = groups.find((x) => x.id === gid);
      $('#rows_' + gid).insertAdjacentHTML('beforeend', slotRowHtml(g, null));
      bindSlotRows(gid);
    };
  });

  $$('.grp-save').forEach((b) => {
    b.onclick = async () => {
      const gid = b.dataset.g;
      const rows = $$('.slot-row', $('#rows_' + gid));
      const entries = [];
      for (const row of rows) {
        const personId = $('.sr-person', row).value;
        if (!personId) continue;
        entries.push({
          personId,
          hours: $('.sr-hours', row).value || undefined,
          note: $('.sr-note', row).value.trim(),
        });
      }
      try {
        const r = await api('/api/set', { method: 'POST', body: { date: day.date, groupId: gid, entries } });
        afterMutation(r);
        loadSchedule();
      } catch (e) { toast(e.message, 'error'); }
    };
  });

  $$('.mRegen').forEach((b) => {
    b.onclick = async () => {
      const gid = b.dataset.gid;
      const g = groups.find((x) => x.id === gid) || {};
      if (await confirmModal(`重新生成本周「${esc(g.name)}」会<b>清空该组本周全部排班</b>并按轮换规则重排，确认？`)) {
        try {
          afterMutation(await api('/api/regen', { method: 'POST', body: { weekStart: state.data.weekStart, groupId: gid } }));
          loadSchedule();
        } catch (e) { toast(e.message, 'error'); }
      }
    };
  });
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

  const groupCards = s.groups.map((g) => {
    const rows = g.members.map((p) => ({ ...get(p), name: p.name }));
    const weeksLabel = state.statsMode === 'past' ? g.weeksPast : state.statsMode === 'month' ? '—' : g.weeksAll;
    if (!rows.length) {
      return `<div class="card"><h3>${esc(g.name)}</h3><p class="hint">该组暂无成员，无排班数据。</p></div>`;
    }
    const maxH = Math.max(1, ...rows.map((r) => r.hours));
    return `
      <div class="card">
        <h3>${esc(g.name)}（${g.members.length} 人）</h3>
        <p class="hint">覆盖 ${weeksLabel} 周 · <b>工时按小时累计</b>：每班默认 ${s.shiftHours}h（设置里可改），周六${s.saturdayDouble ? `按<b>双倍 ${s.shiftHours * 2}h</b> 计入` : '不双倍'}；编辑排班时可为具体人/班次单独设工时。</p>
        <div class="tscroll"><table>
          <thead><tr><th>姓名</th><th>工时</th><th>班次</th><th>周均工时</th><th style="width:26%;min-width:96px">占比</th></tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td><b>${esc(r.name)}</b></td>
                <td><b>${r.hours}h</b></td>
                <td>${r.shifts}</td>
                <td>${r.avg === null ? '—' : r.avg + 'h'}</td>
                <td><div class="bar-wrap"><div class="bar" style="width:${Math.round(r.hours / maxH * 100)}%"></div></div></td>
              </tr>`).join('')}
          </tbody>
        </table></div>
        ${fairnessNote(rows)}
      </div>`;
  }).join('');

  $('#view').innerHTML = `
    <div class="card">
      <h3>人均工时统计</h3>
      <p class="hint">统计起始：${s.since || '暂无数据'} · 两个组独立排班、独立统计，互不影响。「全部」口径包含<b>未来已排</b>的班（含自动轮换占位），「仅已发生」只算已经过去的日期。</p>
      <div class="seg">
        ${modes.map(([k, l]) => `<button class="${state.statsMode === k ? 'active' : ''}" data-mode="${k}">${l}</button>`).join('')}
      </div>
    </div>
    ${groupCards}`;
  $$('.seg button').forEach((b) => {
    b.onclick = () => { state.statsMode = b.dataset.mode; renderStats(); };
  });
}

function fairnessNote(rows) {
  if (!rows.length) return '';
  if (rows.every((r) => r.hours === 0)) return '<p class="hint">暂无排班数据（该组清空后还没有生成/导入过排班）。</p>';
  const hs = rows.map((r) => r.hours);
  const max = Math.max(...hs), min = Math.min(...hs);
  const diff = max - min;
  const level = diff <= 8 ? '均衡 ✅' : diff <= 16 ? '略有差距' : '差距较大 ⚠️';
  const maxP = rows.find((r) => r.hours === max);
  const minP = rows.find((r) => r.hours === min);
  return `<p class="hint">公平性：最多 ${esc(maxP.name)} ${max}h / 最少 ${esc(minP.name)} ${min}h，相差 ${diff}h —— ${level}</p>`;
}

/* ================= AI 排班（管理员） ================= */
async function loadAi() {
  const [r, c, p, m] = await Promise.all([
    api('/api/ai/suggestions'), api('/api/config'), api('/api/ai/prompt'), api('/api/members'),
  ]);
  state.suggestions = r.suggestions;
  state.config = c;
  state.promptMd = p.files || {};
  if (!state.promptMd[state.promptGroup] && state.promptMd.g1 !== undefined) state.promptGroup = 'g1';
  state.members = m;
  renderAi();
}

function renderAi() {
  const sug = state.suggestions || [];
  const groups = (state.members && state.members.groups) || [];
  const defWeek = weekStartOf(addDays(todayStr(), 7)); // 默认下周一
  const modeLine = state.config && state.config.aiApplyMode === 'auto'
    ? '当前模式：<b style="color:var(--ok)">自动应用</b>（建议生成后直接生效并重发飞书）'
    : '当前模式：<b>通知确认</b>（建议生成后需在此确认应用）';
  const pg = state.promptGroup || 'g1';
  const pgName = (groups.find((g) => g.id === pg) || {}).name || pg;
  const md = state.promptMd[pg] || '';
  const promptHintHtml = (gid) => {
    const gName = (groups.find((g) => g.id === gid) || {}).name || gid;
    const file = gid === 'g1' ? 'prompt_md/prompt.md' : 'prompt_md/prompt_b.md';
    const has = (state.promptMd[gid] || '').trim().length > 0;
    return `当前编辑：<b>${esc(gName)}</b>规则，文件 <code>${file}</code>${has ? '' : '（尚未编写）'}。
        AI 生成该组排班时以本规则为准；「补充要求」输入框里的临时指令优先级更高。每天出勤人数、硬性约束、公平口径都写在这里。`;
  };

  $('#view').innerHTML = `
    <div class="card">
      <h3>📋 排班规则（Markdown · 按组）</h3>
      <div class="seg" id="promptSeg">
        ${groups.map((g) => `<button class="${pg === g.id ? 'active' : ''}" data-g="${g.id}">${esc(g.name)}规则</button>`).join('')}
      </div>
      <p class="hint" id="promptHint">${promptHintHtml(pg)}</p>
      <textarea id="aiPromptMd" class="mono" rows="14" spellcheck="false"
        placeholder="（该组还没有规则文件。可直接在此输入规则并点保存，例如：&#10;# 每天出勤人数&#10;周一：2人 …&#10;# 硬性约束&#10;…）">${esc(md)}</textarea>
      <div class="rowbtns">
        <button id="btnSavePrompt" class="primary">保存「${esc(pgName)}」规则</button>
        <span class="inline-note" id="promptState"></span>
      </div>
    </div>

    <div class="card">
      <h3>🪄 AI 生成排班</h3>
      <p class="hint">按上方「该组的规则」让大模型生成一段时间的排班（每天可以是 0~N 人）；结果以「建议」展示（逐日名单对比），确认应用后飞书自动重发。${modeLine}</p>
      <div class="form-grid">
        <div>
          <label>分组</label>
          <select id="genGroup">${groups.map((g) => `<option value="${g.id}" ${g.id === pg ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select>
        </div>
        <div>
          <label>开始日期（自动归到周一）</label>
          <input id="genWeek" type="date" value="${defWeek}">
        </div>
        <div>
          <label>生成周数</label>
          <select id="genWeeks">
            <option value="1" selected>1 周</option>
            <option value="2">2 周</option>
            <option value="3">3 周</option>
            <option value="4">4 周</option>
          </select>
        </div>
        <div>
          <label>&nbsp;</label>
          <button id="btnGen" class="primary big">🪄 生成排班</button>
        </div>
        <div class="full">
          <label>补充要求（可选 · 优先级高于规则 md · 没有规则文件时这里就是规则）</label>
          <textarea id="genInstr" rows="3" placeholder="例：这周三张三请假不要排他；周五该组统一不值班；优先照顾近期班次少的人"></textarea>
        </div>
      </div>
      <p class="inline-note" id="genState"></p>
    </div>

    <div class="card">
      <h3>⚡ 夜间检查（逐组独立，会带上该组规则）</h3>
      <p class="hint">每晚 ${state.config ? state.config.aiCheckHour : '21'}:00 自动逐组检查未来 ${state.config ? state.config.aiCheckDays : 14} 天<b>已排班</b>的周：出现<b>无人排班/班次不均/与规则不符</b>时，由 DeepSeek 按该组规则给出最小改动建议；还没排班的空周不提醒（等你在上面生成）。${modeLine}</p>
      <button id="btnAiCheck" class="primary">⚡ 立即运行 AI 检查</button>
      <span class="inline-note" id="aiCheckHint"></span>
    </div>

    <h3 class="listhead">建议列表</h3>
    ${sug.length ? sug.map(renderSug).join('') : '<div class="card"><p class="hint">暂无 AI 建议。排班均衡时夜检只记日志，不打扰。</p></div>'}`;

  $$('#promptSeg button').forEach((b) => {
    b.onclick = () => {
      state.promptGroup = b.dataset.g;
      const gName = (groups.find((x) => x.id === state.promptGroup) || {}).name || '';
      $('#aiPromptMd').value = state.promptMd[state.promptGroup] || '';
      $$('#promptSeg button').forEach((x) => x.classList.toggle('active', x.dataset.g === state.promptGroup));
      $('#btnSavePrompt').textContent = `保存「${gName}」规则`;
      $('#promptHint').innerHTML = promptHintHtml(state.promptGroup);
      $('#promptState').textContent = '';
      $('#genGroup').value = state.promptGroup; // 顺手把生成目标切到同一组
    };
  });

  $('#btnSavePrompt').onclick = async () => {
    try {
      await api('/api/ai/prompt', { method: 'POST', body: { group: state.promptGroup, md: $('#aiPromptMd').value } });
      state.promptMd[state.promptGroup] = $('#aiPromptMd').value;
      toast(`${pgName}规则已保存 ✅`, 'ok');
      $('#promptState').textContent = `已保存（${$('#aiPromptMd').value.length} 字）`;
    } catch (e) { toast(e.message, 'error'); }
  };

  $('#btnGen').onclick = async () => {
    const btn = $('#btnGen');
    btn.disabled = true;
    $('#genState').textContent = 'AI 正在排班，约需几秒到几十秒…';
    try {
      const r = await api('/api/ai/generate', {
        method: 'POST',
        body: {
          groupId: $('#genGroup').value,
          weekStart: $('#genWeek').value || defWeek,
          weeks: Number($('#genWeeks').value) || 1,
          instruction: $('#genInstr').value.trim(),
        },
      });
      if (r.needChange) {
        toast(`AI 已生成排班建议${r.auto ? '并自动应用 ✅' : '，请在下方确认应用'}`, r.auto ? 'ok' : 'info');
      } else {
        toast(r.reason || 'AI 认为当前排班已符合规则 ✅', 'ok');
      }
      loadAi();
    } catch (e) {
      toast(e.message, 'error');
      $('#genState').textContent = '';
      btn.disabled = false;
    }
  };

  $('#btnAiCheck').onclick = async () => {
    $('#btnAiCheck').disabled = true;
    $('#aiCheckHint').textContent = '正在分析中，约需几秒…';
    try {
      const r = await api('/api/ai/check-now', { method: 'POST', body: {} });
      if (r.skipped) {
        toast('未配置 DeepSeek API Key，请先在「设置」中填写', 'warn');
      } else {
        const parts = (r.results || []).map((x) =>
          x.error ? `${x.name}：失败（${x.error}）`
            : x.skipped ? `${x.name}：尚无已排班的周，跳过`
              : x.needChange ? `${x.name}：${x.auto ? '已自动应用 ✅' : '有待确认的建议'}`
                : `${x.name}：无需变动`);
        toast(parts.join('；') || '检查完成', r.needChange ? 'info' : 'ok', 5000);
      }
      loadAi();
    } catch (e) {
      toast(e.message, 'error');
      $('#aiCheckHint').textContent = '';
      $('#btnAiCheck').disabled = false;
    }
  };

  $$('.sug-apply').forEach((b) => {
    b.onclick = async () => {
      if (await confirmModal('应用这条 AI 建议？应用后飞书会自动重发受影响的周，并跳转排班表查看。')) {
        try {
          const r = await api('/api/ai/apply', { method: 'POST', body: { id: b.dataset.id } });
          const s = r.suggestion;
          if (s && s.scopeStart) {
            const ws = weekStartOf(s.scopeStart);
            toast(`已应用 ✅ 正在查看 ${fmtShort(ws)} 起的那周排班`, 'ok');
            state.weekStart = ws;
            state.tab = 'schedule';
            renderShell();
            loadTab();
          } else {
            toast('已应用，飞书将自动重发 ✅', 'ok');
            loadAi();
          }
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
      <h3>建议 #${esc(s.id)}
        ${s.groupName ? `<span class="status-pill group">${esc(s.groupName)}</span>` : ''}
        <span class="status-pill ${s.status}">${s.status === 'pending' ? '待确认' : s.status === 'applied' ? '已应用' : '已忽略'}</span>
      </h3>
      <p class="hint">${esc(s.time)} · 触发：${esc(s.trigger)}</p>
      <p><b>原因：</b>${esc(s.reason)}</p>
      <div class="sug-changes">
        ${s.changes.map((c) => `<div>${WEEKDAY[dowIdx(c.date)]} ${esc(c.date)}：${c.fromNames && c.fromNames.length ? c.fromNames.map(esc).join('、') : '空缺'} → <b>${c.toNames && c.toNames.length ? c.toNames.map(esc).join('、') : '清空'}</b></div>`).join('')}
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
  const [c, m] = await Promise.all([api('/api/config'), api('/api/members')]);
  state.config = c;
  state.members = m;
  const num = (v) => String(v ?? '');

  const memberCard = `
    <div class="card">
      <h3>👥 成员管理</h3>
      <p class="hint">两个组<b>独立排班、互不干扰</b>。<b>移除成员</b>＝删除账号并清空其名下全部排班（立即下线）；
        <b>调整分组</b>会清空其原组排班。<b>改名</b>只改显示/登录名，排班自动更新；
        每人还有一个<b>代号</b>（如 a、b），排班规则 md 和 AI 识别用代号，改姓名不用动规则。</p>
      ${m.groups.map((g) => {
        const members = m.people.filter((p) => p.groupId === g.id);
        const other = m.groups.find((x) => x.id !== g.id);
        return `
        <div class="member-group">
          <h4>${esc(g.name)}（${members.length} 人）</h4>
          <div class="grp-cfg">
            <span class="hint">自动轮换占位：</span>
            <select class="arot" data-g="${g.id}">
              <option value="1" ${g.autoRotate !== false ? 'selected' : ''}>开</option>
              <option value="0" ${g.autoRotate === false ? 'selected' : ''}>关</option>
            </select>
            <span class="hint">${g.autoRotate !== false
              ? '未排班的日子自动按轮换补 1 人保底（含周五/周日）'
              : '不自动占位：排班只来自「AI排班」生成或手动指派，清空排班后保持全空'}</span>
          </div>
          ${members.length ? members.map((p) => `
            <div class="member-row">
              <span class="name">${esc(p.name)}${p.code && p.code !== p.name ? `<span class="code-chip" title="代号：规则 md 与 AI 识别用">${esc(p.code)}</span>` : ''}</span>
              <button class="ghost btn-sm rn" data-id="${p.id}" data-name="${esc(p.name)}" data-code="${esc(p.code || '')}">✏️ 改名</button>
              ${other ? `<button class="ghost btn-sm mv" data-id="${p.id}" data-to="${other.id}" data-name="${esc(p.name)}" data-g="${esc(other.name)}">移到「${esc(other.name)}」</button>` : ''}
              <button class="btn-sm softdanger rm" data-id="${p.id}" data-name="${esc(p.name)}">移除</button>
            </div>`).join('') : '<p class="hint">暂无成员（该组不会自动排班，添加成员后自动补排未来 4 周）</p>'}
        </div>`;
      }).join('')}
      <div class="section">
        <h3>添加成员</h3>
        <div class="form-grid">
          <div><label>姓名（登录与显示用）</label><input id="mbName" maxlength="20" placeholder="新成员姓名"></div>
          <div><label>加入分组</label>
            <select id="mbGroup">${m.groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select>
          </div>
          <div><label>代号（规则/AI 用，空 = 自动分配 a/b/c…）</label><input id="mbCode" maxlength="10" placeholder="如 e、f、g"></div>
          <div><label>初始密码（空 = ${esc(m.defaultPassword)}）</label><input id="mbPass" placeholder="${esc(m.defaultPassword)}"></div>
          <div><label>&nbsp;</label><button id="btnMemberAdd" class="primary">➕ 添加成员</button></div>
        </div>
        <p class="inline-note" id="memberState"></p>
      </div>
    </div>`;

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
          <label>周六工时口径</label>
          <select id="cfgSatDouble">
            <option value="1" ${c.saturdayDouble ? 'selected' : ''}>双倍计入（统计与 AI 公平口径）</option>
            <option value="0" ${!c.saturdayDouble ? 'selected' : ''}>按普通工时计入</option>
          </select>
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
        <h3>🤖 DeepSeek 配置（夜检 + AI排班共用）</h3>
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

    ${memberCard}

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
      <p class="hint">每行：<code>日期 姓名1 姓名2 …</code>（逗号/空格分隔，一天可多人，自动落到各成员所在组；也可以直接写代号 a/b/c）；
        姓名填 <code>-</code> 表示清空该天（两组都清空）。导入后自动重发飞书。</p>
      <textarea id="impText" rows="6" placeholder="2026-09-21 张三,李四&#10;2026-09-22 王五 赵六"></textarea>
      <div class="rowbtns"><button id="btnImport" class="primary">导入</button></div>
      <div id="impResult" class="inline-note"></div>
    </div>

    <div class="card">
      <h3 style="color:var(--danger)">⚠️ 危险区</h3>
      <p class="hint">两种模式都需输入 <code>CLEAR</code> 确认：
        <br>· <b>清空并保持全空（推荐）</b>：排班归零、<b>统计归零</b>，并自动关闭两组的「自动轮换占位」——之后排班只来自「AI排班」生成或手动指派（想恢复轮换去「成员管理」重新开启）
        <br>· <b>清空并重排占位</b>：老行为，开轮换的组立即补排未来 4 周</p>
      <input id="clearConfirm" placeholder="CLEAR">
      <div class="rowbtns">
        <button id="btnClearEmpty" class="danger">清空并保持全空</button>
        <button id="btnClearRegen" class="ghost">清空并重排占位</button>
      </div>
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
      saturdayDouble: $('#cfgSatDouble').value === '1',
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

  // —— 成员管理 ——
  $('#btnMemberAdd').onclick = async () => {
    const name = $('#mbName').value.trim();
    if (!name) return toast('请输入姓名', 'warn');
    try {
      await api('/api/members/add', {
        method: 'POST',
        body: {
          name,
          groupId: $('#mbGroup').value,
          password: $('#mbPass').value || undefined,
          code: $('#mbCode').value.trim() || undefined,
        },
      });
      toast(`已添加成员「${name}」✅`, 'ok');
      loadSettings();
    } catch (e) { toast(e.message, 'error'); }
  };
  $$('.arot').forEach((sel) => {
    sel.onchange = async () => {
      try {
        await api('/api/groups', { method: 'POST', body: { groupId: sel.dataset.g, autoRotate: sel.value === '1' } });
        toast(sel.value === '1' ? '已开启该组自动轮换占位' : '已关闭该组自动轮换：排班只来自 AI 生成或手动指派', 'ok');
        loadSettings();
      } catch (e) { toast(e.message, 'error'); loadSettings(); }
    };
  });
  $$('.rn').forEach((b) => {
    b.onclick = () => {
      showModal(`改名 · ${esc(b.dataset.name)}`, `
        <label>姓名（登录与界面/飞书显示用）</label>
        <input id="rnName" maxlength="20" value="${esc(b.dataset.name)}">
        <label>代号（排班规则 md 与 AI 识别用，组内唯一；规则里写代号就改姓名无需改规则）</label>
        <input id="rnCode" maxlength="10" value="${esc(b.dataset.code)}" placeholder="如 a、b、c">
        <p class="hint">改名后：排班表、统计、飞书卡片自动显示新姓名，名下有排班的周自动重发飞书；现有登录状态不受影响，下次登录请使用新姓名。</p>
        <div class="rowbtns"><button id="rnSave" class="primary">保存</button><button id="rnCancel" class="ghost">取消</button></div>`);
      $('#rnCancel').onclick = closeModal;
      $('#rnSave').onclick = async () => {
        try {
          await api('/api/members/rename', {
            method: 'POST',
            body: { personId: b.dataset.id, name: $('#rnName').value.trim(), code: $('#rnCode').value.trim() },
          });
          toast(`已保存：${$('#rnName').value.trim()}（代号 ${$('#rnCode').value.trim() || '无'}）✅`, 'ok');
          closeModal();
          loadSettings();
        } catch (e) { toast(e.message, 'error'); }
      };
    };
  });
  $$('.rm').forEach((b) => {
    b.onclick = async () => {
      const name = b.dataset.name;
      if (await confirmModal(`确认移除成员 <b>${esc(name)}</b>？<br>移除后：账号删除、立即下线，名下<b>全部排班清空</b>（空缺待认领/重排）。此操作不可恢复。`)) {
        try {
          const r = await api('/api/members/remove', { method: 'POST', body: { personId: b.dataset.id } });
          toast(`已移除「${name}」，清空其排班 ${r.cleared} 天`, 'ok');
          loadSettings();
        } catch (e) { toast(e.message, 'error'); }
      }
    };
  });
  $$('.mv').forEach((b) => {
    b.onclick = async () => {
      const name = b.dataset.name;
      if (await confirmModal(`确认把 <b>${esc(name)}</b> 移到「${esc(b.dataset.g)}」？<br>原组名下排班会全部清空，之后按新组轮换。`)) {
        try {
          await api('/api/members/move', { method: 'POST', body: { personId: b.dataset.id, groupId: b.dataset.to } });
          toast(`已把「${name}」移到「${b.dataset.g}」`, 'ok');
          loadSettings();
        } catch (e) { toast(e.message, 'error'); }
      }
    };
  });

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

  const doClear = async (keepEmpty) => {
    if ($('#clearConfirm').value !== 'CLEAR') return toast('请先输入 CLEAR 确认', 'warn');
    try {
      await api('/api/clear', { method: 'POST', body: { confirm: 'CLEAR', keepEmpty } });
      toast(keepEmpty
        ? '已清空并保持全空：排班/统计归零，自动轮换占位已关闭 ✅'
        : '已清空并重排轮换占位', 'ok');
    } catch (e) { toast(e.message, 'error'); }
  };
  $('#btnClearEmpty').onclick = () => doClear(true);
  $('#btnClearRegen').onclick = () => doClear(false);
}

/* ================= 日志（管理员） ================= */
async function loadLogs() {
  const r = await api('/api/logs?limit=200');
  state.logs = r.logs;
  $('#view').innerHTML = `
    <div class="card">
      <h3>变更日志（最近 200 条）</h3>
      <div class="tscroll"><table>
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
      </table></div>
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
