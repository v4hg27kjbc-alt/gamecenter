/**
 * /api/prewarm —— 预生成与预热（清单 B-15）
 *
 * 作用：
 *   把「高频问题」的答案提前生成好，写入 KV + 请求指纹缓存。当访客提出同问时，
 *   /api/chat 会直接命中缓存返回，既快又省上游额度。
 *
 * 路由：
 *   GET    /api/prewarm             查看预热状态（每个问题的完成 / 待生成 / 失败）
 *   GET    /api/prewarm?list=1      查看预热问题清单（不含答案）
 *   POST   /api/prewarm             执行预热（支持分批、指定 id、强制重跑）
 *   DELETE /api/prewarm?id=xxx      删除某条预热结果
 *
 * 鉴权：全部需要管理员口令（X-Admin-Token 或 ?token=），因为预热会消耗上游额度。
 *
 * 请求体（POST，均可选）：
 *   { "ids": ["site-aircraft-count"], "force": false, "limit": 4, "ttl": 604800 }
 *   · ids    仅预热指定问题 id（缺省=全部待生成项）
 *   · force  true 时忽略已有结果重跑（用于机型库更新后刷新）
 *   · limit  本次最多执行条数（默认 4，上限 20）—— 顺序执行，避免瞬时打满上游配额
 *   · ttl    缓存有效期秒数（默认取 AI_PREWARM_TTL，兜底 7 天）
 *
 * 定时执行说明（重要）：
 *   Cloudflare Pages Functions **不支持**定时触发器（scheduled event）。
 *   需要定时预热时，请用外部计划任务（Cloudflare Worker Cron / GitHub Actions /
 *   cron-job.org 等）定时 POST 本接口，并携带管理员口令；建议每天 1 次、limit=4。
 *   也可以由管理端「一键预热」手动触发。
 *
 * 红线：
 *   预热答案与实时回答走**同一条** RAG 通道，库内无记录的机型参数必须回答
 *   「库内无记录」，不得因预热而放松事实性要求。
 */

import {
  ERR,
  ok,
  fail,
  withSecurity,
  methodNotAllowed,
  resolveCors,
  readJsonBody,
  checkAdminToken,
  toInt,
  clamp
} from './_lib/http.js';
import { runPrewarm, prewarmStatus, prewarmList, deletePrewarm } from './_lib/prewarm.js';
import { getFlags } from './_lib/flags.js';

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

export async function onRequestGet(context) {
  var denied = requireAdmin(context);
  if (denied) return denied;

  var url = new URL(context.request.url);
  if (url.searchParams.get('list') === '1') {
    return ok({ list: prewarmList() }, baseHeaders(context));
  }
  var status = await prewarmStatus(context.env);
  return ok(status, baseHeaders(context));
}

export async function onRequestPost(context) {
  var denied = requireAdmin(context);
  if (denied) return denied;

  var env = context.env;
  var flags = await getFlags(env, { fresh: false });
  if (!flags.ai_prewarm) {
    return fail(
      ERR.FORBIDDEN,
      '预热功能当前已关闭（开关 ai_prewarm=false）',
      403,
      baseHeaders(context),
      { flag: 'ai_prewarm' }
    );
  }

  var parsed = await readJsonBody(context.request, toInt(env.AI_MAX_BODY_BYTES, 2 * 1024 * 1024));
  var body = parsed.ok ? parsed.body || {} : {};

  var ids = Array.isArray(body.ids) ? body.ids.filter(function (v) { return typeof v === 'string' && v; }) : [];
  var options = {
    ids: ids,
    force: body.force === true,
    limit: clamp(toInt(body.limit, 4), 1, 20),
    ttl: body.ttl ? toInt(body.ttl, 0) : 0
  };

  var result = await runPrewarm(env, options);
  return ok(
    {
      mode: 'manual',
      ids: ids,
      force: options.force,
      limit: options.limit,
      result: result,
      note: '预热结果已写入 KV 与请求指纹缓存；前台同问将直接命中缓存'
    },
    baseHeaders(context)
  );
}

export async function onRequestDelete(context) {
  var denied = requireAdmin(context);
  if (denied) return denied;

  var url = new URL(context.request.url);
  var id = url.searchParams.get('id') || '';
  if (!id) return fail(ERR.BAD_REQUEST, '缺少 id 参数', 400, baseHeaders(context));

  var r = await deletePrewarm(context.env, id);
  if (!r || r.ok !== true) {
    return fail(ERR.NOT_FOUND, '未找到该预热记录：' + id, 404, baseHeaders(context));
  }
  return ok({ deleted: id }, baseHeaders(context));
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: baseHeaders(context) });
}

export async function onRequest(context) {
  var m = context.request.method;
  if (m === 'OPTIONS') return onRequestOptions(context);
  if (m === 'GET' || m === 'HEAD') return onRequestGet(context);
  if (m === 'POST') return onRequestPost(context);
  if (m === 'DELETE') return onRequestDelete(context);
  return methodNotAllowed('GET, POST, DELETE, OPTIONS', baseHeaders(context));
}
