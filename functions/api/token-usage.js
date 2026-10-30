/**
 * GET /api/token-usage —— Token 用量看板（主站版）
 *
 * 鉴权：X-Admin-Token（与 env.ADMIN_TOKEN 比对）。
 * 实现：同域转发 /api/admin/stats?days=N（携带同一管理令牌），
 *       返回用量汇总 + 近 N 日趋势，供「Token 用量」分区渲染。
 *
 * 响应：200 { ok:true, data: { usage:{...}, byDay:[...], byModel:[...], generatedAt, storage } }
 *      未鉴权 → 401；统计接口异常 → 502
 */

import {
  ok,
  fail,
  methodNotAllowed,
  resolveCors,
  corsPreflight,
  checkAdminToken
} from './_lib/http.js';

function daysOf(url) {
  const m = (url.searchParams ? url.searchParams.get('days') : null) || '';
  const d = parseInt(m, 10);
  if (!d) return 7;
  return Math.max(1, Math.min(90, d));
}

function baseHeaders(context) {
  const cors = resolveCors(context.request, context.env);
  return Object.assign({ 'Cache-Control': 'no-store' }, cors.headers);
}

function adminGate(context) {
  const verdict = checkAdminToken(context.request, context.env);
  if (!verdict.ok) {
    const cors = resolveCors(context.request, context.env);
    const code = verdict.reason === 'not_configured' ? 'not_configured' : 'unauthorized';
    return fail(code, verdict.reason === 'not_configured' ? '服务端未配置管理令牌 ADMIN_TOKEN' : '需要管理员令牌（X-Admin-Token）', 401, cors.headers);
  }
  return null;
}

export async function onRequestOptions(context) {
  return corsPreflight(context.request, context.env);
}

export async function onRequestGet(context) {
  try {
    const g = adminGate(context);
    if (g) return g;

    const url = new URL(context.request.url);
    const days = daysOf(url);

    const base = new URL(context.request.url);
    const upstream = await fetch(base.origin + '/api/admin/stats?days=' + days, {
      method: 'GET',
      headers: {
        'X-Admin-Token': (context.env && context.env.ADMIN_TOKEN) ? String(context.env.ADMIN_TOKEN) : '',
        'Accept': 'application/json'
      }
    });

    let payload = null;
    const text = await upstream.text();
    try { payload = JSON.parse(text); } catch (e) { payload = null; }

    if (!upstream.ok || !payload || payload.ok !== true) {
      return fail('UPSTREAM', '用量统计接口暂不可用（' + upstream.status + '）', 502, baseHeaders(context));
    }

    const data = payload.data || payload;
    return ok({ ok: true, data: data }, baseHeaders(context));
  } catch (e) {
    return fail('INTERNAL', '用量查询失败：' + ((e && e.message) ? e.message : '未知错误'), 500, baseHeaders(context));
  }
}

export async function onRequest(context) {
  return methodNotAllowed(
    ['GET', 'OPTIONS'],
    resolveCors(context.request, context.env).headers
  );
}
