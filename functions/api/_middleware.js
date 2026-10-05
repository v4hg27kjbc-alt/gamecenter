/**
 * Cloudflare Pages Functions 中间件 —— /api/* 统一入口（v2.0.0）
 * 项目：民航客机收藏馆（henry126923）
 *
 * 相对 v1（仅保护 /api/ai）的扩展：
 *   1. 严格保护路径由单点扩展为集合：/api/ai、/api/chat、/api/token、/api/prewarm
 *      —— 这些接口会消耗上游额度，必须携带有效访客标识。
 *   2. 只读与公开接口（/api/health、/api/data、/api/aircraft、/api/glossary）只做
 *      体积限制 + 全局限流 + 安全头，不再强制访客标识，避免首次访问 400 拦截。
 *   3. 管理端路径 /api/admin/* 增加「口令存在性预检」（无口令直接 401，不进入业务函数，
 *      减少无效计算；口令正确性仍由各管理端函数二次校验，中间件不接触密钥比较逻辑）。
 *   4. 请求体上限改为可配置 AI_MAX_BODY_BYTES（默认 2MB，与业务层一致）。
 *
 * 环境变量：
 *   AI_RATE_KV               【KV 绑定】边缘限流计数器（缺失时自动跳过节流）
 *   AI_ALLOWED_ORIGINS       【选填】CORS 白名单，逗号分隔；未配置时按默认同站规则
 *   AI_MAX_BODY_BYTES        【选填】请求体上限，默认 2097152（2MB）
 *   MW_IP_PER_MIN / MW_IP_PER_DAY  【选填】/api/* 全局限流（默认 120/分钟、3000/天；设 0 关闭）
 *   MW_BLOCK_UA              【选填】=1 时拦截常见脚本 UA
 *   AI_STRICT_ORIGIN         【选填】=1 时无 Origin 且无 Referer 的请求直接 403
 *   MW_DEBUG                 【选填】=1 时响应头带诊断信息
 *   AI_ADMIN_TOKEN           【Secret】管理端口令（仅做存在性预检）
 */

const STRICT_PATHS = [
  '/api/ai',
  '/api/chat',
  '/api/token',
  '/api/prewarm',
  '/api/ai/',
  '/api/chat/',
  '/api/token/',
  '/api/prewarm/'
];

const ADMIN_PREFIX = '/api/admin/';

const UA_BLOCKLIST = [
  'curl/', 'wget/', 'python-requests', 'python-urllib', 'aiohttp',
  'scrapy', 'okhttp', 'java/', 'go-http-client', 'libwww-perl',
  'httpclient', 'axios/', 'node-fetch'
];

function parseList(value) {
  if (!value) return [];
  return String(value).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

function toInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  var n = parseInt(value, 10);
  return isNaN(n) ? fallback : n;
}

function defaultOriginAllowed(origin) {
  try {
    var u = new URL(origin);
    if (u.protocol !== 'https:') return false;
    var host = u.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return true;      // wrangler pages dev
    return host === 'henry126923.pages.dev' || /\.henry126923\.pages\.dev$/.test(host);
  } catch (e) {
    return false;
  }
}

function corsBase(request, env) {
  var origin = request.headers.get('Origin') || '';
  var allowList = parseList(env.AI_ALLOWED_ORIGINS);
  var allowed = !!origin && (allowList.indexOf(origin) >= 0 || defaultOriginAllowed(origin));
  var headers = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Visitor-Id, X-Admin-Token, X-Requested-With',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  if (allowed) headers['Access-Control-Allow-Origin'] = origin;
  return { allowed: allowed, origin: origin, headers: headers };
}

function jsonResponse(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {})
  });
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-AI-Proxy-Version': '2.0.0'
  };
}

function isValidVisitorId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);
}

async function sha256Hex(input) {
  var data = new TextEncoder().encode(input);
  var digest = await crypto.subtle.digest('SHA-256', data);
  var bytes = new Uint8Array(digest);
  var out = '';
  for (var i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out.slice(0, 32);
}

/** 边缘轻量限流：仅 IP 维度，避免单 IP 海刷拖垮 Functions 调用配额 */
async function ipGuard(env, ip, perMin, perDay) {
  var kv = env.AI_RATE_KV;
  if (!kv || typeof kv.get !== 'function') return { ok: true, kvMissing: true };

  var hash;
  try {
    hash = await sha256Hex((env.AI_HASH_SALT || 'marvis-ai') + '|' + ip);
  } catch (e) {
    hash = 'x' + ip.length;
  }

  var now = Date.now();
  var rules = [
    { key: 'mw:ip:m:' + Math.floor(now / 60000) + ':' + hash, limit: perMin, ttl: 120 },
    { key: 'mw:ip:d:' + new Date(now).toISOString().slice(0, 10) + ':' + hash, limit: perDay, ttl: 172800 }
  ];

  var pending = [];
  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    if (!rule.limit || rule.limit <= 0) continue;
    var current = 0;
    try { current = toInt(await kv.get(rule.key), 0); } catch (e) { current = 0; }
    if (current >= rule.limit) return { ok: false, key: rule.key };
    pending.push({ key: rule.key, value: current + 1, ttl: rule.ttl });
  }
  await Promise.all(
    pending.map(function (p) {
      return kv.put(p.key, String(p.value), { expirationTtl: p.ttl }).catch(function () {});
    })
  );
  return { ok: true };
}

function readVisitorId(request) {
  var id = request.headers.get('X-Visitor-Id') || '';
  if (!id) {
    var cookie = request.headers.get('Cookie') || '';
    var m = cookie.match(/(?:^|;\s*)ai_vid=([^;]+)/);
    if (m) {
      try { id = decodeURIComponent(m[1]); } catch (e) { id = m[1]; }
    }
  }
  return id;
}

function readAdminToken(request) {
  var t = request.headers.get('X-Admin-Token') || '';
  if (!t) {
    try {
      t = new URL(request.url).searchParams.get('token') || '';
    } catch (e) {
      t = '';
    }
  }
  return t;
}

export async function onRequest(context) {
  var request = context.request;
  var env = context.env || {};
  var url = new URL(request.url);
  var path = url.pathname;
  var cors = corsBase(request, env);
  var jsonBase = Object.assign({}, cors.headers, securityHeaders());
  var isStrict = STRICT_PATHS.indexOf(path) >= 0;
  var isAdmin = path.indexOf(ADMIN_PREFIX) === 0;

  // ---- 0. 预检请求：中间件直接回应 ----
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: jsonBase });
  }

  // ---- 1. 体积限制 ----
  var maxBytes = toInt(env.AI_MAX_BODY_BYTES, 2 * 1024 * 1024);
  var contentLength = toInt(request.headers.get('Content-Length'), 0);
  if (maxBytes > 0 && contentLength > maxBytes) {
    return jsonResponse(
      { ok: false, error: 'payload_too_large', message: '请求体超过上限 ' + maxBytes + ' 字节' },
      413,
      jsonBase
    );
  }

  // ---- 2. 脚本 UA 拦截（默认关闭） ----
  if (env.MW_BLOCK_UA === '1') {
    var uaRaw = request.headers.get('User-Agent') || '';
    var uaLower = uaRaw.toLowerCase();
    var blocked = UA_BLOCKLIST.some(function (token) { return uaLower.indexOf(token) >= 0; });
    if (!uaRaw || blocked) {
      return jsonResponse({ ok: false, error: 'forbidden_client', message: '客户端不受支持' }, 403, jsonBase);
    }
  }

  // ---- 3. 来源鉴权（仅严格路径强校验；管理端路径始终校验） ----
  if (isStrict || isAdmin) {
    if (cors.origin) {
      if (!cors.allowed) {
        return jsonResponse({ ok: false, error: 'forbidden_origin', message: '请求来源不在白名单' }, 403, jsonBase);
      }
    } else {
      var referer = request.headers.get('Referer') || '';
      var refOk = null;
      if (referer) {
        try {
          var refOrigin = new URL(referer).origin;
          var allowList = parseList(env.AI_ALLOWED_ORIGINS);
          refOk = allowList.indexOf(refOrigin) >= 0 || defaultOriginAllowed(refOrigin);
        } catch (e) {
          refOk = false;
        }
      }
      if (refOk === false) {
        return jsonResponse({ ok: false, error: 'forbidden_origin', message: '请求来源不在白名单' }, 403, jsonBase);
      }
      if (refOk === null && env.AI_STRICT_ORIGIN === '1') {
        return jsonResponse({ ok: false, error: 'forbidden_origin', message: '缺少来源标识' }, 403, jsonBase);
      }
    }
  }

  // ---- 4. IP 维度边缘限流 ----
  var ip =
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For') ||
    '0.0.0.0';
  var guard = await ipGuard(env, ip, toInt(env.MW_IP_PER_MIN, 120), toInt(env.MW_IP_PER_DAY, 3000));
  if (!guard.ok) {
    return jsonResponse(
      { ok: false, error: 'rate_limited', message: '请求过于频繁，请稍后重试' },
      429,
      Object.assign({ 'Retry-After': '60' }, jsonBase)
    );
  }

  // ---- 5. 管理端口令存在性预检（正确性由业务函数校验） ----
  if (isAdmin && !readAdminToken(request)) {
    return jsonResponse(
      { ok: false, error: 'unauthorized', message: '缺少管理员口令（X-Admin-Token 或 ?token=）' },
      401,
      jsonBase
    );
  }

  // ---- 6. 访客标识（仅严格路径强制；/api/token?bootstrap=1 为首次取号通道，须豁免，否则新访客永远拿不到 ID） ----
  var visitorId = readVisitorId(request);
  var isBootstrapEntry =
    request.method === 'GET' && path === '/api/token' && url.searchParams.get('bootstrap') === '1';
  if (isStrict && !isBootstrapEntry && !isValidVisitorId(visitorId)) {
    return jsonResponse(
      {
        ok: false,
        error: 'invalid_visitor',
        message: '缺少有效访客标识（请先调用 /api/token 获取，或携带 X-Visitor-Id）'
      },
      400,
      jsonBase
    );
  }
  if (visitorId && isValidVisitorId(visitorId)) {
    context.data.visitorId = visitorId;
  }

  // ---- 7. 放行到业务函数，并补齐 CORS / 安全头 ----
  var response;
  try {
    response = await context.next();
  } catch (err) {
    return jsonResponse({ ok: false, error: 'internal_error', message: '服务内部异常' }, 500, jsonBase);
  }

  var newHeaders = new Headers(response.headers);
  Object.keys(cors.headers).forEach(function (k) { newHeaders.set(k, cors.headers[k]); });
  var sec = securityHeaders();
  Object.keys(sec).forEach(function (k) { newHeaders.set(k, sec[k]); });
  if (env.MW_DEBUG === '1' && context.data && context.data.visitorId) {
    newHeaders.set('X-AI-Visitor', String(context.data.visitorId).slice(0, 12));
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
}
