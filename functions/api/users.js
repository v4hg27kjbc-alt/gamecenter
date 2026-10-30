/**
 * /api/users —— 用户管理后端（主站版）
 *
 * 鉴权：X-Admin-Token（与 env.ADMIN_TOKEN 比对）。
 * 存储：NEWS_KV（key: admin:users:v1）—— 用户登记表
 *       字段：{ id, username, phone, passwordHash, role, status, mutedUntil,
 *               violationCount, source, createdAt }
 *       状态：active | muted | banned | flagged
 *
 * 路由：
 *   GET  /api/users                    列表（admin）
 *   POST /api/users                    创建（admin；passwordHash 前端 SHA-256）
 *   POST /api/users/action             { ids:[...], action:'mute'|'unmute'|'flag'|'ban'|'unban', minutes?, reason? }
 *   GET  /api/users/:id                单用户详情（预留）
 *   POST /api/users/:id/action         单用户操作（兼容）
 */

import {
  ok,
  fail,
  methodNotAllowed,
  resolveCors,
  corsPreflight,
  checkAdminToken,
  readJsonBody,
  timingSafeEqual
} from './_lib/http.js';

const USERS_KEY = 'admin:users:v1';
const MAX_USERS = 2000;

function kvOf(env) {
  return (env && env.NEWS_KV && typeof env.NEWS_KV.get === 'function' && typeof env.NEWS_KV.put === 'function') ? env.NEWS_KV : null;
}

async function loadUsers(env) {
  const kv = kvOf(env);
  if (!kv) return [];
  try {
    const raw = await kv.get(USERS_KEY, 'json');
    return Array.isArray(raw) ? raw : (raw && Array.isArray(raw.users) ? raw.users : []);
  } catch (e) {
    return [];
  }
}

async function saveUsers(env, users) {
  const kv = kvOf(env);
  if (!kv) throw new Error('NEWS_KV 未绑定，无法持久化用户数据');
  await kv.put(USERS_KEY, JSON.stringify({ users: users }));
}

function publicView(u) {
  return {
    id: u.id,
    username: u.username,
    phone: u.phone || '',
    phoneMasked: u.phone ? (u.phone.length >= 7 ? u.phone.slice(0, 3) + '****' + u.phone.slice(-4) : '****') : '',
    passwordHash: u.passwordHash || '',
    role: u.role || 'guest',
    status: u.status || 'active',
    mutedUntil: u.mutedUntil || null,
    violationCount: u.violationCount || 0,
    source: u.source || 'admin',
    createdAt: u.createdAt || ''
  };
}

function normalizeAction(action) {
  const map = { mute: 'mute', unmute: 'unmute', flag: 'flag', unflag: 'flag', ban: 'ban', unban: 'unban' };
  return map[String(action || '').toLowerCase()] || null;
}

function normalizePhone(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  return s.replace(/[^\d+]/g, '').slice(0, 20);
}

function nowIso() {
  return new Date().toISOString();
}

function genId(prefix) {
  return (prefix || 'rec') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function applyAction(u, action, body) {
  const now = Date.now();
  const minutes = Math.max(1, Math.min(1440 * 30, parseInt(body.minutes, 10) || 60));
  switch (action) {
    case 'mute':
      u.status = 'muted';
      u.mutedUntil = new Date(now + minutes * 60 * 1000).toISOString();
      u.violationCount = (u.violationCount || 0) + 1;
      u.lastActionAt = nowIso();
      u.lastActionReason = String(body.reason || '').slice(0, 200);
      break;
    case 'unmute':
      if (u.status === 'muted') { u.status = 'active'; u.mutedUntil = null; u.lastActionAt = nowIso(); }
      break;
    case 'flag':
      u.status = 'flagged';
      u.violationCount = (u.violationCount || 0) + 1;
      u.lastActionAt = nowIso();
      u.lastActionReason = String(body.reason || '').slice(0, 200);
      break;
    case 'ban':
      u.status = 'banned';
      u.violationCount = (u.violationCount || 0) + 1;
      u.lastActionAt = nowIso();
      u.lastActionReason = String(body.reason || '').slice(0, 200);
      break;
    case 'unban':
      if (u.status === 'banned' || u.status === 'flagged') { u.status = 'active'; u.lastActionAt = nowIso(); }
      break;
  }
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
    const kv = kvOf(context.env);
    if (!kv) return fail('KV_UNAVAILABLE', '服务端未绑定 NEWS_KV，用户管理不可用', 503, baseHeaders(context));

    const url = new URL(context.request.url);
    const seg = url.pathname.split('/').filter(Boolean);
    if (seg.length >= 3 && seg[seg.length - 2] === 'users') {
      const id = decodeURIComponent(seg[seg.length - 1]);
      const users = await loadUsers(context.env);
      const u = users.find(function (x) { return x.id === id; });
      if (!u) return fail('NOT_FOUND', '用户不存在', 404, baseHeaders(context));
      return ok({ ok: true, data: publicView(u) }, baseHeaders(context));
    }

    const users = await loadUsers(context.env);
    const keyword = (url.searchParams.get('q') || '').trim().toLowerCase();
    let list = users;
    if (keyword) {
      list = list.filter(function (x) {
        return (x.username || '').toLowerCase().indexOf(keyword) >= 0 ||
               (x.phone || '').indexOf(keyword) >= 0;
      });
    }
    const statusFilter = url.searchParams.get('status') || '';
    if (statusFilter && statusFilter !== 'all') {
      list = list.filter(function (x) { return (x.status || 'active') === statusFilter; });
    }
    return ok({ ok: true, data: { users: list.map(publicView), total: users.length, count: list.length } }, baseHeaders(context));
  } catch (e) {
    return fail('INTERNAL', '用户列表获取失败：' + ((e && e.message) ? e.message : '未知错误'), 500, baseHeaders(context));
  }
}

export async function onRequestPost(context) {
  try {
    const g = adminGate(context);
    if (g) return g;
    const kv = kvOf(context.env);
    if (!kv) return fail('KV_UNAVAILABLE', '服务端未绑定 NEWS_KV，用户管理不可用', 503, baseHeaders(context));

    const parsed = await readJsonBody(context.request, 64 * 1024);
    if (!parsed.ok) return fail(parsed.error, parsed.message, parsed.status, baseHeaders(context));
    const body = parsed.data || {};

    const url = new URL(context.request.url);
    const seg = url.pathname.split('/').filter(Boolean);

    // 兼容前端批量写法：POST /api/users  { action:'batch', op, ids } / { action:'single', id, op }
    if (body.action === 'batch' && seg[seg.length - 1] === 'users') {
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const action = normalizeAction(body.op || body.action2);
      if (!action) return fail('BAD_ACTION', '不支持的操作用 action', 400, baseHeaders(context));
      if (!ids.length) return fail('EMPTY_IDS', '请选择要操作的用户', 400, baseHeaders(context));
      const users = await loadUsers(context.env);
      const target = users.filter(function (x) { return ids.indexOf(x.id) >= 0; });
      if (!target.length) return fail('NOT_FOUND', '未匹配到所选用户', 404, baseHeaders(context));
      target.forEach(function (u) { applyAction(u, action, body); });
      await saveUsers(context.env, users);
      return ok({ ok: true, data: { count: target.length, ids: target.map(function (x) { return x.id; }) } }, baseHeaders(context));
    }

    if (body.action === 'single' && seg[seg.length - 1] === 'users') {
      const id = String(body.id || '');
      const action = normalizeAction(body.op);
      if (!action) return fail('BAD_ACTION', '不支持的操作用 action', 400, baseHeaders(context));
      if (!id) return fail('EMPTY_ID', '缺少用户 id', 400, baseHeaders(context));
      const users = await loadUsers(context.env);
      const u = users.find(function (x) { return x.id === id; });
      if (!u) return fail('NOT_FOUND', '用户不存在', 404, baseHeaders(context));
      applyAction(u, action, body);
      await saveUsers(context.env, users);
      return ok({ ok: true, data: publicView(u) }, baseHeaders(context));
    }

    // 单用户操作 POST /api/users/:id/action
    if (seg.length >= 4 && seg[seg.length - 3] === 'users' && seg[seg.length - 1] === 'action') {
      const id = decodeURIComponent(seg[seg.length - 2]);
      const action = normalizeAction(body.action);
      if (!action) return fail('BAD_ACTION', '不支持的操作用 action', 400, baseHeaders(context));
      const users = await loadUsers(context.env);
      const u = users.find(function (x) { return x.id === id; });
      if (!u) return fail('NOT_FOUND', '用户不存在', 404, baseHeaders(context));
      applyAction(u, action, body);
      await saveUsers(context.env, users);
      return ok({ ok: true, data: publicView(u) }, baseHeaders(context));
    }

    // 批量操作 POST /api/users/action
    if (seg[seg.length - 1] === 'action') {
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const action = normalizeAction(body.action);
      if (!action) return fail('BAD_ACTION', '不支持的操作用 action', 400, baseHeaders(context));
      if (!ids.length) return fail('EMPTY_IDS', '请选择要操作的用户', 400, baseHeaders(context));
      const users = await loadUsers(context.env);
      const target = users.filter(function (x) { return ids.indexOf(x.id) >= 0; });
      if (!target.length) return fail('NOT_FOUND', '未匹配到所选用户', 404, baseHeaders(context));
      target.forEach(function (u) { applyAction(u, action, body); });
      await saveUsers(context.env, users);
      return ok({ ok: true, data: { count: target.length, ids: target.map(function (x) { return x.id; }) } }, baseHeaders(context));
    }

    // 创建 POST /api/users
    const username = String(body.username || '').trim().slice(0, 80);
    const passwordHash = String(body.passwordHash || '').trim();
    const phone = String(body.phone || '').trim();
    const role = ['owner', 'admin', 'guest'].indexOf(String(body.role || 'guest')) >= 0 ? String(body.role) : 'guest';
    if (!username) return fail('BAD_NAME', '请输入用户名', 400, baseHeaders(context));
    if (passwordHash && !/^[a-f0-9]{32,128}$/i.test(passwordHash)) return fail('BAD_HASH', 'passwordHash 应为 SHA-256 十六进制串', 400, baseHeaders(context));
    const p = normalizePhone(phone);
    if (phone && !/^\d{11}$/.test(p)) return fail('BAD_PHONE', '手机号格式不正确（需 11 位数字）', 400, baseHeaders(context));

    const users = await loadUsers(context.env);
    if (users.length >= MAX_USERS) return fail('LIMIT', '用户数量已达上限', 400, baseHeaders(context));
    if (users.some(function (x) { return x.username.toLowerCase() === username.toLowerCase(); })) return fail('DUP_NAME', '用户名已存在', 409, baseHeaders(context));
    if (p && users.some(function (x) { return x.phone === p; })) return fail('DUP_PHONE', '手机号已被占用', 409, baseHeaders(context));

    const user = {
      id: genId('u'),
      username: username,
      phone: p || '',
      passwordHash: passwordHash,
      role: role,
      status: 'active',
      mutedUntil: null,
      violationCount: 0,
      source: 'admin',
      createdAt: nowIso()
    };
    users.push(user);
    await saveUsers(context.env, users);
    return jsonResponse({ ok: true, data: publicView(user) }, 201, baseHeaders(context));
  } catch (e) {
    return fail('INTERNAL', '用户操作失败：' + ((e && e.message) ? e.message : '未知错误'), 500, baseHeaders(context));
  }
}

export async function onRequest(context) {
  return methodNotAllowed(
    ['GET', 'POST', 'OPTIONS'],
    resolveCors(context.request, context.env).headers
  );
}
