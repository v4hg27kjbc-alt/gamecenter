/**
 * 短期令牌（Short-Lived Token）服务
 *
 * 目的：前端不持有任何长期密钥。前端只用「访客 ID」向 /api/token 换取短时令牌，
 *       再用该令牌调用 /api/chat。令牌与访客绑定、限时限次、可一次性消费。
 *
 * 令牌结构（三段式，点分隔）：
 *   v1.<base64url(payload JSON)>.<base64url(HMAC-SHA256(payloadB64, secret))>
 *
 * payload 字段：
 *   v  访客 ID 哈希前 12 位（绑定访客，防令牌转移他人使用）
 *   s  scope，如 chat / photo（限定用途）
 *   e  过期时间（Unix 秒）
 *   i  签发时间（Unix 秒）
 *   n  随机 nonce（一次性消费判重使用）
 *   t  允许的最高档位（可选，如 light；缺省按服务端路由规则）
 *   f  允许的功能标识（可选，逗号分隔；缺省不限制）
 *
 * 安全约束：
 *   1) 密钥取自 Secret 环境变量 TOKEN_SECRET；未配置时回落到 AI_HASH_SALT 派生，
 *      功能可用但安全性下降，部署检查会给出告警（见 /api/health 的 tokenSecretConfigured）。
 *   2) 令牌不含任何密钥、访客原文、IP 原文，仅含哈希片段。
 *   3) 签名校验使用常量时间比较；过期判定以服务端时间为准。
 *   4) AI_TOKEN_ONETIME=1 时，令牌使用一次后写入 KV 标记，重复使用返回 token_replayed。
 */

import {
  ERR,
  base64UrlEncodeString,
  base64UrlDecodeToString,
  base64UrlEncode,
  base64UrlDecodeToBytes,
  hashId,
  isValidVisitorId,
  resolveVisitorId,
  timingSafeEqual,
  nowSec,
  newRequestId,
  fail
} from './http.js';

export const TOKEN_VERSION = 'v1';
export const DEFAULT_TOKEN_TTL = 600;      // 默认 10 分钟
export const MAX_TOKEN_TTL = 3600;         // 最长 1 小时
export const TOKEN_SCOPES = ['chat', 'photo', 'story', 'compare', 'translate', 'summary', 'glossary', 'vision'];

/** 模块级 HMAC key 缓存（同一 Worker 实例内复用，避免重复 importKey） */
var keyCache = {};

export function tokenSecretInfo(env) {
  var e = env || {};
  if (e.TOKEN_SECRET) return { secret: String(e.TOKEN_SECRET), weak: false, source: 'TOKEN_SECRET' };
  if (e.AI_HASH_SALT) return { secret: 'fallback|' + String(e.AI_HASH_SALT), weak: true, source: 'AI_HASH_SALT' };
  return { secret: 'fallback|marvis-ai', weak: true, source: 'builtin-default' };
}

async function getHmacKey(secret) {
  if (keyCache[secret]) return keyCache[secret];
  var key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  keyCache[secret] = key;
  return key;
}

async function sign(payloadB64, secret) {
  var key = await getHmacKey(secret);
  var sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  return base64UrlEncode(new Uint8Array(sig));
}

export function visitorFingerprint(visitorId) {
  // 令牌内只放访客哈希前 12 位，避免令牌被解码后反推访客 ID
  return hashId(visitorId, { AI_HASH_SALT: 'token-visitor' }).then(function (h) { return h.slice(0, 12); });
}

/**
 * 签发短期令牌。
 * @param {object} env
 * @param {object} opts { visitorId, scope, ttl, tier, features }
 * @returns {Promise<{ok:boolean, token?:string, expiresIn?:number, exp?:number, scope?:string, reason?:string}>}
 */
export async function issueToken(env, opts) {
  var o = opts || {};
  var visitorId = o.visitorId;
  if (!isValidVisitorId(visitorId)) return { ok: false, reason: ERR.INVALID_VISITOR };

  var scope = o.scope && TOKEN_SCOPES.indexOf(o.scope) >= 0 ? o.scope : 'chat';
  var ttl = Math.min(MAX_TOKEN_TTL, Math.max(60, parseInt(o.ttl, 10) || DEFAULT_TOKEN_TTL));
  var info = tokenSecretInfo(env);
  var iat = nowSec();
  var exp = iat + ttl;

  var payload = {
    v: await visitorFingerprint(visitorId),
    s: scope,
    e: exp,
    i: iat,
    n: newRequestId('n').slice(-16)
  };
  if (o.tier) payload.t = String(o.tier);
  if (o.features) payload.f = String(o.features);

  var payloadB64 = base64UrlEncodeString(JSON.stringify(payload));
  var sig = await sign(payloadB64, info.secret);

  return {
    ok: true,
    token: TOKEN_VERSION + '.' + payloadB64 + '.' + sig,
    expiresIn: ttl,
    exp: exp,
    issuedAt: iat,
    scope: scope,
    keySource: info.source,
    keyWeak: info.weak
  };
}

/**
 * 校验短期令牌。
 * @param {object} env
 * @param {string} token
 * @param {object} opts { scope, visitorId }
 * @returns {Promise<{ok:boolean, payload?:object, reason?:string}>}
 */
export async function verifyToken(env, token, opts) {
  var o = opts || {};
  if (!token || typeof token !== 'string') return { ok: false, reason: ERR.TOKEN_REQUIRED };

  var parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return { ok: false, reason: ERR.TOKEN_INVALID };

  var payloadB64 = parts[1];
  var sig = parts[2];
  var info = tokenSecretInfo(env);
  var expectSig;
  try {
    expectSig = await sign(payloadB64, info.secret);
  } catch (e) {
    return { ok: false, reason: ERR.TOKEN_INVALID };
  }
  if (!timingSafeEqual(sig, expectSig)) return { ok: false, reason: ERR.TOKEN_INVALID };

  var payload = null;
  try {
    payload = JSON.parse(base64UrlDecodeToString(payloadB64));
  } catch (e) {
    return { ok: false, reason: ERR.TOKEN_INVALID };
  }
  if (!payload || typeof payload !== 'object') return { ok: false, reason: ERR.TOKEN_INVALID };

  if (!payload.e || payload.e < nowSec()) return { ok: false, reason: ERR.TOKEN_EXPIRED };
  if (o.scope && payload.s !== o.scope && payload.s !== '*') return { ok: false, reason: ERR.TOKEN_INVALID };

  if (o.visitorId) {
    var fp = await visitorFingerprint(o.visitorId);
    if (payload.v && payload.v !== fp) return { ok: false, reason: ERR.TOKEN_INVALID };
  }

  return { ok: true, payload: payload };
}

/**
 * 一次性消费：AI_TOKEN_ONETIME=1 时防止令牌被重放。
 * 未绑定 KV 时自动跳过（不阻塞主流程）。
 */
export async function consumeToken(env, payload) {
  if (!env || env.AI_TOKEN_ONETIME !== '1') return { ok: true, skipped: true };
  var kv = env.AI_RATE_KV;
  if (!kv || typeof kv.get !== 'function' || !payload || !payload.n) return { ok: true, skipped: true };
  var key = 'tk:used:' + payload.n;
  try {
    var seen = await kv.get(key);
    if (seen) return { ok: false, reason: ERR.TOKEN_REPLAYED };
    var ttl = Math.max(60, (payload.e || nowSec() + 600) - nowSec() + 60);
    await kv.put(key, '1', { expirationTtl: ttl });
    return { ok: true };
  } catch (e) {
    return { ok: true, skipped: true };
  }
}

/**
 * 校验短期令牌并消费（一次性模式）。返回统一结构，便于各接口直接使用。
 */
export async function requireToken(request, context, opts) {
  var o = opts || {};
  var token = request.headers.get('X-AI-Token') || '';
  if (!token && o.allowCookie !== false) {
    var cookie = request.headers.get('Cookie') || '';
    var m = cookie.match(/(?:^|;\s*)ai_token=([^;]+)/);
    if (m && m[1]) token = decodeURIComponent(m[1]);
  }
  var visitorId = resolveVisitorId(request, context);
  var verified = await verifyToken(context.env, token, { scope: o.scope, visitorId: visitorId || undefined });
  if (verified.ok) {
    var consumed = await consumeToken(context.env, verified.payload);
    if (!consumed.ok) return { ok: false, reason: ERR.TOKEN_REPLAYED, visitorId: visitorId };
  }
  return {
    ok: verified.ok,
    reason: verified.reason,
    payload: verified.payload,
    visitorId: visitorId
  };
}

/** 统一的令牌失败响应（含 401 与建议动作） */
export function tokenFailResponse(reason, headers) {
  var status = reason === ERR.TOKEN_REQUIRED ? 401 : 401;
  var map = {
    token_required: '缺少短期令牌，请先 POST /api/token 获取',
    token_invalid: '短期令牌无效或已被篡改',
    token_expired: '短期令牌已过期，请重新获取',
    token_replayed: '短期令牌已被使用，请重新获取',
    invalid_visitor: '缺少有效的访客标识'
  };
  return fail(reason || ERR.TOKEN_INVALID, map[reason] || '令牌校验失败', status, headers, { action: 'POST /api/token' });
}

export { base64UrlDecodeToBytes };
