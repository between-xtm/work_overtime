'use strict';
// 本地 mock 飞书 webhook：验证发送链路用（node mock-webhook.js，监听 127.0.0.1:3999）
const http = require('http');
let count = 0;
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    count += 1;
    console.log(`\n=== mock webhook 收到第 ${count} 次请求 ===`);
    console.log(body);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code: 0, msg: 'success' }));
  });
}).listen(3999, '127.0.0.1', () => console.log('mock webhook: http://127.0.0.1:3999/hook'));
