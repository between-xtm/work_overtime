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

// —— 分组：每天每组一个班次名单（可 0~N 人）db.schedule[date][groupId] = [{personId, hours?, note?}] ——
function groupById(db, groupId) {
  return (db.groups || []).find((g) => g.id === groupId) || null;
}

function peopleOf(db, groupId) {
  return db.people.filter((p) => p.groupId === groupId);
}

// 该组当天的排班数组（空数组 = 空缺）
function slotOf(db, date, groupId) {
  const day = db.schedule[date];
  const arr = day && day[groupId];
  return Array.isArray(arr) ? arr : [];
}

// 整组整天的名单整体替换（空数组 = 清空该组该天）
function setSlot(db, date, groupId, entries) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && e.personId);
  if (list.length) {
    const day = db.schedule[date] || (db.schedule[date] = {});
    day[groupId] = list;
  } else {
    const day = db.schedule[date];
    if (day) {
      delete day[groupId];
      if (!Object.keys(day).length) delete db.schedule[date];
    }
  }
}

function genWeeks(db, groupId) {
  if (!db.weeksGenerated[groupId]) db.weeksGenerated[groupId] = [];
  return db.weeksGenerated[groupId];
}

// 清掉某人名下的全部班次（移除成员/调整分组时用），返回被清空的日期
function clearPersonSlots(db, personId) {
  const cleared = [];
  for (const [date, day] of Object.entries(db.schedule)) {
    if (!day) continue;
    for (const g of db.groups) {
      const arr = day[g.id];
      if (Array.isArray(arr) && arr.some((e) => e && e.personId === personId)) {
        setSlot(db, date, g.id, arr.filter((e) => e && e.personId !== personId));
        cleared.push(date);
      }
    }
  }
  return cleared;
}

// 某人名下有排班的日期（改名后重发飞书用）
function personDates(db, personId) {
  const out = [];
  for (const [date, day] of Object.entries(db.schedule)) {
    if (!day) continue;
    for (const g of db.groups) {
      const arr = day[g.id];
      if (Array.isArray(arr) && arr.some((e) => e && e.personId === personId)) out.push(date);
    }
  }
  return out;
}

// —— 轮换规则占位实现：每组每天先保底 1 人，按组内名单顺序循环 ——
// TODO: 等拿到具体加班逻辑后，只需要改这个函数
function nextAssignee(db, beforeDate, groupId) {
  const people = peopleOf(db, groupId);
  if (!people.length) return null;
  let lastDate = null;
  for (const [date, day] of Object.entries(db.schedule)) {
    const arr = day && day[groupId];
    if (Array.isArray(arr) && arr.length && date < beforeDate && (lastDate === null || date > lastDate)) lastDate = date;
  }
  if (lastDate === null) return people[0];
  const lastArr = db.schedule[lastDate][groupId];
  const lastId = lastArr[lastArr.length - 1].personId;
  const idx = people.findIndex((p) => p.id === lastId);
  return people[(idx + 1) % people.length];
}

// 生成一周排班（单组）：只填整天空缺的日期；该组该周已生成过则不动（保留人工弃班留空）
function ensureWeekGenerated(db, weekStart, groupId) {
  if (!isDateStr(weekStart) || weekStartOf(weekStart) !== weekStart) return false;
  if (!groupById(db, groupId)) return false;
  if (!peopleOf(db, groupId).length) return false; // 空组不生成也不标记，等人加进来后自动补排
  const done = genWeeks(db, groupId);
  if (done.includes(weekStart)) return false;
  let changed = false;
  for (let i = 0; i < 7; i++) {
    const day = addDays(weekStart, i);
    if (!slotOf(db, day, groupId).length) {
      const person = nextAssignee(db, day, groupId);
      if (person) {
        setSlot(db, day, groupId, [{ personId: person.id }]);
        changed = true;
      }
    }
  }
  done.push(weekStart);
  return changed;
}

// 所有组各生成一周（互不干扰）
function ensureWeekAllGroups(db, weekStart) {
  let changed = false;
  for (const g of db.groups) changed = ensureWeekGenerated(db, weekStart, g.id) || changed;
  return changed;
}

// 周六双倍：加班工时按天加权（统计/AI 公平口径）
function weekdayMultiplier(db, date) {
  if (db.config && db.config.saturdayDouble && dowIndex(date) === 5) return 2;
  return 1;
}

// date 传当天日期以应用周六双倍；不传则按基础工时
function entryHours(db, entry, date) {
  const h = Number(entry && entry.hours);
  const base = Number.isFinite(h) && h > 0 ? h : Number(db.config.shiftHours) || 8;
  return base * (date ? weekdayMultiplier(db, date) : 1);
}

// —— 工时统计（管理员页使用，按组口径；周六按双倍计入）——
function computeStats(db) {
  const today = todayStr(db.config.timezone);
  const groups = db.groups.map((g) => ({
    id: g.id, name: g.name,
    weeksAll: new Set(), weeksPast: new Set(),
  }));
  const per = {}; // personId -> 累计
  for (const p of db.people) {
    per[p.id] = { shifts: 0, hours: 0, pastShifts: 0, pastHours: 0, monthShifts: 0, monthHours: 0 };
  }
  let firstDate = null;
  for (const [date, day] of Object.entries(db.schedule)) {
    if (!day) continue;
    for (const g of groups) {
      const arr = day[g.id];
      if (!Array.isArray(arr)) continue;
      for (const e of arr) {
        if (!e || !e.personId || !per[e.personId]) continue;
        const rec = per[e.personId];
        const h = entryHours(db, e, date);
        rec.shifts += 1;
        rec.hours += h;
        g.weeksAll.add(weekStartOf(date));
        if (date <= today) {
          rec.pastShifts += 1;
          rec.pastHours += h;
          g.weeksPast.add(weekStartOf(date));
        }
        if (date.slice(0, 7) === today.slice(0, 7)) {
          rec.monthShifts += 1;
          rec.monthHours += h;
        }
        if (firstDate === null || date < firstDate) firstDate = date;
      }
    }
  }
  return {
    since: firstDate,
    today,
    shiftHours: Number(db.config.shiftHours) || 8,
    saturdayDouble: !!db.config.saturdayDouble,
    groups: groups.map((g) => {
      const wA = g.weeksAll.size;
      const wP = g.weeksPast.size;
      return {
        id: g.id,
        name: g.name,
        weeksAll: wA,
        weeksPast: wP,
        members: peopleOf(db, g.id).map((p) => {
          const r = per[p.id];
          return {
            name: p.name,
            shifts: r.shifts, hours: r.hours,
            avgWeek: wA ? +(r.hours / wA).toFixed(1) : 0,
            pastShifts: r.pastShifts, pastHours: r.pastHours,
            pastAvgWeek: wP ? +(r.pastHours / wP).toFixed(1) : 0,
            monthShifts: r.monthShifts, monthHours: r.monthHours,
          };
        }),
      };
    }),
  };
}

module.exports = {
  parseDate, fmtDate, addDays, dowIndex, weekStartOf, isDateStr,
  WEEKDAY_CN, isoWeek, nowParts, todayStr, nowDisplay,
  groupById, peopleOf, slotOf, setSlot, genWeeks, clearPersonSlots, personDates,
  weekdayMultiplier, nextAssignee, ensureWeekGenerated, ensureWeekAllGroups,
  entryHours, computeStats,
};
