'use strict';
const cron = require('node-cron');
const {
  addDays, weekStartOf, nowParts, ensureWeekAllGroups,
} = require('./scheduler');
const feishu = require('./feishu');
const ai = require('./ai');

let mondayTask = null;
let aiTask = null;

async function mondayFire(store) {
  const db = store.data;
  const today = nowParts(db.config.timezone).date;
  const ws = weekStartOf(today);
  ensureWeekAllGroups(db, ws);
  store.save();
  await feishu.sendWeekNow(store, ws, '每周一定时发送');
  db.lastAutoSend = today;
  store.save();
}

async function aiFire(store) {
  const db = store.data;
  const today = nowParts(db.config.timezone).date;
  db.lastAiCheck = today;
  store.save();
  try {
    await ai.nightlyCheck(store);
  } catch (e) {
    store.addLog('系统', 'system', 'AI夜检', `异常：${e.message || e}`);
    store.save();
  }
}

// 配置变化后重建两个定时任务
function reschedule(store) {
  const cfg = store.data.config;
  const mondayExpr = `${cfg.sendMinute} ${cfg.sendHour} * * 1`;
  if (mondayTask) mondayTask.stop();
  if (cron.validate(mondayExpr)) {
    mondayTask = cron.schedule(mondayExpr, () => mondayFire(store).catch(() => {}), {
      timezone: cfg.timezone || 'Asia/Shanghai',
    });
  }
  const aiExpr = `${cfg.aiCheckMinute} ${cfg.aiCheckHour} * * *`;
  if (aiTask) aiTask.stop();
  if (cron.validate(aiExpr)) {
    aiTask = cron.schedule(aiExpr, () => aiFire(store).catch(() => {}), {
      timezone: cfg.timezone || 'Asia/Shanghai',
    });
  }
}

// 启动/配置变更后的补发：定时时刻服务器不在线时，起来后补一次
function catchup(store) {
  const db = store.data;
  const cfg = db.config;
  const parts = nowParts(cfg.timezone);

  // 周一排班发送补发（本周还没发过就补发）
  if (cfg.webhookUrl) {
    const ws = weekStartOf(parts.date);
    const sendMin = cfg.sendHour * 60 + cfg.sendMinute;
    const nowMin = parts.hour * 60 + parts.minute;
    const isMondayBeforeSend = parts.dow === 0 && nowMin < sendMin;
    if (db.lastAutoSend < ws && !isMondayBeforeSend) {
      mondayFire(store).catch(() => {});
    }
  }

  // AI 夜检补检
  if (cfg.aiApiKey) {
    const checkMin = cfg.aiCheckHour * 60 + cfg.aiCheckMinute;
    const nowMin = parts.hour * 60 + parts.minute;
    const yesterday = addDays(parts.date, -1);
    const checkedYesterdayOrLater = db.lastAiCheck >= yesterday;
    if (db.lastAiCheck < parts.date && !(checkedYesterdayOrLater && nowMin < checkMin)) {
      aiFire(store).catch(() => {});
    }
  }
}

function start(store) {
  reschedule(store);
  catchup(store);
}

module.exports = { start, reschedule, catchup, mondayFire, aiFire };
