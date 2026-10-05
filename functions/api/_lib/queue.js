/**
 * 上游串行队列 + 429 指数退避（Kimi / Moonshot 与 智谱 GLM 账号并发上限均为 1）
 *
 * 背景：
 *   Moonshot 账号实测并发上限为 1，超出并发会直接返回 429
 *   （错误体 code = rate_limit_reached_error）。因此所有上游请求必须排队串行执行。
 *   双上游改造后该约束「按 provider 分别处理」：kimi 与 zhipu 各占一把锁、各排一条队，
 *   同一 provider 内仍严格串行（并发 1），不同 provider 之间互不阻塞。
 *
 * 两级串行（每个 provider 锁域各一套）：
 *   1) isolate 内内存队列：module 作用域 promise 链，保证同一实例内严格串行（零依赖、零延迟）。
 *   2) 跨 isolate KV 租约：用 AI_QUEUE_KV / AI_RATE_KV 的锁键做全局串行闸门，
 *      租约带 TTL 防死锁，未抢到锁的请求按泊松抖动轮询等待。
 *   无 KV 绑定时自动降级为仅内存队列（仍可大幅降低并发）。
 *
 * 429 退避策略（指数 + 抖动 + 上限）：
 *   第 n 次重试等待 = min(base * 2^n, maxDelay) * (0.75 ~ 1.25 随机抖动)
 *   退避期间**主动让出锁**，避免独占队列导致其他访客排队时间过长；到点后重新入队。
 *   超过 AI_QUEUE_MAX_RETRY（默认 4）仍 429 → 返回 ratelimited 降级，由上层兜底文案应答。
 *
 * 排队状态回传：
 *   onStatus({ state, position, waitedMs, attempt, retryInMs })
 *   state: 'queued'（排队中）/ 'running'（已获锁执行）/ 'retrying'（429 退避中）/ 'done'
 *   上层可据此给前端「排队中 / 重试中」提示，绝不把 429 直接抛给用户。
 */

import { toInt, toBool, newRequestId } from './http.js';

const LOCK_KEY_BASE = 'ai:queue:lock';
const WAIT_KEY = 'ai:queue:waiting';

/**
 * 队列锁域：**每个上游 provider 各自一把锁、各自一条串行链**，互不阻塞。
 *   kimi  → 锁键沿用 ai:queue:lock（兼容既有部署，避免灰度期新旧实例互不知晓）
 *   zhipu → 锁键 ai:queue:lock:zhipu
 * 未指定 provider 时落回 kimi 锁域，保证旧调用方行为不变。
 */
export const QUEUE_SCOPES = ['kimi', 'zhipu'];

export function queueScope(provider) {
  return String(provider == null ? '' : provider).trim().toLowerCase() === 'zhipu' ? 'zhipu' : 'kimi';
}

export function lockKeyOf(provider) {
  var scope = queueScope(provider);
  return scope === 'kimi' ? LOCK_KEY_BASE : LOCK_KEY_BASE + ':' + scope;
}

/* isolate 内存队列：每个锁域一条串行 promise 链 */
var memTails = {};
var memWaiting = { kimi: 0, zhipu: 0 };

function tailOf(scope) {
  if (!memTails[scope]) memTails[scope] = Promise.resolve();
  return memTails[scope];
}

function queueKv(env) {
  return (env && (env.AI_QUEUE_KV || env.AI_RATE_KV || env.AI_CACHE_KV)) || null;
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/** 泊松抖动：避免多 isolate 同频轮询造成惊群 */
function jitter(base) {
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

function backoffDelay(env, attempt) {
  var base = toInt(env && env.AI_QUEUE_RETRY_BASE_MS, 1200);
  var max = toInt(env && env.AI_QUEUE_RETRY_MAX_MS, 12000);
  var d = Math.min(base * Math.pow(2, Math.max(0, attempt)), max);
  return jitter(d);
}

/* ------------------------------------------------------------------ */
/* KV 租约（全局串行闸门）                                              */
/* ------------------------------------------------------------------ */

async function acquireLease(env, opts) {
  var o = opts || {};
  var scope = queueScope(o.provider);
  var lockKey = lockKeyOf(scope);
  var kv = queueKv(env);
  if (!kv) return { held: true, holder: '', kvless: true, scope: scope, lockKey: lockKey };

  var holder = o.holder || newRequestId('lease');
  // Cloudflare KV 硬性要求 expirationTtl ≥ 60s：低于 60 会直接抛错，锁永远写不进去（历史故障根因）
  var ttlSec = Math.max(60, Math.min(3600, Math.round(toInt(env.AI_QUEUE_LEASE_TTL_MS, 90000) / 1000)));
  // 排队等待上限：锁正常时几乎瞬时获得，超过该值说明上游被长任务占用，尽早降级而非让访客白等
  var deadline = Date.now() + toInt(env.AI_QUEUE_WAIT_TIMEOUT_MS, 30000);
  var poll = Math.max(120, toInt(env.AI_QUEUE_POLL_MS, 350));
  var started = Date.now();
  var position = 0;

  while (Date.now() < deadline) {
    var cur = null;
    try {
      cur = await kv.get(lockKey);
    } catch (e) {
      cur = null;
    }
    // 锁已是自己的（同一请求重入 / 上一次 put 已生效但读缓存未刷新）：直接放行，绝不空转
    if (cur === holder) {
      memWaiting[scope] = 0;
      if (typeof o.onStatus === 'function') {
        o.onStatus({ state: 'running', provider: scope, position: 0, waitedMs: Date.now() - started, attempt: o.attempt || 0 });
      }
      return { held: true, holder: holder, scope: scope, lockKey: lockKey, waitedMs: Date.now() - started, position: position };
    }
    // KV 无原子 CAS：读空即写，配合短 TTL + 抖动，窗口极小
    if (!cur) {
      var putFailed = false;
      try {
        await kv.put(lockKey, holder, { expirationTtl: ttlSec });
      } catch (e) {
        // KV 写入异常（参数非法 / 配额 / 抖动）：不可静默空转，
        // 降级为「无锁直通」，并发溢出交由上游 429 退避兜底，避免整站问答被 KV 故障拖死
        putFailed = true;
      }
      if (putFailed) {
        memWaiting[scope] = 0;
        if (typeof o.onStatus === 'function') {
          o.onStatus({ state: 'running', provider: scope, position: 0, waitedMs: Date.now() - started, attempt: o.attempt || 0, kvWriteFailed: true });
        }
        return { held: true, holder: holder, scope: scope, lockKey: lockKey, kvWriteFailed: true, waitedMs: Date.now() - started, position: position };
      }
      // 乐观持锁：KV 是最终一致存储，put 成功即视为获锁并放行，不再依赖 read-after-write 校验。
      // 历史故障根因：put 后立刻 read-back，读缓存未刷新时既误判「没拿到锁」、又把锁留在 KV 里，
      // 请求只能自旋到等待超时 → 全站 AI 连环降级（90s 锁 TTL 内每个请求都排队失败）。
      memWaiting[scope] = 0;
      if (typeof o.onStatus === 'function') {
        o.onStatus({ state: 'running', provider: scope, position: 0, waitedMs: Date.now() - started, attempt: o.attempt || 0 });
      }
      return { held: true, holder: holder, scope: scope, lockKey: lockKey, waitedMs: Date.now() - started, position: position };
    }
    position += 1;
    memWaiting[scope] = position;
    if (typeof o.onStatus === 'function') {
      o.onStatus({ state: 'queued', provider: scope, position: position, waitedMs: Date.now() - started, attempt: o.attempt || 0 });
    }
    await sleep(jitter(poll));
  }
  return { held: false, holder: '', scope: scope, lockKey: lockKey, waitedMs: Date.now() - started, position: position };
}

async function releaseLease(env, lease) {
  if (!lease || !lease.held || lease.kvless) return;
  var kv = queueKv(env);
  if (!kv) return;
  var lockKey = lease.lockKey || lockKeyOf(lease.scope);
  try {
    var cur = await kv.get(lockKey);
    // 读到自己的锁 → 删；读到空也要尽力删一次（KV 读缓存滞后会误读为空），
    // 避免锁泄漏把后续请求全部堵在 90s TTL 内排队超时（历史故障根因）
    if (!cur || cur === lease.holder) await kv.delete(lockKey);
  } catch (e) {
    /* 忽略：TTL 会兜底释放 */
  }
}

/* ------------------------------------------------------------------ */
/* 对外主入口                                                          */
/* ------------------------------------------------------------------ */

/**
 * 串行执行一次上游调用，并对 429 自动指数退避重试。
 *
 * @param {object} env
 * @param {function} task 形如 async () => ({ status:'ok'|'retry'|'fail', value?, retryAfterMs?, errorCode?, detail?, status? })
 *        - status:'ok'    → 成功，直接返回 value
 *        - status:'retry' → 429/限流，按 retryAfterMs（可选）或指数退避重试
 *        - status:'fail'  → 不可重试失败，立即返回
 * @param {object} opts { onStatus, requestId, maxRetry, label, provider }
 *        provider：'kimi' | 'zhipu'，决定使用哪个锁域（默认 kimi，缺省行为与旧版一致）
 * @returns {Promise<{ok:boolean, value?:any, errorCode?:string, detail?:string, attempts:number, waitedMs:number, queueWaitMs:number, retried:number, status?:number, exhausted?:boolean}>}
 */
export async function runSerial(env, task, opts) {
  var o = opts || {};
  var maxRetry = toInt(o.maxRetry !== undefined ? o.maxRetry : env && env.AI_QUEUE_MAX_RETRY, 4);
  maxRetry = Math.max(0, Math.min(8, maxRetry));
  var startedAt = Date.now();
  var queueWaitMs = 0;
  var retried = 0;
  var last = null;

  var scope = queueScope(o.provider);
  // isolate 内串行：把本次执行挂到「本 provider 锁域」的内存队列尾部
  var prev = tailOf(scope);
  var release = null;
  memTails[scope] = new Promise(function (res) { release = res; });

  try {
    await prev.catch(function () {});
    for (var attempt = 0; attempt <= maxRetry; attempt++) {
      var lease = await acquireLease(env, {
        provider: scope,
        holder: o.requestId ? o.requestId + '_' + attempt : '',
        attempt: attempt,
        onStatus: o.onStatus
      });
      queueWaitMs += lease.waitedMs || 0;
      if (!lease.held) {
        return {
          ok: false,
          errorCode: 'queue_timeout',
          detail: '排队等待超时（上游并发已满）',
          attempts: attempt + 1,
          retried: retried,
          waitedMs: Date.now() - startedAt,
          queueWaitMs: queueWaitMs
        };
      }

      var res = null;
      try {
        res = await task({ attempt: attempt });
      } catch (e) {
        res = { status: 'fail', errorCode: 'upstream_error', detail: (e && e.message) || 'task threw' };
      }
      last = res || {};

      if (last.status === 'retry') {
        await releaseLease(env, lease);
        retried += 1;
        if (attempt >= maxRetry) {
          if (typeof o.onStatus === 'function') o.onStatus({ state: 'done', attempt: attempt, retried: retried });
          return {
            ok: false,
            errorCode: last.errorCode || 'rate_limited',
            detail: last.detail || '上游持续限流，已超出重试上限',
            status: last.status400 || 429,
            attempts: attempt + 1,
            retried: retried,
            exhausted: true,
            waitedMs: Date.now() - startedAt,
            queueWaitMs: queueWaitMs
          };
        }
        var delay = last.retryAfterMs && last.retryAfterMs > 0 ? jitter(Math.min(last.retryAfterMs, toInt(env && env.AI_QUEUE_RETRY_MAX_MS, 12000))) : backoffDelay(env, attempt);
        if (typeof o.onStatus === 'function') {
          o.onStatus({ state: 'retrying', attempt: attempt + 1, retryInMs: delay, retried: retried, waitedMs: Date.now() - startedAt });
        }
        // 让出锁后再等待，避免长时间独占队列
        await sleep(delay);
        continue;
      }

      await releaseLease(env, lease);
      if (typeof o.onStatus === 'function') o.onStatus({ state: 'done', attempt: attempt, retried: retried });
      if (last.status === 'ok') {
        return {
          ok: true,
          value: last.value,
          attempts: attempt + 1,
          retried: retried,
          waitedMs: Date.now() - startedAt,
          queueWaitMs: queueWaitMs,
          status: last.status400
        };
      }
      return {
        ok: false,
        errorCode: last.errorCode || 'upstream_error',
        detail: last.detail || '',
        status: last.status400,
        attempts: attempt + 1,
        retried: retried,
        waitedMs: Date.now() - startedAt,
        queueWaitMs: queueWaitMs
      };
    }
    return {
      ok: false,
      errorCode: (last && last.errorCode) || 'upstream_error',
      detail: (last && last.detail) || '',
      attempts: maxRetry + 1,
      retried: retried,
      waitedMs: Date.now() - startedAt,
      queueWaitMs: queueWaitMs
    };
  } finally {
    // 释放 isolate 内存队列，让下一个请求继续
    if (release) release();
  }
}

/** 队列运行时快照（供 /api/health 与后台展示；按 provider 分域展示） */
export async function queueSnapshot(env) {
  var kv = queueKv(env);
  var perProvider = {};
  for (var i = 0; i < QUEUE_SCOPES.length; i++) {
    var scope = QUEUE_SCOPES[i];
    var holder = '';
    if (kv) {
      try {
        holder = (await kv.get(lockKeyOf(scope))) || '';
      } catch (e) {
        holder = '';
      }
    }
    perProvider[scope] = {
      concurrencyLimit: 1,
      serialized: true,
      kvLease: !!kv,
      locked: !!holder,
      memoryWaiting: memWaiting[scope] || 0
    };
  }
  return {
    // 顶层字段沿用旧语义（默认锁域 = kimi），保证老调用方/老看板不炸
    concurrencyLimit: 1,
    serialized: true,
    kvLease: !!kv,
    locked: perProvider.kimi.locked,
    memoryWaiting: perProvider.kimi.memoryWaiting,
    perProviderLock: true,
    perProvider: perProvider,
    maxRetry: toInt(env && env.AI_QUEUE_MAX_RETRY, 4),
    retryBaseMs: toInt(env && env.AI_QUEUE_RETRY_BASE_MS, 1200),
    retryMaxMs: toInt(env && env.AI_QUEUE_RETRY_MAX_MS, 12000)
  };
}

/** 是否检测到 429 限流错误（兼容 Moonshot 错误体与标准 OpenAI 错误体） */
export function isRateLimitBody(bodyText, status) {
  if (status === 429) return true;
  var s = String(bodyText || '').toLowerCase();
  return (
    s.indexOf('rate_limit_reached_error') >= 0 ||
    s.indexOf('rate limit') >= 0 ||
    s.indexOf('too many requests') >= 0 ||
    s.indexOf('concurrency') >= 0 && s.indexOf('limit') >= 0
  );
}

/** 从响应头 / 错误体提取建议等待时间（Retry-After / retry_after） */
export function retryAfterMsOf(headers, bodyText) {
  var ra = 0;
  try {
    if (headers && typeof headers.get === 'function') ra = parseFloat(headers.get('Retry-After') || '') || 0;
  } catch (e) {
    ra = 0;
  }
  if (ra > 0) return Math.round(ra * 1000);
  var m = String(bodyText || '').match(/retry[_\- ]?after["'\s:]*([0-9.]+)/i);
  if (m) {
    var v = parseFloat(m[1]) || 0;
    return v > 1000 ? Math.round(v) : Math.round(v * 1000);
  }
  return 0;
}

export { sleep as queueSleep };
