/**
 * /api/coupon —— 券码兑换（主站前端调用，登录用户）
 *
 * 数据与后台 /api/coupons 共用 SMS_KV：
 *   coupon:code:<NORM>   → { code, couponCode, status, type, value, note, batch, prefix, createdAt, createdBy, exp, usedBy, usedByName, usedAt }
 *   coupon:index:v1      → [ 券摘要 ... ]（后台列表，同步状态）
 *   用户侧：acct:u:<uid>.coupons = [{ code, couponCode, type, value, note, at }]
 *
 * 路由（POST，body.action）：
 *   mine    { token }              → { coupons: [...] } 我的券（跨端同步来源）
 *   preview { code }               → { valid, status, type, value, note } 只读校验，不消耗
 *   redeem  { token, code }        → { coupon, coupons } 兑换并标记已使用
 *
 * 说明：券码一经兑换立即标记 used，记录使用者 UID/UID 名与时间；后台可查、可作废、可删除。
 * KV 为最终一致存储，极端并发下同一券码瞬时可能被两台设备同时读到未使用，故兑换采用
 * 「先标记后返回」并二次校验，正常使用（人工输入券码）不会触发该场景。
 */

import { normProjectKeys, couponAllowsProject, projectTitle } from './_lib/data/projects.js';
import { productGate, PRODUCT_OFFLINE_MESSAGE } from './_lib/product-gate.js';

const KV_NAME = 'SMS_KV';
const MAX_COUPONS_PER_USER = 200;

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-allow-methods': 'POST,OPTIONS',
    'content-type': 'application/json;charset=utf-8',
    'cache-control': 'no-store'
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: corsHeaders(origin) });
}

function ok(data, origin) {
  const body = Object.assign({ ok: true }, data || {});
  return json(body, 200, origin);
}

function bad(error, origin, extra, status) {
  const body = Object.assign({ ok: false, error: String(error || 'error') }, extra || {});
  return json(body, status || 200, origin);
}

/** 券码规范化：大写、仅保留 A-Z0-9，用于键与比对 */
function normCode(v) {
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function b64u(buf) {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  return atob(s + pad);
}

function secretOf(env) {
  return (env && (env.TOKEN_SECRET || env.AI_HASH_SALT)) || 'gc-account-fallback-secret-v1';
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
}

async function verifyToken(env, token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const expect = b64u(await hmac(secretOf(env), parts[1]));
  if (expect !== parts[2]) return null;
  try {
    const payload = JSON.parse(b64uDecode(parts[1]));
    if (!payload || !payload.u) return null;
    if (payload.e && payload.e < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

async function readBody(request) {
  try {
    return await request.json();
  } catch (e) {
    return null;
  }
}

async function userOfToken(env, kv, request, body) {
  const auth = request.headers.get('authorization') || '';
  const token = (auth.replace(/^Bearer\s+/i, '') || (body && body.token) || '').trim();
  const payload = await verifyToken(env, token);
  if (!payload) return null;
  const raw = await kv.get('acct:u:' + payload.u);
  if (!raw) return null;
  try {
    const u = JSON.parse(raw);
    if (u && String(u.status || '') === 'banned') return null;
    return u;
  } catch (e) {
    return null;
  }
}

async function readJson(kv, key, fallback) {
  try {
    const raw = await kv.get(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v === null || v === undefined ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

function displayOf(rec) {
  if (!rec) return '';
  if (rec.couponCode) return String(rec.couponCode);
  const n = normCode(rec.code);
  const p = n.startsWith('GC') ? n.slice(0, 2) : '';
  const rest = p ? n.slice(2) : n;
  return p ? p + '-' + rest.slice(0, 4) + '-' + rest.slice(4, 8) : n;
}

function isExpired(rec) {
  if (!rec || !rec.exp) return false;
  const t = Date.parse(rec.exp);
  if (!Number.isFinite(t)) return false;
  return t < Date.now();
}

function briefOf(rec) {
  return {
    code: displayOf(rec),
    type: String(rec.type || '通用券'),
    value: String(rec.value || ''),
    note: String(rec.note || ''),
    at: String(rec.usedAt || ''),
    useLimit: Number(rec.useLimit || 1),
    usedCount: Number(rec.usedCount || 0),
    remaining: Math.max(0, Number(rec.useLimit || 1) - Number(rec.usedCount || 0))
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  const origin = request.headers.get('origin') || '*';

  if (request.method === 'OPTIONS') return json({ ok: true }, 200, origin);
  if (request.method !== 'POST') return bad('method_not_allowed', origin, null, 405);

  const kv = env && env[KV_NAME];
  if (!kv) return bad('KV_UNAVAILABLE', origin, { hint: '服务端存储未就绪，稍后再试' }, 503);

  const body = await readBody(request);
  if (!body || !body.action) return bad('bad_request', origin);
  const action = String(body.action);

  // ---- 我的券码（登录用户，跨端同步）----
  if (action === 'mine') {
    const user = await userOfToken(env, kv, request, body);
    if (!user) return bad('unauthorized', origin, { hint: '请先登录' }, 401);
    const list = Array.isArray(user.coupons) ? user.coupons : [];
    return ok({ coupons: list }, origin);
  }

  // ---- 只读校验（不消耗）：用于输入时的即时反馈 ----
  if (action === 'preview') {
    const code = normCode(body.code);
    if (!code || code.length < 6) return bad('coupon_invalid', origin, { hint: '券码至少 6 位' });
    const rec = await readJson(kv, 'coupon:code:' + code, null);
    if (!rec) return ok({ valid: false, status: 'not_found' }, origin);
    let status = String(rec.status || 'active');
    if (status === 'active' && isExpired(rec)) status = 'expired';
    return ok({
      valid: status === 'active',
      status: status,
      type: String(rec.type || '通用券'),
      value: String(rec.value || ''),
      note: String(rec.note || ''),
      projectKeys: Array.isArray(rec.projectKeys) ? rec.projectKeys : [],
      projectTitles: (Array.isArray(rec.projectKeys) ? rec.projectKeys : []).map(projectTitle)
    }, origin);
  }

  // ---- 兑换：登录用户 + 券码有效 → 标记已使用 ----
  if (action === 'redeem') {
    const user = await userOfToken(env, kv, request, body);
    if (!user) return bad('unauthorized', origin, { hint: '请先登录后再兑换券码' }, 401);

    const code = normCode(body.code);
    if (!code || code.length < 6) return bad('coupon_invalid', origin, { hint: '请输入完整的券码' });
    if (code.length > 40) return bad('coupon_invalid', origin, { hint: '券码格式不正确' });

    const key = 'coupon:code:' + code;
    const rec = await readJson(kv, key, null);
    if (!rec) return bad('coupon_not_found', origin, { hint: '券码不存在，请核对后重试' });

    if (String(rec.status || '') === 'revoked') return bad('coupon_revoked', origin, { hint: '该券码已被作废，如有疑问请联系站长' });
    const useLimit = Math.max(1, Number(rec.useLimit || 1));
    const usedCount = Math.max(0, Number(rec.usedCount || 0));
    if (usedCount >= useLimit) return bad('coupon_used', origin, { hint: '该券码使用次数已达上限（' + useLimit + ' 次），已自动失效' });
    if (String(rec.status || '') === 'used') return bad('coupon_used', origin, { hint: '该券码已被使用，如有疑问请联系站长' });
    if (isExpired(rec)) return bad('coupon_expired', origin, { hint: '该券码已过期' });

    // 关联项目（v3.6）：必须真实关联才可用
    //  - 券码未关联任何项目 → 不可用于具体项目窗口（提示联系站长补关联）
    //  - 券码关联了项目，但当前窗口不是其中之一 → 拒绝
    const projList = Array.isArray(rec.projectKeys) ? rec.projectKeys.filter(Boolean) : [];
    const reqKey = String(body.projectKey || '').trim().toLowerCase();
    if (reqKey) {
      if (!projList.length) {
        return bad('coupon_no_project', origin, { message: '券码当前无权限', hint: '该券码未关联任何项目，暂不可用于此文档，请联系站长补关联' });
      }
      if (!couponAllowsProject(rec, reqKey)) {
        const names = projList.map(projectTitle).join('、');
        return bad('coupon_project_mismatch', origin, { message: '券码当前无权限', hint: '该券码仅可用于：' + names, allowed: projList });
      }
    }
    // 商品下架联动：券码兑换同样拦截
    if (reqKey) {
      const gate = await productGate(env, reqKey);
      if (gate.offline) return bad('product_offline', origin, { message: PRODUCT_OFFLINE_MESSAGE });
    }
    const projectMismatch = false;

    const mine = Array.isArray(user.coupons) ? user.coupons : [];
    const dup = mine.some(function (c) { return normCode(c && c.code) === code; });
    if (dup) return ok({ already: true, coupons: mine }, origin);

    if (mine.length >= MAX_COUPONS_PER_USER) return bad('list_full', origin, { hint: '券码数量已达上限' }, 400);

    const now = new Date().toISOString();
    // 先占位标记，避免同一券码被重复兑换
    const log = Array.isArray(rec.usedLog) ? rec.usedLog.slice(-9) : [];
    log.push({ at: now, by: String(user.uid || ''), byName: String(user.username || user.displayName || ''), project: reqKey || '' });
    const nextCount = usedCount + 1;
    const claimed = {
      code: code,
      couponCode: displayOf(rec),
      status: nextCount >= useLimit ? 'used' : 'active',
      useLimit: useLimit,
      usedCount: nextCount,
      usedLog: log,
      type: String(rec.type || '通用券'),
      value: String(rec.value || ''),
      note: String(rec.note || ''),
      projectKeys: projList,
      batch: String(rec.batch || ''),
      prefix: String(rec.prefix || ''),
      createdAt: String(rec.createdAt || ''),
      createdBy: String(rec.createdBy || ''),
      exp: String(rec.exp || ''),
      usedBy: String(user.uid || ''),
      usedByName: String(user.username || user.displayName || ''),
      usedAt: now,
      redeemedAtProject: reqKey || '',
      projectMismatch: projectMismatch
    };
    await kv.put(key, JSON.stringify(claimed));

    mine.unshift(briefOf(claimed));
    user.coupons = mine.slice(0, MAX_COUPONS_PER_USER);
    await kv.put('acct:u:' + user.uid, JSON.stringify(user));

    // 同步后台索引状态
    try {
      const idx = await readJson(kv, 'coupon:index:v1', []);
      if (Array.isArray(idx)) {
        let hit = false;
        for (let i = 0; i < idx.length; i++) {
          if (normCode(idx[i] && idx[i].code) === code) {
            idx[i].status = nextCount >= useLimit ? 'used' : 'active';
            idx[i].useLimit = useLimit;
            idx[i].usedCount = nextCount;
            idx[i].usedBy = claimed.usedBy;
            idx[i].usedByName = claimed.usedByName;
            idx[i].usedAt = now;
            hit = true;
            break;
          }
        }
        if (hit) await kv.put('coupon:index:v1', JSON.stringify(idx));
      }
    } catch (e) {}

    return ok({
      coupon: briefOf(claimed), coupons: user.coupons,
      useLimit: useLimit, usedCount: nextCount, remaining: Math.max(0, useLimit - nextCount),
      expired: nextCount >= useLimit
    }, origin);
  }

  return bad('unknown_action', origin, null, 400);
}
