'use strict';
// JSON 文件存储：单进程小规模使用，原子写入防止写坏
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nowDisplay } = require('./scheduler');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json');

const DEFAULT_PEOPLE = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const DEFAULT_USER_PASSWORD = '123456';   // 首次登录用，登录后请自行修改
const DEFAULT_ADMIN_PASSWORD = 'admin123'; // 管理员初始密码，登录后请修改

// 固定两个分组，各自独立排班
const DEFAULT_GROUPS = [
  { id: 'g1', name: '一组', autoRotate: true },
  { id: 'g2', name: '二组', autoRotate: true },
];

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function makePerson(name, password, groupId, code) {
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    id: 'p_' + crypto.randomBytes(6).toString('hex'),
    name,
    groupId: groupId || 'g1',
    code: code || '',   // 代号：排班规则 / AI 识别用（组内唯一），界面显示用姓名
    salt,
    passwordHash: hashPassword(password, salt),
  };
}

function defaultConfig() {
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    webhookUrl: '',        // 飞书自定义机器人 webhook 地址
    webhookSecret: '',     // 选填；机器人开启「签名校验」时必填
    publicUrl: '',         // 本网页访问地址，会附在飞书卡片里
    timezone: 'Asia/Shanghai',
    sendHour: 9,           // 每周一发送时刻（时/分）
    sendMinute: 0,
    shiftStart: '09:00',   // 班次起止（展示用）
    shiftEnd: '18:00',
    shiftHours: 8,         // 每班默认工时（统计用，个别班次可按天覆盖）
    saturdayDouble: true,  // 周六加班按双倍工时计入（统计与 AI 公平口径）
    resendDelayMs: 3000,   // 修改后排班自动重发飞书的防抖时间
    // —— 工作区域 IP 验证（纯增量，不影响排班数据）——
    ipRanges: '',           // 工作区域 IP 段：CIDR 或单 IP，逗号分隔（如 192.168.1.0/24,10.8.0.5）；空=未配置
    ipCheckKey: '',         // 外部调用口令：自动化工具/MCP 带 X-Check-Key 头免登录调 /api/where-am-i；空=仅登录可用
    trustForwarded: false,  // 服务器在反向代理后开启，从 X-Forwarded-For 取真实 IP
    // —— DeepSeek AI 夜间检查 ——
    aiApiKey: '',            // 只存本地 data/db.json（0600 权限），接口仅回显掩码
    aiBaseUrl: 'https://api.deepseek.com',
    aiModel: 'deepseek-chat', // 模型名可在设置里改
    aiCheckHour: 21,          // 每晚检查时刻
    aiCheckMinute: 0,
    aiCheckDays: 14,          // 检查未来多少天
    aiApplyMode: 'notify',    // notify=通知管理员确认；auto=自动应用并重发
    adminSalt: salt,
    adminPasswordHash: hashPassword(DEFAULT_ADMIN_PASSWORD, salt),
  };
}

function newDb() {
  return {
    people: DEFAULT_PEOPLE.map((n) => makePerson(n, DEFAULT_USER_PASSWORD, 'g1')),
    groups: DEFAULT_GROUPS.map((g) => ({ ...g })),
    schedule: {},        // { 'YYYY-MM-DD': { [groupId]: { personId, hours?, note? } } }
    weeksGenerated: { g1: [], g2: [] },  // 各组已自动生成过的周（周一日期）；生成过的周里弃班留空、不会被回填
    config: defaultConfig(),
    logs: [],            // 变更记录（新的在前）
    lastSend: null,       // 最近一次飞书发送结果
    lastAutoSend: '',    // 最近一次定时发送的日期（用于周一宕机补发判断）
    aiSuggestions: [],   // AI 排班建议（新的在前，最多 50 条）
    lastAiCheck: '',     // 最近一次 AI 夜检日期（宕机补检用）
  };
}

// 旧版本数据补齐缺失字段 + 分组结构迁移，避免升级后 undefined
function normalizeDb(db) {
  const fresh = newDb();
  for (const k of Object.keys(fresh)) if (db[k] === undefined) db[k] = fresh[k];
  const dc = defaultConfig();
  for (const k of Object.keys(dc)) if (db.config[k] === undefined) db.config[k] = dc[k];
  if (!Array.isArray(db.logs)) db.logs = [];

  // —— 分组迁移（v1 单组 → v2 双组）——
  if (!Array.isArray(db.groups) || !db.groups.length) db.groups = fresh.groups.map((g) => ({ ...g }));
  for (const id of ['g1', 'g2']) {
    if (!db.groups.find((g) => g.id === id)) db.groups.push({ id, name: id === 'g1' ? '一组' : '二组', autoRotate: true });
  }
  for (const g of db.groups) if (g.autoRotate === undefined) g.autoRotate = true; // 自动轮换占位开关（关闭后只认 AI/手动排班）
  for (const p of db.people) {
    if (!p.groupId || !db.groups.find((g) => g.id === p.groupId)) p.groupId = 'g1';
    if (p.code === undefined) p.code = p.name; // 旧数据：代号默认等于当时的名字（如 a）
  }
  // 旧版 weeksGenerated 是数组 → 按组对象（旧排班全部归入一组）
  if (Array.isArray(db.weeksGenerated)) {
    db.weeksGenerated = { g1: db.weeksGenerated.slice(), g2: [] };
  }
  if (!db.weeksGenerated || typeof db.weeksGenerated !== 'object') db.weeksGenerated = { g1: [], g2: [] };
  for (const g of db.groups) if (!Array.isArray(db.weeksGenerated[g.id])) db.weeksGenerated[g.id] = [];
  // 旧版排班结构迁移：
  //   v1 扁平 {personId,...}          → { g1: [{...}] }
  //   v2 单人 { g1: {personId,...} }  → { g1: [{...}] }（v3：每天每组可排多人）
  if (!db.schedule || typeof db.schedule !== 'object') db.schedule = {};
  for (const [date, day] of Object.entries(db.schedule)) {
    if (!day || typeof day !== 'object') continue;
    if (day.personId && !Array.isArray(day)) {
      db.schedule[date] = { g1: [day] };
      continue;
    }
    for (const gid of Object.keys(day)) {
      const e = day[gid];
      if (e && typeof e === 'object' && !Array.isArray(e) && e.personId) day[gid] = [e];
      else if (!Array.isArray(e)) delete day[gid];
    }
  }
  // 旧版 AI 建议没有分组信息，全部归入一组
  if (Array.isArray(db.aiSuggestions)) {
    for (const s of db.aiSuggestions) if (!s.groupId) s.groupId = 'g1';
  }
  return db;
}

class Store {
  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.data = this.loadFile(DB_PATH, newDb());
    normalizeDb(this.data);
    this.sessions = this.loadFile(SESSIONS_PATH, {});
  }

  loadFile(p, fallback) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return fallback;
    }
  }

  save() {
    this.writeAtomic(DB_PATH, this.data);
  }

  saveSessions() {
    this.writeAtomic(SESSIONS_PATH, this.sessions);
  }

  writeAtomic(p, obj) {
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    try { fs.chmodSync(tmp, 0o600); } catch { /* 非 POSIX 环境忽略 */ }
    fs.renameSync(tmp, p);
  }

  personByName(name) {
    const n = String(name || '').trim().toLowerCase();
    return this.data.people.find((p) => p.name.toLowerCase() === n);
  }

  personById(id) {
    return this.data.people.find((p) => p.id === id);
  }

  addLog(actor, role, action, detail) {
    this.data.logs.unshift({
      time: nowDisplay(this.data.config.timezone),
      actor, role, action, detail: String(detail || ''),
    });
    if (this.data.logs.length > 500) this.data.logs.length = 500;
  }
}

module.exports = {
  Store, hashPassword, makePerson,
  DEFAULT_USER_PASSWORD, DEFAULT_ADMIN_PASSWORD, DEFAULT_GROUPS, DATA_DIR,
};
