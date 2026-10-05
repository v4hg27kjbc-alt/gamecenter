/**
 * /api/admin/logs —— AI 调用日志与成本核算（清单 B-20 / B-41 / B-42 / B-43）
 *
 * 用途：管理端「AI 用量」面板的后端。所有查询都是只读聚合，只有「标记已采纳」
 *       一个写操作，且该写操作**不触碰机型库 / 术语库**。
 *
 * 路由：
 *   GET /api/admin/logs?view=summary&days=7        按天/模型/功能汇总（成本、token、缓存、降级）
 *   GET /api/admin/logs?view=calls&limit=100       逐次调用明细（支持过滤）
 *   GET /api/admin/logs?view=asks&limit=100        提问记录（AI 生成内容待人工确认入库）
 *   GET /api/admin/logs?view=pricing               当前计价表（供前端展示成本口径）
 *   GET /api/admin/logs?view=calls&format=csv      导出调用明细 CSV
 *   GET /api/admin/logs?view=asks&format=csv       导出提问记录 CSV
 *   POST /api/admin/logs?action=curate             标记某条提问记录「已人工采纳」
 *
 * 过滤参数（view=calls / asks 通用）：
 *   from / to（Unix 秒）、day（YYYY-MM-DD）、model、feature、
 *   onlyDegraded=1、onlyCached=1、limit（≤500）
 *
 * 鉴权：管理员口令（X-Admin-Token 或 ?token=）。
 *
 * 数据落点（见 sql/0001_ai_tables.sql）：
 *   ai_call_log     逐次调用明细（含模型、token、耗时、成本、缓存 / 降级 / RAG 命中）
 *   ai_call_summary 按 天 × 模型 × 功能 的汇总表
 *   ai_ask_log      提问记录（curated=0 表示尚未人工确认，永不被自动写入机型库）
 *
 * 隐私口径：入库前已把 IP / 访客 ID 替换为加盐哈希，明细里不含原始标识。
 */

import {
  ERR,
  ok,
  fail,
  csvResponse,
  withSecurity,
  methodNotAllowed,
  resolveCors,
  readJsonBody,
  checkAdminToken,
  toInt,
  toBool,
  normalizeText
} from '../_lib/http.js';
import {
  queryLogs,
  summarizeLogs,
  queryAsks,
  logsToCsv,
  asksToCsv,
  pricingTable,
  formatCost,
  storageMode,
  markAskCurated
} from '../_lib/logging.js';

function baseHeaders(context) {
  var h = Object.assign({ 'Cache-Control': 'no-store' }, withSecurity({}));
  return Object.assign(h, resolveCors(context.request, context.env));
}

function requireAdmin(context) {
  if (checkAdminToken(context.request, context.env).ok !== true) {
    return fail(ERR.UNAUTHORIZED, '需要管理员口令（X-Admin-Token 或 ?token=）', 401, baseHeaders(context));
  }
  return null;
}

function buildFilter(url) {
  var f = {
    limit: toInt(url.searchParams.get('limit'), 100),
    day: normalizeText(url.searchParams.get('day') || ''),
    model: normalizeText(url.searchParams.get('model') || ''),
    feature: normalizeText(url.searchParams.get('feature') || ''),
    onlyDegraded: toBool(url.searchParams.get('onlyDegraded'), false),
    onlyCached: toBool(url.searchParams.get('onlyCached'), false)
  };
  var from = toInt(url.searchParams.get('from'), 0);
  var to = toInt(url.searchParams.get('to'), 0);
  if (from) f.from = from;
  if (to) f.to = to;
  return f;
}

export async function onRequestGet(context) {
  var denied = requireAdmin(context);
  if (denied) return denied;

  var env = context.env;
  var url = new URL(context.request.url);
  var view = (url.searchParams.get('view') || 'summary').toLowerCase();
  var format = (url.searchParams.get('format') || '').toLowerCase();
  var filter = buildFilter(url);
  var headers = baseHeaders(context);

  if (view === 'pricing') {
    return ok(
      {
        view: 'pricing',
        units: 'cost_micro 为微元（1 元 = 1,000,000 微元）',
        table: pricingTable(env),
        sample: {
          '0.001 元': formatCost(1000),
          '1 元': formatCost(1000000)
        }
      },
      headers
    );
  }

  if (view === 'calls') {
    var calls = await queryLogs(env, filter);
    if (format === 'csv') {
      return csvResponse(logsToCsv(calls.rows || []), 'ai-calls-' + new Date().toISOString().slice(0, 10) + '.csv', headers);
    }
    return ok(
      {
        view: 'calls',
        storage: calls.storage || storageMode(env),
        ok: calls.ok !== false,
        reason: calls.reason || '',
        count: (calls.rows || []).length,
        truncated: !!calls.truncated,
        items: calls.rows || []
      },
      headers
    );
  }

  if (view === 'asks') {
    var asks = await queryAsks(env, filter);
    if (format === 'csv') {
      return csvResponse(asksToCsv(asks.rows || []), 'ai-asks-' + new Date().toISOString().slice(0, 10) + '.csv', headers);
    }
    return ok(
      {
        view: 'asks',
        storage: asks.storage || storageMode(env),
        ok: asks.ok !== false,
        reason: asks.reason || '',
        count: (asks.rows || []).length,
        items: asks.rows || [],
        note: 'curated=0 表示尚未人工确认；这些记录不会被自动写入机型库或术语库'
      },
      headers
    );
  }

  var summary = await summarizeLogs(env, { days: toInt(url.searchParams.get('days'), 7) });
  return ok(
    {
      view: 'summary',
      storage: summary.storage || storageMode(env),
      ok: summary.ok !== false,
      reason: summary.reason || '',
      days: summary.days,
      summary: summary.summary || {},
      byDay: summary.byDay || [],
      byModel: summary.byModel || [],
      byFeature: summary.byFeature || []
    },
    headers
  );
}

export async function onRequestPost(context) {
  var denied = requireAdmin(context);
  if (denied) return denied;

  var url = new URL(context.request.url);
  var action = (url.searchParams.get('action') || '').toLowerCase();
  if (action !== 'curate') {
    return fail(ERR.BAD_REQUEST, '仅支持 action=curate', 400, baseHeaders(context));
  }

  var parsed = await readJsonBody(context.request, toInt(context.env.AI_MAX_BODY_BYTES, 2 * 1024 * 1024));
  if (!parsed.ok) {
    return fail(parsed.error || ERR.BAD_REQUEST, parsed.detail || '请求体解析失败', parsed.status || 400, baseHeaders(context));
  }
  var body = parsed.body || {};
  var id = body.id;
  if (id === undefined || id === null || id === '') {
    return fail(ERR.BAD_REQUEST, '缺少 id（ai_ask_log.id）', 400, baseHeaders(context));
  }

  var r = await markAskCurated(context.env, id, body.note || '');
  if (!r || r.ok !== true) {
    return fail(
      ERR.NOT_CONFIGURED,
      '标记失败：' + ((r && r.reason) || '数据表未就绪或记录不存在'),
      503,
      baseHeaders(context)
    );
  }

  return ok(
    {
      curated: true,
      id: id,
      autoIngest: false,
      note: '已标记为人工采纳；写入机型库 / 术语库仍需人工在后台资料模块手动完成，本接口不会自动入库'
    },
    baseHeaders(context)
  );
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: baseHeaders(context) });
}

export async function onRequest(context) {
  var m = context.request.method;
  if (m === 'OPTIONS') return onRequestOptions(context);
  if (m === 'GET' || m === 'HEAD') return onRequestGet(context);
  if (m === 'POST') return onRequestPost(context);
  return methodNotAllowed('GET, POST, OPTIONS', baseHeaders(context));
}
