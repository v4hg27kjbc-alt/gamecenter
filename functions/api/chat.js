/**
 * POST /api/chat —— AI 对话主入口
 *
 * 串联全部服务端 AI 能力：
 *   短期令牌校验 → 边缘限流 → 分级模型路由 → 旗舰档每日额度 → 知识锚定(RAG) + 术语注入
 *   → 请求指纹缓存 → 预生成兜底 → 上游调用(SSE/非流式) → 降级兜底 → 日志与成本核算
 *
 * 旗舰档额度（kimi-k3）：
 *   仅 tier=flagship 且 provider=kimi 计入；按访客（ai_vid，缺失时 IP 哈希兜底）每日 N 次（默认 5）；
 *   跨天自动重置；缓存命中 / 预生成命中 / 图片识图档 / 降级兜底均不计数。
 *   正常响应体带 quota 字段（limit/used/remaining）；超限直接 429 + error=quota_exceeded，不降级。
 *
 * 请求（JSON）：
 *   messages   Array  必需，[{role:'user'|'assistant', content:string|Array}]
 *   feature    string 可选，chat|photo|compare|translate|summary|story（用于开关与统计）
 *   provider   string 可选，kimi|zhipu（上游选择；缺省走 kimi，老调用方无需改动）
 *   tier       string 可选，light|flagship|vision（显式分档）
 *   model      string 可选，须在服务端白名单内（AI_MODEL_ALLOWLIST / ZHIPU_MODEL_ALLOWLIST 可扩充）
 *   stream     bool   可选，默认 false
 *   max_tokens / temperature / top_p  可选，服务端二次裁剪
 *   useCache   bool   可选，默认 true
 *
 * 请求头：X-AI-Token（必需）、X-Visitor-Id 或 ai_vid Cookie（访客标识）
 *
 * 响应：见《接口契约》文档；非流式返回 JSON，流式为 OpenAI 兼容 SSE。
 */

import {
  ERR,
  ok,
  fail,
  methodNotAllowed,
  resolveCors,
  corsPreflight,
  readJsonBody,
  getClientIp,
  resolveVisitorId,
  hashId,
  newRequestId,
  nowSec,
  toInt,
  normalizeText
} from './_lib/http.js';
import { requireToken, tokenFailResponse } from './_lib/auth.js';
import { checkRateLimit, rateLimitHeaders, buildScopes } from './_lib/ratelimit.js';
import { getFlags } from './_lib/flags.js';
import { resolveTier, resolveGenerationParams, validateMessages, lastUserText, alternateConfig } from './_lib/router.js';
import { buildChatContext, messagesForUpstream, digestAnswer, NO_RECORD_TEXT } from './_lib/context.js';
import { buildFingerprint, imageHashOf, cacheEnabled, cacheGet, cachePut } from './_lib/cache.js';
import { callUpstream, parseCompletion, usageTokens } from './_lib/upstream.js';
import { logCall, logAsk, computeCost } from './_lib/logging.js';
import { getPrewarmAnswer } from './_lib/prewarm.js';
import {
  isFlagshipRoute,
  resolveQuotaScope,
  readQuota,
  consumeQuota,
  quotaPayload,
  quotaHeaders,
  quotaExceededResponse
} from './_lib/quota.js';
import { degradeJson, degradeSse, sseFromText, sseQueueEvent, sseChunk, sseDone, pickFallback } from './_lib/degrade.js';

const FEATURES = ['chat', 'photo', 'compare', 'translate', 'summary', 'code', 'story'];
const DEGRADE_CACHE_TTL = 60;

/**
 * 主站形态的降级响应（HTTP 200 + ok:true）。
 *
 * 与成功响应同构：ok:true + answer + degraded/degradeKind，前端 AIBridge 据此识别
 * 降级并自动改走其它上游（跨上游兜底）；不识别 degraded 的老前端代码也能照常读到
 * answer 并渲染兜底文案，避免把「已降级的 200」误判成「接口失败」而报连接错误。
 */
function degradeSite(text, kind, headers, route, requestId) {
  return ok(
    {
      answer: text,
      model: 'local-fallback',
      provider: 'local-fallback',
      tier: (route && route.tier) || '',
      routeReason: (route && route.reason) || '',
      cached: false,
      cacheSource: '',
      rag: null,
      glossary: null,
      degraded: true,
      degradeKind: kind || 'unavailable',
      /* 维护 / 熔断 属于「刻意关闭」类降级：前端不得再跨上游兜底绕过开关。
         notconfigured（某家上游未配密钥）不拦截——站点显式指定 provider 时，
         必须允许改走另一家上游，否则该功能会直接变成不可用。 */
      noFallback: !!(kind === 'maintenance' || kind === 'circuit'),
      noRecord: true,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      cost: { micro: 0, yuan: '0.000000' },
      latencyMs: 0,
      requestId: requestId
    },
    headers
  );
}

export async function onRequestOptions(context) {
  return corsPreflight(context.request, context.env, { methods: 'POST, OPTIONS' });
}

export async function onRequestPost(context) {
  return handleChat(context, {});
}

export async function onRequest(context) {
  return methodNotAllowed(['POST', 'OPTIONS'], resolveCors(context.request, context.env, { methods: 'POST, OPTIONS' }).headers);
}

/**
 * 主处理逻辑。抽成独立函数，便于 /api/ai 兼容层复用。
 * @param {object} context Pages Functions 上下文
 * @param {object} options { compat:true 时按 OpenAI 格式返回 }
 */
export async function handleChat(context, options) {
  var o = options || {};
  var request = context.request;
  var env = context.env || {};
  var started = Date.now();
  var requestId = newRequestId('chat');

  var cors = resolveCors(request, env, { methods: 'POST, OPTIONS' });
  if (cors.hasOrigin && !cors.ok) {
    return fail(ERR.FORBIDDEN_ORIGIN, '请求来源不在白名单内', 403, cors.headers);
  }
  if (request.method !== 'POST') {
    return methodNotAllowed(['POST', 'OPTIONS'], cors.headers);
  }

  /* ---------- 1. 功能开关 ---------- */
  var flags = await getFlags(env);
  if (!flags.ai_enabled || !flags.ai_chat) {
    var flagKind = flags.ai_enabled ? 'maintenance' : 'circuit';
    if (o.compat) return compatDegrade(pickFallback(requestId, flagKind), flagKind, cors.headers);
    return degradeSite(pickFallback(requestId, flagKind), flagKind, cors.headers, null, requestId);
  }

  /* ---------- 2. 访客与短期令牌 ---------- */
  var visitorId = resolveVisitorId(request, context, env.AI_VISITOR_COOKIE || 'ai_vid');
  if (!visitorId) {
    return fail(ERR.INVALID_VISITOR, '缺少有效访客标识，请先获取访客 ID', 400, cors.headers, { action: 'GET /api/token?bootstrap=1' });
  }
  var tokenCheck = await requireToken(request, context, { scope: 'chat' });
  if (!tokenCheck.ok) return tokenFailResponse(tokenCheck.reason, cors.headers);

  /* ---------- 3. 限流 ---------- */
  var ipRaw = getClientIp(request);
  var ipHash = await hashId(ipRaw, env);
  var visitorHash = await hashId(visitorId, env);
  var rate = await checkRateLimit(env, buildScopes(env, { ipHash: ipHash, visitorHash: visitorHash }, 'chat'));
  if (!rate.ok) {
    return fail(ERR.RATE_LIMITED, '调用过于频繁，请稍后重试', 429, Object.assign({}, cors.headers, rateLimitHeaders(rate)));
  }

  /* ---------- 4. 请求体 ---------- */
  var body = await readJsonBody(request, toInt(env.AI_MAX_BODY_BYTES, 2 * 1024 * 1024));
  if (body.error) return fail(body.error, body.message, body.error === ERR.PAYLOAD_TOO_LARGE ? 413 : 400, cors.headers);
  var input = body.data || {};

  var validated = validateMessages(input.messages, env);
  if (!validated.ok) return fail(validated.error, validated.detail || 'messages 校验失败', 400, cors.headers);

  var feature = FEATURES.indexOf(String(input.feature || '')) >= 0 ? String(input.feature) : 'chat';

  /* ---------- 5. 分级路由（含上游 provider 选择：缺省 kimi，向后兼容） ---------- */
  var route = resolveTier(
    {
      provider: input.provider,
      tier: input.tier,
      model: input.model,
      feature: feature,
      messages: validated.messages,
      wantDetail: input.wantDetail
    },
    env
  );
  if (route.invalid) {
    var invalidText = '未知的分档标识';
    if (route.reason === ERR.MODEL_NOT_ALLOWED) invalidText = '模型不在白名单内';
    else if (route.reason === ERR.PROVIDER_UNKNOWN) invalidText = '未知的上游标识（可选值：kimi / zhipu，缺省为 kimi）';
    return fail(route.reason, invalidText, 400, cors.headers);
  }
  if (route.tier === 'vision' && (!flags.ai_vision || feature === 'photo' && !flags.ai_vision)) {
    return fail(ERR.FEATURE_DISABLED, '图片识别功能当前已关闭', 403, cors.headers);
  }
  var params = resolveGenerationParams(input, route.config, env);
  var wantStream = (input.stream === true || (env.AI_STREAM_DEFAULT === '1' && input.stream !== false)) && flags.ai_stream !== false;

  /* ---------- 5.5 旗舰档（kimi-k3）每日额度 ----------
   * 只有 tier=flagship 且 provider=kimi 才计数；其余档位（light / vision / code、zhipu）只读回传不计数。
   * 额度用尽 → 直接 429 + quota_exceeded，绝不静默降级到其它模型。
   * 计数时机为「上游成功返回之后」，故缓存命中 / 预生成命中 / 降级兜底都不消耗额度。
   */
  var flagshipCall = isFlagshipRoute(route.tier, route.provider);
  var quotaScopeRef = await resolveQuotaScope(env, { visitorId: visitorId, ip: ipRaw });
  var quotaState = await readQuota(env, quotaScopeRef);
  if (flagshipCall && quotaState.enabled && quotaState.remaining <= 0) {
    safeLog(context, {
      feature: feature,
      tier: route.tier,
      routeReason: route.reason,
      model: route.model,
      stream: wantStream ? 1 : 0,
      cached: false,
      ragHit: false,
      degraded: false,
      status: 429,
      errorCode: ERR.QUOTA_EXCEEDED,
      quotaUsed: quotaState.used,
      quotaLimit: quotaState.limit,
      latencyMs: Date.now() - started,
      requestId: requestId,
      visitorHash: visitorHash,
      ipHash: ipHash
    });
    return quotaExceededResponse(quotaState, cors.headers);
  }

  /* ---------- 6. 上下文（RAG + 术语） ---------- */
  var ctx = await buildChatContext(env, validated.messages, {
    feature: feature,
    ragEnabled: flags.ai_rag !== false,
    glossaryEnabled: flags.ai_glossary !== false
  });
  var upstreamMessages = messagesForUpstream(validated.messages, ctx.systemPrompt);

  var userText = normalizeText(lastUserText(validated.messages));
  var baseHeaders = Object.assign({}, cors.headers, quotaHeaders(quotaState), {
    'X-Request-Id': requestId,
    'X-AI-Model': route.model,
    'X-AI-Tier': route.tier,
    'X-AI-Provider': route.provider,
    'X-AI-Route': route.reason,
    'X-AI-RAG': ctx.rag.hit ? 'HIT:' + ctx.rag.docsCount : 'MISS',
    'Cache-Control': 'no-store'
  });

  /* ---------- 7. 指纹缓存 ---------- */
  var useCache = input.useCache !== false && flags.ai_cache !== false;
  var imageHash = validated.hasImage ? await imageHashOf(validated.messages) : '';
  var fp = '';
  var cacheEligible = useCache && cacheEnabled(env, validated.hasImage);

  if (useCache) {
    fp = await buildFingerprint({
      messages: validated.messages,
      model: route.model,
      tier: route.tier,
      params: params,
      systemPrompt: ctx.systemPrompt,
      imageHash: imageHash,
      ragStamp: ctx.stamps.rag,
      glossaryStamp: ctx.stamps.glossary
    });
  }

  if (cacheEligible && fp) {
    var cached = await cacheGet(env, fp);
    if (cached.hit && cached.entry && cached.entry.answer) {
      var hitEntry = cached.entry;
      var degradeKindCached = normalizeDegradeKind(hitEntry.degradeKind) || (hitEntry.source === 'degrade' ? 'unavailable' : '');
      var hitHeaders = Object.assign({}, baseHeaders, {
        'X-AI-Cache': 'HIT',
        'X-AI-Cache-Source': cached.source,
        'X-AI-RAG': hitEntry.ragHit ? 'HIT:' + (hitEntry.ragDocs || 0) : baseHeaders['X-AI-RAG'],
        'X-AI-Degraded': degradeKindCached ? '1' : '0'
      });
      if (degradeKindCached) hitHeaders['X-AI-Degrade-Kind'] = degradeKindCached;
      safeLog(context, {
        feature: feature,
        tier: route.tier,
        routeReason: route.reason,
        model: hitEntry.model || route.model,
        stream: wantStream ? 1 : 0,
        cached: true,
        ragHit: hitEntry.ragHit || ctx.rag.hit,
        ragDocs: hitEntry.ragDocs || ctx.rag.docsCount,
        glossaryHits: ctx.glossary.count,
        degraded: !!degradeKindCached,
        degradeKind: degradeKindCached,
        status: 200,
        latencyMs: Date.now() - started,
        fp: fp,
        requestId: requestId,
        visitorHash: visitorHash,
        ipHash: ipHash
      });
      if (wantStream) {
        return sseFromText(hitEntry.answer, hitEntry.model || route.model, { id: 'chatcmpl-cache', headers: hitHeaders });
      }
      if (o.compat) {
        return compatJson(hitEntry.answer, hitEntry.model || route.model, hitHeaders, { cached: true, degraded: !!degradeKindCached });
      }
      return ok(
        {
          answer: hitEntry.answer,
          model: hitEntry.model || route.model,
          tier: hitEntry.tier || route.tier,
          routeReason: route.reason,
          feature: feature,
          cached: true,
          cacheSource: cached.source,
          quota: quotaPayload(quotaState),
          rag: ragSummary(ctx),
          glossary: glossarySummary(ctx),
          degraded: !!degradeKindCached,
          degradeKind: degradeKindCached,
          noRecord: ctx.noRecordNotice || undefined,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          cost: { micro: 0, yuan: '0.000000' },
          latencyMs: Date.now() - started,
          requestId: requestId
        },
        hitHeaders
      );
    }
  }

  /* ---------- 8. 预生成二次保障 ---------- */
  if (flags.ai_prewarm !== false && userText) {
    var pw = await getPrewarmAnswer(env, userText, route.model, route.tier);
    if (pw.hit && pw.entry && pw.entry.answer) {
      if (cacheEligible && fp) {
        await cachePut(env, fp, Object.assign({}, pw.entry), undefined);
      }
      var pwHeaders = Object.assign({}, baseHeaders, { 'X-AI-Cache': 'HIT', 'X-AI-Cache-Source': 'prewarm', 'X-AI-Degraded': '0' });
      safeLog(context, {
        feature: feature,
        tier: route.tier,
        routeReason: route.reason,
        model: pw.entry.model,
        stream: wantStream ? 1 : 0,
        cached: true,
        ragHit: pw.entry.ragHit || ctx.rag.hit,
        ragDocs: pw.entry.ragDocs || ctx.rag.docsCount,
        glossaryHits: ctx.glossary.count,
        degraded: false,
        status: 200,
        latencyMs: Date.now() - started,
        fp: fp,
        requestId: requestId,
        visitorHash: visitorHash,
        ipHash: ipHash
      });
      if (wantStream) return sseFromText(pw.entry.answer, pw.entry.model, { id: 'chatcmpl-prewarm', headers: pwHeaders });
      if (o.compat) return compatJson(pw.entry.answer, pw.entry.model, pwHeaders, { cached: true });
      return ok(
        {
          answer: pw.entry.answer,
          model: pw.entry.model,
          tier: pw.entry.tier,
          routeReason: route.reason,
          feature: feature,
          cached: true,
          cacheSource: 'prewarm',
          quota: quotaPayload(quotaState),
          rag: ragSummary(ctx),
          glossary: glossarySummary(ctx),
          degraded: false,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          cost: { micro: 0, yuan: '0.000000' },
          latencyMs: Date.now() - started,
          requestId: requestId
        },
        pwHeaders
      );
    }
  }

  /* ---------- 9. 上游调用（按 provider 分别串行排队 + 429 指数退避，各上游并发上限 1） ---------- */
  var alt = alternateConfig(env, route.config);

  if (wantStream) {
    // 流式：先立刻建立 SSE 通道回传「排队中 / 重试中」，上游就绪后原样转发
    return streamUpstream({
      context: context,
      env: env,
      flags: flags,
      route: route,
      params: params,
      upstreamMessages: upstreamMessages,
      baseHeaders: baseHeaders,
      feature: feature,
      ctx: ctx,
      userText: userText,
      fp: cacheEligible ? fp : '',
      requestId: requestId,
      visitorHash: visitorHash,
      ipHash: ipHash,
      started: started,
      alt: alt,
      flagshipCall: flagshipCall,
      quotaScope: quotaScopeRef,
      quota: quotaState
    });
  }

  var upstream = await callUpstream(env, {
    model: route.model,
    messages: upstreamMessages,
    params: params,
    stream: false,
    timeoutMs: route.config.timeoutMs,
    requestId: requestId,
    provider: route.provider,
    fallbackProvider: alt ? alt.provider : '',
    fallbackModel: alt ? alt.model : ''
  });

  if (!upstream.ok) {
    var kind = upstream.degradeKind || 'unavailable';
    var fallback = pickFallback(requestId + userText, kind);
    if (cacheEligible && fp) {
      await cachePut(env, fp, { answer: fallback, model: 'local-fallback', tier: route.tier, feature: feature, ragHit: ctx.rag.hit, ragDocs: ctx.rag.docsCount, source: 'degrade', degradeKind: kind }, DEGRADE_CACHE_TTL);
    }
    safeLog(context, {
      feature: feature,
      tier: route.tier,
      routeReason: route.reason,
      model: route.model,
      stream: wantStream ? 1 : 0,
      cached: false,
      ragHit: ctx.rag.hit,
      ragDocs: ctx.rag.docsCount,
      glossaryHits: ctx.glossary.count,
      degraded: true,
      degradeKind: kind,
      status: 200,
      errorCode: upstream.errorCode,
      latencyMs: Date.now() - started,
      fp: fp,
      requestId: requestId,
      visitorHash: visitorHash,
      ipHash: ipHash
    });
    logAskSafe(context, env, flags, {
      requestId: requestId,
      feature: feature,
      question: userText,
      answerDigest: digestAnswer(fallback, 200),
      tier: route.tier,
      model: route.model,
      cached: false,
      ragHit: ctx.rag.hit,
      degraded: true,
      visitorHash: visitorHash
    });
    var degradeHeaders = Object.assign({}, baseHeaders, { 'X-AI-Degraded': '1', 'X-AI-Degrade-Kind': kind, 'X-AI-Cache': 'MISS' });
    if (wantStream) return degradeSse(fallback, 'local-fallback', kind, degradeHeaders);
    if (o.compat) return compatDegrade(fallback, kind, degradeHeaders);
    return degradeSite(fallback, kind, degradeHeaders, route, requestId);
  }

  /* ---------- 10. 上游成功（非流式） ---------- */
  var json = null;
  try {
    json = await upstream.response.json();
  } catch (e) {
    json = null;
  }
  var parsed = parseCompletion(json);
  var latency = Date.now() - started;

  if (!parsed.ok) {
    var fallback2 = pickFallback(requestId + userText, 'unavailable');
    safeLog(context, {
      feature: feature, tier: route.tier, routeReason: route.reason, model: route.model, stream: 0, cached: false,
      ragHit: ctx.rag.hit, ragDocs: ctx.rag.docsCount, glossaryHits: ctx.glossary.count,
      degraded: true, degradeKind: 'unavailable', status: 200, errorCode: 'empty_upstream_answer',
      latencyMs: latency, fp: fp, requestId: requestId, visitorHash: visitorHash, ipHash: ipHash
    });
    var hdr2 = Object.assign({}, baseHeaders, { 'X-AI-Degraded': '1', 'X-AI-Degrade-Kind': 'unavailable' });
    if (o.compat) return compatDegrade(fallback2, 'unavailable', hdr2);
    return degradeSite(fallback2, 'unavailable', hdr2, route, requestId);
  }

  var tokens = usageTokens(parsed.usage);
  var cost = computeCost(env, route.model, tokens.prompt, tokens.completion);

  /* 旗舰档额度：上游成功返回后才计数（缓存 / 预生成 / 降级兜底都不计入） */
  if (flagshipCall) {
    quotaState = await consumeQuota(env, quotaScopeRef);
  }

  if (cacheEligible && fp) {
    await cachePut(env, fp, {
      answer: parsed.text,
      model: route.model,
      tier: route.tier,
      feature: feature,
      ragHit: ctx.rag.hit,
      ragDocs: ctx.rag.docsCount,
      source: 'live'
    }, undefined);
  }

  var successHeaders = Object.assign({}, baseHeaders, quotaHeaders(quotaState), {
    'X-AI-Cache': 'MISS',
    'X-AI-Degraded': '0',
    'X-AI-Cost': String(cost.costMicro),
    'X-AI-Latency': String(latency)
  });

  safeLog(context, {
    feature: feature, tier: route.tier, routeReason: route.reason, model: route.model, stream: 0, cached: false,
    ragHit: ctx.rag.hit, ragDocs: ctx.rag.docsCount, glossaryHits: ctx.glossary.count,
    degraded: false, status: 200, promptTokens: tokens.prompt, completionTokens: tokens.completion,
    costMicro: cost.costMicro, latencyMs: latency, fp: fp, requestId: requestId,
    visitorHash: visitorHash, ipHash: ipHash
  });
  logAskSafe(context, env, flags, {
    requestId: requestId, feature: feature, question: userText,
    answerDigest: digestAnswer(parsed.text, 200),
    tier: route.tier, model: route.model, cached: false, ragHit: ctx.rag.hit, degraded: false,
    visitorHash: visitorHash
  });

  if (o.compat) {
    return compatJson(parsed.text, route.model, successHeaders, { usage: parsed.usage });
  }
  return ok(
    {
      answer: parsed.text,
      model: route.model,
      provider: upstream.provider || route.provider,
      tier: route.tier,
      routeReason: route.reason,
      feature: feature,
      cached: false,
      cacheSource: '',
      quota: quotaPayload(quotaState),
      rag: ragSummary(ctx),
      glossary: glossarySummary(ctx),
      degraded: false,
      finishReason: parsed.finishReason || '',
      noRecord: ctx.noRecordNotice || undefined,
      usage: {
        prompt_tokens: tokens.prompt,
        completion_tokens: tokens.completion,
        total_tokens: tokens.prompt + tokens.completion
      },
      cost: { micro: cost.costMicro, yuan: (cost.costMicro / 1000000).toFixed(6), unknownPricing: cost.unknown },
      latencyMs: latency,
      requestId: requestId
    },
    successHeaders
  );
}

/* ------------------------------------------------------------------ */
/* 辅助                                                               */
/* ------------------------------------------------------------------ */

function ragSummary(ctx) {
  return {
    enabled: ctx.rag.enabled,
    hit: ctx.rag.hit,
    count: ctx.rag.docsCount,
    docs: ctx.rag.docs,
    maybeMissing: ctx.rag.maybeMissing
  };
}

function glossarySummary(ctx) {
  return { enabled: ctx.glossary.enabled, count: ctx.glossary.count, terms: ctx.glossary.terms };
}

function normalizeDegradeKind(kind) {
  return kind ? String(kind) : '';
}

function waitUntil(context, promiseFactory) {
  try {
    var p = promiseFactory();
    if (context && typeof context.waitUntil === 'function') {
      context.waitUntil(p);
    }
  } catch (e) {
    /* 后台任务异常不影响响应 */
  }
}

function safeLog(context, record) {
  waitUntil(context, function () {
    return logCall(context.env || {}, record).catch(function () {});
  });
}

function logAskSafe(context, env, flags, record) {
  if (flags && flags.ai_ask_log === false) return;
  waitUntil(context, function () {
    return logAsk(env, record).catch(function () {});
  });
}

/**
 * 流式（SSE）响应：先回传队列状态，再转发上游流。
 *
 * 之所以自行组装流而不用 teeStream：账号并发上限为 1，串行队列的等待与 429 退避
 * 期间必须先给前端可见反馈（event: ai.queue），不能让用户对着空白等待或直接吃 429。
 */
function streamUpstream(info) {
  var enc = new TextEncoder();
  var headers = Object.assign({}, info.baseHeaders, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-AI-Cache': 'MISS',
    'X-AI-Degraded': '0'
  });

  var body = new ReadableStream({
    start: function (controller) {
      var done = false;
      function send(str) {
        if (done || !str) return;
        try {
          controller.enqueue(enc.encode(str));
        } catch (e) {
          done = true;
        }
      }
      function finish() {
        if (done) return;
        done = true;
        try { controller.close(); } catch (e) { /* 忽略 */ }
      }

      (async function () {
        var queueLog = { waitMs: 0, retried: 0, exhausted: false };
        send(sseQueueEvent({ stage: 'queued', model: info.route.model, tier: info.route.tier, provider: info.route.provider }));

        var upstream = await callUpstream(info.env, {
          model: info.route.model,
          messages: info.upstreamMessages,
          params: info.params,
          stream: true,
          timeoutMs: info.route.config.timeoutMs,
          requestId: info.requestId,
          provider: info.route.provider,
          fallbackProvider: info.alt ? info.alt.provider : '',
          fallbackModel: info.alt ? info.alt.model : '',
          onQueueStatus: function (st) {
            // queue.js 的事件字段：{ state:'queued'|'running'|'retrying'|'done', position, waitedMs, attempt, retryInMs }
            var s = st || {};
            var stage = s.state === 'queued' ? 'queued' : s.state === 'retrying' ? 'retrying' : s.state === 'running' ? 'running' : '';
            if (!stage) return;
            send(sseQueueEvent({
              stage: stage,
              attempt: s.attempt || 0,
              waitMs: s.waitedMs || 0,
              retryAfterMs: s.retryInMs || 0,
              model: info.route.model,
              tier: info.route.tier,
              provider: info.route.provider
            }));
          }
        });

        if (upstream.queue) {
          queueLog.waitMs = upstream.queue.waitMs || 0;
          queueLog.retried = upstream.queue.retried || 0;
          queueLog.exhausted = !!upstream.queue.exhausted;
        }

        if (!upstream.ok) {
          var kind = upstream.degradeKind || 'unavailable';
          var fallback = pickFallback(info.requestId + info.userText, kind);
          send(sseChunk(fallback, 'local-fallback', { degraded: true, id: 'chatcmpl-local-fallback' }));
          send(sseDone('local-fallback', { id: 'chatcmpl-local-fallback' }));
          if (info.fp) {
            await cachePut(info.env, info.fp, {
              answer: fallback,
              model: 'local-fallback',
              tier: info.route.tier,
              feature: info.feature,
              ragHit: info.ctx.rag.hit,
              ragDocs: info.ctx.rag.docsCount,
              source: 'degrade',
              degradeKind: kind
            }, DEGRADE_CACHE_TTL);
          }
          await logCall(info.env, {
            feature: info.feature,
            tier: info.route.tier,
            routeReason: info.route.reason,
            model: info.route.model,
            stream: 1,
            cached: false,
            ragHit: info.ctx.rag.hit,
            ragDocs: info.ctx.rag.docsCount,
            glossaryHits: info.ctx.glossary.count,
            degraded: true,
            degradeKind: kind,
            status: 200,
            errorCode: upstream.errorCode,
            queueWaitMs: queueLog.waitMs,
            queueRetries: queueLog.retried,
            latencyMs: Date.now() - info.started,
            fp: info.fp,
            requestId: info.requestId,
            visitorHash: info.visitorHash,
            ipHash: info.ipHash
          }).catch(function () {});
          if (!info.flags || info.flags.ai_ask_log !== false) {
            await logAsk(info.env, {
              requestId: info.requestId,
              feature: info.feature,
              question: info.userText,
              answerDigest: digestAnswer(fallback, 200),
              tier: info.route.tier,
              model: info.route.model,
              cached: false,
              ragHit: info.ctx.rag.hit,
              degraded: true,
              visitorHash: info.visitorHash
            }).catch(function () {});
          }
          finish();
          return;
        }

        // 转发上游 SSE，同时收集完整正文用于缓存与日志
        var reader = upstream.response.body.getReader();
        var decoder = new TextDecoder();
        var acc = { text: '' };
        var pending = '';
        while (true) {
          var part = await reader.read();
          if (part.done) break;
          var raw = decoder.decode(part.value, { stream: true });
          send(raw);
          pending += raw;
          pending = consumeSseText(pending, acc);
        }
        finish();
        await finalizeStream(info.env, info.context, info.flags, {
          text: acc.text,
          fp: info.fp,
          route: info.route,
          feature: info.feature,
          ctx: info.ctx,
          started: info.started,
          requestId: info.requestId,
          visitorHash: info.visitorHash,
          ipHash: info.ipHash,
          question: info.userText,
          queueWaitMs: queueLog.waitMs,
          queueRetries: queueLog.retried,
          /* 旗舰档额度：流式需把计数上下文带到收尾阶段，产出正文后才扣减 */
          flagshipCall: info.flagshipCall,
          quotaScope: info.quotaScope,
          quota: info.quota
        });
      })().catch(function () {
        var fallback = pickFallback(info.requestId, 'unavailable');
        send(sseChunk(fallback, 'local-fallback', { degraded: true, id: 'chatcmpl-local-fallback' }));
        send(sseDone('local-fallback', { id: 'chatcmpl-local-fallback' }));
        finish();
      });
    }
  });

  return new Response(body, { status: 200, headers: headers });
}

/** 逐行解析上游 SSE，累计可见正文（忽略 reasoning_content 思考内容） */
function consumeSseText(buffer, acc) {
  var idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    var line = buffer.slice(0, idx).replace(/\r$/, '');
    buffer = buffer.slice(idx + 1);
    if (line.indexOf('data:') !== 0) continue;
    var payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      var j = JSON.parse(payload);
      var d = j.choices && j.choices[0] && j.choices[0].delta;
      if (d && typeof d.content === 'string') acc.text += d.content;
    } catch (e) { /* 非 JSON 心跳，忽略 */ }
  }
  return buffer;
}

/** 流式结束后补写缓存与日志（此时才拿到完整答案） */
async function finalizeStream(env, context, flags, info) {
  var text = info.text || '';
  if (!text) return;

  /* 旗舰档额度：流式成功产出正文后才计数（缓存 / 预生成 / 降级兜底都不计入） */
  var quotaAfter = info.quota;
  if (info.flagshipCall && info.quotaScope) {
    quotaAfter = await consumeQuota(env, info.quotaScope);
  }
  await cachePut(env, info.fp, {
    answer: text,
    model: info.route.model,
    tier: info.route.tier,
    feature: info.feature,
    ragHit: info.ctx.rag.hit,
    ragDocs: info.ctx.rag.docsCount,
    source: 'live'
  }, undefined);
  await logCall(env, {
    feature: info.feature,
    tier: info.route.tier,
    routeReason: info.route.reason,
    model: info.route.model,
    stream: 1,
    cached: false,
    ragHit: info.ctx.rag.hit,
    ragDocs: info.ctx.rag.docsCount,
    glossaryHits: info.ctx.glossary.count,
    degraded: false,
    status: 200,
    latencyMs: Date.now() - info.started,
    queueWaitMs: info.queueWaitMs || 0,
    queueRetries: info.queueRetries || 0,
    quotaUsed: quotaAfter && quotaAfter.enabled ? quotaAfter.used : undefined,
    quotaLimit: quotaAfter && quotaAfter.enabled ? quotaAfter.limit : undefined,
    fp: info.fp,
    requestId: info.requestId,
    visitorHash: info.visitorHash,
    ipHash: info.ipHash
  });
  if (!flags || flags.ai_ask_log !== false) {
    await logAsk(env, {
      requestId: info.requestId,
      feature: info.feature,
      question: info.question,
      answerDigest: digestAnswer(text, 200),
      tier: info.route.tier,
      model: info.route.model,
      cached: false,
      ragHit: info.ctx.rag.hit,
      degraded: false,
      visitorHash: info.visitorHash
    });
  }
}

/* ------------------------ 兼容 OpenAI 格式输出 ------------------------ */

function compatJson(text, model, headers, extra) {
  var e = extra || {};
  var payload = {
    id: 'chatcmpl-' + nowSec(),
    object: 'chat.completion',
    created: nowSec(),
    model: model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: e.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
  if (e.cached) payload._cached = true;
  if (e.degraded) payload._degraded = true;
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {})
  });
}

function compatDegrade(text, kind, headers) {
  var payload = {
    id: 'chatcmpl-local-fallback',
    object: 'chat.completion',
    created: nowSec(),
    model: 'local-fallback',
    _degraded: true,
    _degrade_kind: kind,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {})
  });
}

export { NO_RECORD_TEXT };
