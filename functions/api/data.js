/**
 * /api/data —— 非 AI 数据读写接口（函数层扩面，清单 B-09 延伸项）
 *
 * 定位：主站里那些「不需要大模型、但需要一个可信服务端」的数据需求，统一收口到这里。
 *       目的不是再造一套 CMS，而是给前台提供：
 *         · 机型库 / 术语库 / 统计的**只读**出口（与 AI 用同一份内置数据，保证口径一致）；
 *         · 可公开的能力清单（模型档位、限额、开关状态），让前端不再硬编码；
 *         · 受开关保护的**写入**出口（留言 / 纠错 / 术语建议），默认关闭。
 *
 * 路由总览（GET）：
 *   GET /api/data?resource=aircraft          机型清单（精简字段，不含长文本）
 *   GET /api/data?resource=aircraft&slug=xxx 单机型详情
 *   GET /api/data?resource=glossary          术语目录
 *   GET /api/data?resource=glossary&q=xxx    术语检索
 *   GET /api/data?resource=stats             机型库统计
 *   GET /api/data?resource=capabilities      站点 AI 能力清单（限额 / 档位 / 开关）
 *   GET /api/data?resource=config            站点公开配置（site_config，缺失键回落默认值）
 *   GET /api/data?resource=messages          留言队列（需管理员口令）
 *
 * 路由总览（POST，全部受 write_enabled 开关保护）：
 *   POST /api/data?resource=message          提交留言 / 纠错 / 术语建议
 *
 * 红线：
 *   1. 任何写入都不会自动进入机型库 / 术语库，只会进入 site_message 待审队列。
 *   2. 不返回任何密钥、不返回访客原始标识（一律哈希）。
 *   3. 表不存在（未执行 0002 迁移）时，读取回落空集、写入返回明确错误码，绝不 500 到底。
 */

import {
  ERR,
  ok,
  fail,
  jsonResponse,
  withSecurity,
  methodNotAllowed,
  resolveCors,
  readJsonBody,
  getClientIp,
  resolveVisitorId,
  hashId,
  newRequestId,
  nowSec,
  dayString,
  toInt,
  clamp,
  truncate,
  normalizeText,
  checkAdminToken
} from './_lib/http.js';
import { getFlags } from './_lib/flags.js';
import { aircraftBriefs, aircraftDetail, libraryStats } from './_lib/rag.js';
import { searchGlossary, listTerms, publicTerm, loadDbTerms } from './_lib/glossary.js';
import { TIERS, tierConfig, modelAllowlist } from './_lib/router.js';
import { quotaDefaults } from './_lib/flags.js';

const RESOURCES = [
  'aircraft',
  'glossary',
  'stats',
  'capabilities',
  'config',
  'messages'
];

/* ------------------------------------------------------------------ */
/* 站点公开配置的代码内置默认值（site_config 缺失时回落）                */
/* ------------------------------------------------------------------ */

const SITE_CONFIG_DEFAULTS = {
  site_name: '民航客机收藏馆',
  announcement: '',
  ai_entry_enabled: '1',
  feedback_enabled: '1',
  glossary_enabled: '1'
};

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function d1(env) {
  var db = env && env.AI_LOG_DB;
  return db && typeof db.prepare === 'function' ? db : null;
}

function baseHeaders(context) {
  var h = Object.assign({ 'Cache-Control': 'no-store' }, withSecurity({}));
  var cors = resolveCors(context.request, context.env);
  return Object.assign(h, cors);
}

function d1Missing(context) {
  return fail(
    ERR.NOT_CONFIGURED,
    '数据表未就绪：请先执行 sql/0002_site_data.sql（wrangler d1 execute）',
    503,
    baseHeaders(context),
    { needMigration: '0002_site_data.sql' }
  );
}

/* ------------------------------------------------------------------ */
/* 只读资源                                                            */
/* ------------------------------------------------------------------ */

function resourceAircraft(context) {
  var url = new URL(context.request.url);
  var slug = normalizeText(url.searchParams.get('slug') || '');
  if (slug) {
    var doc = aircraftDetail(slug);
    if (!doc) {
      return fail(ERR.NOT_FOUND, '机型不存在：' + slug, 404, baseHeaders(context));
    }
    return ok(
      {
        resource: 'aircraft',
        item: doc,
        source: 'builtin:aircraft-index',
        note: '机型库为唯一事实来源，AI 回答同样以本库为准'
      },
      baseHeaders(context)
    );
  }
  var list = aircraftBriefs();
  return ok({ resource: 'aircraft', count: list.length, items: list, source: 'builtin:aircraft-index' }, baseHeaders(context));
}

async function resourceGlossary(context) {
  var url = new URL(context.request.url);
  var q = normalizeText(url.searchParams.get('q') || '');
  var limit = clamp(toInt(url.searchParams.get('limit'), 50), 1, 200);
  var extra = [];
  try {
    extra = await loadDbTerms(context.env);
  } catch (e) {
    extra = [];
  }
  if (q) {
    var found = searchGlossary(q, limit, extra);
    return ok(
      {
        resource: 'glossary',
        query: q,
        count: found.hits.length,
        items: found.hits.map(function (h) {
          return publicTerm(h.term);
        })
      },
      baseHeaders(context)
    );
  }
  var all = listTerms(extra);
  return ok({ resource: 'glossary', count: all.length, items: all.slice(0, limit) }, baseHeaders(context));
}

function resourceStats(context) {
  var stats = libraryStats();
  return ok(
    {
      resource: 'stats',
      aircraft: { count: stats.count, byCountry: stats.byCountry, byTag: stats.byTag },
      meta: stats.meta
    },
    baseHeaders(context)
  );
}

function resourceCapabilities(context) {
  var env = context.env;
  var flags = null;
  return getFlags(env, { fresh: false }).then(function (f) {
    flags = f;
    var tiers = TIERS.map(function (t) {
      var cfg = tierConfig(env, t);
      return {
        tier: t,
        label: cfg.label,
        model: cfg.model,
        purpose: cfg.purpose,
        maxTokens: cfg.maxTokens,
        temperature: cfg.temperature,
        timeoutMs: cfg.timeoutMs
      };
    });
    return ok(
      {
        resource: 'capabilities',
        version: env.AI_API_VERSION || '1.0',
        tiers: tiers,
        models: modelAllowlist(env),
        limits: quotaDefaults(env),
        flags: flags,
        endpoints: {
          chat: '/api/chat',
          token: '/api/token',
          glossary: '/api/glossary',
          aircraft: '/api/aircraft',
          data: '/api/data',
          health: '/api/health',
          prewarm: '/api/prewarm'
        },
        note: '模型列表与限额由服务端下发，前端禁止硬编码密钥或自行拼接上游地址'
      },
      baseHeaders(context)
    );
  });
}

async function resourceConfig(context) {
  var out = Object.assign({}, SITE_CONFIG_DEFAULTS);
  var source = 'defaults';
  var db = d1(context.env);
  if (db) {
    try {
      var res = await db.prepare('SELECT key, value FROM site_config LIMIT 200').all();
      var rows = (res && res.results) || [];
      rows.forEach(function (r) {
        if (r && r.key) out[r.key] = r.value;
      });
      if (rows.length) source = 'd1';
    } catch (e) {
      source = 'defaults';
    }
  }
  return ok({ resource: 'config', source: source, config: out }, baseHeaders(context));
}

async function resourceMessages(context) {
  if (checkAdminToken(context.request, context.env).ok !== true) {
    return fail(ERR.UNAUTHORIZED, '需要管理员口令', 401, baseHeaders(context));
  }
  var db = d1(context.env);
  if (!db) return d1Missing(context);
  var url = new URL(context.request.url);
  var limit = clamp(toInt(url.searchParams.get('limit'), 50), 1, 200);
  var status = normalizeText(url.searchParams.get('status') || '');
  var where = [];
  var binds = [];
  if (status) {
    where.push('status = ?');
    binds.push(status);
  }
  try {
    var sql =
      'SELECT id, ts, day, kind, subject, ref_slug, status, contact, content, review_note, request_id FROM site_message' +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY ts DESC, id DESC LIMIT ' + limit;
    var res2 = await db.prepare(sql).bind.apply(null, binds).all();
    return ok(
      { resource: 'messages', count: ((res2 && res2.results) || []).length, items: (res2 && res2.results) || [] },
      baseHeaders(context)
    );
  } catch (e) {
    return d1Missing(context);
  }
}

/* ------------------------------------------------------------------ */
/* 写入：留言 / 纠错 / 术语建议                                          */
/* ------------------------------------------------------------------ */

const MESSAGE_KINDS = ['feedback', 'correction', 'glossary', 'contact'];
const CONTENT_MAX = 2000;

async function createMessage(context) {
  var env = context.env;
  var flags = await getFlags(env, { fresh: false });
  if (!flags.write_enabled) {
    return fail(
      ERR.FORBIDDEN,
      '数据写入当前已关闭（开关 write_enabled=false）；如需开放请在管理端开启',
      403,
      baseHeaders(context),
      { flag: 'write_enabled' }
    );
  }

  var db = d1(env);
  if (!db) return d1Missing(context);

  var maxBytes = toInt(env.AI_MAX_BODY_BYTES, 2 * 1024 * 1024);
  var parsed = await readJsonBody(context.request, maxBytes);
  if (!parsed.ok) {
    return fail(parsed.error || ERR.BAD_REQUEST, parsed.detail || '请求体解析失败', parsed.status || 400, baseHeaders(context));
  }
  var body = parsed.body || {};

  var kind = normalizeText(body.kind || 'feedback').toLowerCase();
  if (MESSAGE_KINDS.indexOf(kind) < 0) kind = 'feedback';

  var content = truncate(String(body.content || '').trim(), CONTENT_MAX);
  if (content.length < 2) {
    return fail(ERR.BAD_REQUEST, 'content 至少 2 个字符', 400, baseHeaders(context));
  }

  var subject = truncate(normalizeText(body.subject || ''), 120);
  var refSlug = truncate(normalizeText(body.slug || body.ref_slug || ''), 80);
  if (refSlug && !aircraftDetail(refSlug)) refSlug = '';     // 非法 slug 直接丢弃，不做存在性报错
  var contact = truncate(normalizeText(body.contact || ''), 120);

  var ts = nowSec();
  var requestId = newRequestId('data');
  var ip = getClientIp(context.request);
  var visitorId = resolveVisitorId(context.request, context, env.AI_VISITOR_COOKIE);
  var ipHash = ip ? await hashId(ip, env) : '';
  var visitorHash = visitorId ? await hashId(visitorId, env) : '';
  var uaHash = await hashId(context.request.headers.get('User-Agent') || 'ua-unknown', env);

  try {
    await db
      .prepare(
        'INSERT INTO site_message (ts, day, kind, subject, ref_slug, content, contact, status, review_note, request_id, visitor_hash, ip_hash, ua_hash) ' +
          'VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)'
      )
      .bind(ts, dayString(ts), kind, subject, refSlug, content, contact, 'pending', '', requestId, visitorHash, ipHash, uaHash)
      .run();
  } catch (e) {
    return d1Missing(context);
  }

  return ok(
    {
      resource: 'message',
      accepted: true,
      id: requestId,
      status: 'pending',
      autoIngest: false,
      note: '已进入待人工审核队列，不会自动写入机型库 / 术语库'
    },
    baseHeaders(context),
    201
  );
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

export async function onRequestOptions(context) {
  return resolveCors(context.request, context.env).constructor === Object
    ? new Response(null, { status: 204, headers: baseHeaders(context) })
    : new Response(null, { status: 204, headers: baseHeaders(context) });
}

export async function onRequestGet(context) {
  var url = new URL(context.request.url);
  var resource = normalizeText(url.searchParams.get('resource') || 'aircraft').toLowerCase();
  if (RESOURCES.indexOf(resource) < 0) {
    return fail(
      ERR.BAD_REQUEST,
      'resource 不合法，可选：' + RESOURCES.join(' / '),
      400,
      baseHeaders(context)
    );
  }
  var headers = baseHeaders(context);
  if (resource === 'aircraft') {
    var r = resourceAircraft(context);
    return r;
  }
  if (resource === 'glossary') return await resourceGlossary(context);
  if (resource === 'stats') return resourceStats(context);
  if (resource === 'capabilities') {
    var resp = await resourceCapabilities(context);
    return resp;
  }
  if (resource === 'config') return await resourceConfig(context);
  if (resource === 'messages') return await resourceMessages(context);
  return fail(ERR.NOT_FOUND, '资源不存在', 404, headers);
}

export async function onRequestPost(context) {
  var url = new URL(context.request.url);
  var resource = normalizeText(url.searchParams.get('resource') || 'message').toLowerCase();
  if (resource === 'message') return await createMessage(context);
  return fail(ERR.BAD_REQUEST, '仅支持 resource=message 的写入', 400, baseHeaders(context));
}

export async function onRequest(context) {
  var m = context.request.method;
  if (m === 'OPTIONS') return onRequestOptions(context);
  if (m === 'GET') return onRequestGet(context);
  if (m === 'POST') return onRequestPost(context);
  return methodNotAllowed('GET, POST, OPTIONS', baseHeaders(context));
}
