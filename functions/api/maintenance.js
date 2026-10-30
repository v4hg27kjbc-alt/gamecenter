/**
 * /api/maintenance —— 前端访问控制层服务端（维护模式 + 单用户封锁 + AI 门控）
 *
 * 公开 GET（无需登录）：
 *   主站启动时请求本接口，根据返回决定是否显示维护遮罩 / 封锁卡片 / AI 灰置。
 *   接口异常或未配置时默认放行（status: 'ok'），保证站点不白屏、原功能不回归。
 *
 * 配置来源（优先级高 → 低）：
 *   1) KV（MAINTENANCE_KV，由后台「维护控制」分区写入，无需重新部署）
 *      - key 'maintenance:config'    维护配置对象 { enabled, emoji, assetUrl, message, aiGate, appealUrl, blockReason, updatedAt }
 *      - key 'maintenance:blocklist' 封锁名单数组（visitor id 明文列表）
 *   2) 环境变量：
 *      - MAINTENANCE_ENABLED=1            全站维护开关
 *      - MAINTENANCE_EMOJI                维护页中心 Emoji（默认 🔧）
 *      - MAINTENANCE_ASSET_URL            维护页中心 GIF/图片 URL（可选，优先于 Emoji）
 *      - MAINTENANCE_MESSAGE              维护文案（默认「站点维护中」）
 *      - MAINTENANCE_AI_GATE=1            AI 需解锁（未解锁访客 AI 入口灰置）
 *      - MAINTENANCE_APPEAL_URL           封锁申诉跳转地址（默认后台首页）
 *      - BLOCKED_VISITORS                 封锁名单（逗号分隔 visitor id）
 *   3) 代码内置默认值（全放行）
 *
 * 响应：{ ok, status: 'ok'|'maintenance'|'blocked', maintenance:{...}, blocked:{...}, aiGate, source }
 */

import {
  ok,
  fail,
  methodNotAllowed,
  resolveCors,
  corsPreflight,
  resolveVisitorId,
  checkAdminToken,
  timingSafeEqual
} from './_lib/http.js';

const CONFIG_KEY = 'maintenance:config';
const BLOCKLIST_KEY = 'maintenance:blocklist';
const DEFAULT_APPEAL_URL = 'https://henry126923-admincenter.pages.dev';
const DEFAULT_MESSAGE = '站点维护中';
const DEFAULT_EMOJI = '🔧';

async function kvGetJson(env, key) {
  const kv = env && env.MAINTENANCE_KV;
  if (!kv || typeof kv.get !== 'function') return null;
  try {
    return await kv.get(key, 'json');
  } catch (e) {
    return null;
  }
}

function envConfig(env) {
  var on = String((env && env.MAINTENANCE_ENABLED) || '') === '1' || String((env && env.MAINTENANCE_ENABLED) || '').toLowerCase() === 'true';
  var gate = String((env && env.MAINTENANCE_AI_GATE) || '') === '1' || String((env && env.MAINTENANCE_AI_GATE) || '').toLowerCase() === 'true';
  return {
    enabled: on,
    emoji: (env && env.MAINTENANCE_EMOJI) || DEFAULT_EMOJI,
    assetUrl: (env && env.MAINTENANCE_ASSET_URL) || '',
    message: (env && env.MAINTENANCE_MESSAGE) || DEFAULT_MESSAGE,
    aiGate: gate,
    appealUrl: (env && env.MAINTENANCE_APPEAL_URL) || DEFAULT_APPEAL_URL,
    blockReason: (env && env.MAINTENANCE_BLOCK_REASON) || '您的账号因违反平台规则已被限制访问。如有疑问，请前往后台提交申诉。',
    updatedAt: '',
    source: 'env'
  };
}

async function loadConfig(env) {
  var kvConfig = await kvGetJson(env, CONFIG_KEY);
  if (kvConfig && typeof kvConfig === 'object' && kvConfig !== null) {
    var base = envConfig(env);
    var merged = Object.assign({}, base, kvConfig);
    merged.source = 'kv';
    return merged;
  }
  return envConfig(env);
}

async function loadBlocklist(env) {
  var set = {};
  var envList = String((env && env.BLOCKED_VISITORS) || '')
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
  envList.forEach(function (v) { set[v] = 1; });
  var kvList = await kvGetJson(env, BLOCKLIST_KEY);
  if (Array.isArray(kvList)) {
    kvList.forEach(function (v) {
      if (v && typeof v === 'string') set[v] = 1;
    });
  }
  return Object.keys(set);
}

export async function onRequestOptions(context) {
  return corsPreflight(context.request, context.env, { methods: 'GET, OPTIONS' });
}

export async function onRequestGet(context) {
  var request = context.request;
  var env = context.env || {};
  var cors = resolveCors(request, env, { methods: 'GET, OPTIONS' });
  if (cors.hasOrigin && !cors.ok) return fail('FORBIDDEN_ORIGIN', '请求来源不在白名单内', 403, cors.headers);

  var cfg;
  try {
    cfg = await loadConfig(env);
  } catch (e) {
    cfg = {
      enabled: false,
      emoji: DEFAULT_EMOJI,
      assetUrl: '',
      message: DEFAULT_MESSAGE,
      aiGate: false,
      appealUrl: DEFAULT_APPEAL_URL,
      blockReason: '',
      updatedAt: '',
      source: 'default'
    };
  }

  var visitorId = resolveVisitorId(request, context, (env && env.AI_VISITOR_COOKIE) || 'ai_vid');

  /* 管理请求（带合法 X-Admin-Token）额外返回完整封锁名单，供后台「维护控制」回显 */
  var isAdminReq = false;
  try { isAdminReq = !!checkAdminToken(request, env).ok; } catch (e) { isAdminReq = false; }

  /* 封锁优先于维护：单用户封锁随时生效 */
  var blocked = false;
  var blockReason = cfg.blockReason;
  var list = [];
  try {
    list = await loadBlocklist(env);
    if (list.length && visitorId && list.indexOf(visitorId) !== -1) {
      blocked = true;
    }
  } catch (e) {}

  if (blocked) {
    return ok(
      {
        ok: true,
        status: 'blocked',
        visitorId: visitorId,
        maintenance: { enabled: false, emoji: cfg.emoji, assetUrl: cfg.assetUrl, message: cfg.message, updatedAt: cfg.updatedAt || '' },
        blocked: { blocked: true, reason: blockReason || '您的账号已被限制访问', appealUrl: cfg.appealUrl || DEFAULT_APPEAL_URL },
        aiGate: true,
        blocklist: isAdminReq ? list : undefined,
        source: cfg.source || 'default'
      },
      cors.headers
    );
  }

  if (cfg.enabled) {
    return ok(
      {
        ok: true,
        status: 'maintenance',
        visitorId: visitorId || '',
        maintenance: { enabled: true, emoji: cfg.emoji, assetUrl: cfg.assetUrl, message: cfg.message, updatedAt: cfg.updatedAt || '' },
        blocked: { blocked: false },
        aiGate: true,
        blocklist: isAdminReq ? list : undefined,
        source: cfg.source || 'default'
      },
      cors.headers
    );
  }

  return ok(
    {
      ok: true,
      status: 'ok',
      visitorId: visitorId || '',
      maintenance: { enabled: false, emoji: cfg.emoji, assetUrl: cfg.assetUrl, message: cfg.message, updatedAt: cfg.updatedAt || '' },
      blocked: { blocked: false },
      aiGate: cfg.aiGate === true,
      blocklist: isAdminReq ? list : undefined,
      source: cfg.source || 'default'
    },
    cors.headers
  );
}

/* ================================================================== */
/* 管理端写入（后台「维护控制」分区经代理调用）                          */
/*   鉴权：X-Admin-Token / Bearer；可选超管密码 SUPER_ADMIN_PASSWORD    */
/*   存储：MAINTENANCE_KV（必须绑定，否则 503）                          */
/* ================================================================== */

async function kvPutJson(env, key, value) {
  const kv = env && env.MAINTENANCE_KV;
  if (!kv || typeof kv.put !== 'function') return false;
  try {
    await kv.put(key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}

function adminGate(context) {
  const verdict = checkAdminToken(context.request, context.env);
  if (!verdict.ok) {
    const cors = resolveCors(context.request, context.env, { methods: 'GET, POST, OPTIONS' });
    const code = verdict.reason === 'not_configured' ? 'not_configured' : 'unauthorized';
    return fail(code, verdict.reason === 'not_configured' ? '服务端未配置管理令牌 ADMIN_TOKEN' : '需要管理员令牌（X-Admin-Token）', 401, cors.headers);
  }
  return null;
}

async function superPasswordGate(body, env, request) {
  const expect = (env && env.SUPER_ADMIN_PASSWORD) || '';
  if (!expect) return null; // 未配置超管密码 → 仅需管理员令牌
  const provided = (body && typeof body.superPassword === 'string') ? body.superPassword : '';
  if (!provided || !timingSafeEqual(provided, expect)) {
    const cors = resolveCors(request, env, { methods: 'GET, POST, OPTIONS' });
    return fail('super_password_required', '需要超管密码才能修改维护配置', 403, cors.headers);
  }
  return null;
}

export async function onRequestPost(context) {
  const request = context.request;
  const env = context.env || {};
  const cors = resolveCors(request, env, { methods: 'GET, POST, OPTIONS' });
  if (cors.hasOrigin && !cors.ok) return fail('FORBIDDEN_ORIGIN', '请求来源不在白名单内', 403, cors.headers);

  const gate = adminGate(context);
  if (gate) return gate;

  let body = null;
  try {
    body = await request.json();
  } catch (e) {
    return fail('BAD_JSON', '请求体不是合法 JSON', 400, cors.headers);
  }
  if (!body || typeof body !== 'object') return fail('BAD_BODY', '请求体缺失', 400, cors.headers);

  const action = String(body.action || '');
  const passGate = await superPasswordGate(body, env, request);
  if (passGate) return passGate;

  if (action === 'save-config') {
    const cfg = body.config && typeof body.config === 'object' ? body.config : null;
    if (!cfg) return fail('BAD_BODY', '缺少 config 字段', 400, cors.headers);
    const clean = {
      enabled: !!cfg.enabled,
      emoji: String(cfg.emoji || '🔧').slice(0, 32),
      assetUrl: String(cfg.assetUrl || '').slice(0, 500),
      message: String(cfg.message || '站点维护中').slice(0, 120),
      subMessage: String(cfg.subMessage || '').slice(0, 200),
      aiGate: !!cfg.aiGate,
      appealUrl: String(cfg.appealUrl || DEFAULT_APPEAL_URL).slice(0, 500),
      blockReason: String(cfg.blockReason || '').slice(0, 300),
      updatedAt: new Date().toISOString()
    };
    const written = await kvPutJson(env, CONFIG_KEY, clean);
    if (!written) return fail('KV_UNAVAILABLE', '主站未绑定 MAINTENANCE_KV，无法持久化维护配置', 503, cors.headers);
    return ok({ ok: true, saved: clean }, cors.headers);
  }

  if (action === 'save-blocklist') {
    const raw = Array.isArray(body.items) ? body.items : [];
    const items = raw
      .map(function (v) { return String(v).trim(); })
      .filter(function (v) { return /^[A-Za-z0-9_-]{4,64}$/.test(v); });
    const written = await kvPutJson(env, BLOCKLIST_KEY, items);
    if (!written) return fail('KV_UNAVAILABLE', '主站未绑定 MAINTENANCE_KV，无法持久化封锁名单', 503, cors.headers);
    return ok({ ok: true, count: items.length, items: items }, cors.headers);
  }

  return fail('UNKNOWN_ACTION', '未知操作：' + action, 400, cors.headers);
}

export async function onRequest(context) {
  return methodNotAllowed(
    ['GET', 'POST', 'OPTIONS'],
    resolveCors(context.request, context.env, { methods: 'GET, POST, OPTIONS' }).headers
  );
}
