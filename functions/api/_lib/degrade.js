/**
 * 降级与兜底模块
 *
 * 触发降级的场景（全部返回 HTTP 200 + X-AI-Degraded: 1，前端不白屏）：
 *   1) 目标 provider 未配置上游密钥（kimi：MOONSHOT_API_KEY / KIMI_API_KEY；
 *      zhipu：ZHIPU_API_KEY / ZHIPU_BIGMODEL_API_KEY / GLM_API_KEY —— 均缺失）
 *   2) 上游超时 / 网络异常
 *   3) 上游 5xx
 *   4) 上游 429 且串行队列指数退避重试耗尽（rate_limit_reached_error，账号并发上限 1）
 *   5) 排队等待超时（队列被占满，kind = busy）
 *   6) 上游响应无法解析（非 JSON / 缺 content）
 *   7) 熔断开启（连续失败超阈值 或 AI_DISABLED=1 / ai_flags.ai_enabled=0）
 *   8) 维护模式
 *   9) 限流且开启了软限流（rate_soft）
 *  10) 上游额度耗尽（HTTP 402 / 智谱 1113「余额不足或无可用资源包」/ Moonshot 余额不足，
 *      kind = quota）——不可重试，直接降级，避免被队列当成 429 反复退避
 *
 * 注意：单独一次 429 不降级——队列层会先指数退避重试并向前端回传「排队中 / 重试中」，
 *       只有重试耗尽才落到 ratelimited 兜底文案。额度耗尽与 429 限流必须区分。
 *
 * 非降级（应如实回传错误）：上游 4xx（参数 / 权限问题）→ 502 upstream_error。
 */

export const DEGRADE_KINDS = ['unavailable', 'maintenance', 'ratelimited', 'notconfigured', 'circuit', 'busy', 'quota'];

const FALLBACK_TEXTS = {
  unavailable: [
    '（AI 服务正在维护中）暂时无法生成内容，请稍后重试。您仍可正常浏览馆藏机型资料与图鉴页面。',
    '（AI 服务暂时不可用）本次生成未能完成，稍后再试即可。提示：机型库、图鉴与收藏功能不受影响。',
    '（AI 助手离线中）后台模型接口暂时没有响应，请稍后再来。'
  ],
  maintenance: [
    '（AI 服务维护中）后台正在进行例行维护，AI 助手稍后恢复。机型资料与图鉴浏览不受影响。'
  ],
  ratelimited: [
    '（AI 调用过于频繁）已达到当前时间窗的使用上限，请稍后重试。短时间内可继续浏览站内机型资料。'
  ],
  notconfigured: [
    '（AI 服务未就绪）服务端尚未完成模型配置，请联系站点管理员。'
  ],
  circuit: [
    '（AI 服务已暂时熔断）上游模型连续异常，已自动暂停 AI 调用以保护服务，请稍后重试。'
  ],
  busy: [
    '（AI 正在排队）当前同时使用的人较多，你的问题已进入队列，请稍等片刻再试一次。机型资料浏览不受影响。'
  ],
  quota: [
    '（AI 服务额度不足）后台模型账户的可用额度已用尽，暂时无法生成内容，请联系站点管理员补充额度。机型资料与图鉴浏览不受影响。',
    '（AI 服务额度已用尽）模型接口当前没有可用额度，本次生成未能完成，请联系站点管理员。其他页面功能均正常。'
  ]
};

export function pickFallback(seed, kind) {
  var list = FALLBACK_TEXTS[kind] || FALLBACK_TEXTS.unavailable;
  var s = String(seed || '');
  var sum = 0;
  for (var i = 0; i < s.length; i++) sum = (sum + s.charCodeAt(i)) % 9973;
  return list[sum % list.length];
}

export function fallbackTexts() {
  return FALLBACK_TEXTS;
}

/* ------------------------------------------------------------------ */
/* 降级响应构造                                                        */
/* ------------------------------------------------------------------ */

export function buildFallbackPayload(text, model, kind, extra) {
  return Object.assign(
    {
      id: 'chatcmpl-local-fallback',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model || 'local-fallback',
      _degraded: true,
      _degrade_kind: kind || 'unavailable',
      _message: 'AI 服务暂时不可用，已返回本地兜底内容',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop'
        }
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    },
    extra || {}
  );
}

export function degradeJson(text, model, kind, headers) {
  return new Response(JSON.stringify(buildFallbackPayload(text, model, kind)), {
    status: 200,
    headers: Object.assign(
      {
        'Content-Type': 'application/json; charset=utf-8',
        'X-AI-Degraded': '1',
        'X-AI-Degrade-Kind': kind || 'unavailable',
        'Cache-Control': 'no-store'
      },
      headers || {}
    )
  });
}

/* ------------------------------------------------------------------ */
/* 队列状态 SSE 事件（前端据此显示「排队中 / 重试中」）                    */
/* ------------------------------------------------------------------ */

/**
 * 队列状态事件。采用自定义 SSE 事件名 `ai.queue`，与 OpenAI 兼容的
 * `data: {...}` 数据帧共存，前端可安全忽略（老前端不受影响）。
 *
 * stage 取值：queued（已入队）/ running（获得通道，开始调用）/ retrying（429 退避重试中）
 */
export function sseQueueEvent(info) {
  var i = info || {};
  var payload = {
    object: 'ai.queue',
    stage: i.stage || 'queued',
    message: i.message || queueStageText(i.stage, i.retryAfterMs),
    attempt: i.attempt || 0,
    waitMs: i.waitMs || 0,
    retryAfterMs: i.retryAfterMs || 0,
    model: i.model || '',
    tier: i.tier || '',
    provider: i.provider || '',
    at: Math.floor(Date.now() / 1000)
  };
  return 'event: ai.queue\ndata: ' + JSON.stringify(payload) + '\n\n';
}

export function queueStageText(stage, retryAfterMs) {
  if (stage === 'queued') return '已进入 AI 队列，正在等待空闲通道…';
  if (stage === 'running') return '已获得通道，正在请求模型…';
  if (stage === 'retrying') {
    var sec = Math.max(1, Math.round((retryAfterMs || 0) / 1000));
    return '通道繁忙（429），' + sec + ' 秒后自动重试…';
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* SSE 构造（降级与缓存回放共用）                                       */
/* ------------------------------------------------------------------ */

export function sseHeaders(extra) {
  return Object.assign(
    {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    },
    extra || {}
  );
}

export function sseChunk(content, model, opts) {
  var o = opts || {};
  var chunk = {
    id: o.id || 'chatcmpl-local',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model || 'local',
    choices: [{ index: 0, delta: { content: content }, finish_reason: null }]
  };
  if (o.degraded) chunk._degraded = true;
  return 'data: ' + JSON.stringify(chunk) + '\n\n';
}

export function sseDone(model, opts) {
  var o = opts || {};
  var tail = {
    id: o.id || 'chatcmpl-local',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model || 'local',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
  };
  return 'data: ' + JSON.stringify(tail) + '\n\n' + 'data: [DONE]\n\n';
}

export function degradeSse(text, model, kind, headers) {
  var body =
    sseChunk(text, model, { degraded: true, id: 'chatcmpl-local-fallback' }) +
    sseDone(model, { id: 'chatcmpl-local-fallback' });
  return new Response(body, {
    status: 200,
    headers: Object.assign(sseHeaders(), { 'X-AI-Degraded': '1', 'X-AI-Degrade-Kind': kind || 'unavailable' }, headers || {})
  });
}

/**
 * 把一段完整文本以 SSE 分片形式回放。
 * 用途：流式请求命中缓存时，无需再调上游，直接把缓存答案按句切分流式返回。
 * 效果：前端体验与真实流式一致，成本为 0。
 */
export function sseFromText(text, model, opts) {
  var o = opts || {};
  var pieces = splitForStream(text);
  var body = '';
  if (o.role !== false) {
    body += sseChunk('', model, { id: o.id }) ;
  }
  for (var i = 0; i < pieces.length; i++) {
    body += sseChunk(pieces[i], model, { id: o.id });
  }
  body += sseDone(model, { id: o.id });
  return new Response(body, {
    status: 200,
    headers: Object.assign(sseHeaders(), o.headers || {})
  });
}

/** 按标点与长度切分，保证分片自然（避免把数字/英文词切断） */
export function splitForStream(text, maxLen) {
  var limit = maxLen || 48;
  var s = String(text || '');
  if (!s) return [];
  var out = [];
  var buf = '';
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    buf += ch;
    var isBreak = '。！？；\n'.indexOf(ch) >= 0 || (buf.length >= limit && '，、,. )）'.indexOf(ch) >= 0) || buf.length >= limit * 2;
    if (isBreak) {
      out.push(buf);
      buf = '';
    }
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * 包装上游流式响应：透传给前端的同时累积完整文本，用于流结束后写入缓存与日志。
 * @returns {{ response: Response, getText: function():string }}
 */
export function teeStream(upstreamBody, onDone) {
  var accumulated = '';
  var decoder = new TextDecoder();
  var encoder = new TextEncoder();
  var transform = new TransformStream({
    transform: function (chunk, controller) {
      controller.enqueue(chunk);
      try {
        var text = decoder.decode(chunk, { stream: true });
        var lines = text.split('\n');
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (line.indexOf('data:') !== 0) continue;
          var payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            var obj = JSON.parse(payload);
            var delta = obj && obj.choices && obj.choices[0] && obj.choices[0].delta;
            if (delta && typeof delta.content === 'string') accumulated += delta.content;
          } catch (e) {
            /* 忽略无法解析的分片 */
          }
        }
      } catch (e) {
        /* 解码失败忽略，不影响透传 */
      }
    },
    flush: function () {
      try {
        if (typeof onDone === 'function') onDone(accumulated);
      } catch (e) {
        /* 回调异常不影响响应 */
      }
    }
  });
  return { response: upstreamBody.pipeThrough(transform), getText: function () { return accumulated; } };
}

export { encoderNoop };
function encoderNoop() {}
