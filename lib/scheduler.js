'use strict';
// 日期全部用 'YYYY-MM-DD' 字符串运算，以 UTC 正午为锚点，避免时区/夏令时坑

function parseDate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

function fmtDate(dt) {
  return dt.toISOString().slice(0, 10);
}

function addDays(s, n) {
  const d = parseDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fmtDate(d);
}

function dowIndex(s) {
  return (parseDate(s).getUTCDay() + 6) % 7; // 0=周一 ... 6=周日
}

function weekStartOf(s) {
  return addDays(s, -dowIndex(s));
}

function isDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
  const d = parseDate(s);
  return !isNaN(d.getTime()) && fmtDate(d) === String(s);
}

const WEEKDAY_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function isoWeek(s) {
  const d = parseDate(s);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day); // 本周四
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1, 12));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return { week, year: d.getUTCFullYear() };
}

// 指定时区的当前时间（用于"今天"判断与发送时刻判断）
const DOW_EN = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
function nowParts(tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(new Date());
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  return {
    date: `${o.year}-${o.month}-${o.day}`,
    hour: Number(o.hour) % 24,
    minute: Number(o.minute),
    dow: DOW_EN[o.weekday],
  };
}

function todayStr(tz) {
  return nowParts(tz).date;
}

function nowDisplay(tz) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: tz || 'Asia/Shanghai', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date()).replace(/\//g, '-');
}

// —— 轮换规则占位实现：一天一人，按 A→B→C→… 循环 ——
// TODO: 等拿到具体加班逻辑后，只需要改这个函数
function nextAssignee(db, beforeDate) {
  const people = db.people;
  if (!people.length) return null;
  let lastDate = null;
  for (const d of Object.keys(db.schedule)) {
    const e = db.schedule[d];
    if (e && e.personId && d < beforeDate && (lastDate === null || d > lastDate)) lastDate = d;
  }
  if (lastDate === null) return people[0];
  const idx = people.findIndex((p) => p.id === db.schedule[lastDate].personId);
  return people[(idx + 1) % people.length];
}

// 生成一周排班：只填空缺的日期；这周已生成过则不动（保留人工弃班留空）
function ensureWeekGenerated(db, weekStart) {
  if (!isDateStr(weekStart) || weekStartOf(weekStart) !== weekStart) return false;
  if (db.weeksGenerated.includes(weekStart)) return false;
  let changed = false;
  for (let i = 0; i < 7; i++) {
    const day = addDays(weekStart, i);
    const e = db.schedule[day];
    if (!e || !e.personId) {
      const person = nextAssignee(db, day);
      if (person) {
        db.schedule[day] = { personId: person.id };
        changed = true;
      }
    }
  }
  db.weeksGenerated.push(weekStart);
  return changed;
}

function entryHours(db, entry) {
  const h = Number(entry && entry.hours);
  return Number.isFinite(h) && h > 0 ? h : Number(db.config.shiftHours) || 8;
}

// —— 工时统计（管理员页使用）——
function computeStats(db) {
  const today = todayStr(db.config.timezone);
  const per = {}; // personId -> { shifts, hours }
  for (const p of db.people) {
    per[p.id] = { shifts: 0, hours: 0, pastShifts: 0, pastHours: 0, monthShifts: 0, monthHours: 0 };
  }
  const weeksAll = new Set();
  const weeksPast = new Set();
  let firstDate = null;
  for (const [date, e] of Object.entries(db.schedule)) {
    if (!e || !e.personId || !per[e.personId]) continue;
    const h = entryHours(db, e);
    per[e.personId].shifts += 1;
    per[e.personId].hours += h;
    weeksAll.add(weekStartOf(date));
    if (date <= today) {
      per[e.personId].pastShifts += 1;
      per[e.personId].pastHours += h;
      weeksPast.add(weekStartOf(date));
    }
    if (date.slice(0, 7) === today.slice(0, 7)) {
      per[e.personId].monthShifts += 1;
      per[e.personId].monthHours += h;
    }
    if (firstDate === null || date < firstDate) firstDate = date;
  }
  const weeksA = weeksAll.size;
  const weeksP = weeksPast.size;
  const people = db.people.map((p) => {
    const r = per[p.id];
    return {
      name: p.name,
      shifts: r.shifts, hours: r.hours,
      avgWeek: weeksA ? +(r.hours / weeksA).toFixed(1) : 0,
      pastShifts: r.pastShifts, pastHours: r.pastHours,
      pastAvgWeek: weeksP ? +(r.pastHours / weeksP).toFixed(1) : 0,
      monthShifts: r.monthShifts, monthHours: r.monthHours,
    };
  });
  return {
    since: firstDate,
    today,
    weeksAll: weeksA,
    weeksPast: weeksP,
    shiftHours: Number(db.config.shiftHours) || 8,
    people,
  };
}

module.exports = {
  parseDate, fmtDate, addDays, dowIndex, weekStartOf, isDateStr,
  WEEKDAY_CN, isoWeek, nowParts, todayStr, nowDisplay,
  nextAssignee, ensureWeekGenerated, entryHours, computeStats,
};
