/**
 * 预生成与预热（对应条目 B-15）
 *
 * 思路：
 *   1) 站内高频问题（_lib/data/prewarm-questions.js，14 条）在低峰期批量预生成答案；
 *   2) 预生成结果同时写入两处：
 *        · 请求指纹缓存（与实时请求同构的指纹）—— 运行时首选命中，成本为 0
 *        · 问题级索引 ai:pw:q:<问题哈希> —— 指纹未命中时的二次保障（档位/参数一致才用）
 *   3) 支持 Cron 定时预热（functions/api/prewarm.js 的 scheduled 触发），也支持
 *      管理端手动触发；分批执行（limit）避免单次超时。
 *
 * 存储键：
 *   ai:pw:q:<qhash>        预生成答案（按问题文本）
 *   ai:pw:meta:<id>        每条预生成的状态元信息
 *   ai:pw:state            最近一次批量执行的汇总
 */

import { sha256Hex, normalizeText, nowSec, toInt } from './http.js';
import { PREWARM_QUESTIONS, PREWARM_META } from './data/prewarm-questions.js';
import { buildChatContext, messagesForUpstream, digestAnswer } from './context.js';
import { resolveTier, resolveGenerationParams, validateMessages } from './router.js';
import { buildFingerprint, cachePut } from './cache.js';
import { callUpstream, parseCompletion, usageTokens } from './upstream.js';
import { computeCost } from './logging.js';

export { PREWARM_QUESTIONS, PREWARM_META };
export const PREWARM_STAMP = PREWARM_META.version + ':' + PREWARM_QUESTIONS.length;

const Q_PREFIX = 'ai:pw:q:';
const META_PREFIX = 'ai:pw:meta:';
const STATE_KEY = 'ai:pw:state';

export function prewarmKv(env) {
  var kv = env && (env.AI_CACHE_KV || env.AI_RATE_KV);
  return kv && typeof kv.get === 'function' ? kv : null;
}

export function questionHash(question) {
  return sha256Hex(normalizeText(question).toLowerCase()).then(function (h) { return h.slice(0, 24); });
}

export function prewarmList() {
  return PREWARM_QUESTIONS.map(function (q) {
    return {
      id: q.id,
      question: q.q,
      feature: q.feature || 'chat',
      tier: q.tier || 'light',
      tags: q.tags || [],
      rag: !!q.rag
    };
  });
}

/** 单条预生成 */
export async function prewarmOne(env, item, options) {
  var o = options || {};
  var started = Date.now();
  var kv = prewarmKv(env);
  var meta = {
    id: item.id,
    question: item.q,
    feature: item.feature || 'chat',
    tier: item.tier || 'light',
    at: nowSec(),
    status: 'failed',
    error: ''
  };

  try {
    var rawMessages = [{ role: 'user', content: item.q }];
    var validated = validateMessages(rawMessages, env);
    if (!validated.ok) {
      meta.error = 'bad_question';
      await writeMeta(kv, meta);
      return meta;
    }

    var ctx = await buildChatContext(env, validated.messages, {
      feature: o.feature || item.feature || 'chat',
      ragEnabled: o.ragEnabled !== false,
      glossaryEnabled: o.glossaryEnabled !== false
    });

    var route = resolveTier({ messages: validated.messages, tier: item.tier }, env);
    var params = resolveGenerationParams({}, route.config);
    var upstreamMessages = messagesForUpstream(validated.messages, ctx.systemPrompt);
    var fp = await buildFingerprint({
      messages: validated.messages,
      model: route.model,
      tier: route.tier,
      params: params,
      systemPrompt: ctx.systemPrompt,
      ragStamp: ctx.stamps.rag,
      glossaryStamp: ctx.stamps.glossary
    });

    var result = await callUpstream(env, {
      model: route.model,
      messages: upstreamMessages,
      params: params,
      stream: false,
      timeoutMs: route.config.timeoutMs,
      requestId: 'pw_' + item.id
    });

    if (!result.ok) {
      meta.error = result.errorCode || 'upstream_error';
      await writeMeta(kv, meta);
      return meta;
    }

    var json = null;
    try {
      json = await result.response.json();
    } catch (e) {
      json = null;
    }
    var parsed = parseCompletion(json);
    if (!parsed.ok) {
      meta.error = 'empty_answer';
      await writeMeta(kv, meta);
      return meta;
    }

    var tokens = usageTokens(parsed.usage);
    var cost = computeCost(env, route.model, tokens.prompt, tokens.completion);
    var latency = Date.now() - started;

    var entry = {
      answer: parsed.text,
      model: route.model,
      tier: route.tier,
      feature: meta.feature,
      ragHit: ctx.rag.hit,
      ragDocs: ctx.rag.docsCount,
      source: 'prewarm'
    };

    await cachePut(env, fp, entry, o.ttl);
    if (kv) {
      var qh = await questionHash(item.q);
      var payload = Object.assign({ id: item.id, question: item.q, fp: fp, createdAt: nowSec() }, entry);
      await kv
        .put(Q_PREFIX + qh, JSON.stringify(payload), { expirationTtl: toInt(o.ttl, toInt(env.AI_PREWARM_TTL, 604800)) })
        .catch(function () {});
    }

    meta.status = 'done';
    meta.model = route.model;
    meta.ragHit = ctx.rag.hit ? 1 : 0;
    meta.ragDocs = ctx.rag.docsCount;
    meta.glossaryHits = ctx.glossary.count;
    meta.chars = parsed.text.length;
    meta.promptTokens = tokens.prompt;
    meta.completionTokens = tokens.completion;
    meta.costMicro = cost.costMicro;
    meta.latencyMs = latency;
    meta.fp = fp;
    meta.digest = digestAnswer(parsed.text, 120);
    await writeMeta(kv, meta);
    return meta;
  } catch (e) {
    meta.error = 'exception';
    meta.detail = String((e && e.message) || e).slice(0, 200);
    await writeMeta(kv, meta);
    return meta;
  }
}

async function writeMeta(kv, meta) {
  if (!kv) return;
  try {
    var ttl = 2592000;
    await kv.put(META_PREFIX + meta.id, JSON.stringify(meta), { expirationTtl: ttl });
  } catch (e) {
    /* 忽略 */
  }
}

/**
 * 批量预生成（分批执行）。
 * @param {object} env
 * @param {object} options { ids:[], force:false, limit:4, ttl }
 */
export async function runPrewarm(env, options) {
  var o = options || {};
  var kv = prewarmKv(env);
  var items = PREWARM_QUESTIONS;
  if (o.ids && o.ids.length) {
    items = items.filter(function (q) { return o.ids.indexOf(q.id) >= 0; });
  }

  var pending = [];
  if (!o.force && kv) {
    for (var i = 0; i < items.length; i++) {
      var ex = await readMeta(kv, items[i].id);
      if (!ex || ex.status !== 'done') pending.push(items[i]);
    }
  } else {
    pending = items.slice();
  }

  var limit = Math.max(1, toInt(o.limit, 4));
  var batch = pending.slice(0, limit);
  var results = [];
  for (var j = 0; j < batch.length; j++) {
    /* 顺序执行，避免瞬时打满上游配额 */
    var r = await prewarmOne(env, batch[j], { ttl: o.ttl });
    results.push({
      id: r.id,
      status: r.status,
      chars: r.chars || 0,
      model: r.model || '',
      costMicro: r.costMicro || 0,
      latencyMs: r.latencyMs || 0,
      error: r.error || ''
    });
  }

  var summary = {
    at: nowSec(),
    total: items.length,
    pendingBefore: pending.length,
    executed: results.length,
    remaining: Math.max(0, pending.length - results.length),
    ok: results.filter(function (r) { return r.status === 'done'; }).length,
    failed: results.filter(function (r) { return r.status !== 'done'; }).length,
    costMicro: results.reduce(function (a, r) { return a + (r.costMicro || 0); }, 0),
    results: results
  };

  if (kv) {
    try {
      await kv.put(STATE_KEY, JSON.stringify(summary), { expirationTtl: 2592000 });
    } catch (e) {
      /* 忽略 */
    }
  }
  return summary;
}

async function readMeta(kv, id) {
  if (!kv) return null;
  try {
    return await kv.get(META_PREFIX + id, 'json');
  } catch (e) {
    return null;
  }
}

/** 查询全部预生成状态 */
export async function prewarmStatus(env) {
  var kv = prewarmKv(env);
  var list = [];
  for (var i = 0; i < PREWARM_QUESTIONS.length; i++) {
    var q = PREWARM_QUESTIONS[i];
    var meta = await readMeta(kv, q.id);
    list.push({
      id: q.id,
      question: q.q,
      tier: q.tier || 'light',
      feature: q.feature || 'chat',
      status: meta ? meta.status : 'pending',
      model: (meta && meta.model) || '',
      chars: (meta && meta.chars) || 0,
      latencyMs: (meta && meta.latencyMs) || 0,
      costMicro: (meta && meta.costMicro) || 0,
      at: (meta && meta.at) || 0,
      error: (meta && meta.error) || ''
    });
  }
  var state = kv ? await kv.get(STATE_KEY, 'json').catch(function () { return null; }) : null;
  return {
    kvAvailable: !!kv,
    total: list.length,
    done: list.filter(function (x) { return x.status === 'done'; }).length,
    items: list,
    lastRun: state || null
  };
}

/**
 * 运行时二次保障：按问题文本 + 档位 + 模型读取预生成答案。
 * 仅在指纹未命中时调用；档位或模型不一致则视为未命中（避免用错档答案）。
 */
export async function getPrewarmAnswer(env, question, model, tier) {
  var kv = prewarmKv(env);
  if (!kv) return { hit: false };
  try {
    var qh = await questionHash(question);
    var entry = await kv.get(Q_PREFIX + qh, 'json');
    if (!entry || !entry.answer) return { hit: false };
    if (entry.model !== model || entry.tier !== tier) return { hit: false, mismatch: true };
    return { hit: true, entry: entry };
  } catch (e) {
    return { hit: false };
  }
}

export async function deletePrewarm(env, id) {
  var kv = prewarmKv(env);
  if (!kv) return { ok: false, reason: 'kv_unavailable' };
  var item = PREWARM_QUESTIONS.filter(function (q) { return q.id === id; })[0];
  try {
    await kv.delete(META_PREFIX + id);
    if (item) {
      var qh = await questionHash(item.q);
      await kv.delete(Q_PREFIX + qh);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'kv_delete_failed' };
  }
}
