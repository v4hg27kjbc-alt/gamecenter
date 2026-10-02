/**
 * Cloudflare Pages Function — /api/chat
 * ============================================================
 * 主站 AI 服务端中台（二）：对话请求路由与转发
 *
 * 契约（与前端 window.AIBridge.chat 对齐）：
 *   请求：POST /api/chat
 *        header  X-AI-Token: <由 /api/token 签发的短期令牌>
 *        body    {
 *                  messages,            // OpenAI 风格；多模态时 content 为 [{type:'text'|'image_url',...}]
 *                  stream?:  false,     // true 时以 text/event-stream 透传上游 SSE
 *                  tier?:   'light' | 'flagship' | 'vision',   // 场景档位（测评/新闻/照片识机等）
 *                  provider?: 'zhipu' | 'kimi',                // 双模型路由（主问答）
 *                  mode?:   'fast' | 'deep',
 *                  model?:  'glm-4.7-flash' | 'kimi-k2.6' | ...,
 *                  feature?, temperature?, maxTokens?
 *                }
 *   响应（非流式）：
 *        200 { ok:true, answer, model, provider, finishReason, usage, requestId }
 *        401 { ok:false, error:'token_expired' | 'token_invalid' | 'token_missing' }   // 前端会刷新令牌后重试一次
 *        400 { ok:false, error:'unsupported_provider' | 'unsupported_tier' | 'messages_required' | ... }
 *        429 { ok:false, error:'upstream_rate_limited' }
 *        502 { ok:false, error:'upstream_auth_failed' | 'upstream_unavailable' | 'upstream_unreachable' | ... }
 *        500 { ok:false, error:'server_misconfigured' }
 *
 * 零前端密钥原则：上游 API Key 只在服务端从环境变量读取，永不下发。
 *
 * 环境变量（Cloudflare Pages -> Settings -> Variables and Secrets）：
 *   AI_TOKEN_SECRET   必填，与 /api/token 同值，用于校验 X-AI-Token
 *   ZHIPU_API_KEY     必填，智谱开放平台 API Key（provider=zhipu）
 *   KIMI_API_KEY      必填，Moonshot / Kimi API Key（provider=kimi）
 *   ALLOWED_ORIGIN    选填，跨域白名单，逗号分隔；不配置则仅同源
 *   模型覆盖（选填）：AI_MODEL_ZHIPU_LIGHT / AI_MODEL_ZHIPU_FLAGSHIP / AI_MODEL_ZHIPU_VISION
 *                    AI_MODEL_KIMI_DEEP（或 AI_MODEL_KIMI）
 * ============================================================
 */

const UPSTREAMS = {
  zhipu: {
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    keyEnv: 'ZHIPU_API_KEY',
    defaultModel: 'glm-4.7-flash'
  },
  kimi: {
    url: 'https://api.moonshot.cn/v1/chat/completions',
    keyEnv: 'KIMI_API_KEY',
    defaultModel: 'kimi-k2.6'
  }
};

/* tier（场景档位）-> 上游路由；模型名可用环境变量覆盖，便于上游模型迭代时零改码切换 */
const TIER_ROUTES = {
  light:    { provider: 'zhipu', model: 'glm-4.7-flash', envModel: 'AI_MODEL_ZHIPU_LIGHT' },
  flagship: { provider: 'zhipu', model: 'glm-4.7',       envModel: 'AI_MODEL_ZHIPU_FLAGSHIP' },
  vision:   { provider: 'zhipu', model: 'glm-4.7',       envModel: 'AI_MODEL_ZHIPU_VISION' }
};

const DEFAULT_PROVIDER = 'zhipu';
const ALLOWED_PROVIDERS = ['zhipu', 'kimi'];
const TOKEN_VERSION = 'v1';
const CLOCK_SKEW = 30;          // 令牌时间容差（秒）
const MIN_SECRET_LENGTH = 16;
const MAX_MESSAGES = 40;        // 单次请求最大消息条数
const MAX_TOTAL_CHARS = 48000;  // 单次请求文本总字符上限（含图片 dataURL 长度）
const MAX_OUTPUT_TOKENS = 8192;
const MODEL_PATTERN = /^[A-Za-z0-9._:\-]{1,64}$/;

export async function onRequest(context) {
  const { request, env } = context;
  const method = (request.method || 'GET').toUpperCase();
  const cors = corsHeaders(request, env);

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (method !== 'POST') {
    return respond({ ok: false, error: 'method_not_allowed' }, 405, cors);
  }

  /* 1) 服务端自身配置检查 */
  const secret = String(env.AI_TOKEN_SECRET || '').trim();
  if (secret.length < MIN_SECRET_LENGTH) {
    return respond({ ok: false, error: 'server_misconfigured', detail: 'AI_TOKEN_SECRET 未配置' }, 500, cors);
  }

  /* 2) 令牌校验（零前端密钥：前端只带这个短期令牌，不带任何上游 Key） */
  const auth = await verifyToken(request.headers.get('X-AI-Token') || bearerToken(request), secret);
  if (!auth.ok) {
    return respond({ ok: false, error: auth.error }, 401, cors);
  }

  /* 3) 解析请求体 */
  let body = null;
  try {
    body = await request.json();
  } catch (_) {
    body = null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return respond({ ok: false, error: 'bad_request' }, 400, cors);
  }

  /* 4) 路由：tier 优先；主问答按 provider/mode 走左上角模型选择器 */
  const route = resolveRoute(body, env);
  if (route.error) {
    return respond({ ok: false, error: route.error, provider: route.provider || '' }, route.status || 400, cors);
  }

  const upstreamCfg = UPSTREAMS[route.provider];
  const apiKey = String(env[upstreamCfg.keyEnv] || '').trim();
  if (!apiKey) {
    return respond({
      ok: false,
      error: 'server_misconfigured',
      detail: upstreamCfg.keyEnv + ' 未配置',
      provider: route.provider
    }, 500, cors);
  }

  /* 5) 消息体清洗（保持 OpenAI 兼容，含多模态） */
  const normalized = normalizeMessages(body.messages);
  if (normalized.error) {
    return respond({ ok: false, error: normalized.error }, 400, cors);
  }

  const stream = body.stream === true;
  const upstreamBody = {
    model: route.model,
    messages: normalized.messages,
    stream: stream
  };

  const temperature = Number(body.temperature);
  if (Number.isFinite(temperature)) {
    upstreamBody.temperature = Math.min(Math.max(temperature, 0), 2);
  }
  const maxTokensRaw = body.maxTokens != null ? body.maxTokens : body.max_tokens;
  const maxTokens = Number(maxTokensRaw);
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    upstreamBody.max_tokens = Math.min(Math.floor(maxTokens), MAX_OUTPUT_TOKENS);
  }

  /* 6) 转发到上游 */
  let upstream;
  try {
    upstream = await fetch(upstreamCfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Accept': stream ? 'text/event-stream' : 'application/json'
      },
      body: JSON.stringify(upstreamBody)
    });
  } catch (e) {
    return respond({
      ok: false,
      error: 'upstream_unreachable',
      provider: route.provider,
      model: route.model
    }, 502, cors);
  }

  /* 7) 上游错误统一映射（绝不回传 Key；仅回传上游错误摘要便于排查） */
  if (!upstream.ok) {
    let raw = '';
    try {
      raw = await upstream.text();
    } catch (_) {
      raw = '';
    }
    const mapped = mapUpstreamError(upstream.status);
    return respond({
      ok: false,
      error: mapped.error,
      provider: route.provider,
      model: route.model,
      upstreamStatus: upstream.status,
      detail: summarize(raw)
    }, mapped.status, cors);
  }

  /* 8) 流式：SSE 原样透传（OpenAI 兼容增量，末包为 data: [DONE]） */
  if (stream) {
    const headers = new Headers(cors);
    headers.set('Content-Type', 'text/event-stream; charset=utf-8');
    headers.set('Cache-Control', 'no-cache, no-transform');
    headers.set('X-AI-Provider', route.provider);
    headers.set('X-AI-Model', route.model);
    return new Response(upstream.body, { status: 200, headers });
  }

  /* 9) 非流式：归一化为前端 AIBridge 期望的 { ok, answer, model, finishReason, ... } */
  let data = null;
  try {
    data = await upstream.json();
  } catch (_) {
    data = null;
  }
  const choice = (data && Array.isArray(data.choices)) ? data.choices[0] : null;
  if (!choice) {
    return respond({
      ok: false,
      error: 'upstream_bad_response',
      provider: route.provider,
      model: route.model
    }, 502, cors);
  }

  const content = choice.message && typeof choice.message.content === 'string'
    ? choice.message.content
    : '';

  return respond({
    ok: true,
    answer: content,
    model: data.model || route.model,
    provider: route.provider,
    finishReason: choice.finish_reason || 'stop',
    usage: data.usage || null,
    requestId: upstream.headers.get('x-request-id') || data.id || ''
  }, 200, cors);
}

/* ---------- 路由决策 ---------- */
function resolveRoute(body, env) {
  const tier = typeof body.tier === 'string' ? body.tier.trim().toLowerCase() : '';
  if (tier) {
    const t = TIER_ROUTES[tier];
    if (!t) return { error: 'unsupported_tier', status: 400 };
    const model = pickModel(env[t.envModel], t.model);
    return { provider: t.provider, model: model };
  }

  let provider = typeof body.provider === 'string' ? body.provider.trim().toLowerCase() : '';
  let mode = typeof body.mode === 'string' ? body.mode.trim().toLowerCase() : '';
  if (!provider) provider = (mode === 'deep') ? 'kimi' : DEFAULT_PROVIDER;
  if (!mode) mode = (provider === 'kimi') ? 'deep' : 'fast';
  if (ALLOWED_PROVIDERS.indexOf(provider) === -1) {
    return { error: 'unsupported_provider', provider: provider, status: 400 };
  }

  const requested = typeof body.model === 'string' ? body.model.trim() : '';
  let model = '';
  if (requested) {
    if (!MODEL_PATTERN.test(requested)) return { error: 'invalid_model', provider: provider, status: 400 };
    model = requested;
  } else {
    const envModel = provider === 'kimi'
      ? (env.AI_MODEL_KIMI_DEEP || env.AI_MODEL_KIMI)
      : (env.AI_MODEL_ZHIPU_FAST || env.AI_MODEL_ZHIPU);
    model = pickModel(envModel, UPSTREAMS[provider].defaultModel);
  }
  return { provider: provider, model: model, mode: mode };
}

function pickModel(envValue, fallback) {
  const v = String(envValue || '').trim();
  return MODEL_PATTERN.test(v) ? v : fallback;
}

/* ---------- 请求体清洗 ---------- */
function normalizeMessages(input) {
  if (!Array.isArray(input) || input.length === 0) return { error: 'messages_required' };
  if (input.length > MAX_MESSAGES) return { error: 'too_many_messages' };

  const out = [];
  let chars = 0;

  for (let i = 0; i < input.length; i++) {
    const m = input[i];
    if (!m || typeof m !== 'object') return { error: 'bad_message' };

    const role = String(m.role || '').toLowerCase();
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      return { error: 'bad_message_role' };
    }

    const content = m.content;
    if (typeof content === 'string') {
      chars += content.length;
      out.push({ role: role, content: content });
    } else if (Array.isArray(content)) {
      /* 多模态：照片识机等场景（text / image_url） */
      const parts = [];
      for (let j = 0; j < content.length; j++) {
        const p = content[j];
        if (!p || typeof p !== 'object') continue;
        if (p.type === 'text' && typeof p.text === 'string') {
          chars += p.text.length;
          parts.push({ type: 'text', text: p.text });
        } else if (p.type === 'image_url' && p.image_url && typeof p.image_url.url === 'string') {
          chars += p.image_url.url.length;
          parts.push({ type: 'image_url', image_url: { url: p.image_url.url } });
        }
      }
      if (parts.length === 0) return { error: 'bad_message_content' };
      out.push({ role: role, content: parts });
    } else {
      return { error: 'bad_message_content' };
    }
  }

  if (chars > MAX_TOTAL_CHARS) return { error: 'payload_too_large' };
  return { messages: out };
}

/* ---------- 令牌校验 ---------- */
async function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return { ok: false, error: 'token_missing' };

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return { ok: false, error: 'token_invalid' };

  const expected = await hmacSign(secret, parts[1]);
  if (!timingSafeEqual(expected, parts[2])) return { ok: false, error: 'token_invalid' };

  let payload = null;
  try {
    payload = JSON.parse(b64urlToString(parts[1]));
  } catch (_) {
    return { ok: false, error: 'token_invalid' };
  }
  if (!payload || typeof payload.exp !== 'number') return { ok: false, error: 'token_invalid' };

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp + CLOCK_SKEW < now) return { ok: false, error: 'token_expired' };
  if (payload.scope && payload.scope !== 'chat') return { ok: false, error: 'token_scope_invalid' };

  return { ok: true, payload: payload };
}

function bearerToken(request) {
  const h = request.headers.get('Authorization') || '';
  return h.toLowerCase().indexOf('bearer ') === 0 ? h.slice(7).trim() : '';
}

/* ---------- 上游错误映射 ---------- */
function mapUpstreamError(status) {
  if (status === 401 || status === 403) return { status: 502, error: 'upstream_auth_failed' };
  if (status === 429) return { status: 429, error: 'upstream_rate_limited' };
  if (status === 400 || status === 422) return { status: 400, error: 'upstream_bad_request' };
  if (status >= 500) return { status: 502, error: 'upstream_unavailable' };
  return { status: 502, error: 'upstream_error' };
}

function summarize(raw) {
  if (!raw) return '';
  const s = String(raw).replace(/\s+/g, ' ').trim();
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

/* ---------- HTTP 工具 ---------- */
function respond(data, status, cors) {
  const headers = new Headers(cors);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { status: status || 200, headers });
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowList = String(env.ALLOWED_ORIGIN || '')
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(Boolean);

  const headers = new Headers();
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, X-AI-Token');
  headers.set('Access-Control-Max-Age', '86400');
  headers.set('Vary', 'Origin');

  if (origin && (allowList.length === 0 || allowList.indexOf(origin) !== -1)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
  }
  return headers;
}

/* ---------- base64url / HMAC ---------- */
function b64urlFromBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToString(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return b64urlFromBytes(new Uint8Array(sig));
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
