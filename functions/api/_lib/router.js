/**
 * 分级模型路由模块（对应条目 B-13）—— 双上游版（Kimi / Moonshot + 智谱 GLM）
 *
 * 档位定位：
 *   light    轻量档 —— 日常问答、术语解释、功能引导，成本最低、响应最快
 *   flagship 旗舰档 —— 复杂推理、多机型横向对比、长文本分析
 *   vision   视觉档 —— 图片识别、看图问答（如按照片识别机型）
 *   code     代码档 —— 代码生成 / 脚本改写 / 结构化配置输出
 *
 * 路由优先级（自上而下，命中即停）：
 *   1) 请求显式指定 tier（light / flagship / vision / code）
 *   2) 请求显式指定 model（必须在白名单内，按模型能力反推档位）
 *   3) 请求含图片输入 → vision
 *   4) 内容启发式判定 → flagship / light
 *
 * 双上游（provider）：
 *   provider = 'kimi'（默认，未传时行为与旧版单上游完全一致）| 'zhipu'
 *   解析顺序：请求体 provider → 环境变量 AI_PROVIDER_DEFAULT → 'kimi'
 *   每个档位在两家上游各有独立的模型默认值与环境变量，互不干扰、可单独换代：
 *     kimi  → AI_MODEL_LIGHT / AI_MODEL_FLAGSHIP / AI_MODEL_VISION / AI_MODEL_CODE
 *     zhipu → ZHIPU_MODEL_LIGHT / ZHIPU_MODEL_FLAGSHIP / ZHIPU_MODEL_VISION / ZHIPU_MODEL_CODE
 *   极端情况下即便 provider 与 model 不匹配，upstream.js 也会按模型名纠正到正确的上游。
 */

import { ERR, normalizeText, parseList, toInt, truncate } from './http.js';
import { modelCaps, normalizeProvider, DEFAULT_PROVIDER, PROVIDERS } from './upstream.js';

export const TIERS = ['light', 'flagship', 'vision', 'code'];

/**
 * 档位默认模型（kimi 侧为 Moonshot / Kimi 实测可用模型；zhipu 侧为智谱 BigModel 规格模型）。
 * 严禁使用已下线的 moonshot-v1 全系 / kimi-k2 全系 / kimi-k2.5 / kimi-latest / kimi-thinking-preview。
 * 改模型不用改代码：设置对应环境变量即可（kimi 用 AI_MODEL_*，zhipu 用 ZHIPU_MODEL_*）。
 */
export const TIER_DEFAULTS = {
  light: {
    envKey: 'AI_MODEL_LIGHT',
    envAlias: 'AI_MODEL_STANDARD',
    env: {
      kimi: { key: 'AI_MODEL_LIGHT', alias: 'AI_MODEL_STANDARD' },
      zhipu: { key: 'ZHIPU_MODEL_LIGHT', alias: 'ZHIPU_MODEL_STANDARD' }
    },
    model: 'kimi-k2.6',
    models: { kimi: 'kimi-k2.6', zhipu: 'glm-4.5-air' },
    label: '标准档',
    maxTokens: 1600,
    temperature: 0.6,
    timeoutMs: 70000,
    purpose: '日常问答 / 术语解释 / 功能引导 / 内容润色 / 图文识图'
  },
  flagship: {
    envKey: 'AI_MODEL_FLAGSHIP',
    env: {
      kimi: { key: 'AI_MODEL_FLAGSHIP' },
      zhipu: { key: 'ZHIPU_MODEL_FLAGSHIP' }
    },
    model: 'kimi-k3',
    models: { kimi: 'kimi-k3', zhipu: 'glm-4.7' },
    label: '旗舰档',
    maxTokens: 4096,
    temperature: 0.6,
    timeoutMs: 90000,
    purpose: '复杂推理 / 多机型横向对比 / 长文本分析 / 方案生成'
  },
  vision: {
    envKey: 'AI_MODEL_VISION',
    env: {
      kimi: { key: 'AI_MODEL_VISION' },
      zhipu: { key: 'ZHIPU_MODEL_VISION' }
    },
    model: 'kimi-k2.6',
    models: { kimi: 'kimi-k2.6', zhipu: 'glm-4.5v' },
    label: '视觉档',
    maxTokens: 2048,
    temperature: 0.5,
    timeoutMs: 80000,
    purpose: '图片识别 / 看图问答 / 机型外观判定（多模态 content 数组）'
  },
  code: {
    envKey: 'AI_MODEL_CODE',
    env: {
      kimi: { key: 'AI_MODEL_CODE' },
      zhipu: { key: 'ZHIPU_MODEL_CODE' }
    },
    model: 'kimi-k2.7-code-highspeed',
    models: { kimi: 'kimi-k2.7-code-highspeed', zhipu: 'glm-4.6' },
    label: '代码档',
    maxTokens: 4096,
    temperature: 0.3,
    timeoutMs: 90000,
    purpose: '代码生成 / 脚本改写 / 结构化配置输出'
  }
};

/** 模型 → 档位 的显式对照（白名单内的已知模型，优先于正则启发式） */
export const MODEL_TIER_HINTS = {
  'kimi-k3': 'flagship',
  'kimi-k2.6': 'light',
  'kimi-k2.7-code': 'code',
  'kimi-k2.7-code-highspeed': 'code',
  'glm-4.5': 'flagship',
  'glm-4.5-air': 'light',
  'glm-4.5v': 'vision',
  'glm-4.6': 'code',
  'glm-4.7': 'flagship',
  'glm-5': 'flagship'
};

/** 分档关键词：命中任一即升级到旗舰档 */
export const COMPLEX_HINTS = [
  '对比', '比较', '区别', '差异', '优劣', '优缺点',
  '为什么', '原理', '论证', '分析', '推演', '评估', '方案', '设计一套', '如何实现',
  '详细', '深入', '展开讲', '技术细节', '发展趋势', '预测', '总结成', '写成报告',
  '多个角度', '综合分析', '帮我规划', '路线图'
];

/* ------------------------------------------------------------------ */
/* provider 与档位配置                                                  */
/* ------------------------------------------------------------------ */

/** 归一化 provider；无法识别或未传时返回默认上游（kimi） */
export function providerOrDefault(value) {
  return normalizeProvider(value) || DEFAULT_PROVIDER;
}

/** 该档位在某上游下应使用的模型名（环境变量优先） */
export function tierModelFor(env, tier, provider) {
  return tierConfig(env, tier, provider).model;
}

/**
 * 取某档位在某上游下的配置。
 * @param {object} env
 * @param {string} tier light|flagship|vision|code
 * @param {string} [provider] 'kimi' | 'zhipu'，缺省 kimi（与旧版单上游行为一致）
 * @returns {{tier,provider,label,model,envKey,models,maxTokens,temperature,timeoutMs,purpose}}
 */
export function tierConfig(env, tier, provider) {
  var t = TIER_DEFAULTS[tier] || TIER_DEFAULTS.light;
  var p = providerOrDefault(provider);
  var spec = (t.env && t.env[p]) || { key: t.envKey, alias: t.envAlias };
  var raw = '';
  if (env && spec.key && env[spec.key]) raw = env[spec.key];
  if (!raw && env && spec.alias && env[spec.alias]) raw = env[spec.alias];
  var envModel = raw ? String(raw).trim() : '';
  var fallback = (t.models && t.models[p]) || t.model;
  return {
    tier: tier,
    provider: p,
    label: t.label,
    model: envModel || fallback,
    envKey: spec.key || t.envKey,
    models: t.models,
    maxTokens: t.maxTokens,
    temperature: t.temperature,
    timeoutMs: t.timeoutMs,
    purpose: t.purpose
  };
}

/** 白名单：两家上游的档位模型 + 内置可用模型 + 环境变量扩充（AI_MODEL_ALLOWLIST / ZHIPU_MODEL_ALLOWLIST） */
export function modelAllowlist(env) {
  var base = [];
  TIERS.forEach(function (t) {
    PROVIDERS.forEach(function (p) { base.push(tierConfig(env, t, p).model); });
  });
  // Kimi 全系实测可用模型一律放行，便于前端按功能显式指定档位
  base.push('kimi-k3', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed');
  // 智谱实测可用模型（以 /api/paas/v4/models 返回为准）
  base.push('glm-4.5-air', 'glm-4.5', 'glm-4.5v', 'glm-4.6', 'glm-4.7', 'glm-5');
  var extra = parseList(env && env.AI_MODEL_ALLOWLIST).concat(parseList(env && env.ZHIPU_MODEL_ALLOWLIST));
  return base.concat(extra).filter(function (v, i, arr) { return v && arr.indexOf(v) === i; });
}

/** 模型 → 档位（先查两家档位配置，再查对照表，最后按模型名启发式） */
export function modelToTier(env, model) {
  var m = String(model || '').trim();
  if (!m) return '';
  for (var i = 0; i < TIERS.length; i++) {
    var t = TIERS[i];
    for (var j = 0; j < PROVIDERS.length; j++) {
      if (tierConfig(env, t, PROVIDERS[j]).model === m) return t;
    }
  }
  if (MODEL_TIER_HINTS[m]) return MODEL_TIER_HINTS[m];
  var low = m.toLowerCase();
  if (/code/.test(low)) return 'code';
  if (/vision|visual|(^|[-_])vl|v\d*$/.test(low)) return 'vision';
  if (/k3|glm-5|glm-4\.[6-9]/.test(low)) return 'flagship';
  if (/air|flash|glm-4\.5$/.test(low)) return 'light';
  return 'light';
}

/* ------------------------------------------------------------------ */
/* 消息解析与校验                                                       */
/* ------------------------------------------------------------------ */

export function messageHasImage(message) {
  if (!message || !Array.isArray(message.content)) return false;
  for (var i = 0; i < message.content.length; i++) {
    var part = message.content[i];
    if (part && (part.type === 'image_url' || part.image_url)) return true;
  }
  return false;
}

export function messagesHaveImage(messages) {
  for (var i = 0; i < (messages || []).length; i++) {
    if (messageHasImage(messages[i])) return true;
  }
  return false;
}

export function extractMessageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map(function (part) {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('\n');
  }
  return '';
}

export function extractDocText(messages) {
  var out = [];
  for (var i = 0; i < (messages || []).length; i++) {
    out.push(extractMessageText(messages[i]));
  }
  return normalizeText(out.join('\n'));
}

export function lastUserText(messages) {
  for (var i = (messages || []).length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'user') return extractMessageText(messages[i]);
  }
  return '';
}

/**
 * 校验并规范化 messages。
 * @returns {{ok:boolean, error?:string, messages?:Array, docText?:string, hasImage?:boolean}}
 */
export function validateMessages(rawMessages, env) {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return { ok: false, error: ERR.BAD_MESSAGES, detail: 'messages 必须是非空数组' };
  }
  if (rawMessages.length > 30) {
    return { ok: false, error: ERR.BAD_MESSAGES, detail: 'messages 条数上限 30' };
  }
  var maxChars = toInt(env && env.AI_MAX_INPUT_CHARS, 8000);
  var cleaned = [];
  var total = 0;
  for (var i = 0; i < rawMessages.length; i++) {
    var m = rawMessages[i];
    if (!m || typeof m !== 'object') return { ok: false, error: ERR.BAD_MESSAGES, detail: '第 ' + (i + 1) + ' 条消息格式不合法' };
    var role = m.role === 'system' || m.role === 'assistant' ? m.role : 'user';
    var content = m.content;
    if (typeof content === 'string') {
      if (content.length > maxChars) return { ok: false, error: ERR.PAYLOAD_TOO_LARGE, detail: '单条消息正文超过 ' + maxChars + ' 字符' };
      total += content.length;
      cleaned.push({ role: role, content: content });
    } else if (Array.isArray(content)) {
      var parts = [];
      for (var j = 0; j < content.length; j++) {
        var part = content[j];
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'text' && typeof part.text === 'string') {
          total += part.text.length;
          parts.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string') {
          parts.push({ type: 'image_url', image_url: { url: truncate(part.image_url.url, 2000000) } });
        }
      }
      if (!parts.length) return { ok: false, error: ERR.BAD_MESSAGES, detail: '第 ' + (i + 1) + ' 条消息的 content 数组为空' };
      cleaned.push({ role: role, content: parts });
    } else {
      return { ok: false, error: ERR.BAD_MESSAGES, detail: '第 ' + (i + 1) + ' 条消息的 content 必须是字符串或数组' };
    }
  }
  if (total > maxChars * 3) {
    return { ok: false, error: ERR.PAYLOAD_TOO_LARGE, detail: '全部输入合计超过 ' + maxChars * 3 + ' 字符' };
  }
  return {
    ok: true,
    messages: cleaned,
    docText: extractDocText(cleaned),
    hasImage: messagesHaveImage(cleaned)
  };
}

/* ------------------------------------------------------------------ */
/* 档位决策                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {object} body 请求体 { provider?, tier?, model?, feature?, messages?, stream? }
 * @param {object} env
 * @returns {{tier:string, provider:string, reason:string, model:string, resolvedBy:string, config:object, invalid?:boolean}}
 */
export function resolveTier(body, env) {
  var b = body || {};
  var rawProvider = typeof b.provider === 'string' ? b.provider.trim() : '';
  var provider = normalizeProvider(rawProvider) || normalizeProvider(env && env.AI_PROVIDER_DEFAULT) || DEFAULT_PROVIDER;

  // 显式传了无法识别的 provider：明确报错，绝不静默改走别的上游
  if (rawProvider && !normalizeProvider(rawProvider)) {
    var cfgBad = tierConfig(env, 'light', DEFAULT_PROVIDER);
    return {
      tier: 'light',
      provider: DEFAULT_PROVIDER,
      reason: ERR.PROVIDER_UNKNOWN,
      model: cfgBad.model,
      resolvedBy: 'explicit:provider',
      invalid: true,
      config: cfgBad
    };
  }

  var explicitTier = typeof b.tier === 'string' ? b.tier.toLowerCase().trim() : '';
  if (explicitTier) {
    if (TIERS.indexOf(explicitTier) < 0) {
      var cfgLight0 = tierConfig(env, 'light', provider);
      return { tier: 'light', provider: provider, reason: ERR.TIER_UNKNOWN, model: cfgLight0.model, resolvedBy: 'explicit', invalid: true, config: cfgLight0 };
    }
    var cfgByTier = tierConfig(env, explicitTier, provider);
    return { tier: explicitTier, provider: provider, reason: 'explicit', model: cfgByTier.model, resolvedBy: 'explicit', config: cfgByTier };
  }

  var explicitModel = typeof b.model === 'string' ? b.model.trim() : '';
  if (explicitModel) {
    if (modelAllowlist(env).indexOf(explicitModel) < 0) {
      var cfgLight1 = tierConfig(env, 'light', provider);
      return { tier: 'light', provider: provider, reason: ERR.MODEL_NOT_ALLOWED, model: explicitModel, resolvedBy: 'explicit:model', invalid: true, config: cfgLight1 };
    }
    // 模型自带上游归属：显式模型优先决定 provider，避免 provider / model 错配
    var modelProvider = providerOrDefault(modelCaps(explicitModel).provider || provider);
    var mappedTier = modelToTier(env, explicitModel);
    var cfgByModel = tierConfig(env, mappedTier, modelProvider);
    return { tier: mappedTier, provider: modelProvider, reason: 'explicit:model', model: explicitModel, resolvedBy: 'explicit:model', config: cfgByModel };
  }

  var messages = Array.isArray(b.messages) ? b.messages : [];

  // 代码类任务优先走代码档（kimi-k2.7-code 系列 / glm-4.6）
  if (String(b.feature || '') === 'code' || b.code === true) {
    var cfgCode = tierConfig(env, 'code', provider);
    return { tier: 'code', provider: provider, reason: 'auto:code', model: cfgCode.model, resolvedBy: 'auto', config: cfgCode };
  }

  if (messagesHaveImage(messages) || String(b.feature || '') === 'photo') {
    var cfgVision = tierConfig(env, 'vision', provider);
    return { tier: 'vision', provider: provider, reason: messagesHaveImage(messages) ? 'auto:image' : 'auto:feature', model: cfgVision.model, resolvedBy: 'auto', config: cfgVision };
  }

  var text = extractDocText(messages);
  var auto = scoreComplexity(text, b);
  var tier = auto.complex ? 'flagship' : 'light';
  var cfg = tierConfig(env, tier, provider);
  return { tier: tier, provider: provider, reason: auto.reason, model: cfg.model, resolvedBy: 'auto', config: cfg, score: auto.score };
}

/**
 * 同一个档位在「另一家上游」的等价配置（用于可选的跨上游兜底）。
 * @returns {object|null} {provider,model,tier,...} 或 null（无可用备选）
 */
export function alternateConfig(env, cfg) {
  if (!cfg || !cfg.tier) return null;
  var p = providerOrDefault(cfg.provider);
  if (PROVIDERS.length < 2) return null;
  var other = p === 'kimi' ? 'zhipu' : 'kimi';
  var alt = tierConfig(env, cfg.tier, other);
  // 视觉档要求备选模型同样支持图片输入，否则不降级（避免必然失败的请求）
  if (cfg.tier === 'vision' && !modelCaps(alt.model).vision) return null;
  return alt;
}

/**
 * 复杂度打分：得分达到阈值即走旗舰档。
 * 权重可读、可调，避免黑盒。
 */
export function scoreComplexity(text, body) {
  var t = String(text || '');
  var score = 0;
  var hits = [];
  for (var i = 0; i < COMPLEX_HINTS.length; i++) {
    var kw = COMPLEX_HINTS[i];
    if (t.indexOf(kw) >= 0) {
      score += 3;
      hits.push(kw);
    }
  }
  if (t.length > 400) score += 2;
  if (t.length > 1200) score += 2;
  var questions = (t.match(/[?？]/g) || []).length;
  if (questions >= 3) score += 2;
  if (body && body.wantDetail === true) score += 3;
  if (body && String(body.feature || '') === 'compare') score += 3;
  var threshold = 6;
  return { score: score, complex: score >= threshold, reason: score >= threshold ? 'auto:complex' : 'auto:default', hits: hits, threshold: threshold };
}

/** 智谱思考力度 → 开关：low 关闭思考（省钱、更快），high / max 打开思考 */
export function zhipuThinkingOf(effort) {
  return String(effort || '').toLowerCase() === 'low' ? 'disabled' : 'enabled';
}

/**
 * 允许客户端覆盖 max_tokens / temperature，但必须在服务端上限内。
 * 思考参数按 provider 分别映射（两家字段与取值不同，不得混用）：
 *   - kimi ：reasoning_effort（仅 kimi-k3，low / high / max，默认读 env AI_REASONING_EFFORT）
 *            与 thinking（kimi-k2.6 / kimi-k2.7 系列，enabled / disabled，默认读 env AI_THINKING）
 *   - zhipu：thinking（enabled / disabled）。若只给了 reasoning_effort，则按其数值映射为开关：
 *            low → disabled，high / max → enabled（智谱不接受 effort 字面量）
 *   max_tokens 由 upstream.buildRequestBody 按模型硬上限二次裁剪（智谱越界会返回 code 1210）
 */
export function resolveGenerationParams(body, cfg, env) {
  var b = body || {};
  var e = env || {};
  var provider = cfg && cfg.provider ? providerOrDefault(cfg.provider) : DEFAULT_PROVIDER;
  var maxTokens = toInt(b.max_tokens, cfg.maxTokens);
  maxTokens = Math.min(Math.max(64, maxTokens), cfg.maxTokens * 2);
  var temperature = typeof b.temperature === 'number' ? b.temperature : cfg.temperature;
  temperature = Math.min(1, Math.max(0, temperature));
  var topP = typeof b.top_p === 'number' ? Math.min(1, Math.max(0.01, b.top_p)) : 0.9;

  var out = { max_tokens: maxTokens, temperature: temperature, top_p: topP };

  var effort = typeof b.reasoning_effort === 'string' ? b.reasoning_effort.trim().toLowerCase() : '';
  if (!effort && e.AI_REASONING_EFFORT) effort = String(e.AI_REASONING_EFFORT).trim().toLowerCase();
  var effortOk = ['low', 'high', 'max'].indexOf(effort) >= 0;

  var thinking = typeof b.thinking === 'string' ? b.thinking.trim().toLowerCase() : '';
  var thinkingExplicit = thinking === 'enabled' || thinking === 'disabled';
  if (!thinkingExplicit && e.AI_THINKING) {
    var envThinking = String(e.AI_THINKING).trim().toLowerCase();
    if (envThinking === 'enabled' || envThinking === 'disabled') {
      thinking = envThinking;
      thinkingExplicit = true;
    }
  }

  if (provider === 'zhipu') {
    if (thinkingExplicit) out.thinking = thinking;
    else if (effortOk) out.thinking = zhipuThinkingOf(effort);
  } else {
    if (effortOk) out.reasoning_effort = effort;
    if (thinkingExplicit) out.thinking = thinking;
  }

  // 思考开关的字段名：智谱固定为 thinking；kimi 允许用 AI_THINKING_FIELD 微调
  out.thinking_field = provider === 'zhipu' ? 'thinking' : (e.AI_THINKING_FIELD || 'thinking');

  return out;
}

/** 单上游（默认 kimi）路由表：保持旧结构，老调用方与看板无需改动 */
export function routingTable(env) {
  return TIERS.map(function (t) {
    var cfg = tierConfig(env, t, DEFAULT_PROVIDER);
    var caps = modelCaps(cfg.model);
    return {
      tier: t,
      provider: cfg.provider,
      label: cfg.label,
      model: cfg.model,
      envKey: cfg.envKey,
      maxTokens: cfg.maxTokens,
      timeoutMs: cfg.timeoutMs,
      purpose: cfg.purpose,
      vision: !!caps.vision,
      thinking: caps.thinking,
      context: caps.context
    };
  });
}

/** 双上游路由表：供 /api/health、后台与《接口契约》展示 */
export function routingTableAll(env) {
  var out = [];
  PROVIDERS.forEach(function (p) {
    TIERS.forEach(function (t) {
      var cfg = tierConfig(env, t, p);
      var caps = modelCaps(cfg.model);
      out.push({
        provider: p,
        tier: t,
        label: cfg.label,
        model: cfg.model,
        envKey: cfg.envKey,
        maxTokens: cfg.maxTokens,
        maxOutput: caps.maxOutput || 0,
        timeoutMs: cfg.timeoutMs,
        purpose: cfg.purpose,
        vision: !!caps.vision,
        thinking: caps.thinking,
        context: caps.context
      });
    });
  });
  return out;
}
