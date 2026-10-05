/**
 * 基础 HTTP 工具层：响应封装、CORS、错误码、哈希、请求参数解析
 *
 * 本模块不依赖任何外部包，仅使用 Web 标准 API（Cloudflare Workers / Pages Functions 可用）。
 * 所有 /api/* 函数共用此层，保证错误码、响应头与安全头完全一致。
 */

/* ------------------------------------------------------------------ */
/* 1. 错误码字典（接口契约文档与本文件必须保持一致）                    */
/* ------------------------------------------------------------------ */

export const ERR = {
  BAD_REQUEST: 'bad_request',
  BAD_JSON: 'bad_json',
  BAD_MESSAGES: 'bad_messages',
  INVALID_VISITOR: 'invalid_visitor',
  TOKEN_REQUIRED: 'token_required',
  TOKEN_INVALID: 'token_invalid',
  TOKEN_EXPIRED: 'token_expired',
  TOKEN_REPLAYED: 'token_replayed',
  FORBIDDEN: 'forbidden',
  FORBIDDEN_ORIGIN: 'forbidden_origin',
  UNAUTHORIZED: 'unauthorized',
  NOT_FOUND: 'not_found',
  METHOD_NOT_ALLOWED: 'method_not_allowed',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  MODEL_NOT_ALLOWED: 'model_not_allowed',
  TIER_UNKNOWN: 'tier_unknown',
  PROVIDER_UNKNOWN: 'provider_unknown',
  FEATURE_DISABLED: 'feature_disabled',
  RATE_LIMITED: 'rate_limited',
  UPSTREAM_ERROR: 'upstream_error',
  UPSTREAM_TIMEOUT: 'upstream_timeout',
  DEGRADED: 'degraded',
  MAINTENANCE: 'maintenance',
  WRITE_DISABLED: 'write_disabled',
  INTERNAL: 'internal_error',
  NOT_CONFIGURED: 'not_configured',
  QUOTA_EXHAUSTED: 'quota_exhausted',
  /** 旗舰档（kimi-k3）每日额度用尽（前端按 /quota|exceed/i 识别，并置 __aiQuotaExceeded） */
  QUOTA_EXCEEDED: 'quota_exceeded'
};

/** 面向用户的统一错误文案（避免把内部细节暴露给前端） */
export const ERR_TEXT = {
  bad_request: '请求参数不合法',
  bad_json: '请求体不是合法 JSON',
  bad_messages: 'messages 字段不合法',
  invalid_visitor: '缺少有效的访客标识',
  token_required: '缺少短期令牌，请先调用 /api/token 获取',
  token_invalid: '短期令牌无效',
  token_expired: '短期令牌已过期，请重新获取',
  token_replayed: '短期令牌已被使用（一次性令牌不可重复使用）',
  forbidden_origin: '请求来源不在白名单',
  unauthorized: '管理员凭据缺失或不正确',
  not_found: '资源不存在',
  method_not_allowed: '请求方法不被支持',
  payload_too_large: '请求体过大',
  model_not_allowed: '模型不在白名单内',
  tier_unknown: '未知的分档标识',
  provider_unknown: '未知的上游标识（可选值：kimi / zhipu，缺省为 kimi）',
  feature_disabled: '该功能已被服务端关闭',
  rate_limited: '调用过于频繁，请稍后重试',
  upstream_error: '上游模型服务异常',
  upstream_timeout: '上游模型服务超时',
  degraded: 'AI 服务暂时不可用，已返回兜底内容',
  maintenance: 'AI 服务维护中',
  write_disabled: '本接口为只读接口，写入已关闭',
  internal_error: '服务内部错误',
  not_configured: '该能力尚未完成配置',
  quota_exhausted: '上游模型额度不足，请联系站点管理员',
  quota_exceeded: '今日旗舰模式（kimi-k3）额度已用完，请改用快速回答 / 深度思考，或等待次日重置'
};

/* ------------------------------------------------------------------ */
/* 2. 响应构造                                                          */
/* ------------------------------------------------------------------ */

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN'
};

export function withSecurity(headers) {
  return Object.assign({}, SECURITY_HEADERS, headers || {});
}

export function jsonResponse(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: withSecurity(Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {}))
  });
}

export function ok(data, headers) {
  return jsonResponse(Object.assign({ ok: true }, data || {}), 200, headers);
}

export function fail(code, message, status, headers, extra) {
  return jsonResponse(
    Object.assign(
      {
        ok: false,
        error: code,
        message: message || ERR_TEXT[code] || '请求处理失败'
      },
      extra || {}
    ),
    status || 400,
    headers
  );
}

export function textResponse(text, status, headers) {
  return new Response(text, {
    status: status || 200,
    headers: withSecurity(Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, headers || {}))
  });
}

export function csvResponse(csv, filename, headers) {
  return new Response('\ufeff' + csv, {
    status: 200,
    headers: withSecurity(
      Object.assign(
        {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="' + (filename || 'export.csv') + '"',
          'Cache-Control': 'no-store'
        },
        headers || {}
      )
    )
  });
}

export function methodNotAllowed(allowed, headers) {
  return fail(ERR.METHOD_NOT_ALLOWED, '请使用 ' + (allowed || []).join(' / ') + ' 调用本接口', 405,
    Object.assign({ Allow: (allowed || []).join(', ') }, headers || {}));
}

/* ------------------------------------------------------------------ */
/* 3. 参数解析                                                          */
/* ------------------------------------------------------------------ */

export function parseList(value) {
  if (!value) return [];
  return String(value).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

export function toInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  var n = parseInt(value, 10);
  return isNaN(n) ? fallback : n;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return !!fallback;
  var s = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].indexOf(s) >= 0) return true;
  if (['0', 'false', 'no', 'off'].indexOf(s) >= 0) return false;
  return !!fallback;
}

/** 折叠空白、去首尾，用于缓存指纹归一化与关键词提取 */
export function normalizeText(input) {
  return String(input === undefined || input === null ? '' : input)
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncate(input, max) {
  var s = String(input === undefined || input === null ? '' : input);
  return s.length > max ? s.slice(0, max) : s;
}

/* ------------------------------------------------------------------ */
/* 4. 哈希与随机 ID                                                     */
/* ------------------------------------------------------------------ */

export async function sha256Hex(input) {
  var data = new TextEncoder().encode(String(input));
  var digest = await crypto.subtle.digest('SHA-256', data);
  var bytes = new Uint8Array(digest);
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/** 对外展示与入库一律使用加盐哈希前 32 位，绝不落明文 IP / 访客 ID */
export async function hashId(raw, env) {
  if (!raw) return 'none';
  var salted = ((env && env.AI_HASH_SALT) || 'marvis-ai') + '|' + raw;
  try {
    return (await sha256Hex(salted)).slice(0, 32);
  } catch (e) {
    return (await sha256Hex(raw)).slice(0, 32);
  }
}

export function newRequestId(prefix) {
  var rand = '';
  try {
    var buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    for (var i = 0; i < buf.length; i++) rand += buf[i].toString(16).padStart(2, '0');
  } catch (e) {
    rand = Math.random().toString(16).slice(2, 18);
  }
  return (prefix || 'req') + '_' + Date.now().toString(36) + '_' + rand;
}

export function base64UrlEncode(bytes) {
  var bin = '';
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlEncodeString(str) {
  return base64UrlEncode(new TextEncoder().encode(str));
}

export function base64UrlDecodeToBytes(str) {
  var s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) s += '=';
  var bin = atob(s);
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function base64UrlDecodeToString(str) {
  return new TextDecoder().decode(base64UrlDecodeToBytes(str));
}

/* ------------------------------------------------------------------ */
/* 5. 访客标识与客户端 IP                                               */
/* ------------------------------------------------------------------ */

/** 访客 ID 规范：8~64 位字母、数字、下划线、短横线 */
export function isValidVisitorId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);
}

export function readCookie(request, name) {
  var cookie = request.headers.get('Cookie') || '';
  var m = cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  if (!m || !m[1]) return '';
  try {
    return decodeURIComponent(m[1]);
  } catch (e) {
    return m[1];
  }
}

/** 从中间件注入的 context.data → 请求头 → Cookie 三级回退读取访客 ID */
export function resolveVisitorId(request, context, cookieName) {
  var fromCtx = context && context.data ? context.data.visitorId : '';
  if (isValidVisitorId(fromCtx)) return fromCtx;
  var fromHeader = request.headers.get('X-Visitor-Id') || '';
  if (isValidVisitorId(fromHeader)) return fromHeader;
  var fromCookie = readCookie(request, cookieName || 'ai_vid');
  return isValidVisitorId(fromCookie) ? fromCookie : '';
}

export function getClientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Real-IP') ||
    (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() ||
    '0.0.0.0'
  );
}

/* ------------------------------------------------------------------ */
/* 6. CORS 白名单                                                       */
/* ------------------------------------------------------------------ */

function defaultOriginAllowed(origin, env) {
  try {
    var u = new URL(origin);
    if (u.protocol !== 'https:') return false;
    var host = u.hostname;
    var extra = parseList(env && env.AI_EXTRA_ORIGIN_SUFFIX);
    for (var i = 0; i < extra.length; i++) {
      if (host === extra[i] || host.slice(-(extra[i].length + 1)) === '.' + extra[i]) return true;
    }
    return host === 'henry126923.pages.dev' || /\.henry126923\.pages\.dev$/.test(host);
  } catch (e) {
    return false;
  }
}

/**
 * 解析 CORS。
 * 返回 { ok, hasOrigin, origin, headers }；ok=false 表示来源不在白名单，调用方应返回 403。
 */
export function resolveCors(request, env, options) {
  var opts = options || {};
  var methods = opts.methods || 'GET, POST, OPTIONS';
  var headersAllow = opts.headers || 'Content-Type, X-Visitor-Id, X-AI-Token, X-Requested-With, Authorization';
  var origin = request.headers.get('Origin') || '';
  var allowList = parseList(env && env.AI_ALLOWED_ORIGINS);
  var allowed = false;

  if (origin) {
    allowed = allowList.indexOf(origin) >= 0 || defaultOriginAllowed(origin, env);
  }

  var headers = {
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': headersAllow,
    'Access-Control-Max-Age': '86400',
    'Access-Control-Expose-Headers':
      'X-Request-Id, X-AI-Model, X-AI-Tier, X-AI-Provider, X-AI-Route, X-AI-Cache, X-AI-RAG, X-AI-Degraded, X-AI-Cost, X-AI-Latency, ' +
      'X-AI-Quota-Tier, X-AI-Quota-Limit, X-AI-Quota-Used, X-AI-Quota-Remaining, X-AI-Quota-Reset',
    'Vary': 'Origin'
  };
  if (allowed) headers['Access-Control-Allow-Origin'] = origin;

  return { ok: origin ? allowed : false, hasOrigin: !!origin, origin: origin, headers: headers };
}

/** 无 Origin（同源 / 非浏览器请求）时用 Referer 兜底判断，返回 null 表示无法判断 */
export function refererAllowed(request, env) {
  var referer = request.headers.get('Referer') || '';
  if (!referer) return null;
  try {
    var refOrigin = new URL(referer).origin;
    var allowList = parseList(env && env.AI_ALLOWED_ORIGINS);
    return allowList.indexOf(refOrigin) >= 0 || defaultOriginAllowed(refOrigin, env);
  } catch (e) {
    return false;
  }
}

export function corsPreflight(request, env, options) {
  var cors = resolveCors(request, env, options);
  return new Response(null, { status: 204, headers: withSecurity(cors.headers) });
}

/* ------------------------------------------------------------------ */
/* 7. 请求体读取（含体积上限）                                          */
/* ------------------------------------------------------------------ */

/**
 * 读取并解析 JSON 请求体（带体积上限）。
 *
 * 返回体同时兼容两种历史调用约定，避免调用方判空写法不一致：
 *   成功：{ ok: true,  data, body }              —— data 与 body 同值
 *   失败：{ ok: false, error, message, detail, status }
 * status 为建议 HTTP 状态码（413 体积超限 / 400 其他）。
 */
export async function readJsonBody(request, maxBytes) {
  var raw = '';
  try {
    raw = await request.text();
  } catch (e) {
    return bodyFail(ERR.BAD_REQUEST, '请求体读取失败');
  }
  var limit = maxBytes || 256 * 1024;
  if (raw.length > limit) {
    return bodyFail(ERR.PAYLOAD_TOO_LARGE, '请求体过大（上限 ' + Math.round(limit / 1024) + ' KB）');
  }
  if (!raw) return { ok: true, data: {}, body: {} };
  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return bodyFail(ERR.BAD_JSON, ERR_TEXT.bad_json);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return bodyFail(ERR.BAD_REQUEST, '请求体必须是 JSON 对象');
  }
  return { ok: true, data: parsed, body: parsed };
}

function bodyFail(code, message) {
  return {
    ok: false,
    error: code,
    message: message,
    detail: message,
    status: code === ERR.PAYLOAD_TOO_LARGE ? 413 : 400
  };
}

/* ------------------------------------------------------------------ */
/* 8. 管理端鉴权                                                        */
/* ------------------------------------------------------------------ */

/**
 * 管理端令牌校验。支持两种传法：
 *   Authorization: Bearer <ADMIN_TOKEN>
 *   X-Admin-Token: <ADMIN_TOKEN>
 * 使用常量时间比较，避免时序侧信道。
 */
export function checkAdminToken(request, env) {
  var expected = env && env.ADMIN_TOKEN;
  if (!expected) return { ok: false, configured: false, reason: ERR.NOT_CONFIGURED };
  var auth = request.headers.get('Authorization') || '';
  var bearer = auth.indexOf('Bearer ') === 0 ? auth.slice(7).trim() : '';
  var provided = bearer || request.headers.get('X-Admin-Token') || '';
  if (!provided) return { ok: false, configured: true, reason: ERR.UNAUTHORIZED };
  return { ok: timingSafeEqual(provided, expected), configured: true, reason: ERR.UNAUTHORIZED };
}

export function timingSafeEqual(a, b) {
  var sa = String(a);
  var sb = String(b);
  var len = Math.max(sa.length, sb.length);
  var diff = sa.length === sb.length ? 0 : 1;
  for (var i = 0; i < len; i++) {
    var ca = i < sa.length ? sa.charCodeAt(i) : 0;
    var cb = i < sb.length ? sb.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

/* ------------------------------------------------------------------ */
/* 9. 定时/时间工具                                                     */
/* ------------------------------------------------------------------ */

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export function dayString(ts) {
  var d = ts ? new Date(ts * 1000) : new Date();
  var m = String(d.getUTCMonth() + 1).padStart(2, '0');
  var day = String(d.getUTCDate()).padStart(2, '0');
  return d.getUTCFullYear() + '-' + m + '-' + day;
}

/** 带超时的 fetch 包装：返回 { ok, response, timedOut, error } */
export async function fetchWithTimeout(url, init, timeoutMs) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  try {
    var merged = Object.assign({}, init || {}, { signal: controller.signal });
    var res = await fetch(url, merged);
    clearTimeout(timer);
    return { ok: true, response: res };
  } catch (err) {
    clearTimeout(timer);
    var aborted = err && (err.name === 'AbortError' || /abort/i.test(String(err.message || '')));
    return { ok: false, timedOut: aborted, error: (err && err.message) || 'fetch failed' };
  }
}
