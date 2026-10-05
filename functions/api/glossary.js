/**
 * GET /api/glossary —— 术语词典服务（对应条目 B-17）
 *
 * 查询参数：
 *   term   精确查询单个术语（匹配 term / 中文名 / 英文名 / 别名，大小写不敏感）
 *   q      关键词模糊检索（返回最相关的 N 条）
 *   list   传 1 输出全部术语目录（仅名称字段，体积可控）
 *   limit  模糊检索返回条数，默认 3，上限 20
 *
 * 数据来源：代码内置词典（glossary-data.js）+ D1 表 ai_glossary_term（可选覆盖层）
 * 本接口为只读接口，不涉及任何写入。
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
import {
  lookupExact,
  searchGlossary,
  listTerms,
  publicTerm,
  loadDbTerms,
  GLOSSARY_META
} from './_lib/glossary.js';
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
  if (!flags.ai_enabled || !flags.ai_read) return fail(ERR.MAINTENANCE, '数据接口当前不可用', 503, cors.headers);

  var ipHash = await hashId(getClientIp(request), env);
  var rate = await checkRateLimit(env, buildScopes(env, { ipHash: ipHash }, 'readonly'));
  if (!rate.ok) {
    return fail(ERR.RATE_LIMITED, '查询过于频繁，请稍后重试', 429, Object.assign({}, cors.headers, rateLimitHeaders(rate)));
  }

  var url = new URL(request.url);
  var term = url.searchParams.get('term') || '';
  var q = url.searchParams.get('q') || '';
  var wantList = url.searchParams.get('list') === '1';
  var limit = Math.min(20, Math.max(1, toInt(url.searchParams.get('limit'), 3)));

  var extra = await loadDbTerms(env);
  var headers = Object.assign({}, cors.headers, { 'Cache-Control': 'public, max-age=300' });

  if (wantList) {
    var terms = listTerms(extra);
    return ok(
      {
        meta: {
          version: GLOSSARY_META.version,
          count: terms.length,
          builtin: GLOSSARY_META.count,
          dbOverride: extra.length,
          scope: GLOSSARY_META.scope,
          note: GLOSSARY_META.note
        },
        terms: terms
      },
      headers
    );
  }

  if (term) {
    var exact = lookupExact(term, extra);
    if (!exact) {
      return fail(ERR.NOT_FOUND, '词典中未收录该术语（可尝试 q 参数做模糊检索）', 404, headers, { query: term, suggest: '/api/glossary?list=1' });
    }
    return ok({ term: publicTerm(exact), matched: 'exact' }, headers);
  }

  if (!q) {
    return fail(ERR.BAD_REQUEST, '请提供 term（精确）或 q（模糊）或 list=1（目录）', 400, headers);
  }

  var result = searchGlossary(q, limit, extra);
  if (result.miss) {
    return ok({ query: q, count: 0, terms: [], note: '词典中未找到匹配术语' }, headers);
  }
  return ok(
    {
      query: q,
      count: result.hits.length,
      terms: result.hits.map(function (h) {
        var t = publicTerm(h.term);
        t.score = h.score;
        return t;
      })
    },
    headers
  );
}

export async function onRequest(context) {
  return methodNotAllowed(['GET', 'OPTIONS'], resolveCors(context.request, context.env, { methods: 'GET, OPTIONS' }).headers);
}
