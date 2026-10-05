/**
 * 上游模型调用（双上游：Kimi / Moonshot + 智谱 GLM）+ 串行队列 + 熔断保护
 *
 * 上游 A（provider = kimi，默认上游，向后兼容）：
 *   月之暗面 Moonshot（OpenAI 兼容 /chat/completions）
 *   中国区：https://api.moonshot.cn/v1/chat/completions （本 Key 唯一可用区）
 *   全球区：https://api.moonshot.ai/v1（该 Key 返回 401，默认不启用，可用 AI_UPSTREAM_ENDPOINT 覆盖）
 *   密钥：仅从环境变量 MOONSHOT_API_KEY / KIMI_API_KEY / AI_UPSTREAM_KEY 读取
 *
 * 上游 B（provider = zhipu）：
 *   智谱 GLM · BigModel 开放平台（OpenAI 兼容 /api/paas/v4/chat/completions）
 *   https://open.bigmodel.cn/api/paas/v4/chat/completions
 *   密钥：仅从环境变量 ZHIPU_API_KEY（兼容 ZHIPU_BIGMODEL_API_KEY / GLM_API_KEY）读取
 *
 * 密钥红线：代码、文档、前端产物、日志中一律不出现明文，仅服务端环境变量（.dev.vars 本地 /
 *   Cloudflare Secret 线上）。对外展示一律用占位符 MOONSHOT_API_KEY / ZHIPU_API_KEY。
 *
 * 并发约束（硬性）：
 *   Moonshot 账号并发上限实测为 1，所有请求经 _lib/queue.js 串行排队；429（rate_limit_reached_error）
 *   自动指数退避重试，退避期间让出锁，绝不把 429 直接抛给访客。
 *   引入双上游后，队列按 provider 各自独立串行（互不阻塞），并发上限仍为 1。
 *
 * 保护机制：
 *   1) 串行队列（见 queue.js）：按 provider 分离的并发 1 + 排队状态回传
 *   2) 超时（AbortController，按档位 timeoutMs）
 *   3) 熔断：连续失败达阈值（AI_CIRCUIT_THRESHOLD，默认 5）→ 打开熔断
 *      AI_CIRCUIT_TTL 秒（默认 300）；期间所有请求直接降级，保护上游与自身额度
 *   4) 失败分类：明确哪些错误降级兜底、哪些如实回传
 *   5) 可选的跨上游兜底（AI_PROVIDER_FALLBACK=1，默认关闭）：主上游失败时自动改用另一上游
 *
 * 模型（Kimi 实测可用，严禁使用已下线的 moonshot-v1 全系 / kimi-k2 全系 / kimi-k2.5 /
 *   kimi-latest / kimi-thinking-preview）：
 *   kimi-k3                    旗舰，原生视觉，1M 上下文，始终思考（reasoning_effort: low|high|max）
 *   kimi-k2.6                  视觉 + 文本，256k
 *   kimi-k2.7-code             代码专用，256k
 *   kimi-k2.7-code-highspeed   代码专用（高速版），256k
 *
 * 模型（智谱，模型 id 以 /api/paas/v4/models 返回为准）：
 *   glm-4.5-air   轻量档（本项目实测跑通）
 *   glm-4.5       标准档
 *   glm-4.6       代码 / 通用
 *   glm-4.7       旗舰档
 *   glm-4.5v      视觉档（多模态）
 *   glm-5 / glm-5.x  旗舰档（模型名可用 ZHIPU_MODEL_* 环境变量覆盖后启用）
 *   注意：智谱侧模型是否可用还取决于账号资源包，未开通的模型会返回
 *   code 1113（余额不足或无可用资源包），属账号配置问题而非代码问题。
 */

import { ERR, toInt, toBool, fetchWithTimeout } from './http.js';
import { runSerial, isRateLimitBody, retryAfterMsOf } from './queue.js';

export const DEFAULT_PROVIDER = 'kimi';
export const PROVIDERS = ['kimi', 'zhipu'];

/**
 * 上游规格表：密钥变量名、端点、并发、队列锁域、placeholder 全部集中在此，
 * 新增上游只需在此登记 + 在 queue.js 登记锁域，其余代码无需改动。
 */
export const PROVIDER_SPECS = {
  kimi: {
    id: 'kimi',
    label: 'Kimi / Moonshot（月之暗面 · 中国区）',
    keyEnvs: ['MOONSHOT_API_KEY', 'KIMI_API_KEY', 'AI_UPSTREAM_KEY'],
    endpointEnv: 'AI_UPSTREAM_ENDPOINT',
    defaultEndpoint: 'https://api.moonshot.cn/v1/chat/completions',
    concurrencyEnv: 'AI_UPSTREAM_CONCURRENCY',
    defaultConcurrency: 1,
    modelEnvPrefix: 'AI_MODEL_',
    thinkingValues: ['enabled', 'disabled'],
    placeholder: 'MOONSHOT_API_KEY'
  },
  zhipu: {
    id: 'zhipu',
    label: '智谱 GLM（BigModel 开放平台）',
    keyEnvs: ['ZHIPU_API_KEY', 'ZHIPU_BIGMODEL_API_KEY', 'GLM_API_KEY'],
    endpointEnv: 'ZHIPU_UPSTREAM_ENDPOINT',
    defaultEndpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    concurrencyEnv: 'ZHIPU_UPSTREAM_CONCURRENCY',
    defaultConcurrency: 1,
    modelEnvPrefix: 'ZHIPU_MODEL_',
    // 智谱 thinking.type 仅接受 enabled / disabled（官方规格）。
    // low / high / max 属 reasoning_effort（GLM-5.2+ 才支持），不得塞进 thinking.type，
    // 否则上游按非法参数返回 4xx。effort 字面量统一由 router.zhipuThinkingOf 折算成开关。
    thinkingValues: ['enabled', 'disabled'],
    placeholder: 'ZHIPU_API_KEY'
  }
};

export const DEFAULT_ENDPOINT = PROVIDER_SPECS.kimi.defaultEndpoint;
export const CIRCUIT_OPEN_KEY = 'ai:circuit:open';
export const CIRCUIT_FAIL_KEY = 'ai:circuit:fail';

/**
 * 模型能力表：用于档位路由、视觉判定、思考参数注入与 token 上限裁剪。
 *   vision    是否支持图片输入
 *   thinking  'effort'（顶层 reasoning_effort）/ 'toggle'（thinking.type 开关）/ 'none'
 *   context   上下文窗口（供前端与自检参考）
 *   maxOutput 该模型单次输出 token 硬上限（上游规格），用于二次裁剪，防止 1210 类参数报错
 */
export const MODEL_CAPS = {
  /* ---------- 上游 A：Kimi / Moonshot ---------- */
  /* sampling：采样参数硬约束。Moonshot 新一代模型（k2.6 / k3 / k2.7-code 系列）只接受
   * temperature=1、top_p=0.95，传其它值一律 400 invalid_request_error（2026-10 实测）。
   * 服务端档位默认 temperature 为 0.3~0.6、top_p 0.9，若原样透传会导致全部上游调用失败
   * （表现为 /api/chat 恒返回 local-fallback，_degrade_kind=unavailable），故在此登记为硬约束，
   * 由 buildRequestBody 强制覆盖。新增 Moonshot 模型时务必先实测并在此登记。 */
  'kimi-k3': { provider: 'kimi', vision: true, thinking: 'effort', effort: ['low', 'high', 'max'], context: 1000000, sampling: { temperature: 1, top_p: 0.95 }, note: '旗舰 / 原生视觉 / 1M 上下文 / 始终思考' },
  'kimi-k2.6': { provider: 'kimi', vision: true, thinking: 'toggle', context: 256000, sampling: { temperature: 1, top_p: 0.95 }, note: '视觉 + 文本 / 256k' },
  'kimi-k2.7-code': { provider: 'kimi', vision: false, thinking: 'toggle', context: 256000, sampling: { temperature: 1, top_p: 0.95 }, note: '代码专用' },
  'kimi-k2.7-code-highspeed': { provider: 'kimi', vision: false, thinking: 'toggle', context: 256000, sampling: { temperature: 1, top_p: 0.95 }, note: '代码专用（高速）' },

  /* ---------- 上游 B：智谱 GLM ----------
   * maxOutput：智谱 /chat/completions 对 max_tokens 有取值范围校验（越界返回 code 1210），
   * 实测 glm-4.5-air 取值范围 [1, 98304]。同族模型按 98304 处理，如官方规格调整，
   * 可直接改此表或由 ZHIPU_MODEL_* 换模型；context 未实测者以官方文档为准。 */
  'glm-4.5-air': { provider: 'zhipu', vision: false, thinking: 'toggle', context: 128000, maxOutput: 98304, note: '智谱轻量档 / max_tokens 上限 98304（实测）' },
  'glm-4.5': { provider: 'zhipu', vision: false, thinking: 'toggle', context: 128000, maxOutput: 98304, note: '智谱标准档' },
  'glm-4.6': { provider: 'zhipu', vision: false, thinking: 'toggle', context: 128000, maxOutput: 98304, note: '智谱通用 / 代码备选档' },
  'glm-4.7': { provider: 'zhipu', vision: false, thinking: 'toggle', context: 128000, maxOutput: 98304, note: '智谱旗舰档' },
  'glm-5': { provider: 'zhipu', vision: false, thinking: 'toggle', context: 128000, maxOutput: 98304, note: '智谱旗舰档（新一代）' },
  'glm-4.5v': { provider: 'zhipu', vision: true, thinking: 'toggle', context: 128000, maxOutput: 98304, note: '智谱视觉档（多模态）' }
};

/** 已下线模型黑名单：即使被环境变量误配也要拦下，避免线上 404 */
export const RETIRED_MODELS = [
  'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k',
  'moonshot-v1-8k-vision-preview', 'moonshot-v1-32k-vision-preview', 'moonshot-v1-128k-vision-preview',
  'moonshot-v1-auto', 'kimi-k2-0711-preview', 'kimi-k2-0905-preview', 'kimi-k2-turbo-preview',
  'kimi-k2.5', 'kimi-latest', 'kimi-thinking-preview'
];

export function isRetiredModel(model) {
  var m = String(model || '').trim().toLowerCase();
  if (!m) return false;
  for (var i = 0; i < RETIRED_MODELS.length; i++) {
    if (m === RETIRED_MODELS[i]) return true;
  }
  return m.indexOf('moonshot-v1') === 0;
}

/** 模型 → provider（按能力表精确/前缀匹配；未登记者按模型名前缀猜测；完全未知返回 ''） */
export function providerOfModel(model) {
  var m = String(model || '').trim();
  if (!m) return '';
  if (MODEL_CAPS[m] && MODEL_CAPS[m].provider) return MODEL_CAPS[m].provider;
  var key = Object.keys(MODEL_CAPS).filter(function (k) { return m.indexOf(k) === 0; })[0];
  if (key && MODEL_CAPS[key].provider) return MODEL_CAPS[key].provider;
  var low = m.toLowerCase();
  if (low.indexOf('glm') === 0) return 'zhipu';
  if (low.indexOf('kimi') === 0 || low.indexOf('moonshot') === 0) return 'kimi';
  return '';
}

/* ------------------------------------------------------------------ */
/* 失败原因归类（配额耗尽 / 限流 / 未配置 / 超时 / 忙）                  */
/* ------------------------------------------------------------------ */

/**
 * 是否为「额度耗尽」类错误（不可重试，必须与 429 限流区分开）。
 *
 * 覆盖：
 *   - HTTP 402 Payment Required（Moonshot / 通用计费错误）
 *   - 智谱 BigModel 业务码 1113「余额不足或无可用资源包」、1112 / 1267 等计费类错误
 *   - 常见文案：insufficient balance / insufficient_quota / quota exceeded /
 *     billing / arrears / 余额不足 / 无可用资源包 / 欠费
 *
 * 注意：必须在 isRateLimitBody 之前判断——智谱在额度耗尽时同样返回 429，
 * 若先按限流处理会被队列反复退避重试（AI_QUEUE_MAX_RETRY 次），既浪费等待时间，
 * 又会给用户返回「调用过于频繁」的错误提示。
 */
export function isQuotaExhaustedBody(bodyText, status) {
  if (status === 402) return true;
  var s = String(bodyText || '').toLowerCase();
  if (!s) return false;
  return (
    s.indexOf('insufficient balance') >= 0 ||
    s.indexOf('insufficient_quota') >= 0 ||
    s.indexOf('insufficient quota') >= 0 ||
    s.indexOf('quota exceeded') >= 0 ||
    s.indexOf('exceeded your current quota') >= 0 ||
    s.indexOf('account is in arrears') >= 0 ||
    s.indexOf('billing') >= 0 ||
    s.indexOf('余额不足') >= 0 ||
    s.indexOf('无可用资源包') >= 0 ||
    s.indexOf('资源包') >= 0 && s.indexOf('不足') >= 0 ||
    s.indexOf('欠费') >= 0 ||
    /"code"\s*:\s*"?1113"?/.test(s) ||
    /"code"\s*:\s*"?1112"?/.test(s) ||
    /"code"\s*:\s*"?1267"?/.test(s)
  );
}

/**
 * 错误码 → 降级类型（前端兜底文案与服务端日志共用同一套取值，见 degrade.js）。
 * @param {string} errorCode ERR.* 之一
 * @param {boolean} [exhausted] 队列重试是否已耗尽
 */
export function degradeKindOf(errorCode, exhausted) {
  var code = errorCode || ERR.UPSTREAM_ERROR;
  if (code === ERR.QUOTA_EXHAUSTED || code === 'quota_exhausted') return 'quota';
  if (code === ERR.RATE_LIMITED || code === 'rate_limited' || exhausted) return 'ratelimited';
  if (code === ERR.NOT_CONFIGURED) return 'notconfigured';
  if (code === 'queue_timeout') return 'busy';
  if (code === ERR.UPSTREAM_TIMEOUT) return 'unavailable';
  return 'unavailable';
}

export function modelCaps(model) {
  var m = String(model || '').trim();
  if (MODEL_CAPS[m]) return MODEL_CAPS[m];
  var key = Object.keys(MODEL_CAPS).filter(function (k) { return m.indexOf(k) === 0; })[0];
  if (key) return MODEL_CAPS[key];
  var low = m.toLowerCase();
  if (low.indexOf('glm') === 0) {
    return { provider: 'zhipu', vision: /v$/.test(low), thinking: 'toggle', context: 128000, maxOutput: 98304, note: '未登记的智谱模型，按智谱规格兜底处理' };
  }
  return { provider: '', vision: false, thinking: 'none', context: 256000, note: '未知模型，按纯文本处理' };
}

/* ------------------------------------------------------------------ */
/* provider 解析与凭据 / 端点读取（一律只从环境变量读，绝不硬编码）      */
/* ------------------------------------------------------------------ */

/** 归一化 provider 标识；无法识别返回 ''（不抛错，交由调用方兜底） */
export function normalizeProvider(value) {
  var s = String(value == null ? '' : value).trim().toLowerCase();
  if (!s) return '';
  if (s === 'kimi' || s === 'moonshot' || s === 'moonshot-cn' || s === 'moonshot_cn') return 'kimi';
  if (s === 'zhipu' || s === 'zhipuai' || s === 'glm' || s === 'bigmodel' || s === 'bigmodel-cn') return 'zhipu';
  return '';
}

export function providerSpec(provider) {
  var id = normalizeProvider(provider) || DEFAULT_PROVIDER;
  return PROVIDER_SPECS[id] || PROVIDER_SPECS[DEFAULT_PROVIDER];
}

/**
 * 决定本次请求走哪个上游。
 * 规则：模型自身所属 provider 优先（避免 provider/model 错配导致 404）；
 *       其次用请求显式指定；再其次 AI_PROVIDER_DEFAULT；最后默认 kimi（向后兼容）。
 */
export function resolveProvider(env, requested, model) {
  var byModel = providerOfModel(model);
  if (byModel) return byModel;
  var req = normalizeProvider(requested);
  if (req) return req;
  var envDefault = normalizeProvider(env && env.AI_PROVIDER_DEFAULT);
  return envDefault || DEFAULT_PROVIDER;
}

export function providerKey(env, provider) {
  var spec = providerSpec(provider);
  for (var i = 0; i < spec.keyEnvs.length; i++) {
    var v = env && env[spec.keyEnvs[i]];
    if (v && String(v).trim()) return String(v).trim();
  }
  return '';
}

export function providerKeySource(env, provider) {
  var spec = providerSpec(provider);
  for (var i = 0; i < spec.keyEnvs.length; i++) {
    if (env && env[spec.keyEnvs[i]]) return spec.keyEnvs[i];
  }
  return 'none';
}

export function providerEndpoint(env, provider) {
  var spec = providerSpec(provider);
  return (env && env[spec.endpointEnv]) || spec.defaultEndpoint;
}

/** 上游并发上限（自检与文档展示用；队列当前按 provider 独立串行，上限恒为 1） */
export function providerConcurrency(env, provider) {
  var spec = providerSpec(provider);
  return Math.max(1, toInt(env && env[spec.concurrencyEnv], spec.defaultConcurrency));
}

/* 兼容别名：老代码/老文档里的单上游写法继续可用（等价于 provider = kimi） */
export function upstreamKey(env) {
  return providerKey(env, DEFAULT_PROVIDER);
}

export function upstreamKeySource(env) {
  return providerKeySource(env, DEFAULT_PROVIDER);
}

export function upstreamEndpoint(env) {
  return providerEndpoint(env, DEFAULT_PROVIDER);
}

/** 上游清单（供 /api/health 与文档使用；密钥只回答「来自哪个变量名」，不回显任何内容） */
export function providerCatalog(env) {
  return PROVIDERS.map(function (p) {
    var spec = PROVIDER_SPECS[p];
    var source = providerKeySource(env, p);
    return {
      provider: p,
      label: spec.label,
      configured: source !== 'none',
      keySource: source,
      endpoint: env && env[spec.endpointEnv] ? 'custom' : 'default',
      concurrency: providerConcurrency(env, p),
      default: p === DEFAULT_PROVIDER,
      models: modelCatalog(p)
    };
  });
}

/* ------------------------------------------------------------------ */
/* 熔断                                                               */
/* ------------------------------------------------------------------ */

function circuitKv(env) {
  return (env && (env.AI_CIRCUIT_KV || env.AI_RATE_KV)) || null;
}

/* 熔断按 provider 分域：单个上游连续失败只熔断该上游，另一家仍可被跨上游兜底使用。
   历史故障根因：全局单 key 熔断，任何一家抖动都会把 kimi/zhipu 一起拒掉 → 全站 AI 不可用 */
function circuitKeys(provider) {
  var p = normalizeProvider(provider) || 'global';
  return { open: CIRCUIT_OPEN_KEY + ':' + p, fail: CIRCUIT_FAIL_KEY + ':' + p };
}

export async function isCircuitOpen(env, provider) {
  var kv = circuitKv(env);
  if (!kv) return false;
  try {
    var v = await kv.get(circuitKeys(provider).open);
    return !!v;
  } catch (e) {
    return false;
  }
}

export async function recordFailure(env, provider) {
  var kv = circuitKv(env);
  if (!kv) return { open: false };
  var keys = circuitKeys(provider);
  var threshold = toInt(env.AI_CIRCUIT_THRESHOLD, 10);
  var ttl = toInt(env.AI_CIRCUIT_TTL, 90);
  try {
    var current = toInt(await kv.get(keys.fail), 0) + 1;
    if (current >= threshold) {
      await kv.put(keys.open, String(Date.now()), { expirationTtl: ttl });
      await kv.put(keys.fail, '0', { expirationTtl: ttl });
      return { open: true, count: current };
    }
    await kv.put(keys.fail, String(current), { expirationTtl: Math.max(ttl, 600) });
    return { open: false, count: current };
  } catch (e) {
    return { open: false };
  }
}

export async function recordSuccess(env, provider) {
  var kv = circuitKv(env);
  if (!kv) return;
  try {
    await kv.put(circuitKeys(provider).fail, '0', { expirationTtl: 600 });
  } catch (e) {
    /* 忽略 */
  }
}

/* ------------------------------------------------------------------ */
/* 请求构造                                                            */
/* ------------------------------------------------------------------ */

/**
 * 构造上游 /chat/completions 请求体（两家均为 OpenAI 兼容协议，差异点按 provider 抹平）。
 *
 * @param {string} model
 * @param {Array} messages 已含 system 的完整消息（多模态 content 数组原样透传）
 * @param {object} params { max_tokens, temperature, top_p, reasoning_effort, thinking, thinking_field, response_format, tools, stop, include_usage }
 * @param {boolean} stream
 * @param {string} [provider] 不传则按模型名推断
 */
export function buildRequestBody(model, messages, params, stream, provider) {
  var p = params || {};
  var caps = modelCaps(model);
  var prov = normalizeProvider(provider) || caps.provider || providerOfModel(model) || DEFAULT_PROVIDER;
  var spec = providerSpec(prov);

  var body = {
    model: model,
    messages: messages,
    stream: !!stream,
    max_tokens: p.max_tokens,
    temperature: p.temperature,
    top_p: p.top_p
  };

  // 采样参数硬约束：部分上游模型对 temperature / top_p 只接受固定值（见 MODEL_CAPS.sampling），
  // 传其它值会直接 4xx。此处按能力表强制覆盖，避免整档请求全军覆没。
  if (caps.sampling) {
    if (caps.sampling.temperature !== undefined) body.temperature = caps.sampling.temperature;
    if (caps.sampling.top_p !== undefined) body.top_p = caps.sampling.top_p;
  }

  // token 上限二次裁剪：不越上游硬上限（智谱越界会返回 code 1210）
  if (body.max_tokens !== undefined && body.max_tokens !== null && caps.maxOutput) {
    body.max_tokens = Math.min(Math.max(1, toInt(body.max_tokens, 1)), caps.maxOutput);
  }

  // 思考强度：kimi-k3 顶层 reasoning_effort（low / high / max）
  var effort = p.reasoning_effort;
  if (effort && caps.thinking === 'effort' && (caps.effort || []).indexOf(effort) >= 0) {
    body.reasoning_effort = effort;
  }

  // 思考开关：kimi-k2.6/k2.7 与智谱 GLM 均为 thinking.type；
  // 取值按 provider 各自规格放行（两家均只有 enabled / disabled）
  var allowed = spec.thinkingValues || ['enabled', 'disabled'];
  var thinkingWanted = p.thinking;
  if (prov === 'zhipu' && thinkingWanted && allowed.indexOf(thinkingWanted) < 0) {
    // 防御：智谱收到 effort 字面量（low / high / max …）时折算成开关，非法值丢弃走上游默认，
    // 严禁原样透传 thinking:{type:'high'}——上游会判非法参数返回 4xx
    var effLiteral = String(thinkingWanted).trim().toLowerCase();
    thinkingWanted = ['low', 'medium', 'high', 'max', 'xhigh', 'minimal', 'none'].indexOf(effLiteral) >= 0
      ? zhipuThinkingOf(effLiteral)
      : '';
  }
  if (thinkingWanted && allowed.indexOf(thinkingWanted) >= 0) {
    var field = p.thinking_field || 'thinking';
    if (field === 'thinking') body.thinking = { type: thinkingWanted };
    else if (field === 'enable_thinking') body.enable_thinking = thinkingWanted === 'enabled';
  }

  if (p.response_format) body.response_format = p.response_format;
  if (p.tools) body.tools = p.tools;
  if (p.tool_choice) body.tool_choice = p.tool_choice;
  if (p.stop) body.stop = p.stop;
  // 流式用量：两家均支持 stream_options.include_usage（实测）
  if (stream && p.include_usage !== false) body.stream_options = { include_usage: true };

  Object.keys(body).forEach(function (k) {
    if (body[k] === undefined) delete body[k];
  });
  return body;
}

/* ------------------------------------------------------------------ */
/* 上游调用                                                            */
/* ------------------------------------------------------------------ */

/**
 * 调用上游（自动按 provider 串行排队 + 429 指数退避）。
 *
 * @param {object} env
 * @param {object} options {
 *   model, messages, params, stream, timeoutMs, requestId, onQueueStatus, maxRetry,
 *   provider,              // 目标上游：'kimi' | 'zhipu'（不传则按 model 推断，默认 kimi）
 *   fallbackProvider,      // 可选：主上游失败后的备用上游（需 AI_PROVIDER_FALLBACK=1 才生效）
 *   fallbackModel          // 可选：备用上游对应的模型（由 router 按档位换算）
 * }
 * @returns {Promise<{ok:boolean, response?:Response, provider?:string, errorCode?:string, degradeKind?:string,
 *                    detail?:string, status?:number, failoverFrom?:string,
 *                    queue?:{waitMs:number, attempts:number, retried:number, exhausted:boolean}, queueEvents?:Array}>}
 */
export async function callUpstream(env, options) {
  var o = options || {};
  var provider = resolveProvider(env, o.provider, o.model);
  var result = await callUpstreamOnce(env, o, provider);

  // 快速恢复（2026-10-05）：无条件开启跨上游兜底，主上游抖动/排队失败时自动切换备用上游
  if (!result.ok) {
    var alt = normalizeProvider(o.fallbackProvider);
    if (alt && alt !== provider && o.fallbackModel && providerKey(env, alt)) {
      var altResult = await callUpstreamOnce(env, Object.assign({}, o, { model: o.fallbackModel }), alt);
      if (altResult.ok) {
        altResult.failoverFrom = provider;
        if (result.queue && altResult.queue) altResult.queue.failoverWaitMs = result.queue.totalMs || 0;
        return altResult;
      }
      altResult.failoverFrom = provider;
      result = altResult;
    }
  }
  return result;
}

/** 单次上游调用（不含跨上游兜底） */
async function callUpstreamOnce(env, o, provider) {
  var spec = providerSpec(provider);
  var key = providerKey(env, provider);

  if (!key) {
    return {
      ok: false,
      provider: provider,
      errorCode: ERR.NOT_CONFIGURED,
      degradeKind: 'notconfigured',
      detail: '未配置 ' + spec.placeholder + '（仅服务端环境变量，本地 .dev.vars / 线上 Cloudflare Secret）'
    };
  }
  if (!o.model) {
    return { ok: false, provider: provider, errorCode: ERR.NOT_CONFIGURED, degradeKind: 'notconfigured', detail: '未指定模型档位' };
  }
  if (provider === 'kimi' && isRetiredModel(o.model)) {
    return {
      ok: false,
      provider: provider,
      errorCode: ERR.MODEL_NOT_ALLOWED,
      degradeKind: 'notconfigured',
      detail: '模型 ' + o.model + ' 已下线，请在 AI_MODEL_* 环境变量中改用 kimi-k3 / kimi-k2.6 / kimi-k2.7-code'
    };
  }

  if (await isCircuitOpen(env, provider)) {
    return { ok: false, provider: provider, errorCode: ERR.DEGRADED, degradeKind: 'circuit', detail: '熔断已打开' };
  }

  var body = buildRequestBody(o.model, o.messages, o.params || {}, o.stream, provider);
  var timeoutMs = o.timeoutMs || 25000;
  var headers = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + key,
    Accept: o.stream ? 'text/event-stream' : 'application/json'
  };
  if (o.requestId) headers['X-Request-Id'] = o.requestId;

  var endpoint = providerEndpoint(env, provider);
  var queueEvents = [];
  var netRetry = Math.max(0, Math.min(2, toInt(env.AI_UPSTREAM_RETRY, 1)));

  var outcome = await runSerial(
    env,
    async function () {
      var lastNet = null;
      for (var attempt = 0; attempt <= netRetry; attempt++) {
        var res = await fetchWithTimeout(
          endpoint,
          { method: 'POST', headers: headers, body: JSON.stringify(body) },
          timeoutMs
        );

        if (!res.ok) {
          // 网络异常 / 超时：可重试（不计入 429 队列重试）
          lastNet = { kind: res.timedOut ? 'timeout' : 'network', detail: res.error };
          if (attempt < netRetry) continue;
          await recordFailure(env, provider);
          return {
            status: 'fail',
            errorCode: res.timedOut ? ERR.UPSTREAM_TIMEOUT : ERR.UPSTREAM_ERROR,
            detail: (lastNet && lastNet.detail) || '',
            status400: 0
          };
        }

        var status = res.response.status;

        if (status >= 200 && status < 300) {
          await recordSuccess(env, provider);
          return { status: 'ok', value: res.response, status400: status };
        }

        // 429：交给串行队列做指数退避（rate_limit_reached_error / rate limit）
        if (status === 429) {
          var txt429 = '';
          try { txt429 = await res.response.text(); } catch (e) { txt429 = ''; }
          // 429 也可能是「额度耗尽」（智谱 1113 / Moonshot 余额不足）：不可重试，直接按额度降级
          if (isQuotaExhaustedBody(txt429, status)) {
            return {
              status: 'fail',
              errorCode: ERR.QUOTA_EXHAUSTED,
              detail: '上游额度不足（' + spec.label + '）：' + txt429.slice(0, 160),
              status400: status
            };
          }
          var wait = retryAfterMsOf(res.response.headers, txt429);
          // 429 属「上游限流」而非「上游故障」：已由串行队列指数退避处理，
          // 若计入熔断，高并发会被误判成故障 → 熔断打开 → 全站 AI 不可用（历史故障根因）
          return {
            status: 'retry',
            errorCode: ERR.RATE_LIMITED,
            detail: '上游限流 429（' + spec.label + ' 并发上限 ' + providerConcurrency(env, provider) + '）：' + txt429.slice(0, 160),
            retryAfterMs: wait,
            status400: 429
          };
        }

        // 5xx：明确不可重试（队列层不重试），直接降级
        if (status >= 500) {
          var txt5 = '';
          try { txt5 = await res.response.text(); } catch (e) { txt5 = ''; }
          await recordFailure(env, provider);
          return { status: 'fail', errorCode: ERR.UPSTREAM_ERROR, detail: 'HTTP ' + status + ' ' + txt5.slice(0, 160), status400: status };
        }

        if (status === 401 || status === 403) {
          return { status: 'fail', errorCode: ERR.NOT_CONFIGURED, detail: '上游鉴权失败（' + spec.placeholder + ' 无效或无权访问该模型）', status400: status };
        }

        // 400 / 404 / 422 等：请求本身有问题，不重试
        var text = '';
        try { text = await res.response.text(); } catch (e) { text = ''; }
        // 额度耗尽（402 / 智谱 1113「余额不足或无可用资源包」等）：不重试，明确按额度降级
        if (isQuotaExhaustedBody(text, status)) {
          return {
            status: 'fail',
            errorCode: ERR.QUOTA_EXHAUSTED,
            detail: '上游额度不足（' + spec.label + '）：' + text.slice(0, 200),
            status400: status
          };
        }
        if (status === 429 || isRateLimitBody(text, status)) {
          return { status: 'retry', errorCode: ERR.RATE_LIMITED, detail: text.slice(0, 160), retryAfterMs: retryAfterMsOf(res.response.headers, text), status400: 429 };
        }
        return { status: 'fail', errorCode: ERR.UPSTREAM_ERROR, detail: 'HTTP ' + status + ' ' + text.slice(0, 200), status400: status };
      }
      return { status: 'fail', errorCode: ERR.UPSTREAM_ERROR, detail: 'unknown' };
    },
    {
      requestId: o.requestId,
      provider: provider,
      maxRetry: o.maxRetry !== undefined ? o.maxRetry : toInt(env.AI_QUEUE_MAX_RETRY, 4),
      onStatus: function (st) {
        queueEvents.push(Object.assign({ at: Date.now() }, st));
        if (typeof o.onQueueStatus === 'function') {
          try { o.onQueueStatus(st); } catch (e) { /* 忽略回调异常 */ }
        }
      }
    }
  );

  var queueInfo = {
    waitMs: outcome.queueWaitMs || 0,
    totalMs: outcome.waitedMs || 0,
    attempts: outcome.attempts || 1,
    retried: outcome.retried || 0,
    exhausted: !!outcome.exhausted,
    events: queueEvents
  };

  if (outcome.ok) {
    return { ok: true, provider: provider, response: outcome.value, status: outcome.status || 200, queue: queueInfo };
  }

  var code = outcome.errorCode || ERR.UPSTREAM_ERROR;
  var kind = degradeKindOf(code, outcome.exhausted);

  return {
    ok: false,
    provider: provider,
    errorCode: code,
    degradeKind: kind,
    detail: outcome.detail || '',
    status: outcome.status || 0,
    queue: queueInfo
  };
}

/* ------------------------------------------------------------------ */
/* 用量解析                                                            */
/* ------------------------------------------------------------------ */

/** 从非流式响应体解析 usage 与正文（忽略 reasoning_content，仅取可见回答） */
export function parseCompletion(json) {
  if (!json || typeof json !== 'object') return { ok: false, text: '', usage: null };
  var choice = json.choices && json.choices[0];
  var message = choice && choice.message;
  var text = message && typeof message.content === 'string' ? message.content : '';
  if (!text && choice && typeof choice.text === 'string') text = choice.text;
  return {
    ok: !!text,
    text: text,
    usage: json.usage || null,
    model: json.model || '',
    finishReason: choice ? choice.finish_reason : '',
    reasoning: (message && typeof message.reasoning_content === 'string') ? message.reasoning_content : ''
  };
}

export function usageTokens(usage) {
  if (!usage) return { prompt: 0, completion: 0, total: 0 };
  var prompt = toInt(usage.prompt_tokens, 0);
  var completion = toInt(usage.completion_tokens, 0);
  var total = toInt(usage.total_tokens, prompt + completion);
  return { prompt: prompt, completion: completion, total: total };
}

/**
 * 供 /api/health 与《接口契约》使用的模型清单。
 * @param {string} [provider] 不传则返回全部上游模型
 */
export function modelCatalog(provider) {
  var want = normalizeProvider(provider);
  return Object.keys(MODEL_CAPS)
    .filter(function (m) { return !want || MODEL_CAPS[m].provider === want; })
    .map(function (m) {
      var c = MODEL_CAPS[m];
      return {
        model: m,
        provider: c.provider || '',
        vision: !!c.vision,
        context: c.context,
        maxOutput: c.maxOutput || 0,
        thinking: c.thinking,
        note: c.note
      };
    });
}

export { toBool };
