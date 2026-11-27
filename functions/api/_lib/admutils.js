/**
 * functions/api/_utils.js
 * 公共工具：跨域处理、管理员鉴权、统一 JSON 响应、请求体解析、字段映射。
 *
 * 注意：Pages Functions 不会把以 "_" 开头的文件注册为路由，
 *      因此本文件只作为模块被其他函数 import，不会暴露成接口。
 */

/** 主站域名（允许跨域访问本接口） */
export const MAIN_SITE_ORIGIN = 'https://henry126923.pages.dev';

/** 管理后台 / API 自身域名：图片等资源直链使用（跨域引用必须绝对地址，相对路径在主站会 404） */
export const API_ORIGIN = 'https://henry126923-admincenter.pages.dev';

/** 允许跨域来源白名单 */
export const ALLOWED_ORIGINS = [
  MAIN_SITE_ORIGIN,
  'https://henry126923-admincenter.pages.dev',
  'http://localhost:8788',
  'http://127.0.0.1:8788',
  'http://localhost:8080',
  'http://127.0.0.1:8080'
];

/** 生成 CORS 响应头 */
export function corsHeaders(request) {
  const origin = (request && request.headers.get('Origin')) || '';
  const allow = ALLOWED_ORIGINS.indexOf(origin) >= 0 ? origin : MAIN_SITE_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token, Accept',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

/** 统一 JSON 响应 */
export function json(data, status = 200, request = null, extraHeaders = null) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  };
  if (request) Object.assign(headers, corsHeaders(request));
  if (extraHeaders && typeof extraHeaders === 'object') Object.assign(headers, extraHeaders);
  return new Response(JSON.stringify(data), { status, headers });
}

/** 统一错误响应（错误兜底：任何异常都返回结构化 JSON，不抛出到边缘） */
export function fail(message, status = 400, request = null, extra = null) {
  const body = { ok: false, error: String(message || '未知错误') };
  if (extra && typeof extra === 'object') Object.assign(body, extra);
  return json(body, status, request);
}

/** OPTIONS 预检：命中时返回 204，否则返回 null */
export function preflight(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  return null;
}

/** 读取请求头里的管理令牌 */
export function adminTokenOf(request) {
  return request.headers.get('X-Admin-Token') || '';
}

/* ==================== 服务端会话（HttpOnly Cookie） ==================== */

/** 会话 Cookie 名 */
export const SESSION_COOKIE = 'mv_admin';

/** 常量时间字符串比较（长度不同直接判定不等） */
function constTimeEqual(a, b) {
  const x = (a === undefined || a === null) ? '' : String(a);
  const y = (b === undefined || b === null) ? '' : String(b);
  if (!x || !y || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** UTF-8 安全的 base64url 编码；异常返回空串 */
function b64urlEncode(str) {
  try {
    const bytes = new TextEncoder().encode(String(str));
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch (e) { return ''; }
}

/** base64url 解码为 UTF-8 字符串；异常返回空串 */
function b64urlDecode(s) {
  try {
    const t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    const pad = t.length % 4 ? new Array(5 - (t.length % 4)).join('=') : '';
    const bin = atob(t + pad);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch (e) { return ''; }
}

/** HMAC-SHA256 → 小写 hex；异常返回空串 */
async function hmacHex(key, msg) {
  try {
    const enc = new TextEncoder();
    const k = await crypto.subtle.importKey(
      'raw', enc.encode(String(key || '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', k, enc.encode(String(msg || '')));
    const b = new Uint8Array(sig);
    let out = '';
    for (let i = 0; i < b.length; i++) out += ('0' + b[i].toString(16)).slice(-2);
    return out;
  } catch (e) { return ''; }
}

/** SHA-256 → 小写 hex；异常返回空串 */
async function sha256Hex(text) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text || '')));
    const b = new Uint8Array(buf);
    let out = '';
    for (let i = 0; i < b.length; i++) out += ('0' + b[i].toString(16)).slice(-2);
    return out;
  } catch (e) { return ''; }
}

/** 读取指定 Cookie 的值；不存在返回空串 */
export function cookieOf(request, name) {
  try {
    const raw = (request && request.headers.get('Cookie')) || '';
    const parts = raw.split(';');
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i].trim();
      if (!p) continue;
      const idx = p.indexOf('=');
      if (idx < 0) continue;
      if (p.slice(0, idx).trim() === name) return p.slice(idx + 1).trim();
    }
  } catch (e) { /* 无 Cookie 头 */ }
  return '';
}

/** 签发会话令牌：base64url(payload) + '.' + hmacHex；密钥取 env.ADMIN_TOKEN，未配置返回空串 */
export async function signSession(env, payload) {
  try {
    const key = (env && env.ADMIN_TOKEN) ? String(env.ADMIN_TOKEN) : '';
    if (!key) return '';
    const body = b64urlEncode(JSON.stringify(payload || {}));
    if (!body) return '';
    const sig = await hmacHex(key, body);
    if (!sig) return '';
    return body + '.' + sig;
  } catch (e) { return ''; }
}

/** 校验会话：签名常量时间比对 + 过期时间判断；失败一律返回 null */
export async function verifySession(request, env) {
  try {
    const key = (env && env.ADMIN_TOKEN) ? String(env.ADMIN_TOKEN) : '';
    if (!key) return null;
    const token = cookieOf(request, SESSION_COOKIE);
    if (!token) return null;
    const dot = token.lastIndexOf('.');
    if (dot <= 0 || dot >= token.length - 1) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expect = await hmacHex(key, body);
    if (!expect || !constTimeEqual(expect, sig)) return null;
    let payload = null;
    try { payload = JSON.parse(b64urlDecode(body)); } catch (e) { payload = null; }
    if (!payload || typeof payload !== 'object') return null;
    const exp = Number(payload.exp || 0);
    if (!exp || exp <= Date.now()) return null;
    return payload;
  } catch (e) { return null; }
}

/** 下发会话 Cookie（默认 7 天） */
export function sessionSetCookie(value, maxAge) {
  const age = (typeof maxAge === 'number' && maxAge > 0) ? Math.floor(maxAge) : 604800;
  return SESSION_COOKIE + '=' + String(value || '')
    + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + age;
}

/** 清除会话 Cookie */
export function sessionClearCookie() {
  return SESSION_COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

/* ==================== 管理员鉴权 ==================== */

/**
 * 管理员鉴权（异步）：
 *   1) 优先校验服务端会话 Cookie（登录后自动签发，前端无需再填令牌）；
 *   2) 会话无效时回退旧的请求头 X-Admin-Token 与 env.ADMIN_TOKEN 比对（备用兼容）。
 * 未配置 ADMIN_TOKEN 时会话与令牌两种方式都无法通过（避免接口裸奔）。
 */
export async function isAdmin(request, env) {
  try {
    const payload = await verifySession(request, env);
    if (payload) return true;
  } catch (e) { /* 会话不可用 → 回退令牌方式 */ }
  const expect = (env && env.ADMIN_TOKEN) ? String(env.ADMIN_TOKEN) : '';
  if (!expect) return false;
  const token = adminTokenOf(request);
  if (!token) return false;
  return constTimeEqual(token, expect);
}

/** 是否已配置任一管理密码来源（KV 的 admin:auth / 环境变量 ADMIN_PASSWORD / 令牌 ADMIN_TOKEN） */
export function adminPasswordConfigured(env) {
  return !!(env && (env.ADMIN_PASSWORD || env.NEWS_KV || env.ADMIN_TOKEN));
}

/**
 * 校验管理员登录凭据。
 * 密码源优先级：
 *   1) KV（NEWS_KV 的 admin:auth，存 { user, salt, hash }，hash = sha256hex(salt + password)）
 *   2) 环境变量 ADMIN_PASSWORD（明文比对）
 *   3) 环境变量 ADMIN_TOKEN（明文比对）—— 即管理令牌本身可直接作为服务端登录密码使用
 * 返回 true（通过）/ false（不通过）/ 'not_configured'（三者都未配置）。
 */
export async function verifyAdminCredentials(env, username, password) {
  try {
    const expectUser = (env && env.ADMIN_USER) ? String(env.ADMIN_USER) : 'henry';
    const name = str(username, 80);
    const pwd = (password === undefined || password === null) ? '' : String(password);
    if (!name || name.toLowerCase() !== expectUser.toLowerCase()) return false;

    // 1) KV 中的密码记录（哈希优先，明文兼容）
    let kvRecord = null;
    try {
      if (env && env.NEWS_KV) {
        const raw = await env.NEWS_KV.get('admin:auth');
        if (raw) { try { kvRecord = JSON.parse(raw); } catch (e) { kvRecord = null; } }
      }
    } catch (e) { kvRecord = null; }

    if (kvRecord && typeof kvRecord === 'object') {
      if (kvRecord.hash) {
        const hash = await sha256Hex(String(kvRecord.salt || '') + pwd);
        return !!hash && constTimeEqual(hash, String(kvRecord.hash));
      }
      if (typeof kvRecord.password === 'string') return constTimeEqual(kvRecord.password, pwd);
    }

    // 2) 回退环境变量明文密码
    if (env && env.ADMIN_PASSWORD) return constTimeEqual(String(env.ADMIN_PASSWORD), pwd);

    // 3) 兜底：KV 与 ADMIN_PASSWORD 均未配置时，管理令牌本身即可作为服务端登录密码
    if (env && env.ADMIN_TOKEN) return constTimeEqual(String(env.ADMIN_TOKEN), pwd);

    // 4) 三者都未配置
    return 'not_configured';
  } catch (e) { return false; }
}

/** 写入 / 更新管理密码（随机 salt + sha256 哈希），成功返回 true */
export async function setAdminPassword(env, username, newPassword) {
  try {
    if (!env || !env.NEWS_KV) return false;
    const pwd = (newPassword === undefined || newPassword === null) ? '' : String(newPassword);
    if (!pwd) return false;
    const saltBytes = new Uint8Array(16);
    crypto.getRandomValues(saltBytes);
    let salt = '';
    for (let i = 0; i < saltBytes.length; i++) salt += ('0' + saltBytes[i].toString(16)).slice(-2);
    const hash = await sha256Hex(salt + pwd);
    if (!hash) return false;
    const rec = {
      user: str(username, 80) || ((env.ADMIN_USER) ? String(env.ADMIN_USER) : 'henry'),
      salt: salt,
      hash: hash,
      updatedAt: new Date().toISOString()
    };
    await env.NEWS_KV.put('admin:auth', JSON.stringify(rec));
    return true;
  } catch (e) { return false; }
}

export function unauthorized(request) {
  return fail('未授权：请先登录后台，或携带正确的 X-Admin-Token', 401, request);
}

export function nowIso() {
  return new Date().toISOString();
}

export function genId(prefix) {
  return (prefix || 'rec') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 读取请求体：兼容 application/json 与纯文本 JSON */
export async function readBody(request) {
  const ct = (request.headers.get('Content-Type') || '').toLowerCase();
  if (ct.indexOf('application/json') >= 0) {
    try { return (await request.json()) || {}; } catch (e) { return {}; }
  }
  try {
    const txt = await request.text();
    if (!txt) return {};
    return JSON.parse(txt);
  } catch (e) {
    return {};
  }
}

/** 字符串清洗：去空白 + 截断 */
export function str(v, max) {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  return (max && s.length > max) ? s.slice(0, max) : s;
}

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/heic': 'heic'
};

/** 解析 dataURL（data:image/jpeg;base64,xxxx）为 { mime, ext, bytes } */
export function parseDataUrl(dataUrl) {
  const s = String(dataUrl || '');
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(s);
  if (!m) return null;
  const mime = (m[1] || 'image/jpeg').toLowerCase();
  const isB64 = !!m[2];
  const payload = m[3] || '';
  const ext = MIME_EXT[mime] || 'jpg';
  if (!isB64) {
    try {
      return { mime, ext, bytes: new TextEncoder().encode(decodeURIComponent(payload)) };
    } catch (e) {
      return null;
    }
  }
  try {
    const bin = atob(payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { mime, ext, bytes };
  } catch (e) {
    return null;
  }
}

/**
 * 图片 key → 可访问的绝对 URL（跨域必需）
 *   - 已是 http(s) 外链 / dataURL：原样返回
 *   - 已是 /api/... 形式：补 API_ORIGIN
 *   - 纯 key（recommend-rec_xxx.jpg）：拼成 API_ORIGIN + /api/image/<key>
 * 注：历史上返回相对路径 /api/image/<key>，主站域名下不存在该路由（会命中整页 HTML），
 *     导致上传的照片在主站显示失败，故统一改为绝对地址。
 */
export function imageUrlOf(imageKey) {
  const k = str(imageKey, 500);
  if (!k) return '';
  if (/^(https?:)?\/\//i.test(k) || /^data:/i.test(k)) return k;
  if (/^\/api\//i.test(k)) return API_ORIGIN + k;
  return API_ORIGIN + '/api/image/' + k.replace(/^\/+/, '');
}

/** D1 中 specs 以 JSON 字符串存储，统一解析为对象返回（前端据此渲染规格表，避免被逐字符拆解成乱码） */
export function parseSpecsField(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return Array.isArray(raw) ? {} : raw;
  const s = String(raw).trim();
  if (!s) return {};
  try {
    const obj = JSON.parse(s);
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  } catch (e) {
    return {};
  }
}

/** airlineIds 字段解析（兼容 JSON 数组字符串 / 逗号分隔字符串） */
export function parseAirlineIds(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((v) => String(v)).filter(Boolean);
  const s = String(raw).trim();
  if (!s) return [];
  if (s.charAt(0) === '[') {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map((v) => String(v)).filter(Boolean);
    } catch (e) { /* 退回逗号分隔解析 */ }
  }
  return s.split(',').map((v) => v.trim()).filter(Boolean);
}

/** D1 行 → 主站/后台通用字段（camelCase） */
export function mapRecommendation(row) {
  if (!row) return null;
  return {
    id: row.id,
    uid: row.uid,
    nameZh: row.nameZh || '',
    code: row.code || '',
    category: row.category || '',
    country: row.country || '',
    image_key: row.image_key || '',
    image: imageUrlOf(row.image_key),
    descZh: row.descZh || '',
    specs: parseSpecsField(row.specs),
    prodDate: row.prodDate || '',
    airlineIds: parseAirlineIds(row.airlineIds),
    submittedAt: row.submitted_at || '',
    status: row.status || 'pending',
    reply: row.reply || '',
    reviewedAt: row.reviewed_at || ''
  };
}

/** 统一异常文本 */
export function errText(err, fallback) {
  return (err && err.message) ? err.message : (fallback || '未知错误');
}

/* ===== v67：反馈联系方式脱敏 + 邮件通知（受理 / 结果两个节点） ===== */

/** 手机号脱敏：138****8888（对已脱敏字符串幂等） */
export function maskPhone(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 7) return digits.slice(0, 3) + '****' + digits.slice(-4);
  if (digits.length >= 2) return digits.charAt(0) + '****' + digits.slice(-1);
  return '****';
}

/** 邮箱脱敏：ab***@example.com（对已脱敏字符串幂等） */
export function maskEmail(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  const at = s.indexOf('@');
  if (at <= 0) return '****';
  const name = s.slice(0, at);
  const domain = s.slice(at);
  if (name.length <= 2) return name.charAt(0) + '***' + domain;
  return name.slice(0, 2) + '***' + domain;
}

/** 邮箱基础格式校验（不依赖外部库） */
export function isEmailLike(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v == null ? '' : v).trim());
}

/** 手机号基础清洗：保留数字与首位 +，其余符号去掉（含空格的国际写法） */
export function normalizePhone(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  return s.replace(/[^\d+]/g, '').slice(0, 20);
}

/** 邮件服务默认参数（环境变量未配置时的兜底） */
export const MAIL_DEFAULTS = {
  endpoint: 'https://api.resend.com/emails',
  from: '民航客机收藏馆 <onboarding@resend.dev>'
};

/**
 * 邮件服务是否可用：
 *   必填 MAIL_API_KEY（邮件服务 Key）；可选 MAIL_ENABLED=off 全局关闭
 *   未配置时返回 false → 调用方跳过发信并记录 notify_status = 'skipped_no_key'
 */
export function mailConfigured(env) {
  if (!env || !env.MAIL_API_KEY) return false;
  const flag = String(env.MAIL_ENABLED || '').trim().toLowerCase();
  if (flag === 'off' || flag === 'false' || flag === '0') return false;
  return true;
}

/**
 * 发送邮件（HTTP API，兼容 Resend 协议）。永不抛异常，统一返回状态对象：
 *   { status: 'sent' | 'failed' | 'skipped_no_key' | 'skipped_no_recipient', message, id }
 * 环境变量：MAIL_API_KEY(必填) / MAIL_API_ENDPOINT(可选) / MAIL_FROM(可选) / MAIL_REPLY_TO(可选)
 */
export async function sendMail(env, opts) {
  const o = opts || {};
  const to = String(o.to || '').trim();
  try {
    if (!to) return { status: 'skipped_no_recipient', message: '收件人为空，已跳过邮件通知', id: '' };
    if (!mailConfigured(env)) {
      return { status: 'skipped_no_key', message: '未配置 MAIL_API_KEY，已跳过邮件通知', id: '' };
    }
    const endpoint = String(env.MAIL_API_ENDPOINT || MAIL_DEFAULTS.endpoint);
    const payload = {
      from: String(env.MAIL_FROM || MAIL_DEFAULTS.from),
      to: [to],
      subject: String(o.subject || '民航客机收藏馆 通知'),
      text: String(o.text || '')
    };
    if (o.html) payload.html = String(o.html);
    if (env.MAIL_REPLY_TO) payload.reply_to = String(env.MAIL_REPLY_TO);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + String(env.MAIL_API_KEY)
      },
      body: JSON.stringify(payload)
    });
    const txt = await res.text().catch(() => '');
    if (!res.ok) {
      return { status: 'failed', message: 'HTTP ' + res.status + ' ' + String(txt).slice(0, 200), id: '' };
    }
    let id = '';
    try { const j = JSON.parse(txt); id = (j && j.id) ? String(j.id) : ''; } catch (e) { id = ''; }
    return { status: 'sent', message: '', id };
  } catch (err) {
    return { status: 'failed', message: errText(err), id: '' };
  }
}

/** 反馈类型白名单 */
export const FEEDBACK_TYPES = ['功能建议', 'Bug 反馈', '内容纠错', '体验优化', '其他'];

/** 反馈邮件正文（受理 / 结果两个节点） */
export function feedbackMailContent(stage, row, reply) {
  const site = '民航客机收藏馆';
  const type = (row && row.type) || '反馈';
  const content = (row && row.content) || '';
  const id = (row && row.id) || '';
  const who = String((row && row.name) || '').trim();   // v68：有姓名时用于邮件称呼
  const hi = '你好' + (who ? '（' + who + '）' : '') + '：';
  if (stage === 'accepted') {
    return {
      subject: '【' + site + '】你的反馈已受理',
      text: hi + '\n\n我们已收到你的反馈，正在处理中。\n\n反馈编号：' + id + '\n反馈类型：' + type + '\n反馈内容：' + content +
        '\n\n处理完成后我们会再次邮件通知你。感谢你的支持！\n\n—— ' + site,
      html: '<p>' + escapeHtml(hi) + '</p><p>我们已收到你的反馈，正在处理中。</p>' +
        '<p><strong>反馈编号：</strong>' + escapeHtml(id) + '<br><strong>反馈类型：</strong>' + escapeHtml(type) +
        '<br><strong>反馈内容：</strong>' + escapeHtml(content) + '</p>' +
        '<p>处理完成后我们会再次邮件通知你。感谢你的支持！</p><p>—— ' + site + '</p>'
    };
  }
  const rep = String(reply || '').trim();
  return {
    subject: '【' + site + '】你的反馈已处理完成',
    text: hi + '\n\n你提交的反馈已处理完成。\n\n反馈编号：' + id + '\n反馈类型：' + type + '\n反馈内容：' + content +
      (rep ? ('\n\n处理回复：' + rep) : '') + '\n\n感谢你的支持！\n\n—— ' + site,
    html: '<p>' + escapeHtml(hi) + '</p><p>你提交的反馈已处理完成。</p>' +
      '<p><strong>反馈编号：</strong>' + escapeHtml(id) + '<br><strong>反馈类型：</strong>' + escapeHtml(type) +
      '<br><strong>反馈内容：</strong>' + escapeHtml(content) + '</p>' +
      (rep ? ('<p><strong>处理回复：</strong>' + escapeHtml(rep) + '</p>') : '') +
      '<p>感谢你的支持！</p><p>—— ' + site + '</p>'
  };
}

/** HTML 文本转义（邮件模板用） */
export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
