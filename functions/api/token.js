/**
 * POST /api/token —— 短期令牌签发（对应条目 B-11）
 * GET  /api/token?bootstrap=1 —— 首次访问时下发访客 ID（HttpOnly Cookie）
 *
 * 前端永不持有任何长期密钥：仅凭「访客 ID」换取限时限次的短期令牌，
 * 再用该令牌调用 /api/chat。令牌绑定访客、限定用途与档位、可一次性消费。
 *
 * 请求（POST JSON，全部可选）：
 *   scope     string  令牌用途，默认 chat（chat|photo|compare|translate|summary|glossary|vision|story）
 *   ttl       number  有效期秒，默认 600，上限 3600
 *   tier      string  限定最高档位（light|flagship|vision），缺省按服务端路由
 *   features  string  限定可用功能（逗号分隔），缺省不限制
 *
 * 响应：{ ok, token, expiresIn, exp, issuedAt, scope, keySource, keyWeak }
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
  isValidVisitorId,
  newRequestId,
  toInt
} from './_lib/http.js';
import { issueToken, DEFAULT_TOKEN_TTL, MAX_TOKEN_TTL, TOKEN_SCOPES, tokenSecretInfo } from './_lib/auth.js';
import { checkRateLimit, rateLimitHeaders, buildScopes } from './_lib/ratelimit.js';
import { getFlags } from './_lib/flags.js';

export async function onRequestOptions(context) {
  return corsPreflight(context.request, context.env, { methods: 'GET, POST, OPTIONS' });
}

export async function onRequestGet(context) {
  var request = context.request;
  var env = context.env || {};
  var cors = resolveCors(request, env, { methods: 'GET, POST, OPTIONS' });
  if (cors.hasOrigin && !cors.ok) return fail(ERR.FORBIDDEN_ORIGIN, '请求来源不在白名单内', 403, cors.headers);

  var flags = await getFlags(env);
  if (!flags.ai_enabled) return fail(ERR.MAINTENANCE, 'AI 服务维护中', 503, cors.headers);

  var url = new URL(request.url);
  var bootstrap = url.searchParams.get('bootstrap') === '1';
  var visitorId = resolveVisitorId(request, context, env.AI_VISITOR_COOKIE || 'ai_vid');

  if (bootstrap || !visitorId) {
    var newId = generateVisitorId();
    return ok(
      {
        visitorId: newId,
        cookieSet: true,
        cookieName: env.AI_VISITOR_COOKIE || 'ai_vid',
        note: '访客标识已生成，请在前端持久保存（localStorage 或 Cookie），后续所有接口携带 X-Visitor-Id'
      },
      Object.assign({}, cors.headers, {
        'Set-Cookie':
          (env.AI_VISITOR_COOKIE || 'ai_vid') +
          '=' +
          newId +
          '; Path=/; Max-Age=31536000; SameSite=Lax; Secure; HttpOnly'
      })
    );
  }

  return ok(
    {
      visitorId: visitorId,
      valid: isValidVisitorId(visitorId),
      tokenEndpoint: 'POST /api/token',
      scopes: TOKEN_SCOPES
    },
    cors.headers
  );
}

export async function onRequestPost(context) {
  var request = context.request;
  var env = context.env || {};
  var cors = resolveCors(request, env, { methods: 'GET, POST, OPTIONS' });
  if (cors.hasOrigin && !cors.ok) return fail(ERR.FORBIDDEN_ORIGIN, '请求来源不在白名单内', 403, cors.headers);

  var flags = await getFlags(env);
  if (!flags.ai_enabled) return fail(ERR.MAINTENANCE, 'AI 服务维护中', 503, cors.headers);

  var visitorId = resolveVisitorId(request, context, env.AI_VISITOR_COOKIE || 'ai_vid');
  if (!visitorId) {
    return fail(ERR.INVALID_VISITOR, '缺少有效访客标识；可先 GET /api/token?bootstrap=1 获取', 400, cors.headers);
  }

  var ipHash = await hashId(getClientIp(request), env);
  var visitorHash = await hashId(visitorId, env);
  var rate = await checkRateLimit(env, buildScopes(env, { ipHash: ipHash, visitorHash: visitorHash }, 'token'));
  if (!rate.ok) {
    return fail(ERR.RATE_LIMITED, '令牌签发过于频繁，请稍后重试', 429, Object.assign({}, cors.headers, rateLimitHeaders(rate)));
  }

  var body = await readJsonBody(request, 32 * 1024);
  if (body.error) return fail(body.error, body.message, 400, cors.headers);
  var input = body.data || {};

  var scope = String(input.scope || 'chat');
  if (TOKEN_SCOPES.indexOf(scope) < 0) {
    return fail(ERR.BAD_REQUEST, '不支持的 scope，可选：' + TOKEN_SCOPES.join('/'), 400, cors.headers);
  }
  if (scope === 'photo' && flags.ai_vision === false) {
    return fail(ERR.FEATURE_DISABLED, '图片识别功能当前已关闭', 403, cors.headers);
  }

  var ttl = toInt(input.ttl, toInt(env.AI_TOKEN_TTL, DEFAULT_TOKEN_TTL));
  ttl = Math.min(MAX_TOKEN_TTL, Math.max(60, ttl));

  var issued = await issueToken(env, {
    visitorId: visitorId,
    scope: scope,
    ttl: ttl,
    tier: input.tier,
    features: input.features
  });
  if (!issued.ok) {
    return fail(issued.reason || ERR.INTERNAL, '令牌签发失败', 400, cors.headers);
  }

  var sec = tokenSecretInfo(env);
  return ok(
    {
      token: issued.token,
      expiresIn: issued.expiresIn,
      exp: issued.exp,
      issuedAt: issued.issuedAt,
      scope: issued.scope,
      oneTime: env.AI_TOKEN_ONETIME === '1',
      keySource: sec.source,
      keyWeak: sec.weak,
      usage: { header: 'X-AI-Token', endpoint: 'POST /api/chat' },
      requestId: newRequestId('tok')
    },
    Object.assign({}, cors.headers, {
      'Cache-Control': 'no-store',
      'X-AI-Token-TTL': String(issued.expiresIn)
    })
  );
}

export async function onRequest(context) {
  return methodNotAllowed(['GET', 'POST', 'OPTIONS'], resolveCors(context.request, context.env, { methods: 'GET, POST, OPTIONS' }).headers);
}

function generateVisitorId() {
  var rand = '';
  try {
    var buf = new Uint8Array(12);
    crypto.getRandomValues(buf);
    for (var i = 0; i < buf.length; i++) rand += buf[i].toString(16).padStart(2, '0');
  } catch (e) {
    rand = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
  return 'v' + Date.now().toString(36) + rand.slice(0, 16);
}
