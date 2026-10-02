/**
 * Cloudflare Pages Function — /api/token
 * ============================================================
 * 主站 AI 服务端中台（一）：短期令牌签发
 *
 * 契约（与前端 window.AIBridge 对齐，见 index.html 内 AIBridge 模块）：
 *   GET  /api/token?bootstrap=1
 *        -> 下发访客 Cookie(ai_vid)，返回 { ok:true, bootstrapped:true, vid }
 *        前端仅在首次访问时调用一次，用于携带访客标识（限流/去重），不含任何身份信息。
 *
 *   POST /api/token   body: { scope?: 'chat', ttl?: 900, provider?: 'zhipu' | 'kimi' }
 *        -> 200 { ok:true, token, expiresIn, scope, provider, tokenType, upstreamReady }
 *        -> 400 { ok:false, error:'unsupported_provider' }
 *        -> 500 { ok:false, error:'server_misconfigured' }
 *
 * 零前端密钥原则：
 *   本接口【不下发、不携带、不暴露】任何上游 API Key。
 *   返回的 token 是服务端用 AI_TOKEN_SECRET 签发的短期 HMAC-SHA256 令牌
 *   （格式 v1.<base64url(payload)>.<base64url(signature)>），由 /api/chat 校验。
 *   上游密钥只存在于 Cloudflare 环境变量中，且只被 /api/chat 在服务端使用。
 *
 * 环境变量（Cloudflare Pages -> Settings -> Variables and Secrets）：
 *   AI_TOKEN_SECRET   必填，令牌签名密钥，长度 >= 16（建议 openssl rand -base64 48）
 *   ALLOWED_ORIGIN    选填，跨域白名单，逗号分隔；不配置则仅同源可用
 *   ZHIPU_API_KEY     由 /api/chat 使用，本接口仅探测是否已配置（返回 upstreamReady）
 *   KIMI_API_KEY      同上
 * ============================================================
 */

const COOKIE_NAME = 'ai_vid';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 180; // 180 天
const DEFAULT_TTL = 900;                   // 15 分钟（与前端 TOKEN_TTL 一致）
const MAX_TTL = 3600;                      // 服务端上限 1 小时（与前端注释一致）
const TOKEN_VERSION = 'v1';
const ALLOWED_PROVIDERS = ['zhipu', 'kimi'];
const DEFAULT_PROVIDER = 'zhipu';
const MIN_SECRET_LENGTH = 16;

export async function onRequest(context) {
  const { request, env } = context;
  const method = (request.method || 'GET').toUpperCase();
  const cors = corsHeaders(request, env);

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (method === 'GET') {
    return handleBootstrap(request, cors);
  }
  if (method === 'POST') {
    return handleIssue(request, env, cors);
  }
  return respond({ ok: false, error: 'method_not_allowed' }, 405, cors);
}

/* ---------- GET /api/token?bootstrap=1：下发访客 Cookie ---------- */
function handleBootstrap(request, cors) {
  const vid = readCookie(request, COOKIE_NAME) || newVisitorId();
  const headers = new Headers(cors);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('Set-Cookie', cookieHeader(vid));
  return new Response(
    JSON.stringify({ ok: true, bootstrapped: true, vid }),
    { status: 200, headers }
  );
}

/* ---------- POST /api/token：签发短期令牌 ---------- */
async function handleIssue(request, env, cors) {
  const secret = String(env.AI_TOKEN_SECRET || '').trim();
  if (secret.length < MIN_SECRET_LENGTH) {
    return respond({
      ok: false,
      error: 'server_misconfigured',
      detail: 'AI_TOKEN_SECRET 未配置或长度不足 ' + MIN_SECRET_LENGTH
    }, 500, cors);
  }

  let body = {};
  try {
    body = await request.json();
  } catch (_) {
    body = {};
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};

  const scope = (typeof body.scope === 'string' && body.scope.trim())
    ? body.scope.trim().slice(0, 32)
    : 'chat';

  let provider = (typeof body.provider === 'string') ? body.provider.trim().toLowerCase() : '';
  if (!provider || provider === 'auto') provider = DEFAULT_PROVIDER;
  if (ALLOWED_PROVIDERS.indexOf(provider) === -1) {
    return respond({ ok: false, error: 'unsupported_provider', provider }, 400, cors);
  }

  let ttl = Number(body.ttl);
  if (!Number.isFinite(ttl) || ttl <= 0) ttl = DEFAULT_TTL;
  ttl = Math.min(Math.floor(ttl), MAX_TTL);

  const vid = readCookie(request, COOKIE_NAME) || newVisitorId();
  const now = Math.floor(Date.now() / 1000);
  const payload = { vid, scope, provider, iat: now, exp: now + ttl };
  const token = await signToken(payload, secret);

  /* 仅探测上游密钥是否已绑定，绝不返回值本身 */
  const upstreamReady = provider === 'zhipu'
    ? !!String(env.ZHIPU_API_KEY || '').trim()
    : !!String(env.KIMI_API_KEY || '').trim();

  const headers = new Headers(cors);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('Set-Cookie', cookieHeader(vid));

  return new Response(JSON.stringify({
    ok: true,
    token,
    expiresIn: ttl,
    scope,
    provider,
    tokenType: 'hmac-sha256',
    upstreamReady
  }), { status: 200, headers });
}

/* ---------- 令牌签发 ---------- */
async function signToken(payload, secret) {
  const encoded = b64urlFromString(JSON.stringify(payload));
  const signature = await hmacSign(secret, encoded);
  return TOKEN_VERSION + '.' + encoded + '.' + signature;
}

/* ---------- 工具体 ---------- */
function respond(data, status, cors) {
  const headers = new Headers(cors);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { status: status || 200, headers });
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowList = String(env.ALLOWED_ORIGIN || '')
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(Boolean);

  const headers = new Headers();
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, X-AI-Token');
  headers.set('Access-Control-Max-Age', '86400');
  headers.set('Vary', 'Origin');

  if (origin && (allowList.length === 0 || allowList.indexOf(origin) !== -1)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
  }
  return headers;
}

function newVisitorId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.prototype.map.call(bytes, function (b) {
    return b.toString(16).padStart(2, '0');
  }).join('');
}

function readCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  const parts = raw.split(';');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    if (p.slice(0, eq).trim() === name) {
      return decodeURIComponent(p.slice(eq + 1).trim());
    }
  }
  return '';
}

function cookieHeader(vid) {
  return COOKIE_NAME + '=' + encodeURIComponent(vid) +
    '; Path=/; Max-Age=' + COOKIE_MAX_AGE +
    '; HttpOnly; Secure; SameSite=Lax';
}

/* ---------- base64url / HMAC ---------- */
function b64urlFromBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlFromString(str) {
  return b64urlFromBytes(new TextEncoder().encode(str));
}

async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return b64urlFromBytes(new Uint8Array(sig));
}
