/**
 * GET /api/aircraft —— 机型库只读数据接口（非 AI 数据接口，对应条目 B-09 函数层扩面）
 *
 * 查询参数：
 *   slug     读取单个机型完整资料（含参数、历史、技术特点、趣闻）
 *   q        关键词检索（复用 RAG 检索器，返回命中的机型摘要）
 *   limit    检索返回条数，默认 5，上限 20
 *   stats    传 1 返回机型库统计（国别分布、标签分布）
 *   dryRun   （仅写入类接口使用，本接口不涉及）
 *
 * 特性：纯只读、可长缓存、无令牌要求（数据接口不需要短期令牌，仅受限流保护）。
 * 写入类接口见 /api/data（默认关闭）。
 */

import {
  ERR,
  ok,
  fail,
  methodNotAllowed,
  resolveCors,
  corsPreflight,
  toInt,
  getClientIp,
  hashId
} from './_lib/http.js';
import { aircraftBriefs, aircraftDetail, searchAircraft, libraryStats, RAG_META } from './_lib/rag.js';
import { checkRateLimit, rateLimitHeaders, buildScopes } from './_lib/ratelimit.js';
import { getFlags } from './_lib/flags.js';

export async function onRequestOptions(context) {
  return corsPreflight(context.request, context.env, { methods: 'GET, OPTIONS' });
}

export async function onRequestGet(context) {
  var request = context.request;
  var env = context.env || {};
  var cors = resolveCors(request, env, { methods: 'GET, OPTIONS' });
  if (cors.hasOrigin && !cors.ok) return fail(ERR.FORBIDDEN_ORIGIN, '请求来源不在白名单内', 403, cors.headers);

  var flags = await getFlags(env);
  if (!flags.ai_read) return fail(ERR.MAINTENANCE, '数据接口当前不可用', 503, cors.headers);

  var ipHash = await hashId(getClientIp(request), env);
  var rate = await checkRateLimit(env, buildScopes(env, { ipHash: ipHash }, 'readonly'));
  if (!rate.ok) {
    return fail(ERR.RATE_LIMITED, '查询过于频繁，请稍后重试', 429, Object.assign({}, cors.headers, rateLimitHeaders(rate)));
  }

  var url = new URL(request.url);
  var slug = url.searchParams.get('slug') || '';
  var q = url.searchParams.get('q') || '';
  var wantStats = url.searchParams.get('stats') === '1';
  var limit = Math.min(20, Math.max(1, toInt(url.searchParams.get('limit'), 5)));
  var headers = Object.assign({}, cors.headers, { 'Cache-Control': 'public, max-age=600' });

  if (slug) {
    var doc = aircraftDetail(slug);
    if (!doc) return fail(ERR.NOT_FOUND, '未找到该机型（slug 不匹配站内机型库）', 404, headers, { slug: slug });
    return ok({ aircraft: doc, source: RAG_META.source }, headers);
  }

  if (wantStats) {
    return ok({ stats: libraryStats(), source: RAG_META.source }, headers);
  }

  if (q) {
    var res = searchAircraft(q, limit);
    return ok(
      {
        query: q,
        count: res.hits.length,
        miss: res.miss,
        maybeMissing: res.maybeMissing,
        items: res.hits.map(function (h) {
          return {
            slug: h.slug,
            code: h.code,
            nameZh: h.nameZh,
            nameEn: h.nameEn,
            country: h.doc.country,
            category: h.doc.category,
            tags: h.doc.tags || [],
            score: h.score
          };
        }),
        note: res.miss ? '库内无记录' : ''
      },
      headers
    );
  }

  return ok(
    {
      meta: RAG_META,
      count: aircraftBriefs().length,
      items: aircraftBriefs(),
      hint: '使用 ?slug=xxx 读取单个机型完整资料，?q=关键词 检索，?stats=1 查看分布'
    },
    headers
  );
}

export async function onRequest(context) {
  return methodNotAllowed(['GET', 'OPTIONS'], resolveCors(context.request, context.env, { methods: 'GET, OPTIONS' }).headers);
}
