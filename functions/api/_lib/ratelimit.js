/**
 * 限流模块（多维窗口计数）
 *
 * 维度：IP / 访客ID / 令牌 / 管理端
 * 窗口：分钟 / 天（两级）
 * 存储：KV（绑定名 AI_RATE_KV）；未绑定时返回 kvMissing=true，调用方决定是否放行
 *
 * 实现要点：
 *   1) 所有窗口「先全查、全通过才记账」，被拒绝的请求不消耗配额；
 *   2) KV 键只存哈希 ID，不落明文；
 *   3) KV 为最终一致性存储，极端并发下计数可能略少（防滥刷场景足够）；
 *      若需严格计数可换 Durable Objects，接口保持不变。
 */

import { toInt } from './http.js';

export const RATE_TTL_MINUTE = 120;
export const RATE_TTL_DAY = 172800;

export function rateKv(env) {
  var kv = env && env.AI_RATE_KV;
  return kv && typeof kv.get === 'function' && typeof kv.put === 'function' ? kv : null;
}

/**
 * @param {object} env
 * @param {Array} scopes [{ dim, id, perMin, perDay, prefix }]
 * @returns {Promise<{ok:boolean, kvMissing?:boolean, dimension?:string, window?:string, limit?:number, used?:number}>}
 */
export async function checkRateLimit(env, scopes) {
  var kv = rateKv(env);
  if (!kv) return { ok: true, kvMissing: true };

  var now = Date.now();
  var minuteBucket = Math.floor(now / 60000);
  var dayBucket = new Date(now).toISOString().slice(0, 10);
  var pending = [];

  for (var i = 0; i < (scopes || []).length; i++) {
    var scope = scopes[i];
    if (!scope || !scope.id) continue;
    var prefix = scope.prefix || 'rl';
    var rules = [
      { win: 'minute', key: prefix + ':' + scope.dim + ':m:' + minuteBucket + ':' + scope.id, limit: scope.perMin, ttl: RATE_TTL_MINUTE },
      { win: 'day', key: prefix + ':' + scope.dim + ':d:' + dayBucket + ':' + scope.id, limit: scope.perDay, ttl: RATE_TTL_DAY }
    ];
    for (var j = 0; j < rules.length; j++) {
      var rule = rules[j];
      if (!rule.limit || rule.limit <= 0) continue;
      var current = 0;
      try {
        current = toInt(await kv.get(rule.key), 0);
      } catch (e) {
        current = 0;
      }
      if (current >= rule.limit) {
        return { ok: false, dimension: scope.dim, window: rule.win, limit: rule.limit, used: current };
      }
      pending.push({ key: rule.key, value: current + 1, ttl: rule.ttl });
    }
  }

  await Promise.all(
    pending.map(function (item) {
      return kv.put(item.key, String(item.value), { expirationTtl: item.ttl }).catch(function () {});
    })
  );

  return { ok: true };
}

/** 限流响应头（含 Retry-After 与剩余额度提示） */
export function rateLimitHeaders(result) {
  var headers = { 'X-AI-RateLimit-Window': (result && result.window) || 'minute' };
  headers['Retry-After'] = result && result.window === 'day' ? '3600' : '60';
  if (result && result.limit) {
    headers['X-AI-RateLimit-Limit'] = String(result.limit);
    headers['X-AI-RateLimit-Used'] = String(result.used === undefined ? '' : result.used);
  }
  return headers;
}

/** 常用维度组装：根据业务场景读取环境变量配额 */
export function buildScopes(env, ids, preset) {
  var p = preset || 'chat';
  var conf = {
    chat: {
      ipMin: toInt(env.AI_RATE_IP_PER_MIN, 20),
      ipDay: toInt(env.AI_RATE_IP_PER_DAY, 800),
      visitorMin: toInt(env.AI_RATE_VID_PER_MIN, 10),
      visitorDay: toInt(env.AI_RATE_VID_PER_DAY, 300)
    },
    token: {
      ipMin: toInt(env.AI_TOKEN_RATE_IP_PER_MIN, 30),
      ipDay: toInt(env.AI_TOKEN_RATE_IP_PER_DAY, 600),
      visitorMin: toInt(env.AI_TOKEN_RATE_VID_PER_MIN, 12),
      visitorDay: toInt(env.AI_TOKEN_RATE_VID_PER_DAY, 200)
    },
    readonly: {
      ipMin: toInt(env.AI_READ_RATE_IP_PER_MIN, 120),
      ipDay: toInt(env.AI_READ_RATE_IP_PER_DAY, 4000),
      visitorMin: 0,
      visitorDay: 0
    },
    prewarm: {
      ipMin: 0,
      ipDay: 0,
      visitorMin: 0,
      visitorDay: 0
    }
  }[p] || null;

  if (!conf) return [];
  var scopes = [];
  if (ids.ipHash) {
    scopes.push({ dim: 'ip', id: ids.ipHash, perMin: conf.ipMin, perDay: conf.ipDay });
  }
  if (ids.visitorHash) {
    scopes.push({ dim: 'vid', id: ids.visitorHash, perMin: conf.visitorMin, perDay: conf.visitorDay });
  }
  return scopes;
}
