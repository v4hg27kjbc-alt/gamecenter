/**
 * /api/admin/stats —— AI 服务端「一屏总览」聚合接口（清单 B-25 ~ B-32 的只读出口）
 *
 * 作用：
 *   管理端首页只需要一次请求，就能拿到运营所需的全部关键指标：
 *     调用量 / token / 成本 / 缓存命中率 / 降级率 / 平均耗时 / 预热进度 / 开关状态 /
 *     数据规模 / 配额上限 / 存储后端。
 *   避免前端为每个指标各发一次请求，也避免把统计口径散落到多处。
 *
 * 路由：
 *   GET /api/admin/stats?days=7     总览（days 取值 1~90，默认 7）
 *
 * 鉴权：管理员口令（X-Admin-Token 或 ?token=）。
 *
 * 口径说明：
 *   · 命中率 = cached_calls / calls；降级率 = degraded_calls / calls；
 *     平均耗时 = latency_sum_ms / calls（来自 ai_call_summary 的累计值）。
 *   · 成本单位为微元（1 元 = 1,000,000 微元），同时给出人类可读的 formatted。
 *   · D1 不可用时自动回落到 KV 环形缓冲，此时 byDay/byModel 可能缺失，接口会带
 *     storage='kv' 与 degradedFields 字段如实说明，不伪造数据。
 */

import {
  ERR,
  ok,
  fail,
  withSecurity,
  methodNotAllowed,
  resolveCors,
  checkAdminToken,
  toInt,
  clamp
} from '../_lib/http.js';
import { summarizeLogs, storageMode, pricingTable, formatCost, computeCost } from '../_lib/logging.js';
import { getFlags, quotaDefaults } from '../_lib/flags.js';
import { prewarmStatus } from '../_lib/prewarm.js';
import { RAG_META, aircraftBriefs, libraryStats } from '../_lib/rag.js';
import { GLOSSARY_META, listTerms } from '../_lib/glossary.js';
import { TIERS, tierConfig, modelAllowlist } from '../_lib/router.js';
import { providerOfModel, providerCatalog } from '../_lib/upstream.js';

function baseHeaders(context) {
  var h = Object.assign({ 'Cache-Control': 'no-store' }, withSecurity({}));
  return Object.assign(h, resolveCors(context.request, context.env));
}

function requireAdmin(context) {
  if (checkAdminToken(context.request, context.env).ok !== true) {
    return fail(ERR.UNAUTHORIZED, '需要管理员口令（X-Admin-Token 或 ?token=）', 401, baseHeaders(context));
  }
  return null;
}

function ratio(a, b) {
  var x = Number(a) || 0;
  var y = Number(b) || 0;
  if (!y) return 0;
  return Math.round((x / y) * 10000) / 100;      // 百分比，保留两位
}

function withLatency(rows) {
  return (rows || []).map(function (r) {
    var calls = Number(r.calls) || 0;
    var sum = Number(r.latency_sum_ms) || 0;
    return Object.assign({}, r, {
      avg_latency_ms: calls ? Math.round(sum / calls) : 0,
      avg_cost_micro: calls ? Math.round((Number(r.cost_micro) || 0) / calls) : 0,
      cached_ratio: ratio(r.cached_calls, calls),
      degraded_ratio: ratio(r.degraded_calls, calls),
      cost_formatted: formatCost(Number(r.cost_micro) || 0)
    });
  });
}

/* 双上游维度汇总：把 byModel 结果按「模型 → 上游」归并（无 provider 列时无需改库即可按上游看用量） */
function aggregateByProvider(byModel) {
  var buckets = {};
  (byModel || []).forEach(function (r) {
    var p = providerOfModel(r.model) || 'unknown';
    var b = buckets[p] || (buckets[p] = { provider: p, calls: 0, cost_micro: 0, total_tokens: 0, latency_sum_ms: 0, models: [] });
    var calls = Number(r.calls) || 0;
    b.calls += calls;
    b.cost_micro += Number(r.cost_micro) || 0;
    b.total_tokens += Number(r.total_tokens) || 0;
    b.latency_sum_ms += Number(r.latency_sum_ms) || 0;
    b.models.push({ model: r.model, calls: calls });
  });
  return Object.keys(buckets)
    .map(function (k) {
      var b = buckets[k];
      b.avg_latency_ms = b.calls ? Math.round(b.latency_sum_ms / b.calls) : 0;
      b.cost_formatted = formatCost(b.cost_micro);
      b.models.sort(function (a, b2) { return b2.calls - a.calls; });
      return b;
    })
    .sort(function (a, b) { return b.calls - a.calls; });
}

export async function onRequestGet(context) {
  var denied = requireAdmin(context);
  if (denied) return denied;

  var env = context.env;
  var url = new URL(context.request.url);
  var days = clamp(toInt(url.searchParams.get('days'), 7), 1, 90);

  var flags = await getFlags(env, { fresh: false });
  var summary = await summarizeLogs(env, { days: days });
  var prewarm = await prewarmStatus(env);
  var stats = libraryStats();
  var storage = storageMode(env);

  var s = summary.summary || {};
  var calls = Number(s.calls) || 0;
  var byModel = withLatency(summary.byModel);
  var byProvider = aggregateByProvider(summary.byModel);
  var byFeature = withLatency(summary.byFeature);

  var degradedFields = [];
  if (!summary.byDay) degradedFields.push('byDay');
  if (!summary.byModel) degradedFields.push('byModel');
  if (summary.storage !== 'd1') degradedFields.push('storage:' + (summary.storage || 'unknown'));

  var limits = quotaDefaults(env);
  var tiers = TIERS.map(function (t) {
    var cfg = tierConfig(env, t);
    /* 单位成本：按当前计价表估算「1 次典型调用」的成本，供定价与预算参考 */
    var est = computeCost(env, cfg.model, 800, 400);
    return {
      tier: t,
      label: cfg.label,
      model: cfg.model,
      maxTokens: cfg.maxTokens,
      timeoutMs: cfg.timeoutMs,
      estCostMicroPerCall: est,
      estCostFormatted: formatCost(est)
    };
  });

  return ok(
    {
      days: days,
      generatedAt: new Date().toISOString(),
      storage: storage,
      degradedFields: degradedFields,

      /* ---- 用量与成本（B-20 / B-41 ~ B-43） ---- */
      usage: {
        calls: calls,
        totalTokens: s.totalTokens || 0,
        promptTokens: s.promptTokens || 0,
        completionTokens: s.completionTokens || 0,
        costMicro: s.costMicro || 0,
        costYuan: s.costYuan || ((Number(s.costMicro) || 0) / 1000000).toFixed(6),
        costFormatted: formatCost(Number(s.costMicro) || 0),
        cachedCalls: s.cached || 0,
        degradedCalls: s.degraded || 0,
        cacheHitRatio: ratio(s.cached, calls),
        degradeRatio: ratio(s.degraded, calls)
      },
      byDay: summary.byDay || [],
      byModel: byModel,
      byProvider: byProvider,
      byFeature: byFeature,

      /* ---- 预生成与预热（B-15） ---- */
      prewarm: {
        kvAvailable: !!prewarm.kvAvailable,
        total: prewarm.total || 0,
        done: prewarm.done || 0,
        pending: Math.max(0, (prewarm.total || 0) - (prewarm.done || 0)),
        lastRun: prewarm.lastRun || null
      },

      /* ---- 数据规模（RAG 唯一事实来源与术语库） ---- */
      data: {
        aircraft: stats.count || aircraftBriefs().length,
        aircraftMeta: RAG_META,
        glossary: listTerms().length,
        glossaryMeta: GLOSSARY_META,
        byCountry: stats.byCountry || {},
        byTag: stats.byTag || {}
      },

      /* ---- 运行配置与开关（B-13 / B-19） ---- */
      tiers: tiers,
      upstreams: providerCatalog(env),
      models: modelAllowlist(env),
      flags: flags,
      limits: limits,
      pricing: pricingTable(env)
    },
    baseHeaders(context)
  );
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: baseHeaders(context) });
}

export async function onRequest(context) {
  var m = context.request.method;
  if (m === 'OPTIONS') return onRequestOptions(context);
  if (m === 'GET' || m === 'HEAD') return onRequestGet(context);
  return methodNotAllowed('GET, OPTIONS', baseHeaders(context));
}
