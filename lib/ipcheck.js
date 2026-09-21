'use strict';
// 工作区域 IP 验证：取客户端真实 IP + 判断是否命中配置的 IP 段（CIDR / 单 IP）

function normalizeIp(ip) {
  let s = String(ip || '').trim();
  if (s.startsWith('::ffff:')) s = s.slice(7); // IPv6-mapped IPv4 → 1.2.3.4
  if (s === '::1') s = '127.0.0.1';
  return s;
}

// trustForwarded=true（服务器在反向代理后）才信任 X-Forwarded-For，防止直连时伪造
function clientIp(req, trustForwarded) {
  if (trustForwarded) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const first = String(xff).split(',')[0].trim();
      if (first) return normalizeIp(first);
    }
  }
  return normalizeIp(req.socket.remoteAddress || '');
}

function ipv4ToInt(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

// 返回命中的那个 IP 段；未命中返回 null。支持 192.168.0.0/16、单 IP（v4/v6 均可）
function ipInRanges(ip, rangesStr) {
  const target = normalizeIp(ip);
  const parts = String(rangesStr || '').split(/[,，\s]+/).filter(Boolean);
  for (const raw of parts) {
    const r = raw.trim();
    if (r.includes('/')) {
      const [base, bitsRaw] = r.split('/');
      const bits = Number(bitsRaw);
      const b = ipv4ToInt(base);
      const n = ipv4ToInt(target);
      if (b !== null && n !== null && Number.isInteger(bits) && bits >= 0 && bits <= 32) {
        const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
        if ((n & mask) === (b & mask)) return r;
      }
    } else if (normalizeIp(r) === target) {
      return r;
    }
  }
  return null;
}

module.exports = { clientIp, normalizeIp, ipv4ToInt, ipInRanges };
