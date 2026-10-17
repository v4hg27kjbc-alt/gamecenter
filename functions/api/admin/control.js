/**
 * /api/admin/control —— 「访客协助台」管理 API（委婉命名的用户访问管控）
 *
 * 路由（全部需管理员口令 X-Admin-Token / Authorization: Bearer）：
 *   GET  /api/admin/control?action=list-visitors&limit=100   访问统计列表（含受限标注）
 *   GET  /api/admin/control?action=list-restrictions         全部受限记录（用户/地区/全体）
 *   GET  /api/admin/control?action=list-appeals&status=pending  解除协助申请列表
 *   POST /api/admin/control?action=restrict                  添加受限 {scope, target, reason, note}
 *   POST /api/admin/control?action=unrestrict                解除受限 {scope, target}
 *   POST /api/admin/control?action=resolve-appeal            审核申请 {id, action:'granted'|'denied'}
 *
 * 公开接口（无需登录，供前端访客提交）：
 *   POST /api/admin/control?action=appeal                    提交解除申请 {q, note, contact}
 *
 * 数据：主站 KV（AI_RATE_KV），见 _lib/usercontrol.js。
 * 隐私：列表只返回加盐哈希标识，不落原始 IP / 访客 ID 明文。
 */

import {
  ERR,
  ok,
  fail,
  methodNotAllowed,
  resolveCors,
  corsPreflight,
  readJsonBody,
  checkAdminToken,
  resolveVisitorId,
  hashId,
  toInt
} from '../_lib/http.js';
import {
  listVisitors,
  listRestrictions,
  listAppeals,
  addRestriction,
  removeRestriction,
  submitAppeal,
  resolveAppeal
} from '../_lib/usercontrol.js';

export async function onRequestOptions(context) {
  return corsPreflight(context.request, context.env, { methods: 'GET, POST, OPTIONS' });
}

export async function onRequestGet(context) {
  var request = context.request;
  var env = context.env || {};
  var cors = resolveCors(request, env, { methods: 'GET, POST, OPTIONS' });
  if (cors.hasOrigin && !cors.ok) return fail(ERR.FORBIDDEN_ORIGIN, '请求来源不在白名单内', 403, cors.headers);
  var auth = checkAdminToken(request, env);
  if (!auth.ok) return fail(auth.reason, '需要管理员权限', 401, cors.headers);

  var url = new URL(request.url);
  var action = url.searchParams.get('action') || 'list-visitors';
  try {
    if (action === 'list-visitors') {
      var limit = toInt(url.searchParams.get('limit'), 100);
      var visitors = await listVisitors(env, limit);
      var restrictions = await listRestrictions(env);
      var restrictedUsers = {};
      var restrictedCountries = {};
      var restrictedPrefixes = {};
      var globalRestricted = false;
      for (var i = 0; i < restrictions.length; i++) {
        var r = restrictions[i];
        if (r.scope === 'user') restrictedUsers[r.target] = r;
        else if (r.scope === 'country') restrictedCountries[r.target] = r;
        else if (r.scope === 'ipprefix') restrictedPrefixes[r.target] = r;
        else if (r.scope === 'global') globalRestricted = true;
      }
      var rows = visitors.map(function (v) {
        var rUser = restrictedUsers[v.hash] || null;
        var restricted = !!(globalRestricted || rUser);
        var level = rUser ? 1 : (globalRestricted ? 3 : 0);
        var note = rUser ? rUser.note : (globalRestricted ? '全体受限' : '');
        return {
          hash: v.hash,
          visits: v.visits,
          firstVisit: v.firstVisit,
          lastVisit: v.lastVisit,
          country: v.country,
          ipPrefix: v.ip ? ipShort(v.ip) : '',
          restricted: restricted,
          level: level,
          note: note
        };
      });
      return ok({ visitors: rows, total: rows.length, globalRestricted: globalRestricted, restrictions: restrictions.length }, cors.headers);
    }
    if (action === 'list-restrictions') {
      return ok({ restrictions: await listRestrictions(env) }, cors.headers);
    }
    if (action === 'list-appeals') {
      var status = url.searchParams.get('status') || '';
      return ok({ appeals: await listAppeals(env, status) }, cors.headers);
    }
    return fail(ERR.BAD_REQUEST, '未知的 action：' + action, 400, cors.headers);
  } catch (err) {
    return fail(ERR.INTERNAL, '访客协助台查询失败：' + (err && err.message ? err.message : String(err)), 500, cors.headers);
  }
}

function ipShort(ip) {
  var s = String(ip || '');
  return s.indexOf(':') >= 0 ? s.slice(0, 16) + '…' : s;
}

export async function onRequestPost(context) {
  var request = context.request;
  var env = context.env || {};
  var cors = resolveCors(request, env, { methods: 'GET, POST, OPTIONS' });
  if (cors.hasOrigin && !cors.ok) return fail(ERR.FORBIDDEN_ORIGIN, '请求来源不在白名单内', 403, cors.headers);

  var url = new URL(request.url);
  var action = url.searchParams.get('action') || '';

  /* 公开：用户提交解除协助申请（无需管理员口令；访客标识从 HttpOnly Cookie 解析并加盐哈希） */
  if (action === 'appeal') {
    try {
      var visitorId = resolveVisitorId(request, context, env.AI_VISITOR_COOKIE || 'ai_vid');
      if (!visitorId) return fail(ERR.INVALID_VISITOR, '缺少访客标识，请刷新页面后重试', 400, cors.headers);
      var body = await readJsonBody(request, 65536);
      var aHash = await hashId(visitorId, env);
      var rec = await submitAppeal(env, {
        visitorHash: aHash,
        q: body.q || '',
        note: body.note || '',
        contact: body.contact || ''
      });
      return ok({ ok: true, appeal: rec }, cors.headers);
    } catch (err) {
      return fail(ERR.BAD_REQUEST, '申请提交失败：' + (err && err.message ? err.message : String(err)), 400, cors.headers);
    }
  }

  var auth = checkAdminToken(request, env);
  if (!auth.ok) return fail(auth.reason, '需要管理员权限', 401, cors.headers);

  try {
    var body2 = await readJsonBody(request, 65536);
    if (action === 'restrict') {
      var rec2 = await addRestriction(env, {
        scope: body2.scope,
        target: body2.target,
        reason: body2.reason,
        note: body2.note
      });
      return ok({ ok: true, restriction: rec2 }, cors.headers);
    }
    if (action === 'unrestrict') {
      var r3 = await removeRestriction(env, { scope: body2.scope, target: body2.target });
      return ok({ ok: true, removed: r3.removed }, cors.headers);
    }
    if (action === 'resolve-appeal') {
      var r4 = await resolveAppeal(env, { id: body2.id, action: body2.action });
      return ok({ ok: true, appeal: r4 }, cors.headers);
    }
    return fail(ERR.BAD_REQUEST, '未知的 action：' + action, 400, cors.headers);
  } catch (err) {
    return fail(ERR.BAD_REQUEST, '访客协助台操作失败：' + (err && err.message ? err.message : String(err)), 400, cors.headers);
  }
}

export async function onRequest(context) {
  return methodNotAllowed(['GET', 'POST', 'OPTIONS'], resolveCors(context.request, context.env, { methods: 'GET, POST, OPTIONS' }).headers);
}
