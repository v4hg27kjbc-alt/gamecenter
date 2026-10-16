/**
 * POST /api/qa-logs —— 主站「AI 答不上来的问题 / AI 调用失败」上报
 * 数据源：后台（aviation-admin）「AI 答不上来的问题 Top」榜与记录数统计（qa_logs 表）
 * 触发场景：
 *   1) 前端 RAG 未命中 / 资料不足（reason: retrieval-empty / insufficient-context）
 *   2) AI 无法回答（超时 / 网络失败 / 服务端错误，reason: llm-failed，由 AIBridge 统一上报）
 * 请求体：{ q, reason, hits, answered, uid }
 */
import {
  ok,
  fail,
  methodNotAllowed,
  corsPreflight,
  readJsonBody
} from './_lib/http.js';

const REASONS = ['retrieval-empty', 'insufficient-context', 'llm-failed'];
const MAX_Q = 200;

function str(v, max) {
  if (v === undefined || v === null) return '';
  var s = String(v).trim();
  if (max && s.length > max) s = s.slice(0, max);
  return s;
}

function nowIso() {
  return new Date().toISOString();
}

function ensureTable(db) {
  return db
    .prepare(
      "CREATE TABLE IF NOT EXISTS qa_logs (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "question TEXT NOT NULL, " +
        "reason TEXT DEFAULT '', " +
        "hits INTEGER DEFAULT 0, " +
        "answered INTEGER DEFAULT 0, " +
        "uid TEXT DEFAULT '', " +
        "created_at TEXT DEFAULT ''" +
      ")"
    )
    .run();
}

export async function onRequestOptions(context) {
  return corsPreflight(context.request, context.env);
}

export async function onRequestPost(context) {
  try {
    var env = context.env || {};
    if (!env.DB) {
      return fail('AI_LOG_DB', '服务端未配置 D1 绑定（DB），无法记录问答日志', 500, {});
    }
    var body = await readJsonBody(context.request, 8192);
    if (!body.ok) {
      return fail(body.error || 'BAD_REQUEST', body.message || '请求体无效', body.status || 400, {});
    }
    var data = body.data || {};
    var q = str(data.q || data.question, MAX_Q);
    if (!q) {
      return fail('BAD_REQUEST', '缺少必填字段：q（提问内容）', 400, {});
    }
    var reason = str(data.reason, 40);
    if (REASONS.indexOf(reason) < 0) reason = 'retrieval-empty';
    var hits = parseInt(data.hits, 10);
    if (isNaN(hits) || hits < 0) hits = 0;
    if (hits > 100000) hits = 100000;
    var answered = data.answered ? 1 : 0;
    var uid = str(data.uid, 80);

    await ensureTable(env.DB);
    await env.DB.prepare(
      'INSERT INTO qa_logs (question, reason, hits, answered, uid, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind(q, reason, hits, answered, uid, nowIso())
      .run();

    return ok({ ok: true, recorded: true }, {});
  } catch (err) {
    return fail(
      'INTERNAL',
      '问答日志写入失败：' + (err && err.message ? String(err.message) : String(err)),
      500,
      {}
    );
  }
}

export async function onRequest(context) {
  var method = (context.request && context.request.method) || 'GET';
  if (method === 'POST') return onRequestPost(context);
  if (method === 'OPTIONS') return onRequestOptions(context);
  return methodNotAllowed('POST, OPTIONS', {});
}
