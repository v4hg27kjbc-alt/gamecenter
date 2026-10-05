/**
 * 旗舰档（kimi-k3）每日额度模块  v2
 *
 * 目标：旗舰档（tier=flagship 且 provider=kimi，即 kimi-k3）按访客维度做「每自然日 N 次」额度控制，
 *      非旗舰档（light / vision / code、zhipu 上游）不限也不计数。
 *
 * 维度与兜底：
 *   主键 = 访客 ID（ai_vid Cookie / X-Visitor-Id 头，哈希后落库，不存明文）
 *   兜底 = 客户端 IP 哈希（访客 ID 缺失时）
 *
 * 存储（v2 变更，重要）：
 *   主存储 = D1（AI_LOG_DB 已绑定），表 ai_flagship_quota，用原子 UPSERT 计数：
 *       INSERT ... ON CONFLICT(scope_key, day) DO UPDATE SET used = used + 1 WHERE used < limit
 *     —— D1 读写强一致且原子，可保证「同一访客同日第 6 次必被拦截」。
 *   兜底存储 = KV（AI_RATE_KV → AI_CACHE_KV）：D1 未绑定或异常时降级使用（尽力而为）。
 *   KV 仍作为镜像写入（best-effort，失败不影响主流程），保持对既有 KV 绑定的复用。
 *
 *   ⚠️ 为何不以 KV 为主：Cloudflare KV 免费额度为每日 1000 次写入（按账号/命名空间），
 *   且 KV 读有边缘缓存（默认 60s）导致「读-改-写」不可靠。线上实测已出现
 *   "KV put() limit exceeded for the day"，写入静默失败 → 计数不增长、限额形同失效。
 *
 * 计数口径（重要）：
 *   1) 只有「旗舰档 + 真正打到上游并成功返回」才消耗额度；
 *   2) 缓存命中（fingerprint / prewarm）、图片识图档（vision）、降级兜底均不计数；
 *   3) 额度用尽时直接 429 + error=quota_exceeded，绝不静默降级到其它模型；
 *   4) 跨天自动重置：按 UTC 自然日分桶（day 列），TTL/过期由 day 决定，次日自动满额。
 *
 * 环境变量：
 *   AI_FLAGSHIP_QUOTA_ENABLED=0  关闭旗舰额度限制（默认开启）
 *   AI_FLAGSHIP_DAILY_LIMIT      每日次数，默认 5
 */

import { ERR, fail, toInt, hashId, dayString } from './http.js';

export const QUOTA_VERSION = 'v2';
export const QUOTA_KEY_PREFIX = 'ai:k3q:' + QUOTA_VERSION + ':';
export const QUOTA_TABLE = 'ai_flagship_quota';
export const FLAGSHIP_TIER = 'flagship';
export const FLAGSHIP_PROVIDER = 'kimi';
export const FLAGSHIP_MODEL_LABEL = 'kimi-k3';
export const DEFAULT_FLAGSHIP_DAILY_LIMIT = 5;

/** 主存储：D1（强一致、原子计数） */
export function quotaDb(env) {
  var db = env && env.AI_LOG_DB;
  return db && typeof db.prepare === 'function' ? db : null;
}

/** 兜底存储：KV（优先限流 KV，其次缓存 KV） */
export function quotaKv(env) {
  var kv = env && (env.AI_RATE_KV || env.AI_CACHE_KV);
  return kv && typeof kv.get === 'function' && typeof kv.put === 'function' ? kv : null;
}

/** 当前生效的存储类型：d1 优先，其次 kv，都没有则额度控制不可用 */
export function quotaStore(env) {
  if (quotaDb(env)) return 'd1';
  if (quotaKv(env)) return 'kv';
  return 'none';
}

export function flagshipQuotaEnabled(env) {
  if (!env || env.AI_FLAGSHIP_QUOTA_ENABLED === '0') return false;
  return quotaStore(env) !== 'none';
}

export function flagshipDailyLimit(env) {
  var n = toInt(env && env.AI_FLAGSHIP_DAILY_LIMIT, DEFAULT_FLAGSHIP_DAILY_LIMIT);
  return Math.max(1, n);
}

/** 是否旗舰档调用：仅 tier=flagship 且 provider=kimi（缺省 provider 视为 kimi） */
export function isFlagshipRoute(tier, provider) {
  var t = String(tier === undefined || tier === null ? '' : tier).toLowerCase();
  var p = String(provider === undefined || provider === null || provider === '' ? FLAGSHIP_PROVIDER : provider).toLowerCase();
  return t === FLAGSHIP_TIER && p === FLAGSHIP_PROVIDER;
}

/** 访客维度：ai_vid 哈希优先，缺失时用 IP 哈希兜底 */
export async function resolveQuotaScope(env, opts) {
  var o = opts || {};
  if (o.visitorId) return { dim: 'vid', id: await hashId(o.visitorId, env) };
  return { dim: 'ip', id: await hashId(o.ip || '0.0.0.0', env) };
}

function quotaKey(scope, day) {
  return QUOTA_KEY_PREFIX + scope.dim + ':' + scope.id + ':' + day;
}

/** 落库用的维度键（不存明文访客 ID / IP） */
function scopeKey(scope, day) {
  return scope.dim + ':' + scope.id + ':' + day;
}

/** 距次日（UTC）零点的秒数，用于 Retry-After 与 KV TTL */
function secondsToNextUtcDay(nowMs) {
  var now = nowMs || Date.now();
  var d = new Date(now);
  var next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
  return Math.max(60, Math.round((next - now) / 1000));
}

function baseQuota(env, scope, now) {
  var limit = flagshipDailyLimit(env);
  return {
    tier: FLAGSHIP_TIER,
    model: FLAGSHIP_MODEL_LABEL,
    limit: limit,
    used: 0,
    remaining: limit,
    day: dayString(Math.floor(now / 1000)),
    scope: scope && scope.dim ? scope.dim : 'none',
    resetInSec: secondsToNextUtcDay(now),
    scopeDim: scope && scope.dim ? scope.dim : 'none',
    scopeId: scope && scope.id ? scope.id : '',
    store: 'none',
    enabled: false
  };
}

function clampQuota(quota, used) {
  var u = toInt(used, 0);
  if (u < 0) u = 0;
  if (u > quota.limit) u = quota.limit;
  quota.used = u;
  quota.remaining = Math.max(0, quota.limit - u);
  return quota;
}

/** D1 读取当前用量；异常返回 null（调用方决定是否降级） */
async function d1ReadUsed(env, key) {
  var db = quotaDb(env);
  if (!db) return null;
  try {
    var row = await db
      .prepare('SELECT used FROM ' + QUOTA_TABLE + ' WHERE scope_key = ?1 AND day = ?2')
      .bind(key.scopeKey, key.day)
      .first();
    return row ? toInt(row.used, 0) : 0;
  } catch (e) {
    return null;
  }
}

/** KV 读取当前用量 */
async function kvReadUsed(env, key) {
  var kv = quotaKv(env);
  if (!kv) return null;
  try {
    return toInt(await kv.get(key.kvKey, { cacheTtl: 30 }), 0);
  } catch (e) {
    return null;
  }
}

/** KV best-effort 镜像写入：失败不影响主流程（KV 有每日写入上限） */
async function kvMirror(env, key, used, ttl) {
  var kv = quotaKv(env);
  if (!kv) return;
  try {
    await kv.put(key.kvKey, String(used), { expirationTtl: ttl });
  } catch (e) {
    /* 忽略：KV 仅作冗余观测，权威计数在 D1 */
  }
}

/** 只读查询（不计数）：用于任意响应体回传剩余额度 */
export async function readQuota(env, scope, nowMs) {
  var now = nowMs || Date.now();
  var quota = baseQuota(env, scope, now);
  if (!flagshipQuotaEnabled(env) || !scope || !scope.id) return quota;
  quota.enabled = true;
  quota.store = quotaStore(env);

  var key = { scopeKey: scopeKey(scope, quota.day), kvKey: quotaKey(scope, quota.day), day: quota.day };
  var used = null;
  if (quota.store === 'd1') {
    used = await d1ReadUsed(env, key);
    if (used === null) {
      // D1 异常 → 降级 KV（尽力而为），仍读不到则按 0 放行
      quota.store = quotaKv(env) ? 'kv' : 'none';
      used = quota.store === 'kv' ? await kvReadUsed(env, key) : 0;
    }
  } else {
    used = await kvReadUsed(env, key);
  }
  return clampQuota(quota, used === null ? 0 : used);
}

/**
 * 计数 +1（仅上游成功返回后调用）。
 * D1 路径为原子 UPSERT：并发下不会突破 limit；KV 路径为「读-改-写」，尽力而为。
 */
export async function consumeQuota(env, scope, nowMs) {
  var now = nowMs || Date.now();
  var quota = await readQuota(env, scope, now);
  if (!quota.enabled) return quota;

  var ttl = secondsToNextUtcDay(now) + 600; // 跨到次日再留 10 分钟缓冲，保证零点前后不误判
  var key = { scopeKey: scopeKey(scope, quota.day), kvKey: quotaKey(scope, quota.day), day: quota.day };
  var nowSec = Math.floor(now / 1000);

  if (quota.store === 'd1') {
    var db = quotaDb(env);
    try {
      await db
        .prepare(
          'INSERT INTO ' + QUOTA_TABLE + ' (scope_key, day, used, updated_at) VALUES (?1, ?2, 1, ?3) ' +
            'ON CONFLICT(scope_key, day) DO UPDATE SET used = used + 1, updated_at = ?3 WHERE used < ?4'
        )
        .bind(key.scopeKey, key.day, nowSec, quota.limit)
        .run();
      var row = await db
        .prepare('SELECT used FROM ' + QUOTA_TABLE + ' WHERE scope_key = ?1 AND day = ?2')
        .bind(key.scopeKey, key.day)
        .first();
      var used = row ? toInt(row.used, 0) : quota.used;
      await kvMirror(env, key, Math.min(quota.limit, used), ttl);
      return clampQuota(quota, used);
    } catch (e) {
      // 写失败不阻断主流程：退回 KV 路径并尽力补记一次
    }
  }

  var next = Math.min(quota.limit, quota.used + 1);
  var kv = quotaKv(env);
  if (kv) {
    try {
      await kv.put(key.kvKey, String(next), { expirationTtl: ttl });
    } catch (e) {
      /* KV 写失败不阻断主流程；极端情况下只是少计一次 */
    }
  }
  return clampQuota(quota, next);
}

/** 响应体中的 quota 字段（前端按此解析：limit / used / remaining） */
export function quotaPayload(quota) {
  if (!quota || !quota.enabled) return undefined;
  return {
    tier: quota.tier,
    model: quota.model,
    limit: quota.limit,
    used: quota.used,
    remaining: quota.remaining,
    day: quota.day,
    scope: quota.scope,
    resetInSec: quota.resetInSec
  };
}

/** 观测响应头 */
export function quotaHeaders(quota) {
  if (!quota || !quota.enabled) return {};
  return {
    'X-AI-Quota-Tier': quota.tier,
    'X-AI-Quota-Limit': String(quota.limit),
    'X-AI-Quota-Used': String(quota.used),
    'X-AI-Quota-Remaining': String(quota.remaining),
    'X-AI-Quota-Reset': String(quota.resetInSec),
    'X-AI-Quota-Store': quota.store || 'none'
  };
}

/** 中文提示文案（对用户可见） */
export function quotaExceededText(quota) {
  var limit = quota && quota.limit ? quota.limit : DEFAULT_FLAGSHIP_DAILY_LIMIT;
  var mins = quota && quota.resetInSec ? Math.max(1, Math.round(quota.resetInSec / 60)) : 0;
  return (
    '今日旗舰模式（kimi-k3）额度已用完：每个访客每天最多 ' + limit + ' 次，' +
    '约 ' + mins + ' 分钟后（次日 00:00 UTC）自动重置。' +
    '现在可改用「快速回答」或「深度思考」，或明天再来体验旗舰模式。'
  );
}

/** 超限响应：HTTP 429 + error=quota_exceeded（不做任何降级） */
export function quotaExceededResponse(quota, corsHeaders) {
  var headers = Object.assign({}, corsHeaders || {}, quotaHeaders(quota));
  if (quota && quota.resetInSec) headers['Retry-After'] = String(quota.resetInSec);
  headers['Cache-Control'] = 'no-store';
  return fail(
    ERR.QUOTA_EXCEEDED,
    quotaExceededText(quota),
    429,
    headers,
    {
      quota: quotaPayload(quota) || { limit: DEFAULT_FLAGSHIP_DAILY_LIMIT, used: DEFAULT_FLAGSHIP_DAILY_LIMIT, remaining: 0 },
      quotaExceeded: true,
      retryAfterSec: (quota && quota.resetInSec) || 0,
      hint: '请改用快速回答 / 深度思考模式，或等待次日额度重置'
    }
  );
}
