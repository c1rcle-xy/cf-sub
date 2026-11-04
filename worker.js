/**
 * cf-sub — 基于 Cloudflare Workers + KV 的节点订阅管理服务
 * ---------------------------------------------------------------------------
 * 单文件实现，可直接粘贴到 Cloudflare Dashboard 的 Worker 编辑器部署。
 *
 * 功能：
 *   GET  /                      首页（说明）
 *   GET  /admin                 管理界面（需 ADMIN_TOKEN）
 *   GET  /sub                   订阅出口（默认 base64）
 *        ?format=raw|base64|clash|json
 *        ?token=xxx            与 SUB_TOKEN 配套（若已配置）
 *
 *   POST /api/login             校验管理员口令并下发 Cookie
 *   POST /api/logout            清除 Cookie
 *   GET  /api/store             读取全部节点（需管理员）
 *   PUT  /api/store             覆盖写入全部节点（需管理员）
 *   POST /api/import            从远程订阅 URL 拉取并解析（需管理员）
 *   GET  /api/meta              运行时信息（需管理员）
 *
 * 需要的绑定：
 *   KV 命名空间   -> SUB_KV
 *   Secret/变量   -> ADMIN_TOKEN （必填）
 *                    SUB_TOKEN   （可选，给订阅出口加一道口令）
 *
 * 存储结构（KV 中单 key 存整份 JSON）：
 *   { version, updatedAt, nodes: [{ id, name, uri, enabled, remark }] }
 */

/* ============================== 常量 ============================== */

const STORE_KEY = 'sub_store_v1';
const SESSION_COOKIE = 'cfsub_sess';
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 天

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ============================== 通用响应 ============================== */

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

function textResponse(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

function htmlResponse(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      ...headers,
    },
  });
}

/* ============================== 编码 / 比较 ============================== */

function b64encode(str) {
  const bytes = enc.encode(str);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function b64decode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return dec.decode(bytes);
}

function tryB64decode(str) {
  try {
    const out = b64decode(str);
    // 过滤掉解出来是乱码的情况
    if (/[\u0000-\u0008\u000e-\u001f]/.test(out)) return null;
    return out;
  } catch {
    return null;
  }
}

/** 常数时间字符串比较 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    diff |= (x[i] || 0) ^ (y[i] || 0);
  }
  return diff === 0;
}

function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'n_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/* ============================== KV 存储 ============================== */

function emptyStore() {
  return { version: 1, updatedAt: null, nodes: [] };
}

function normalizeNode(n) {
  if (!n || typeof n !== 'object') return null;
  const uri = typeof n.uri === 'string' ? n.uri.trim() : '';
  if (!uri) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(uri)) return null;
  return {
    id: typeof n.id === 'string' && n.id ? n.id : newId(),
    name: typeof n.name === 'string' && n.name.trim() ? n.name.trim().slice(0, 200) : '',
    uri: uri.slice(0, 8192),
    enabled: n.enabled !== false,
    remark: typeof n.remark === 'string' ? n.remark.trim().slice(0, 500) : '',
  };
}

async function loadStore(env) {
  if (!env.SUB_KV) throw new Error('缺少 KV 绑定：请在 Worker 设置里绑定命名空间 SUB_KV');
  const raw = await env.SUB_KV.get(STORE_KEY);
  if (!raw) return emptyStore();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return emptyStore();
  }
  if (!data || !Array.isArray(data.nodes)) return emptyStore();
  const seen = new Set();
  const nodes = [];
  for (const n of data.nodes) {
    const v = normalizeNode(n);
    if (!v) continue;
    if (seen.has(v.id)) v.id = newId();
    seen.add(v.id);
    nodes.push(v);
  }
  return { version: Number(data.version) || 1, updatedAt: data.updatedAt || null, nodes };
}

async function saveStore(env, store) {
  const clean = {
    version: 1,
    updatedAt: new Date().toISOString(),
    nodes: (store.nodes || []).map(normalizeNode).filter(Boolean),
  };
  await env.SUB_KV.put(STORE_KEY, JSON.stringify(clean));
  return clean;
}

/* ============================== 认证 ============================== */

function parseCookies(req) {
  const out = {};
  const raw = req.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

function readAdminToken(req, url) {
  const auth = req.headers.get('authorization') || '';
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  const h = req.headers.get('x-admin-token');
  if (h) return h.trim();
  const c = parseCookies(req)[SESSION_COOKIE];
  if (c) return c;
  const q = url.searchParams.get('token');
  if (q) return q;
  return '';
}

function isAdmin(req, url, env) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return false;
  const got = readAdminToken(req, url);
  if (!got) return false;
  return safeEqual(got, expected);
}

function timingDelay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sessionCookie(token, secure) {
  const parts = [
    SESSION_COOKIE + '=' + encodeURIComponent(token),
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=' + SESSION_MAX_AGE,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function clearCookie() {
  return SESSION_COOKIE + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';
}

/* ============================== URI 解析工具 ============================== */

function unbracket(host) {
  if (typeof host !== 'string') return '';
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function splitHostPort(s, fallbackPort) {
  let host = '';
  let port = fallbackPort || 443;
  const str = String(s || '').trim();
  if (!str) return { host, port };
  if (str.startsWith('[')) {
    const end = str.indexOf(']');
    if (end < 0) return { host: str, port };
    host = str.slice(1, end);
    const rest = str.slice(end + 1).replace(/^:/, '');
    const p = parseInt(rest, 10);
    if (p) port = p;
    return { host, port };
  }
  const idx = str.lastIndexOf(':');
  if (idx < 0) return { host: str, port };
  host = str.slice(0, idx);
  const p = parseInt(str.slice(idx + 1), 10);
  if (p) port = p;
  return { host, port };
}

function toInt(v, dflt) {
  const n = parseInt(String(v == null ? '' : v), 10);
  return Number.isFinite(n) ? n : dflt;
}

function truthy(v) {
  const s = String(v == null ? '' : v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function splitComma(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 从 URI 的 fragment 取节点名 */
function uriName(uri) {
  const i = uri.indexOf('#');
  if (i < 0) return '';
  try {
    return decodeURIComponent(uri.slice(i + 1)).trim();
  } catch {
    return uri.slice(i + 1).trim();
  }
}

/** 解析 ws / grpc / h2 / http 等传输层参数到 Clash 结构 */
function applyTransport(proxy, params, opts) {
  const type = (params.get('type') || opts.defaultType || 'tcp').toLowerCase();
  const host = params.get('host') || '';
  const path = params.get('path') || '/';
  const sni = params.get('sni') || '';
  const serviceName = params.get('serviceName') || params.get('servicename') || '';

  if (type === 'ws' || type === 'websocket') {
    proxy.network = 'ws';
    const wsOpts = { path };
    const hdrs = {};
    if (host) hdrs.Host = host;
    if (Object.keys(hdrs).length) wsOpts.headers = hdrs;
    if (params.get('ed')) wsOpts['max-early-data'] = toInt(params.get('ed'), 2048);
    if (params.get('eh')) wsOpts['early-data-header-name'] = params.get('eh');
    proxy['ws-opts'] = wsOpts;
  } else if (type === 'grpc') {
    proxy.network = 'grpc';
    proxy['grpc-opts'] = { 'grpc-service-name': serviceName || path.replace(/^\//, '') || '' };
  } else if (type === 'h2' || type === 'http') {
    if (type === 'h2') {
      proxy.network = 'h2';
      const h2 = { path };
      if (host) h2.host = splitComma(host);
      proxy['h2-opts'] = h2;
    } else {
      proxy.network = 'http';
      const hopts = { path: [path] };
      if (host) hopts.headers = { Host: splitComma(host) };
      proxy['http-opts'] = hopts;
    }
    if (sni) proxy.servername = sni;
  } else if (type === 'httpupgrade') {
    proxy.network = 'httpupgrade';
    const uo = { path };
    if (host) uo.host = host;
    proxy['httpupgrade-opts'] = uo;
  } else if (type === 'tcp' || type === 'none' || type === 'raw') {
    if (params.get('headerType') === 'http') {
      proxy.network = 'http';
      const hopts = { path: [path] };
      if (host) hopts.headers = { Host: splitComma(host) };
      proxy['http-opts'] = hopts;
    }
  }
}

/* ------------------------------ ss:// ------------------------------ */

function parseSS(uri) {
  let rest = uri.slice(5); // after ss://
  const name = uriName(uri);
  const hashIdx = rest.indexOf('#');
  if (hashIdx >= 0) rest = rest.slice(0, hashIdx);
  let qs = '';
  const qi = rest.indexOf('?');
  if (qi >= 0) {
    qs = rest.slice(qi + 1);
    rest = rest.slice(0, qi);
  }

  let method = '';
  let password = '';
  let host = '';
  let port = 0;

  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    const userinfo = rest.slice(0, at);
    let ui = userinfo;
    if (!ui.includes(':')) {
      ui = tryB64decode(decodeURIComponent(ui));
      if (ui == null) return null;
    } else {
      try {
        ui = decodeURIComponent(ui);
      } catch {
        /* keep */
      }
    }
    const ci = ui.indexOf(':');
    if (ci < 0) return null;
    method = ui.slice(0, ci);
    password = ui.slice(ci + 1);
    const hp = splitHostPort(rest.slice(at + 1));
    host = hp.host;
    port = hp.port;
  } else {
    const plain = tryB64decode(decodeURIComponent(rest));
    if (!plain) return null;
    const a2 = plain.lastIndexOf('@');
    if (a2 < 0) return null;
    const ui = plain.slice(0, a2);
    const ci = ui.indexOf(':');
    if (ci < 0) return null;
    method = ui.slice(0, ci);
    password = ui.slice(ci + 1);
    const hp = splitHostPort(plain.slice(a2 + 1));
    host = hp.host;
    port = hp.port;
  }

  if (!host || !method) return null;

  const proxy = {
    name,
    type: 'ss',
    server: unbracket(host),
    port: port || 8388,
    cipher: method.toLowerCase(),
    password,
    udp: true,
  };

  const params = new URLSearchParams(qs);
  const plugin = params.get('plugin');
  if (plugin) {
    const segs = plugin.split(';');
    const pname = (segs[0] || '').toLowerCase();
    const popt = {};
    for (const seg of segs.slice(1)) {
      const eq = seg.indexOf('=');
      if (eq < 0) {
        if (seg.trim()) popt[seg.trim()] = true;
      } else {
        popt[seg.slice(0, eq).trim()] = seg.slice(eq + 1).trim();
      }
    }
    if (pname === 'obfs-local' || pname === 'obfs') {
      proxy.plugin = 'obfs';
      proxy['plugin-opts'] = { mode: popt.obfs || 'http' };
      if (popt['obfs-host']) proxy['plugin-opts'].host = popt['obfs-host'];
    } else if (pname === 'v2ray-plugin') {
      proxy.plugin = 'v2ray-plugin';
      proxy['plugin-opts'] = {
        mode: popt.mode || 'websocket',
        host: popt.host || '',
        path: popt.path || '/',
        tls: !!popt.tls,
      };
      if (!proxy['plugin-opts'].host) delete proxy['plugin-opts'].host;
    } else if (pname === 'shadow-tls') {
      proxy.plugin = 'shadow-tls';
      proxy['plugin-opts'] = {
        host: popt.host || '',
        password: popt.password || '',
        version: toInt(popt.version, 3),
      };
    } else {
      // 未知插件，保留原样交给客户端自己判断
      proxy.plugin = pname;
    }
  }

  return proxy;
}

/* ------------------------------ vmess:// ------------------------------ */

function parseVMess(uri) {
  const body = uri.slice(8);
  const name = uriName(uri);
  const plain = tryB64decode(body.split('#')[0]);
  if (!plain) return null;
  let j;
  try {
    j = JSON.parse(plain);
  } catch {
    return null;
  }
  if (!j || !j.add) return null;

  const port = toInt(j.port, 443);
  const net = String(j.net || 'tcp').toLowerCase();
  const proxy = {
    name: name || j.ps || unbracket(String(j.add)) + ':' + port,
    type: 'vmess',
    server: unbracket(String(j.add)),
    port,
    uuid: String(j.id || ''),
    alterId: toInt(j.aid, 0),
    cipher: String(j.scy || 'auto') || 'auto',
    udp: true,
  };

  const tlsMode = String(j.tls || '').toLowerCase();
  if (tlsMode === 'tls' || tlsMode === 'reality') {
    proxy.tls = true;
    const sn = String(j.sni || j.host || '').split(',')[0].trim();
    if (sn) proxy.servername = sn;
    if (j.alpn) {
      const alpn = Array.isArray(j.alpn) ? j.alpn : splitComma(j.alpn);
      if (alpn.length) proxy.alpn = alpn;
    }
    if (j.fp) proxy['client-fingerprint'] = String(j.fp);
  }

  const path = String(j.path || '/');
  const host = String(j.host || '');
  if (net === 'ws') {
    proxy.network = 'ws';
    const wsOpts = { path: path || '/' };
    if (host) wsOpts.headers = { Host: host.split(',')[0].trim() };
    proxy['ws-opts'] = wsOpts;
  } else if (net === 'grpc') {
    proxy.network = 'grpc';
    proxy['grpc-opts'] = { 'grpc-service-name': path.replace(/^\//, '') };
  } else if (net === 'h2' || net === 'http') {
    proxy.network = 'h2';
    const h2 = { path: path || '/' };
    if (host) h2.host = splitComma(host);
    proxy['h2-opts'] = h2;
  } else if (net === 'tcp' && String(j.type || '').toLowerCase() === 'http') {
    proxy.network = 'http';
    const hopts = { path: [path || '/'] };
    if (host) hopts.headers = { Host: splitComma(host) };
    proxy['http-opts'] = hopts;
  }

  return proxy;
}

/* ------------------------------ vless:// ------------------------------ */

function parseVLESS(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (!u.hostname) return null;
  const p = u.searchParams;
  const port = toInt(u.port, 443);
  const proxy = {
    name: uriName(uri) || unbracket(u.hostname) + ':' + port,
    type: 'vless',
    server: unbracket(u.hostname),
    port,
    uuid: decodeURIComponent(u.username || ''),
    udp: true,
  };

  const sec = (p.get('security') || 'none').toLowerCase();
  if (sec === 'tls' || sec === 'reality') {
    proxy.tls = true;
    const sni = p.get('sni') || p.get('host') || '';
    if (sni) proxy.servername = sni.split(',')[0].trim();
    if (p.get('fp')) proxy['client-fingerprint'] = p.get('fp');
    if (p.get('alpn')) proxy.alpn = splitComma(p.get('alpn'));
    if (sec === 'reality') {
      const ro = {};
      if (p.get('pbk')) ro['public-key'] = p.get('pbk');
      if (p.get('sid')) ro['short-id'] = p.get('sid');
      if (Object.keys(ro).length) proxy['reality-opts'] = ro;
    }
  }
  if (p.get('flow')) proxy.flow = p.get('flow');
  applyTransport(proxy, p, {});
  return proxy;
}

/* ------------------------------ trojan:// ------------------------------ */

function parseTrojan(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (!u.hostname) return null;
  const p = u.searchParams;
  const port = toInt(u.port, 443);
  const proxy = {
    name: uriName(uri) || unbracket(u.hostname) + ':' + port,
    type: 'trojan',
    server: unbracket(u.hostname),
    port,
    password: decodeURIComponent(u.username || ''),
    udp: true,
  };
  const sni = p.get('sni') || p.get('peer') || p.get('host') || '';
  if (sni) proxy.sni = sni.split(',')[0].trim();
  if (truthy(p.get('allowInsecure')) || truthy(p.get('insecure'))) proxy['skip-cert-verify'] = true;
  if (p.get('alpn')) proxy.alpn = splitComma(p.get('alpn'));
  if (p.get('fp')) proxy['client-fingerprint'] = p.get('fp');
  applyTransport(proxy, p, {});
  if (!proxy.sni && proxy.network === 'ws' && p.get('host')) proxy.sni = p.get('host');
  return proxy;
}

/* ------------------------------ hysteria2:// ------------------------------ */

function parseHysteria2(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (!u.hostname) return null;
  const p = u.searchParams;
  const port = toInt(u.port, 443);
  let auth = decodeURIComponent(u.username || '');
  if (!auth && u.password) auth = decodeURIComponent(u.password);
  // hysteria2://user:pass@host 形式
  if (u.username && u.password) {
    auth = decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password);
  }
  const proxy = {
    name: uriName(uri) || unbracket(u.hostname) + ':' + port,
    type: 'hysteria2',
    server: unbracket(u.hostname),
    port,
    password: auth,
  };
  const sni = p.get('sni') || p.get('peer') || '';
  if (sni) proxy.sni = sni;
  if (truthy(p.get('insecure')) || truthy(p.get('allowInsecure'))) proxy['skip-cert-verify'] = true;
  if (p.get('obfs')) {
    proxy.obfs = p.get('obfs');
    if (p.get('obfs-password')) proxy['obfs-password'] = p.get('obfs-password');
  }
  if (p.get('alpn')) proxy.alpn = splitComma(p.get('alpn'));
  if (p.get('up')) proxy.up = p.get('up');
  if (p.get('down')) proxy.down = p.get('down');
  return proxy;
}

/* ------------------------------ tuic:// ------------------------------ */

function parseTUIC(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (!u.hostname) return null;
  const p = u.searchParams;
  const port = toInt(u.port, 443);
  const proxy = {
    name: uriName(uri) || unbracket(u.hostname) + ':' + port,
    type: 'tuic',
    server: unbracket(u.hostname),
    port,
    uuid: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
  };
  if (p.get('sni')) proxy.sni = p.get('sni');
  if (p.get('alpn')) proxy.alpn = splitComma(p.get('alpn'));
  else proxy.alpn = ['h3'];
  if (truthy(p.get('allow_insecure')) || truthy(p.get('insecure'))) proxy['skip-cert-verify'] = true;
  if (p.get('congestion_control') || p.get('congestion_controller')) {
    proxy['congestion-controller'] = p.get('congestion_control') || p.get('congestion_controller');
  }
  if (p.get('udp_relay_mode')) proxy['udp-relay-mode'] = p.get('udp_relay_mode');
  return proxy;
}

/* ------------------------------ anytls:// ------------------------------ */

function parseAnyTLS(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (!u.hostname) return null;
  const p = u.searchParams;
  const port = toInt(u.port, 443);
  const proxy = {
    name: uriName(uri) || unbracket(u.hostname) + ':' + port,
    type: 'anytls',
    server: unbracket(u.hostname),
    port,
    password: decodeURIComponent(u.username || ''),
    udp: true,
  };
  const sni = p.get('sni') || p.get('peer') || '';
  if (sni) proxy.sni = sni;
  if (truthy(p.get('insecure')) || truthy(p.get('allowInsecure'))) proxy['skip-cert-verify'] = true;
  if (p.get('fp')) proxy['client-fingerprint'] = p.get('fp');
  return proxy;
}

/* ------------------------------ 统一入口 ------------------------------ */

function parseNodeURI(uri) {
  const s = String(uri || '').trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  try {
    if (lower.startsWith('ss://')) return parseSS(s);
    if (lower.startsWith('vmess://')) return parseVMess(s);
    if (lower.startsWith('vless://')) return parseVLESS(s);
    if (lower.startsWith('trojan://')) return parseTrojan(s);
    if (lower.startsWith('hysteria2://') || lower.startsWith('hy2://')) return parseHysteria2(s);
    if (lower.startsWith('tuic://')) return parseTUIC(s);
    if (lower.startsWith('anytls://')) return parseAnyTLS(s);
  } catch {
    return null;
  }
  return null;
}

function protocolOf(uri) {
  const m = String(uri || '').match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\//);
  return m ? m[1].toLowerCase() : 'unknown';
}

/* ============================== YAML 序列化 ============================== */

function yamlScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  if (s === '') return '""';
  const looksNumeric = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s);
  const reserved = /^(true|false|null|yes|no|on|off|~)$/i.test(s);
  if (!looksNumeric && !reserved && /^[A-Za-z0-9_.:@/+\-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function yamlDump(value, indent) {
  const P = (n) => ' '.repeat(n);
  if (value === null || value === undefined) return P(indent) + 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return P(indent) + '[]';
    const lines = [];
    for (const item of value) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const child = yamlDump(item, indent + 2);
        const cl = child.split('\n');
        cl[0] = P(indent) + '- ' + cl[0].slice(indent + 2);
        lines.push(cl.join('\n'));
      } else {
        lines.push(P(indent) + '- ' + yamlScalar(item));
      }
    }
    return lines.join('\n');
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return P(indent) + '{}';
    const lines = [];
    for (const [k, v] of entries) {
      if (v !== null && typeof v === 'object') {
        if (Array.isArray(v) && v.length === 0) {
          lines.push(P(indent) + k + ': []');
          continue;
        }
        if (!Array.isArray(v) && Object.keys(v).length === 0) {
          lines.push(P(indent) + k + ': {}');
          continue;
        }
        lines.push(P(indent) + k + ':');
        lines.push(yamlDump(v, indent + 2));
      } else {
        lines.push(P(indent) + k + ': ' + yamlScalar(v));
      }
    }
    return lines.join('\n');
  }
  return P(indent) + yamlScalar(value);
}

/* ============================== 订阅渲染 ============================== */

function activeNodes(store) {
  return (store.nodes || []).filter((n) => n.enabled !== false && n.uri);
}

function displayName(node, index) {
  if (node.name) return node.name;
  const got = uriName(node.uri);
  if (got) return got;
  const p = parseNodeURI(node.uri);
  if (p && p.server) return p.type + '-' + p.server;
  return 'node-' + (index + 1);
}

function renderRaw(store) {
  const list = activeNodes(store);
  return list.map((n, i) => n.uri.trim()).join('\n') + (list.length ? '\n' : '');
}

function renderBase64(store) {
  const raw = renderRaw(store);
  return raw.trim() ? b64encode(raw) : '';
}

function uniqueNamer() {
  const used = new Set();
  return (want) => {
    let base = String(want || 'node').replace(/[\r\n\t]/g, ' ').trim() || 'node';
    let name = base;
    let i = 2;
    while (used.has(name)) name = base + ' ' + i++;
    used.add(name);
    return name;
  };
}

function buildClashProxies(store) {
  const takeName = uniqueNamer();
  const proxies = [];
  const skipped = [];
  activeNodes(store).forEach((node, idx) => {
    const parsed = parseNodeURI(node.uri);
    if (!parsed) {
      skipped.push({ name: displayName(node, idx), reason: '不支持的协议或 URI 解析失败', uri: node.uri });
      return;
    }
    if (!parsed.server) {
      skipped.push({ name: displayName(node, idx), reason: '缺少服务器地址', uri: node.uri });
      return;
    }
    parsed.name = takeName(node.name || parsed.name || displayName(node, idx));
    // 清掉空字段
    for (const k of Object.keys(parsed)) {
      if (parsed[k] === '' || parsed[k] === undefined || parsed[k] === null) delete parsed[k];
    }
    proxies.push(parsed);
  });
  return { proxies, skipped };
}

function renderClash(store) {
  const { proxies } = buildClashProxies(store);
  const names = proxies.map((p) => p.name);
  const config = {};

  config['mixed-port'] = 7890;
  config['allow-lan'] = false;
  config.mode = 'rule';
  config['log-level'] = 'info';
  config['external-controller'] = '127.0.0.1:9090';
  config['unified-delay'] = true;
  config['tcp-concurrent'] = true;
  config.dns = {
    enable: true,
    ipv6: false,
    'enhanced-mode': 'fake-ip',
    'fake-ip-range': '198.18.0.1/16',
    'default-nameserver': ['223.5.5.5', '119.29.29.29'],
    nameserver: ['https://doh.pub/dns-query', 'https://dns.alidns.com/dns-query'],
    fallback: ['https://1.1.1.1/dns-query', 'https://dns.google/dns-query'],
  };
  config.proxies = proxies;
  config['proxy-groups'] = [
    {
      name: '🚀 节点选择',
      type: 'select',
      proxies: ['♻️ 自动选择', 'DIRECT'].concat(names),
    },
    {
      name: '♻️ 自动选择',
      type: 'url-test',
      url: 'http://www.gstatic.com/generate_204',
      interval: 300,
      tolerance: 50,
      proxies: names.length ? names : ['DIRECT'],
    },
    {
      name: '🌍 国外媒体',
      type: 'select',
      proxies: ['🚀 节点选择', '♻️ 自动选择', 'DIRECT'].concat(names),
    },
    {
      name: '🐟 漏网之鱼',
      type: 'select',
      proxies: ['🚀 节点选择', 'DIRECT'],
    },
  ];
  config.rules = [
    'GEOIP,LAN,DIRECT,no-resolve',
    'GEOIP,CN,DIRECT',
    'MATCH,🐟 漏网之鱼',
  ];

  return yamlDump(config, 0) + '\n';
}

/* ============================== 导入解析 ============================== */

/** 把一段订阅文本拆成 URI 数组；自动识别 base64 包裹 */
function extractURIs(text) {
  let body = String(text || '').trim();
  if (!body) return [];
  const looksLikeURI = /^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//m.test(body);
  if (!looksLikeURI) {
    const plain = tryB64decode(body);
    if (plain && /^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//m.test(plain)) body = plain;
  }
  const out = [];
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) continue;
    if (!/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(t)) continue;
    // 一行里可能有多个 URI（少见），按空白再切一次
    for (const piece of t.split(/\s+/)) {
      if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(piece)) out.push(piece);
    }
  }
  return out;
}

function mergeNodes(existing, incoming) {
  const byUri = new Map();
  for (const n of existing) byUri.set(n.uri, n);
  let added = 0;
  let updated = 0;
  for (const uri of incoming) {
    const name = uriName(uri);
    const found = byUri.get(uri);
    if (found) {
      if (name && !found.name) {
        found.name = name;
        updated++;
      }
      continue;
    }
    const node = normalizeNode({ id: newId(), name, uri, enabled: true, remark: '' });
    if (!node) continue;
    byUri.set(uri, node);
    added++;
  }
  return { nodes: Array.from(byUri.values()), added, updated };
}

/* ============================== 内网地址判断（导入防 SSRF） ============================== */

function isBlockedHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    return true;
  }
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = +v4[1];
    const b = +v4[2];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
    if (h.startsWith('::ffff:')) return isBlockedHost(h.slice(7));
    return false;
  }
  return false;
}

/* ============================== 路由处理 ============================== */

async function handleSub(req, env, url) {
  if (!env.SUB_KV) return textResponse('服务未配置完整：缺少 KV 绑定 SUB_KV', 500);

  const subToken = env.SUB_TOKEN;
  if (subToken) {
    const got = url.searchParams.get('token') || req.headers.get('x-sub-token') || '';
    if (!safeEqual(got, subToken)) {
      await timingDelay(200);
      return textResponse('unauthorized', 401);
    }
  }

  const store = await loadStore(env);
  const format = (url.searchParams.get('format') || 'base64').toLowerCase();
  const count = activeNodes(store).length;

  const baseHeaders = {
    'profile-update-interval': '12',
    'x-node-count': String(count),
    'access-control-allow-origin': '*',
  };

  if (format === 'raw' || format === 'text' || format === 'uri') {
    return textResponse(renderRaw(store), 200, {
      ...baseHeaders,
      'content-disposition': 'attachment; filename="nodes.txt"',
    });
  }

  if (format === 'clash' || format === 'yaml' || format === 'meta') {
    return new Response(renderClash(store), {
      status: 200,
      headers: {
        'content-type': 'text/yaml; charset=utf-8',
        'cache-control': 'no-store',
        ...baseHeaders,
        'content-disposition': 'attachment; filename="nodes.yaml"',
      },
    });
  }

  if (format === 'json') {
    return jsonResponse(
      {
        updatedAt: store.updatedAt,
        count,
        nodes: activeNodes(store).map((n, i) => ({
          name: displayName(n, i),
          uri: n.uri,
        })),
      },
      200,
      baseHeaders
    );
  }

  return textResponse(renderBase64(store), 200, {
    ...baseHeaders,
    'content-type': 'text/plain; charset=utf-8',
  });
}

async function handleApi(req, env, url, ctx) {
  const path = url.pathname;
  const method = req.method.toUpperCase();

  // ---------- 登录 / 登出 ----------
  if (path === '/api/login' && method === 'POST') {
    if (!env.ADMIN_TOKEN) {
      return jsonResponse({ ok: false, error: '服务端未设置 ADMIN_TOKEN' }, 500);
    }
    let body = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const token = String(body.token || '');
    if (!token) return jsonResponse({ ok: false, error: '口令不能为空' }, 400);
    if (!safeEqual(token, env.ADMIN_TOKEN)) {
      await timingDelay(400);
      return jsonResponse({ ok: false, error: '口令不正确' }, 401);
    }
    const secure = url.protocol === 'https:';
    return jsonResponse({ ok: true }, 200, {
      'set-cookie': sessionCookie(env.ADMIN_TOKEN, secure),
    });
  }

  if (path === '/api/logout' && method === 'POST') {
    return jsonResponse({ ok: true }, 200, { 'set-cookie': clearCookie() });
  }

  // ---------- 以下全部需要管理员 ----------
  if (!isAdmin(req, url, env)) {
    await timingDelay(150);
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }

  if (path === '/api/store' && method === 'GET') {
    const store = await loadStore(env);
    return jsonResponse({ ok: true, ...store });
  }

  if (path === '/api/store' && (method === 'PUT' || method === 'POST')) {
    let body;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ ok: false, error: '请求体不是合法 JSON' }, 400);
    }
    const nodes = Array.isArray(body) ? body : body && body.nodes;
    if (!Array.isArray(nodes)) {
      return jsonResponse({ ok: false, error: '缺少 nodes 数组' }, 400);
    }
    if (nodes.length > 5000) {
      return jsonResponse({ ok: false, error: '节点数量超过上限（5000）' }, 413);
    }
    const store = { version: 1, nodes };
    const saved = await saveStore(env, store);
    return jsonResponse({ ok: true, version: saved.version, updatedAt: saved.updatedAt, count: saved.nodes.length });
  }

  if (path === '/api/meta' && method === 'GET') {
    const store = await loadStore(env);
    return jsonResponse({
      ok: true,
      updatedAt: store.updatedAt,
      total: store.nodes.length,
      enabled: activeNodes(store).length,
      hasSubToken: !!env.SUB_TOKEN,
      hasAdminToken: !!env.ADMIN_TOKEN,
      allowRemoteImport: env.ALLOW_REMOTE_IMPORT !== 'false',
    });
  }

  if (path === '/api/import' && method === 'POST') {
    let body = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    let text = '';
    const remoteUrl = String(body.url || '').trim();

    if (remoteUrl) {
      if (env.ALLOW_REMOTE_IMPORT === 'false') {
        return jsonResponse({ ok: false, error: '服务端已禁用远程导入' }, 403);
      }
      let target;
      try {
        target = new URL(remoteUrl);
      } catch {
        return jsonResponse({ ok: false, error: 'URL 不合法' }, 400);
      }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        return jsonResponse({ ok: false, error: '只支持 http/https' }, 400);
      }
      if (isBlockedHost(target.hostname)) {
        return jsonResponse({ ok: false, error: '拒绝访问内网地址' }, 400);
      }
      const resp = await fetch(target.toString(), {
        headers: { 'user-agent': 'cf-sub/1.0', accept: '*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        return jsonResponse({ ok: false, error: '拉取失败，HTTP ' + resp.status }, 502);
      }
      const buf = await resp.arrayBuffer();
      if (buf.byteLength > 2 * 1024 * 1024) {
        return jsonResponse({ ok: false, error: '订阅内容超过 2MB' }, 413);
      }
      text = dec.decode(buf);
    } else {
      text = String(body.text || '');
    }

    const uris = extractURIs(text);
    if (!uris.length) {
      return jsonResponse({ ok: false, error: '没有解析出任何节点' }, 400);
    }

    if (body.dryRun) {
      return jsonResponse({ ok: true, dryRun: true, parsed: uris.length, uris });
    }

    const store = await loadStore(env);
    const merged = mergeNodes(store.nodes, uris);
    const saved = await saveStore(env, { version: store.version || 1, nodes: merged.nodes });
    return jsonResponse({
      ok: true,
      parsed: uris.length,
      added: merged.added,
      updated: merged.updated,
      total: saved.nodes.length,
    });
  }

  return jsonResponse({ ok: false, error: 'not found' }, 404);
}

/* ============================== 首页 ============================== */

const HOME_HTML = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>节点订阅服务</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#0b0e14;color:#dbe2ee;
       font:14px/1.7 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .card{width:min(520px,92vw);background:#12161f;border:1px solid #262c38;border-radius:14px;padding:28px 30px}
  h1{margin:0 0 4px;font-size:20px;letter-spacing:.3px}
  .sub{color:#7d8799;margin:0 0 20px;font-size:13px}
  ul{list-style:none;padding:0;margin:0 0 20px}
  li{display:flex;gap:10px;align-items:baseline;padding:7px 0;border-bottom:1px solid #1c2230;font-size:13px}
  li:last-child{border-bottom:0}
  code{background:#1a1f2b;border:1px solid #262c38;border-radius:6px;padding:1px 6px;
       font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:#9dc1ff}
  .k{color:#7d8799;min-width:74px;flex:none}
  a{color:#4f8cff;text-decoration:none}
  a:hover{text-decoration:underline}
  .btn{display:inline-block;background:#4f8cff;color:#fff;padding:8px 18px;border-radius:8px;font-weight:500}
  .btn:hover{text-decoration:none;filter:brightness(1.1)}
  .foot{margin-top:18px;font-size:12px;color:#5c6675}
</style>
</head>
<body>
  <div class="card">
    <h1>节点订阅服务</h1>
    <p class="sub">运行正常 · Cloudflare Workers</p>
    <ul>
      <li><span class="k">管理后台</span><span><a href="/admin">/admin</a> — 需要管理员口令</span></li>
      <li><span class="k">订阅出口</span><span><code>/sub</code> 默认 Base64</span></li>
      <li><span class="k">明文</span><span><code>/sub?format=raw</code></span></li>
      <li><span class="k">Clash</span><span><code>/sub?format=clash</code></span></li>
      <li><span class="k">JSON</span><span><code>/sub?format=json</code></span></li>
    </ul>
    <a class="btn" href="/admin">进入管理后台</a>
    <div class="foot">未授权访问者拿不到任何节点信息。</div>
  </div>
</body>
</html>`;

/* ============================== 管理界面 ============================== */

const ADMIN_HTML = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>节点订阅 · 管理</title>
<style>
  *{box-sizing:border-box}
  :root{
    --bg:#0b0e14; --surface:#12161f; --surface2:#1a1f2b; --line:#262c38;
    --fg:#dbe2ee; --muted:#7d8799; --accent:#4f8cff;
    --ok:#35c46a; --warn:#f0a92b; --err:#ef5350; --radius:10px;
  }
  html,body{height:100%}
  body{margin:0;background:var(--bg);color:var(--fg);
       font:14px/1.6 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
       -webkit-font-smoothing:antialiased}
  button,input,textarea{font:inherit;color:inherit}
  button{cursor:pointer}
  a{color:var(--accent);text-decoration:none}
  .hidden{display:none!important}
  .muted{color:var(--muted)}

  /* ---------- 登录 ---------- */
  #loginView{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .login-box{width:min(360px,92vw)}
  .login-box h1{margin:0 0 6px;font-size:22px;letter-spacing:.3px}
  .login-box p{margin:0 0 22px;font-size:13px}
  .login-box input{width:100%;padding:11px 13px;background:var(--surface);
    border:1px solid var(--line);border-radius:9px;outline:none;margin-bottom:12px;transition:border-color .15s}
  .login-box input:focus{border-color:var(--accent)}
  .err{color:var(--err);font-size:13px;margin-top:12px;min-height:20px}

  /* ---------- 主界面 ---------- */
  #appView{max-width:1000px;margin:0 auto;padding:0 16px 80px}
  .top{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:12px;
    padding:14px 0;background:linear-gradient(var(--bg) 70%,transparent);
    border-bottom:1px solid var(--line);margin-bottom:16px}
  .brand{font-size:16px;font-weight:600;letter-spacing:.3px;display:flex;align-items:center;gap:9px}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--muted);flex:none}
  .dot.saved{background:var(--ok)}
  .dot.dirty{background:var(--warn)}
  .dot.saving{background:var(--accent);animation:pulse 1s infinite}
  .dot.error{background:var(--err)}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
  .top-right{margin-left:auto;display:flex;align-items:center;gap:10px;font-size:12.5px}
  #saveState{color:var(--muted)}

  .toolbar{display:flex;gap:9px;flex-wrap:wrap;margin-bottom:14px}
  .toolbar input[type=search]{flex:1 1 220px;min-width:0;padding:9px 12px;background:var(--surface);
    border:1px solid var(--line);border-radius:9px;outline:none}
  .toolbar input[type=search]:focus{border-color:var(--accent)}

  button.base{padding:9px 15px;background:var(--surface);border:1px solid var(--line);
    border-radius:9px;transition:.15s;white-space:nowrap}
  button.base:hover{background:var(--surface2);border-color:#34404f}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:500}
  button.primary:hover{filter:brightness(1.1)}
  button.danger:hover{color:var(--err);border-color:var(--err)}
  .w-full{width:100%}

  /* ---------- 订阅链接面板 ---------- */
  .links{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);
    padding:6px;margin-bottom:14px}
  .link-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:7px}
  .link-row:hover{background:var(--surface2)}
  .link-row .lbl{width:74px;flex:none;font-size:12.5px;color:var(--muted)}
  .link-row .url{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    font-size:12.5px;color:#9dc1ff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .link-row .cp{padding:4px 10px;font-size:12px;background:transparent;border:1px solid var(--line);
    border-radius:6px;flex:none}

  /* ---------- 节点列表 ---------- */
  .list{display:flex;flex-direction:column;gap:8px}
  .row{display:flex;align-items:center;gap:11px;background:var(--surface);border:1px solid var(--line);
    border-radius:var(--radius);padding:10px 12px;transition:border-color .15s}
  .row:hover{border-color:#333e4e}
  .row.off{opacity:.45}
  .sw{width:34px;height:20px;border-radius:20px;border:1px solid var(--line);background:var(--surface2);
    position:relative;flex:none;padding:0;transition:.18s}
  .sw::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;
    background:var(--muted);transition:.18s}
  .row:not(.off) .sw{background:var(--accent);border-color:var(--accent)}
  .row:not(.off) .sw::after{left:16px;background:#fff}
  .row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
  .nm{background:transparent;border:1px solid transparent;border-radius:6px;padding:2px 6px;
    font-size:14px;font-weight:500;outline:none;width:100%;max-width:420px}
  .nm:hover{border-color:var(--line)}
  .nm:focus{border-color:var(--accent);background:var(--surface2)}
  .row-sub{display:flex;align-items:center;gap:8px;padding-left:6px;min-width:0}
  .tag{font-size:10.5px;font-weight:600;letter-spacing:.4px;padding:1px 6px;border-radius:4px;
    background:#20283a;color:#8fb4f0;flex:none;text-transform:uppercase}
  .tag.t-vless{background:#1e2a44;color:#8fb4f0}
  .tag.t-vmess{background:#2a2438;color:#b79df0}
  .tag.t-ss{background:#1e3328;color:#7ddba4}
  .tag.t-trojan{background:#3a2426;color:#f0949a}
  .tag.t-hysteria2,.tag.t-hy2{background:#33291c;color:#f0c07d}
  .tag.t-tuic{background:#1c3033;color:#7dd3db}
  .tag.t-anytls{background:#2c2433;color:#c99df0}
  .uri{font-size:12px;color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
  .row-actions{display:flex;gap:4px;flex:none}
  .row-actions button{padding:5px 9px;font-size:12.5px;background:transparent;border:1px solid transparent;
    border-radius:6px;color:var(--muted)}
  .row-actions button:hover{background:var(--surface2);border-color:var(--line);color:var(--fg)}
  .row-actions button.danger:hover{color:var(--err);border-color:var(--err)}

  .empty{text-align:center;color:var(--muted);padding:60px 20px;font-size:13.5px}

  /* ---------- 弹窗 ---------- */
  .modal{position:fixed;inset:0;background:rgba(5,7,11,.72);display:flex;align-items:center;
    justify-content:center;padding:20px;z-index:100;backdrop-filter:blur(3px)}
  .modal-box{width:min(620px,100%);max-height:88vh;display:flex;flex-direction:column;
    background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden;
    box-shadow:0 20px 60px rgba(0,0,0,.5)}
  .modal-head{display:flex;align-items:center;padding:15px 18px;border-bottom:1px solid var(--line);
    font-weight:600;font-size:15px}
  .modal-head button{margin-left:auto;background:transparent;border:0;font-size:20px;line-height:1;
    color:var(--muted);padding:0 4px}
  .modal-head button:hover{color:var(--fg)}
  .modal-body{padding:18px;overflow:auto;display:flex;flex-direction:column;gap:12px}
  .field label{display:block;font-size:12.5px;color:var(--muted);margin-bottom:5px}
  .field input,.field textarea{width:100%;padding:9px 11px;background:var(--surface2);
    border:1px solid var(--line);border-radius:8px;outline:none;resize:vertical}
  .field input:focus,.field textarea:focus{border-color:var(--accent)}
  .field textarea{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;
    min-height:150px;line-height:1.55}
  .hint{font-size:12px;color:var(--muted);line-height:1.5}
  .modal-foot{display:flex;gap:9px;justify-content:flex-end;padding:14px 18px;
    border-top:1px solid var(--line)}
  .modal-foot button{padding:8px 17px;border-radius:8px;background:var(--surface2);
    border:1px solid var(--line)}

  /* ---------- Toast ---------- */
  #toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(12px);
    background:var(--surface2);border:1px solid var(--line);border-radius:9px;padding:9px 18px;
    font-size:13px;opacity:0;transition:.22s;pointer-events:none;z-index:200;
    box-shadow:0 8px 30px rgba(0,0,0,.45);max-width:90vw}
  #toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
  #toast.ok{border-color:#2a6b45;color:#8fe3ad}
  #toast.bad{border-color:#6b2a2a;color:#f0a0a0}

  @media (max-width:640px){
    .row{flex-wrap:wrap}
    .row-main{order:1;flex:1 1 100%;max-width:none}
    .sw{order:0}
    .row-actions{order:2;margin-left:auto}
    .nm{max-width:none}
  }
</style>
</head>
<body>

<!-- ============ 登录 ============ -->
<div id="loginView" class="hidden">
  <div class="login-box">
    <h1>节点订阅</h1>
    <p class="muted">输入管理员口令以继续</p>
    <form id="loginForm" autocomplete="off">
      <input id="loginToken" type="password" placeholder="ADMIN_TOKEN" autocomplete="current-password">
      <button class="base primary w-full" type="submit">进入</button>
    </form>
    <div id="loginErr" class="err"></div>
  </div>
</div>

<!-- ============ 主界面 ============ -->
<div id="appView" class="hidden">
  <div class="top">
    <div class="brand"><span id="saveDot" class="dot"></span>节点订阅</div>
    <div class="top-right">
      <span id="saveState"></span>
      <button id="btnLogout" class="base">退出</button>
    </div>
  </div>

  <div class="toolbar">
    <input id="search" type="search" placeholder="搜索名称 / 协议 / 地址…">
    <button id="btnAdd" class="base primary">＋ 新增节点</button>
    <button id="btnImport" class="base">批量导入</button>
    <button id="btnLinks" class="base">订阅链接</button>
  </div>

  <div id="linksPanel" class="links hidden"></div>

  <div id="list" class="list"></div>
  <div id="empty" class="empty hidden">还没有节点。点「新增节点」或「批量导入」开始。</div>
</div>

<!-- ============ 弹窗 ============ -->
<div id="modal" class="modal hidden">
  <div class="modal-box">
    <div class="modal-head"><span id="modalTitle"></span><button id="modalClose" type="button">×</button></div>
    <div id="modalBody" class="modal-body"></div>
    <div class="modal-foot">
      <button id="modalCancel" type="button">取消</button>
      <button id="modalOk" class="primary" type="button">确定</button>
    </div>
  </div>
</div>

<div id="toast"></div>

<script>
(function () {
  "use strict";

  /* ---------------- 状态 ---------------- */
  var state = {
    nodes: [],
    loading: true,
    dirty: false,
    saving: false,
    pending: false,
    saveTimer: null,
    filter: "",
    subToken: false
  };
  var modalHandler = null;

  /* ---------------- DOM 工具 ---------------- */
  function $(sel) { return document.querySelector(sel); }
  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function toast(msg, kind) {
    var t = $("#toast");
    t.textContent = msg;
    t.className = "show" + (kind ? " " + kind : "");
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.className = ""; }, 2200);
  }

  /* ---------------- API ---------------- */
  function api(path, opts) {
    opts = opts || {};
    opts.credentials = "same-origin";
    var headers = opts.headers || {};
    if (opts.body !== undefined && typeof opts.body !== "string") {
      opts.body = JSON.stringify(opts.body);
      headers["content-type"] = "application/json";
    }
    opts.headers = headers;
    return fetch(path, opts).then(function (r) {
      return r.text().then(function (txt) {
        var data = {};
        try { data = txt ? JSON.parse(txt) : {}; } catch (e) { data = { raw: txt }; }
        if (!r.ok || data.ok === false) {
          var err = new Error(data.error || ("HTTP " + r.status));
          err.status = r.status;
          throw err;
        }
        return data;
      });
    });
  }

  function protocolOf(uri) {
    var m = String(uri || "").match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\//);
    return m ? m[1].toLowerCase() : "unknown";
  }
  function shortUri(uri) {
    var s = String(uri || "");
    if (s.length <= 78) return s;
    return s.slice(0, 60) + " … " + s.slice(-14);
  }

  /* ---------------- 保存状态 ---------------- */
  function setSaveState(kind, detail) {
    var dot = $("#saveDot");
    var label = $("#saveState");
    dot.className = "dot " + kind;
    var map = { saved: "已保存", dirty: "未保存", saving: "保存中…", error: "保存失败", idle: "" };
    label.textContent = detail ? map[kind] + " · " + detail : (map[kind] || "");
    if (detail) label.title = detail;
  }

  function markDirty() {
    state.dirty = true;
    setSaveState("dirty");
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(doSave, 700);
  }

  function doSave() {
    if (!state.dirty) return;
    if (state.saving) { state.pending = true; return; }
    state.saving = true;
    setSaveState("saving");
    api("/api/store", { method: "PUT", body: { nodes: state.nodes } }).then(function (j) {
      state.saving = false;
      state.dirty = false;
      setSaveState("saved", new Date().toLocaleTimeString());
      if (state.pending) { state.pending = false; markDirty(); }
    }).catch(function (err) {
      state.saving = false;
      setSaveState("error", err.message);
      toast("保存失败：" + err.message, "bad");
    });
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    var list = $("#list");
    var nodes = state.nodes;
    var q = state.filter.trim().toLowerCase();

    if (!nodes.length) {
      list.innerHTML = "";
      $("#empty").classList.remove("hidden");
      return;
    }
    $("#empty").classList.add("hidden");

    var visible = nodes;
    if (q) {
      visible = nodes.filter(function (n) {
        return String(n.name || "").toLowerCase().indexOf(q) >= 0
          || String(n.uri || "").toLowerCase().indexOf(q) >= 0;
      });
    }
    if (!visible.length) {
      list.innerHTML = '<div class="empty">没有匹配「' + esc(state.filter) + '」的节点</div>';
      return;
    }

    var html = "";
    for (var i = 0; i < visible.length; i++) {
      var n = visible[i];
      var idx = nodes.indexOf(n);
      var proto = protocolOf(n.uri);
      html += '<div class="row' + (n.enabled === false ? " off" : "") + '" data-id="' + esc(n.id) + '">'
        + '<button class="sw" data-act="toggle" type="button" title="启用 / 禁用"></button>'
        + '<div class="row-main">'
        + '<input class="nm" data-act="name" value="' + esc(n.name) + '" placeholder="给这个节点起个名字">'
        + '<div class="row-sub">'
        + '<span class="tag t-' + esc(proto) + '">' + esc(proto) + '</span>'
        + '<span class="uri" title="' + esc(n.uri) + '">' + esc(shortUri(n.uri)) + '</span>'
        + '</div></div>'
        + '<div class="row-actions">'
        + '<button data-act="up" type="button" title="上移"' + (idx === 0 ? " disabled" : "") + '>↑</button>'
        + '<button data-act="down" type="button" title="下移"' + (idx === nodes.length - 1 ? " disabled" : "") + '>↓</button>'
        + '<button data-act="edit" type="button">编辑</button>'
        + '<button data-act="del" class="danger" type="button">删除</button>'
        + '</div></div>';
    }
    list.innerHTML = html;
  }

  function findNode(id) {
    for (var i = 0; i < state.nodes.length; i++) {
      if (state.nodes[i].id === id) return state.nodes[i];
    }
    return null;
  }

  /* ---------------- 订阅链接面板 ---------------- */
  function renderLinks() {
    var origin = location.origin;
    var q = state.subToken ? "?token=你的SUB_TOKEN" : "";
    function sep(base) { return state.subToken ? base + "?token=你的SUB_TOKEN&format=" : base + "?format="; }
    var rows = [
      ["Base64", origin + "/sub" + q],
      ["明文", sep(origin + "/sub") + "raw"],
      ["Clash", sep(origin + "/sub") + "clash"],
      ["JSON", sep(origin + "/sub") + "json"]
    ];
    var html = "";
    for (var i = 0; i < rows.length; i++) {
      html += '<div class="link-row">'
        + '<span class="lbl">' + esc(rows[i][0]) + "</span>"
        + '<span class="url" title="' + esc(rows[i][1]) + '">' + esc(rows[i][1]) + "</span>"
        + '<button class="cp" data-copy="' + esc(rows[i][1]) + '" type="button">复制</button>'
        + "</div>";
    }
    if (state.subToken) {
      html += '<div class="link-row"><span class="lbl">提示</span>'
        + '<span class="url">已启用 SUB_TOKEN，把链接里的「你的SUB_TOKEN」换成实际口令</span></div>';
    }
    $("#linksPanel").innerHTML = html;
  }

  /* ---------------- 弹窗 ---------------- */
  function openModal(cfg) {
    $("#modalTitle").textContent = cfg.title;
    $("#modalBody").innerHTML = cfg.body;
    $("#modalOk").textContent = cfg.okText || "确定";
    $("#modal").classList.remove("hidden");
    modalHandler = cfg.onOk || null;
    if (cfg.after) setTimeout(cfg.after, 30);
  }
  function closeModal() {
    $("#modal").classList.add("hidden");
    modalHandler = null;
  }

  /* ---------------- 操作 ---------------- */
  function addNode() {
    openModal({
      title: "新增节点",
      okText: "添加",
      body: '<div class="field"><label>节点名称（可留空，自动从链接里取）</label>'
        + '<input id="fName" placeholder="例如：香港 01"></div>'
        + '<div class="field"><label>节点链接</label>'
        + '<textarea id="fUri" placeholder="vless://… / vmess://… / ss://… / trojan://… / hysteria2://…"></textarea></div>'
        + '<div class="hint">支持一条一条加，也支持一次贴多行——多行会自动拆成多个节点。</div>',
      after: function () { var e = $("#fUri"); if (e) e.focus(); },
      onOk: function () {
        var name = ($("#fName").value || "").trim();
        var raw = ($("#fUri").value || "").trim();
        if (!raw) { toast("节点链接不能为空", "bad"); return false; }
        var lines = raw.split(/\r?\n/).map(function (s) { return s.trim(); })
          .filter(function (s) { return /^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(s); });
        if (!lines.length) { toast("没识别出合法链接", "bad"); return false; }
        lines.forEach(function (uri, i) {
          var nm = name;
          if (!nm && lines.length > 1) {
            var h = uri.indexOf("#");
            nm = h >= 0 ? decodeURIComponent(uri.slice(h + 1)) : "";
          } else if (!nm) {
            var h2 = uri.indexOf("#");
            nm = h2 >= 0 ? decodeURIComponent(uri.slice(h2 + 1)) : "";
          }
          state.nodes.push({
            id: "n_" + Date.now().toString(36) + "_" + i + Math.random().toString(36).slice(2, 7),
            name: nm || "",
            uri: uri,
            enabled: true,
            remark: ""
          });
        });
        closeModal();
        render();
        markDirty();
        toast("已添加 " + lines.length + " 个节点", "ok");
      }
    });
  }

  function editNode(node) {
    openModal({
      title: "编辑节点",
      okText: "保存",
      body: '<div class="field"><label>节点名称</label>'
        + '<input id="fName" value="' + esc(node.name) + '"></div>'
        + '<div class="field"><label>节点链接</label>'
        + '<textarea id="fUri">' + esc(node.uri) + "</textarea></div>"
        + '<div class="field"><label>备注（只给自己看，不会进订阅）</label>'
        + '<input id="fRemark" value="' + esc(node.remark) + '"></div>',
      onOk: function () {
        var uri = ($("#fUri").value || "").trim();
        if (!uri) { toast("节点链接不能为空", "bad"); return false; }
        if (!/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(uri)) { toast("链接格式不对", "bad"); return false; }
        node.name = ($("#fName").value || "").trim();
        node.uri = uri;
        node.remark = ($("#fRemark").value || "").trim();
        closeModal();
        render();
        markDirty();
        toast("已更新", "ok");
      }
    });
  }

  function importModal() {
    openModal({
      title: "批量导入",
      okText: "导入",
      body: '<div class="field"><label>粘贴订阅内容（Base64 或明文均可）</label>'
        + '<textarea id="fText" placeholder="把机场订阅的原始内容整段粘进来，或者每行一个节点链接"></textarea></div>'
        + '<div class="field"><label>或者填一个订阅 URL（服务端拉取）</label>'
        + '<input id="fUrl" placeholder="https://example.com/api/v1/client/subscribe?token=…"></div>'
        + '<div class="hint">两者都填时优先用 URL。导入会按节点链接去重，已存在的不会重复添加。</div>',
      onOk: function () {
        var text = ($("#fText").value || "").trim();
        var url = ($("#fUrl").value || "").trim();
        if (!text && !url) { toast("粘贴内容或填 URL", "bad"); return false; }
        var btn = $("#modalOk");
        btn.disabled = true;
        btn.textContent = "导入中…";
        var payload = url ? { url: url } : { text: text };
        api("/api/import", { method: "POST", body: payload }).then(function (j) {
          return api("/api/store", { method: "GET" }).then(function (s) {
            state.nodes = s.nodes || [];
            state.dirty = false;
            closeModal();
            render();
            setSaveState("saved", new Date().toLocaleTimeString());
            toast("解析 " + j.parsed + " 条，新增 " + j.added + "，更新 " + j.updated, "ok");
          });
        }).catch(function (err) {
          btn.disabled = false;
          btn.textContent = "导入";
          toast("导入失败：" + err.message, "bad");
        });
        return false;
      }
    });
  }

  function deleteNode(node) {
    if (!confirm("删除节点「" + (node.name || "未命名") + "」？")) return;
    var i = state.nodes.indexOf(node);
    if (i >= 0) state.nodes.splice(i, 1);
    render();
    markDirty();
    toast("已删除", "ok");
  }

  function moveNode(node, dir) {
    var i = state.nodes.indexOf(node);
    var j = i + dir;
    if (i < 0 || j < 0 || j >= state.nodes.length) return;
    var tmp = state.nodes[i];
    state.nodes[i] = state.nodes[j];
    state.nodes[j] = tmp;
    render();
    markDirty();
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    $("#list").addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("button") : null;
      if (!btn) return;
      var row = btn.closest(".row");
      if (!row) return;
      var node = findNode(row.getAttribute("data-id"));
      if (!node) return;
      var act = btn.getAttribute("data-act");
      if (act === "toggle") {
        node.enabled = node.enabled === false ? true : false;
        render(); markDirty();
      } else if (act === "up") { moveNode(node, -1); }
      else if (act === "down") { moveNode(node, 1); }
      else if (act === "edit") { editNode(node); }
      else if (act === "del") { deleteNode(node); }
    });

    $("#list").addEventListener("input", function (e) {
      var t = e.target;
      if (!t.getAttribute || t.getAttribute("data-act") !== "name") return;
      var row = t.closest(".row");
      if (!row) return;
      var node = findNode(row.getAttribute("data-id"));
      if (!node) return;
      node.name = t.value;
      markDirty();
    });

    $("#linksPanel").addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("button[data-copy]") : null;
      if (!btn) return;
      var val = btn.getAttribute("data-copy");
      copyText(val, btn);
    });

    $("#search").addEventListener("input", function (e) {
      state.filter = e.target.value;
      render();
    });

    $("#btnAdd").addEventListener("click", addNode);
    $("#btnImport").addEventListener("click", importModal);

    $("#btnLinks").addEventListener("click", function () {
      var p = $("#linksPanel");
      p.classList.toggle("hidden");
      if (!p.classList.contains("hidden")) renderLinks();
    });

    $("#btnLogout").addEventListener("click", function () {
      api("/api/logout", { method: "POST" }).then(function () {
        location.reload();
      }).catch(function () { location.reload(); });
    });

    $("#modalClose").addEventListener("click", closeModal);
    $("#modalCancel").addEventListener("click", closeModal);
    $("#modal").addEventListener("click", function (e) {
      if (e.target === $("#modal")) closeModal();
    });
    $("#modalOk").addEventListener("click", function () {
      if (!modalHandler) { closeModal(); return; }
      var r = modalHandler();
      if (r !== false) { /* handler 自己负责关闭 */ }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !$("#modal").classList.contains("hidden")) closeModal();
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        clearTimeout(state.saveTimer);
        doSave();
      }
    });
    window.addEventListener("beforeunload", function (e) {
      if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
    });

    $("#loginForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var token = $("#loginToken").value;
      if (!token) return;
      var btn = $("#loginForm button");
      btn.disabled = true;
      btn.textContent = "验证中…";
      api("/api/login", { method: "POST", body: { token: token } }).then(function () {
        $("#loginErr").textContent = "";
        boot();
      }).catch(function (err) {
        $("#loginErr").textContent = err.message;
        btn.disabled = false;
        btn.textContent = "进入";
        $("#loginToken").select();
      });
    });
  }

  function copyText(text, btn) {
    function done() {
      var old = btn.textContent;
      btn.textContent = "已复制";
      setTimeout(function () { btn.textContent = old; }, 1200);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else {
      fallback();
    }
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch (err) { toast("复制失败，请手动选中", "bad"); }
      document.body.removeChild(ta);
    }
  }

  /* ---------------- 启动 ---------------- */
  function showLogin(msg) {
    $("#appView").classList.add("hidden");
    $("#loginView").classList.remove("hidden");
    if (msg) $("#loginErr").textContent = msg;
    var inp = $("#loginToken");
    if (inp) inp.focus();
  }

  function boot() {
    $("#loginView").classList.add("hidden");
    $("#appView").classList.remove("hidden");
    setSaveState("saving");
    Promise.all([
      api("/api/store", { method: "GET" }),
      api("/api/meta", { method: "GET" }).catch(function () { return {}; })
    ]).then(function (res) {
      var store = res[0];
      var meta = res[1] || {};
      state.nodes = store.nodes || [];
      state.subToken = !!meta.hasSubToken;
      state.dirty = false;
      render();
      if (store.updatedAt) {
        setSaveState("saved", new Date(store.updatedAt).toLocaleString());
      } else {
        setSaveState("idle");
      }
    }).catch(function (err) {
      if (err.status === 401) showLogin("");
      else showLogin("加载失败：" + err.message);
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    bind();
    boot();
  });
})();
</script>
</body>
</html>`;

/* ============================== 入口 ============================== */

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
            'access-control-allow-headers': 'content-type,authorization,x-admin-token,x-sub-token',
            'access-control-max-age': '86400',
          },
        });
      }

      if (path.startsWith('/api/')) return await handleApi(req, env, url, ctx);

      if (path === '/sub' || path.startsWith('/sub/')) return await handleSub(req, env, url);

      if (path === '/admin') {
        // 允许 /admin?token=xxx 一次性登录：写入 Cookie 后重定向到干净的 /admin
        const q = url.searchParams.get('token');
        if (q && env.ADMIN_TOKEN && safeEqual(q, env.ADMIN_TOKEN)) {
          const secure = url.protocol === 'https:';
          const clean = new URL(url.toString());
          clean.searchParams.delete('token');
          return new Response(null, {
            status: 302,
            headers: {
              location: clean.pathname + (clean.search || ''),
              'set-cookie': sessionCookie(env.ADMIN_TOKEN, secure),
            },
          });
        }
        return htmlResponse(ADMIN_HTML, 200);
      }

      if (path === '/health') {
        return jsonResponse({ ok: true, ts: new Date().toISOString() });
      }

      if (path === '/' || path === '/index.html') {
        return htmlResponse(HOME_HTML, 200);
      }

      return textResponse('Not Found', 404);
    } catch (err) {
      return jsonResponse(
        { ok: false, error: String(err && err.message ? err.message : err) },
        500
      );
    }
  },
};
