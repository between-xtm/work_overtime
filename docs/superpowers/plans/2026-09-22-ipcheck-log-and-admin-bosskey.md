# 验证留档 + 管理员老板键 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 工作区域验证落库留档（管理员筛选+CSV导出、成员自查），登录页隐藏管理员入口（连按 6 下 `·` 显示）。

**Architecture:** 全部改动收在现有文件内（`lib/store.js`、`server.js`、`public/app.js`、`使用说明.md`），不新建文件。流水存 `db.json` 的 `ipCheckLog` 数组（`data/` 已 gitignore），复用现有鉴权/写库/前端渲染模式。

**Tech Stack:** Node.js + Express（零新依赖），前端原生 JS 单文件。

## Global Constraints

- 零新 npm 依赖（package.json 不动）
- 本项目无测试框架：每个任务以 `node --check` 语法校验 + 提交收尾，Task 8 用本地冒烟测试覆盖 spec 全部验收项
- 中文文案、注释风格与现有代码一致（`'use strict'`、中文注释）
- 时间显示口径沿用 `Intl.DateTimeFormat('zh-CN', { timeZone: cfg.timezone })`
- 每个任务独立提交，提交信息中文、说"为什么"
- 部署走 git：push → 服务器 `git pull` → `systemctl restart work-overtime`

---

### Task 1: store.js 增加 ipCheckLog 集合与追加方法

**Files:**
- Modify: `lib/store.js`（newDb 约 L66-78、normalizeDb 约 L94、Store 类 addLog 后约 L152）

**Interfaces:**
- Produces: `store.appendIpCheck(entry)` —— entry `{ts:number, name:string, ip:string, inWorkArea:boolean, matched:string, source:'web'|'api'}`，无返回值；`db.ipCheckLog: Array`（新的在后，>10000 条裁到 9000）

- [ ] **Step 1: newDb() 增加集合**

在 `newDb()` 返回对象中 `lastAiCheck: '',` 之后加一行：

```js
    ipCheckLog: [],      // 工作区域验证流水（新的在后；>10000 条自动裁旧）
```

- [ ] **Step 2: normalizeDb 增加类型防护**

在 `if (!Array.isArray(db.logs)) db.logs = [];` 之后加：

```js
  if (!Array.isArray(db.ipCheckLog)) db.ipCheckLog = []; // 验证流水（旧库自动补齐）
```

- [ ] **Step 3: Store 类增加追加方法**

在 `addLog(...)` 方法之后、类结束花括号前加：

```js
  // 验证留档：只追加；超上限一次裁到 9000，避免每次保存都裁剪
  appendIpCheck(entry) {
    this.data.ipCheckLog.push(entry);
    if (this.data.ipCheckLog.length > 10000) {
      this.data.ipCheckLog = this.data.ipCheckLog.slice(-9000);
    }
  }
```

- [ ] **Step 4: 语法校验**

Run: `node --check lib/store.js`
Expected: 无输出（通过）

- [ ] **Step 5: Commit**

```bash
git add lib/store.js
git commit -m "验证留档：db 增加 ipCheckLog 流水集合（封顶 1 万条自动裁旧）"
```

---

### Task 2: where-am-i 落库

**Files:**
- Modify: `server.js` L676-699（`app.get('/api/where-am-i', ...)`）

**Interfaces:**
- Consumes: `store.appendIpCheck(entry)`（Task 1）
- Produces: 配置了 IP 段时响应体新增 `recorded: true`；未配置分支行为不变

- [ ] **Step 1: 修改处理逻辑**

把 where-am-i 处理器末段（从 `const matched = ...` 起）替换为：

```js
  const matched = ipcheck.ipInRanges(ip, ranges);
  // 已配置 IP 段才留档（未配置时验证无意义，不写库）
  store.appendIpCheck({
    ts: Date.now(),
    name: req.auth ? String(req.auth.name || '') : '',  // 自动化调用无登录身份
    ip,
    inWorkArea: !!matched,
    matched: matched || '',
    source: req.auth ? 'web' : 'api',
  });
  store.save();
  res.json({
    ok: true,
    ip,
    configured: true,
    recorded: true,
    inWorkArea: !!matched,
    matched: matched || '',
    ranges: list,
    time: sch.nowDisplay(cfg.timezone),
  });
```

- [ ] **Step 2: 语法校验**

Run: `node --check server.js`
Expected: 无输出（通过）

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "验证留档：where-am-i 配置 IP 段后自动落库（web/api 来源可辨）"
```

---

### Task 3: 查询 / 自查 / 导出三个接口

**Files:**
- Modify: `server.js`（where-am-i 路由之后、`app.post('/api/send-now'` 之前插入整块）

**Interfaces:**
- Consumes: `auth.requireAdmin` / `auth.requireAuth`（现有）
- Produces:
  - `GET /api/ipcheck-log?month=&name=&limit=`（管理员）→ `{records:[{time,name,ip,inWorkArea,matched,source}], months:[...]}`，records 新的在前、默认 500 条上限 2000；`month=all` 或空 = 全部；months 为全部流水去重的 `YYYY-MM` 列表（新的在前）
  - `GET /api/ipcheck-log/mine`（任一登录）→ `{records:[...]}` 本人最近 20 条（新的在前）
  - `GET /api/ipcheck-log/export?month=`（管理员）→ `text/csv`（UTF-8 BOM，时间升序，`Content-Disposition` 带中文文件名）
  - 内部工具：`fmtLogTs(ts,tz)`、`monthOfTs(ts,tz)`、`csvCell(v)`、`filteredIpLog(db,{month,name,limit,desc})`

- [ ] **Step 1: 插入工具函数与三个路由**

在 where-am-i 的 `});` 之后插入：

```js
// —— 验证留档：管理员筛选查询 / 成员自查 / CSV 导出 ——
function fmtLogTs(ts, tz) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: tz || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(ts)).replace(/\//g, '-');
}

function monthOfTs(ts, tz) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: tz || 'Asia/Shanghai', year: 'numeric', month: '2-digit',
  }).format(new Date(ts)).replace('/', '-');
}

function csvCell(v) {
  const s = String(v === undefined || v === null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function filteredIpLog(db, { month, name, limit, desc }) {
  const tz = db.config.timezone;
  let rows = db.ipCheckLog.slice();
  if (month) rows = rows.filter((r) => monthOfTs(r.ts, tz) === month);
  if (name) {
    const q = String(name).trim().toLowerCase();
    rows = rows.filter((r) => String(r.name || '').toLowerCase().includes(q));
  }
  if (desc) rows.reverse(); // 新的在前（查询场景）；导出保持时间升序
  return rows.slice(0, limit);
}

function ipLogMonths(db) {
  const tz = db.config.timezone;
  const seen = new Map(); // YYYY-MM → 排序键，新的在前
  for (const r of db.ipCheckLog) {
    const m = monthOfTs(r.ts, tz);
    if (!seen.has(m)) seen.set(m, r.ts);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
}

app.get('/api/ipcheck-log', auth.requireAdmin, (req, res) => {
  const db = store.data;
  const tz = db.config.timezone;
  const month = String(req.query.month || '').trim();
  const name = String(req.query.name || '').trim();
  const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 500));
  const rows = filteredIpLog(db, { month: month === 'all' ? '' : month, name, limit, desc: true });
  res.json({
    records: rows.map((r) => ({ time: fmtLogTs(r.ts, tz), name: r.name, ip: r.ip, inWorkArea: r.inWorkArea, matched: r.matched, source: r.source })),
    months: ipLogMonths(db),
  });
});

app.get('/api/ipcheck-log/mine', auth.requireAuth, (req, res) => {
  const tz = store.data.config.timezone;
  const rows = store.data.ipCheckLog
    .filter((r) => req.auth && r.name === req.auth.name)
    .slice(-20).reverse();
  res.json({ records: rows.map((r) => ({ time: fmtLogTs(r.ts, tz), name: r.name, ip: r.ip, inWorkArea: r.inWorkArea, matched: r.matched, source: r.source })) });
});

app.get('/api/ipcheck-log/export', auth.requireAdmin, (req, res) => {
  const db = store.data;
  const tz = db.config.timezone;
  const month = String(req.query.month || '').trim();
  const rows = filteredIpLog(db, { month: month === 'all' ? '' : month, name: '', limit: 100000, desc: false });
  const head = '时间,姓名,IP,工作区域内,命中IP段,来源';
  const body = rows.map((r) => [
    fmtLogTs(r.ts, tz), r.name || '（自动化）', r.ip,
    r.inWorkArea ? '是' : '否', r.matched || '', r.source === 'api' ? '自动化' : '网页',
  ].map(csvCell).join(',')).join('\r\n');
  const fname = (month && month !== 'all') ? `加班验证记录-${month}.csv` : '加班验证记录-全部.csv';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ipcheck-log.csv"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.send('\uFEFF' + head + '\r\n' + body);
});
```

- [ ] **Step 2: 语法校验**

Run: `node --check server.js`
Expected: 无输出（通过）

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "验证留档：管理员筛选查询 + 成员自查 + CSV 导出（UTF-8 BOM 中文文件名）"
```

---

### Task 4: 成员端——已留档提示 + 自己的留档列表

**Files:**
- Modify: `public/app.js` 排班页 ipcheck-bar 模板（约 L282-285）与 btnIpCheck 处理器（约 L296-317）

**Interfaces:**
- Consumes: `GET /api/ipcheck-log/mine` → `{records:[{time,ip,inWorkArea,...}]}`
- Produces: DOM 元素 `#myIpLogWrap`（details）、`#myIpLog`（容器）

- [ ] **Step 1: 模板加留档折叠区**

把 `</div>` 结束的 `.ipcheck-bar` 那块改为（在 ipcheck-bar 的 `</div>` 之后追加一行 details）：

```js
    <div class="ipcheck-bar">
      <button id="btnIpCheck" class="ghost btn-sm">📍 验证我是否在工作区域</button>
      ${d.config.jukuUrl ? '<button id="btnJuku" class="ghost btn-sm">🎬 加班看剧</button>' : ''}
      <span id="ipCheckResult" class="inline-note"></span>
    </div>
    <details id="myIpLogWrap" style="margin:10px 0 0 2px">
      <summary class="hint" style="cursor:pointer;user-select:none">📋 我的验证留档（最近 20 条）</summary>
      <div id="myIpLog" class="hint" style="margin-top:6px"></div>
    </details>
```

- [ ] **Step 2: 处理器前加 fillMyIpLog，成功分支提示已留档**

在 `$('#btnIpCheck').onclick = ...` 之前插入：

```js
  const myLogWrap = $('#myIpLogWrap');
  const fillMyIpLog = async () => {
    const box = $('#myIpLog');
    if (!box) return;
    try {
      const r = await api('/api/ipcheck-log/mine');
      box.innerHTML = r.records.length
        ? `<div class="tscroll"><table><tbody>${r.records.map((x) => `<tr><td>${esc(x.time)}</td><td>${esc(x.ip)}</td><td>${x.inWorkArea ? '<span class="ok">区域内</span>' : '<span class="bad">区域外</span>'}</td></tr>`).join('')}</tbody></table></div>`
        : '暂无记录。点上面按钮验证一次就会自动留档。';
    } catch (e) { box.textContent = e.message; }
  };
  if (myLogWrap) myLogWrap.ontoggle = () => { if (myLogWrap.open) fillMyIpLog(); };
```

btnIpClick 成功分支文案替换（保持其余逻辑不动，两处 innerHTML 各改一处，并在 finally 前补一行刷新）：

```js
      } else if (r.inWorkArea) {
        out.innerHTML = `✅ 已留档：你在工作区域（IP：${esc(r.ip)}${r.matched ? ` · 命中 ${esc(r.matched)}` : ''}）`;
        out.className = 'inline-note ok';
      } else {
        out.innerHTML = `⚠️ 已留档：你不在工作区域（IP：${esc(r.ip)}，未命中 ${esc((r.ranges || []).join('、')) || '任何 IP 段'}）`;
        out.className = 'inline-note bad';
      }
```

并在 `} catch (e) {` 之前（即 else 分束后）加：

```js
      if (myLogWrap && myLogWrap.open) fillMyIpLog();
```

- [ ] **Step 3: 语法校验**

Run: `node --check public/app.js`
Expected: 无输出（通过）

- [ ] **Step 4: Commit**

```bash
git add public/app.js
git commit -m "验证留档：成员验证后提示已留档，可展开查看自己的最近记录"
```

---

### Task 5: 管理员统计页「验证留档」卡片

**Files:**
- Modify: `public/app.js` state 定义（约 L36-43）、renderStats（约 L552-607）

**Interfaces:**
- Consumes: `GET /api/ipcheck-log`（records+months）、`GET /api/ipcheck-log/export`（blob）
- Produces: 无（纯 UI）；state 新键 `ipLogMonth: 'all'`、`ipLogName: ''`

- [ ] **Step 1: state 增加两个键**

在 `statsMode: 'all',` 之后加：

```js
  ipLogMonth: 'all',
  ipLogName: '',
```

- [ ] **Step 2: renderStats 模板插入卡片**

把 `$('#view').innerHTML = ...` 模板中 `${groupCards}` 之前插入 `${ipLogCardHtml()}`，即模板变为：

```js
  $('#view').innerHTML = `
    <div class="card">
      <h3>人均工时统计</h3>
      <p class="hint">统计起始：…（原样保留）</p>
      <div class="seg">…（原样保留）</div>
    </div>
    ${ipLogCardHtml()}
    ${groupCards}`;
```

- [ ] **Step 3: 新增三个函数（放在 renderStats 之后、fairnessNote 之前）**

```js
function ipLogCardHtml() {
  return `
    <div class="card" id="ipLogCard">
      <h3>📍 验证留档</h3>
      <p class="hint">成员点「验证我是否在工作区域」自动落库（仅在配置了 IP 段后记录）；「导出 CSV」按所选月份下载，Excel 可直接打开，留存备查。</p>
      <div class="row">
        <select id="ipLogMonth"><option value="all">全部月份</option></select>
        <input id="ipLogName" placeholder="按姓名筛选（可留空）" style="max-width:180px" value="${esc(state.ipLogName || '')}">
        <button id="btnIpLogExport" class="ghost btn-sm">⬇ 导出 CSV</button>
      </div>
      <div class="tscroll"><table>
        <thead><tr><th>时间</th><th>姓名</th><th>IP</th><th>工作区域内</th><th>命中IP段</th><th>来源</th></tr></thead>
        <tbody id="ipLogTable"><tr><td colspan="6" class="hint">加载中…</td></tr></tbody>
      </table></div>
    </div>`;
}

async function renderIpLogCard() {
  const table = $('#ipLogTable');
  if (!table) return;
  try {
    const q = new URLSearchParams({ month: state.ipLogMonth || 'all' });
    if (state.ipLogName) q.set('name', state.ipLogName);
    const r = await api('/api/ipcheck-log?' + q.toString());
    const sel = $('#ipLogMonth');
    if (sel) {
      sel.innerHTML = ['all', ...(r.months || [])].map((m) => `<option value="${esc(m)}" ${m === (state.ipLogMonth || 'all') ? 'selected' : ''}>${m === 'all' ? '全部月份' : m}</option>`).join('');
      sel.onchange = () => { state.ipLogMonth = sel.value; renderIpLogCard(); };
    }
    table.innerHTML = r.records.length ? r.records.map((x) => `
      <tr>
        <td>${esc(x.time)}</td><td><b>${esc(x.name || '（自动化）')}</b></td><td>${esc(x.ip)}</td>
        <td>${x.inWorkArea ? '<span class="ok">是</span>' : '<span class="bad">否</span>'}</td>
        <td>${esc(x.matched || '—')}</td><td>${x.source === 'api' ? '自动化' : '网页'}</td>
      </tr>`).join('') : '<tr><td colspan="6" class="hint">暂无验证记录（配置工作区域 IP 段后，成员验证会自动留档）</td></tr>';
  } catch (e) {
    table.innerHTML = `<tr><td colspan="6" class="hint">${esc(e.message)}</td></tr>`;
  }
}

async function exportIpLogCsv() {
  try {
    const q = new URLSearchParams({ month: state.ipLogMonth || 'all' });
    const res = await fetch('/api/ipcheck-log/export?' + q.toString(), {
      headers: { Authorization: 'Bearer ' + state.token },
    });
    if (!res.ok) return toast('导出失败 ' + res.status, 'error');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const m = (res.headers.get('Content-Disposition') || '').match(/filename\*=UTF-8''([^;]+)/);
    a.download = m ? decodeURIComponent(m[1]) : '加班验证记录.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    toast(e.message, 'error');
  }
}
```

- [ ] **Step 4: renderStats 末尾接线**

在 `$$('.seg button').forEach(...)` 之后追加：

```js
  const ipName = $('#ipLogName');
  if (ipName) ipName.onchange = () => { state.ipLogName = ipName.value.trim(); renderIpLogCard(); };
  const ipExport = $('#btnIpLogExport');
  if (ipExport) ipExport.onclick = exportIpLogCsv;
  renderIpLogCard();
```

- [ ] **Step 5: 语法校验**

Run: `node --check public/app.js`
Expected: 无输出（通过）

- [ ] **Step 6: Commit**

```bash
git add public/app.js
git commit -m "验证留档：统计页新增卡片（月份/姓名筛选 + 导出 CSV）"
```

---

### Task 6: 登录页隐藏管理员入口 + 老板键

**Files:**
- Modify: `public/app.js` renderLogin（约 L110-132）、doLogin（约 L134-149）

**Interfaces:**
- Produces: 登录页默认无「管理员」选项；连按 6 下 `·`（U+00B7）或 `` ` ``（U+0060）后追加该选项并选中；其他键清零计数

- [ ] **Step 1: 删除下拉框里的管理员选项**

renderLogin 模板中删除这行：

```js
            <option value="admin">管理员</option>
```

- [ ] **Step 2: 老板键实现（模块级变量 + armBossKey）**

在 `/* —— 登录页 —— */` 注释之后加：

```js
let bossKeyCount = 0;      // 连点计数：· 或 `，其他键清零
let bossKeyHandler = null; // 全局监听引用（防重复挂载/退出登录后残留）

function armBossKey() {
  if (bossKeyHandler) document.removeEventListener('keydown', bossKeyHandler);
  bossKeyCount = 0;
  bossKeyHandler = (e) => {
    if (e.key !== '·' && e.key !== '`') { bossKeyCount = 0; return; }
    bossKeyCount += 1;
    if (bossKeyCount < 6) return;
    bossKeyCount = 0;
    const sel = $('#loginName');
    if (sel && !sel.querySelector('option[value="admin"]')) {
      sel.insertAdjacentHTML('beforeend', '<option value="admin">管理员</option>');
      sel.value = 'admin';
      $('#loginPass').focus();
    }
  };
  document.addEventListener('keydown', bossKeyHandler);
}
```

renderLogin 末尾（`$('#loginPass').onkeydown = ...` 之后）加一行：

```js
  armBossKey();
```

- [ ] **Step 3: 登录成功后摘除监听**

doLogin 中 `renderShell();` 之前加：

```js
  if (bossKeyHandler) { document.removeEventListener('keydown', bossKeyHandler); bossKeyHandler = null; }
```

- [ ] **Step 4: 语法校验**

Run: `node --check public/app.js`
Expected: 无输出（通过）

- [ ] **Step 5: Commit**

```bash
git add public/app.js
git commit -m "管理员入口老板键：登录页默认隐藏，连按 6 下 · 才显示（挡视线不挡密码）"
```

---

### Task 7: 使用说明.md 更新

**Files:**
- Modify: `使用说明.md`（启动/停止、登录账号、工作区域 IP 验证、剧库部署四处）

- [ ] **Step 1: 启动/停止章节替换为 systemd**

把「## 启动 / 停止」整段代码块替换为：

```bash
systemctl status work-overtime juku   # 查看状态
systemctl restart work-overtime      # 重启排班站（改代码 git pull 后执行）
systemctl stop work-overtime         # 停止
journalctl -u work-overtime -n 50     # 看日志
```

并注明：两服务已由 systemd 托管（开机自启、崩溃 3 秒自动拉起、内存限额 排班站 200M / 剧库 400M，超限只重启自己不拖累整机）。

- [ ] **Step 2: 登录账号章节加老板键备忘**

在管理员账号条目后加一行：

> 管理员登录入口默认隐藏：在登录页**连按 6 下 `·`**（中文输入法；英文输入法下按同一物理键出 `` ` `` 也算）后，下拉框出现「管理员」选项。按其他键计数清零，页面无任何提示。

- [ ] **Step 3: 工作区域 IP 验证章节更新留档说明**

把「该功能只做查询，不写任何排班数据」一句替换为：

> 配置了 IP 段后，每次验证自动落一条流水（时间/姓名/IP/是否区域内/来源）。管理员在「统计」页可按月份、姓名筛选查看并**导出 CSV**（Excel 直接打开）留档；成员在排班页可展开「我的验证留档」查看自己的最近 20 条。自动化（X-Check-Key）调用也记录，来源标"自动化"。

- [ ] **Step 4: 剧库部署章节补 systemd 与直连现状**

「服务器部署剧库」末尾追加一行：

> 剧库已迁移 systemd 托管（服务名 `juku`，含内存限额与自动重启），并已开启直连模式（`directSources: hongguo`）——兼容内容由成员浏览器直连红果 CDN，服务器不再中转视频。

- [ ] **Step 5: Commit**

```bash
git add 使用说明.md
git commit -m "文档：systemd 托管、验证留档、老板键说明"
```

---

### Task 8: 本地冒烟测试 + 部署上线

**Files:**
- 无代码改动；本地临时目录 `.tmp-smoke/`（测完删除）

**Interfaces:**
- Consumes: 全部前序任务
- Produces: spec 验收清单全绿 + 线上部署完成

- [ ] **Step 1: 起本地冒烟实例**

PowerShell：

```powershell
$env:DATA_DIR="E:\work_overtime\.tmp-smoke"; $env:PORT="8790"; node server.js
```

（后台运行；全新空库：管理员 admin/admin123，成员 A/123456）

- [ ] **Step 2: 按验收清单跑 API**

用 PowerShell `Invoke-RestMethod` 依次验证（每步核对期望）：

1. admin 登录拿 token → `POST /api/login {name:'admin',password:'admin123'}`
2. 配置 IP 段与口令 → `POST /api/config`（Bearer admin token，body `{ipRanges:'127.0.0.1', ipCheckKey:'smoke-key'}`）→ 期望 `{ok:true}`
3. 未登录无凭据调 `GET /api/where-am-i` → 期望 **401**（原有限流不破坏）
4. 成员 A 登录拿 token → 调 `where-am-i` → 期望 `recorded:true`、`inWorkArea:true`（本机 127.0.0.1 命中）
5. 自动化口子 → 带 `-Headers @{'X-Check-Key'='smoke-key'}` 调 `where-am-i` → 期望成功
6. admin 调 `GET /api/ipcheck-log` → 期望 2 条记录（1 条网页 + 1 条自动化 name 为空）、`months` 含当月
7. 成员 A 调 `GET /api/ipcheck-log/mine` → 期望只有自己的 1 条
8. 成员 A 调 `GET /api/ipcheck-log` → 期望 **403**
9. admin 调 `GET /api/ipcheck-log/export?month=all` → 期望响应头 `text/csv`、正文以 `\uFEFF时间,姓名,IP` 开头、含"自动化"
10. 杀冒烟进程、删除 `.tmp-smoke/`，重新核对本机 8787 生产服务未受影响（本机无生产服务则跳过）

- [ ] **Step 3: push 部署**

```powershell
git push origin master
ssh ot-server "cd /root/work_overtime && git pull && systemctl restart work-overtime && sleep 3 && curl -s -o /dev/null -w %{http_code} http://127.0.0.1:8787/"
```

期望：pull 干净、restart 成功、curl 返回 `200`。

- [ ] **Step 4: 线上抽查**

```powershell
ssh ot-server "curl -s http://127.0.0.1:8787/api/ipcheck-log -o /dev/null -w %{http_code}"
```

期望 `401`（接口存在且鉴权生效，不是 404）。

- [ ] **Step 5: 浏览器人肉项（转告用户）**

- 登录页下拉默认无「管理员」；连按 6 下 `·` 出现并选中
- 成员点验证按钮提示「已留档」、展开能看到自己的记录
- 管理员统计页出现「📍 验证留档」卡片、导出 CSV 打开正常

- [ ] **Step 6: Commit（若有冒烟过程中的微调）**

```bash
git add -A && git commit -m "冒烟测试修正（如有）"
```

---

## Self-Review 结论

- **Spec 覆盖**：A1 记录字段/时机→Task 2；A2 存储/裁剪→Task 1；A3 四接口→Task 2/3；A4 两端 UI→Task 4/5；B 老板键→Task 6；文档→Task 7；验收清单→Task 8。无缺口。
- **占位符**：无 TBD/TODO；所有代码步骤给出完整代码。
- **类型一致**：`appendIpCheck(entry)` 字段与 Task 2 写入一致；`months` 仅由 Task 3 产出、Task 5 消费；`recorded` 仅前端忽略（提示文案不依赖它，直接按 configured 分支）。CSV/查询的时间列都经 `fmtLogTs`，口径统一。
