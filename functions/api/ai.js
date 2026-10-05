/**
 * /api/ai —— 兼容入口（历史前端专用，清单 B-10 的向后兼容层）
 *
 * 背景：
 *   桌面既有交付包（AI代理-服务端 v1）里，前端调用的是 `POST /api/ai`。
 *   本次服务端中台把完整能力收敛到 `POST /api/chat`，但**不能让老前端失效**，
 *   因此保留 /api/ai 作为薄封装：不重复实现任何逻辑，直接转调 /api/chat。
 *
 * 语义等价关系：
 *   POST /api/ai   ≡  POST /api/chat
 *   入参、出参、错误码、SSE 事件格式完全一致（见 docs/接口契约.md）。
 *
 * 与 chat 的唯一差别：
 *   响应头会带上 `X-AI-Endpoint: /api/ai (compat)`，便于在浏览器 Network 面板
 *   与调用日志里区分「老前端流量」与「新前端流量」，为将来下线老入口提供数据依据。
 *
 * 迁移建议（给前端）：
 *   新代码请直接使用 /api/chat，并在请求体携带 tier / feature 以获得分级路由与
 *   更细的成本归集；老参数（model / messages / stream）继续被兼容支持。
 */

import { onRequestPost as chatPost, onRequestOptions as chatOptions } from './chat.js';
import { ERR, fail } from './_lib/http.js';

function tagCompat(response) {
  if (!response || !response.headers) return response;
  var headers = new Headers(response.headers);
  headers.set('X-AI-Endpoint', '/api/ai (compat)');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: headers
  });
}

export async function onRequestPost(context) {
  return tagCompat(await chatPost(context));
}

/**
 * GET /api/ai —— 兼容入口不提供 GET 语义
 * 历史实现误调用未定义的 chatGet()，会抛 ReferenceError 导致 500。
 * 此处改为显式 405，并给出正确调用方式（不删除文件，兼容层继续存在）。
 */
export async function onRequestGet(context) {
  return fail(
    ERR.METHOD_NOT_ALLOWED,
    '本接口仅支持 POST：请注意方法。',
    405,
    { 'Allow': 'POST, OPTIONS', 'X-AI-Endpoint': '/api/ai (compat)' }
  );
}

export async function onRequestOptions(context) {
  return chatOptions(context);
}
