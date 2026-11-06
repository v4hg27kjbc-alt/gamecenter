/**
 * 用户账户接口（注册 / 登录 / 资料 / 头像 / 收藏 / 临时账户迁移）
 *
 * POST /api/account   { action: 'register' | 'login' | 'profile' | 'update' | 'favorite' | 'migrate' | 'logout' }
 *
 * 存储：SMS_KV（已绑定） 前缀 acct:
 *   acct:u:<uid>        用户记录 JSON
 *   acct:n:<名小写>      用户名索引 -> uid
 *   acct:seq            UID 序号计数
 *
 * 令牌：无状态 HMAC-SHA256，格式 v1.<b64url(payload)>.<b64url(sig)>
 *   密钥来源 TOKEN_SECRET → AI_HASH_SALT → 内置兜底（与 token.js 同源策略）
 *
 * UID 规则：GC + 注册日期 YYMMDD + 3 位序号，如 GC261106-007
 */

const KV_NAME = 'SMS_KV';
const SEQ_KEY = 'acct:seq';
const MAX_FAV = 300;
const MAX_AVATAR = 60000;
const PASS_MIN = 6;

const ERR = {
  kv: 'KV_UNAVAILABLE',
  bad: 'bad_request',
  exists: 'username_taken',
  noUser: 'user_not_found',
  badPass: 'bad_password',
  denied: 'unauthorized',
};

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': origin || '*',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-methods': 'POST, OPTIONS',
      'cache-control': 'no-store',
    },
  });
}

function ok(data, origin) { return json(Object.assign({ ok: true }, data), 200, origin); }
function bad(code, origin, extra, status) { return json(Object.assign({ ok: false, error: code }, extra || {}), status || 400, origin); }

function b64u(buf) {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
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

async function issueToken(env, uid, days) {
  const exp = Math.floor(Date.now() / 1000) + (days || 30) * 86400;
  const payload = { u: uid, e: exp, i: Math.floor(Date.now() / 1000), n: Math.random().toString(36).slice(2, 10) };
  const p = b64u(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = b64u(await hmac(secretOf(env), p));
  return 'v1.' + p + '.' + sig;
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
  } catch (e) { return null; }
}

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 120000, hash: 'SHA-256' }, key, 256);
  return b64u(bits);
}

function normName(name) {
  return String(name || '').trim().toLowerCase();
}
function validName(name) {
  return /^[\u4e00-\u9fa5A-Za-z0-9_\-]{2,16}$/.test(String(name || '').trim());
}

function todayStamp(d) {
  const t = d || new Date();
  const yy = String(t.getUTCFullYear()).slice(2);
  const mm = String(t.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(t.getUTCDate()).padStart(2, '0');
  return yy + mm + dd;
}

async function nextUid(kv) {
  let seq = 0;
  try { seq = parseInt((await kv.get(SEQ_KEY)) || '0', 10) || 0; } catch (e) { seq = 0; }
  const stamp = todayStamp();
  for (let i = 0; i < 30; i++) {
    seq += 1;
    const uid = 'GC' + stamp + '-' + String(seq % 1000).padStart(3, '0');
    const exists = await kv.get('acct:u:' + uid);
    if (!exists) {
      await kv.put(SEQ_KEY, String(seq));
      return uid;
    }
  }
  return 'GC' + stamp + '-' + Math.random().toString(36).slice(2, 5).toUpperCase();
}

function publicProfile(u) {
  return {
    uid: u.uid,
    username: u.username,
    displayName: u.displayName || u.username,
    avatar: u.avatar || '',
    createdAt: u.createdAt,
    favorites: u.favorites || [],
    saved: u.saved || [],
    tier: u.tier || 'visitor',
    migrated: !!u.migrated,
  };
}

async function readBody(request) {
  try { return await request.json(); } catch (e) { return null; }
}

async function userOfToken(env, kv, request, body) {
  const auth = request.headers.get('authorization') || '';
  const token = (auth.replace(/^Bearer\s+/i, '') || (body && body.token) || '').trim();
  const payload = await verifyToken(env, token);
  if (!payload) return null;
  const raw = await kv.get('acct:u:' + payload.u);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

export async function onRequest(context) {
  const { request, env } = context;
  const origin = request.headers.get('origin') || '*';

  if (request.method === 'OPTIONS') return json({ ok: true }, 200, origin);
  if (request.method !== 'POST') return bad('method_not_allowed', origin, null, 405);

  const kv = env && env[KV_NAME];
  if (!kv) return bad(ERR.kv, origin, null, 503);

  const body = await readBody(request);
  if (!body || !body.action) return bad(ERR.bad, origin);

  const action = String(body.action);

  // ---- 注册 ----
  if (action === 'register') {
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!validName(username)) return bad('username_invalid', origin, { hint: '用户名 2-16 位，中文/字母/数字/下划线/短横线' });
    if (password.length < PASS_MIN) return bad('password_too_short', origin, { hint: '密码至少 6 位' });

    const lower = normName(username);
    const dup = await kv.get('acct:n:' + lower);
    if (dup) return bad(ERR.exists, origin, null, 409);

    const uid = await nextUid(kv);
    const salt = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    const pass = await hashPassword(password, salt);
    const now = new Date().toISOString();
    const user = {
      uid, username, displayName: username, salt, pass,
      avatar: String(body.avatar || '').slice(0, MAX_AVATAR),
      createdAt: now, favorites: [], saved: [], tier: 'member', migrated: false,
    };
    await kv.put('acct:u:' + uid, JSON.stringify(user));
    await kv.put('acct:n:' + lower, uid);
    const token = await issueToken(env, uid);
    return ok({ token, profile: publicProfile(user) }, origin);
  }

  // ---- 登录 ----
  if (action === 'login') {
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username || !password) return bad(ERR.bad, origin, { hint: '请输入用户名和密码' });
    const lower = normName(username);
    let uid = await kv.get('acct:n:' + lower);
    if (!uid && /^GC\d{6}-\d{3}$/i.test(username)) uid = username.toUpperCase();
    if (!uid) return bad(ERR.noUser, origin, null, 404);
    const raw = await kv.get('acct:u:' + uid);
    if (!raw) return bad(ERR.noUser, origin, null, 404);
    const user = JSON.parse(raw);
    const pass = await hashPassword(password, user.salt);
    if (pass !== user.pass) return bad(ERR.badPass, origin, null, 401);
    user.lastLoginAt = new Date().toISOString();
    await kv.put('acct:u:' + user.uid, JSON.stringify(user));
    const token = await issueToken(env, user.uid);
    return ok({ token, profile: publicProfile(user) }, origin);
  }

  // ---- 资料 ----
  if (action === 'profile') {
    const user = await userOfToken(env, kv, request, body);
    if (!user) return bad(ERR.denied, origin, null, 401);
    return ok({ profile: publicProfile(user) }, origin);
  }

  // ---- 更新资料（显示名 / 头像 / 用户名）----
  if (action === 'update') {
    const user = await userOfToken(env, kv, request, body);
    if (!user) return bad(ERR.denied, origin, null, 401);
    if (body.displayName !== undefined) {
      const dn = String(body.displayName).trim();
      if (!dn || dn.length > 16) return bad('display_name_invalid', origin, { hint: '昵称 1-16 个字符' });
      user.displayName = dn;
    }
    if (body.username !== undefined) {
      const nu = String(body.username).trim();
      if (!validName(nu)) return bad('username_invalid', origin);
      const lower = normName(nu);
      const holder = await kv.get('acct:n:' + lower);
      if (holder && holder !== user.uid) return bad(ERR.exists, origin, null, 409);
      if (lower !== normName(user.username)) {
        await kv.delete('acct:n:' + normName(user.username)).catch(() => {});
        await kv.put('acct:n:' + lower, user.uid);
      }
      user.username = nu;
      if (!body.displayName && !user.displayName) user.displayName = nu;
    }
    if (body.avatar !== undefined) {
      const av = String(body.avatar || '');
      if (av.length > MAX_AVATAR) return bad('avatar_too_large', origin, { hint: '头像过大，请换一张小图' });
      user.avatar = av;
    }
    await kv.put('acct:u:' + user.uid, JSON.stringify(user));
    return ok({ profile: publicProfile(user) }, origin);
  }

  // ---- 收藏 / 保存 ----
  if (action === 'favorite') {
    const user = await userOfToken(env, kv, request, body);
    if (!user) return bad(ERR.denied, origin, null, 401);
    const kind = body.kind === 'save' ? 'saved' : 'favorites';
    const list = Array.isArray(user[kind]) ? user[kind] : [];
    const id = String(body.aircraftId || '').slice(0, 60);
    if (!id) return bad(ERR.bad, origin);
    const idx = list.indexOf(id);
    if (body.op === 'remove') { if (idx >= 0) list.splice(idx, 1); }
    else if (idx < 0) { if (list.length >= MAX_FAV) return bad('list_full', origin, null, 400); list.push(id); }
    user[kind] = list;
    await kv.put('acct:u:' + user.uid, JSON.stringify(user));
    return ok({ profile: publicProfile(user) }, origin);
  }

  // ---- 临时账户一键迁移 ----
  if (action === 'migrate') {
    const user = await userOfToken(env, kv, request, body);
    if (!user) return bad(ERR.denied, origin, null, 401);
    const fromFav = Array.isArray(body.favorites) ? body.favorites.map(String) : [];
    const fromSaved = Array.isArray(body.saved) ? body.saved.map(String) : [];
    const merge = (base, add) => {
      const out = Array.isArray(base) ? base.slice() : [];
      add.forEach(function (x) { if (x && out.indexOf(x) < 0 && out.length < MAX_FAV) out.push(x); });
      return out;
    };
    const beforeFav = (user.favorites || []).length;
    const beforeSaved = (user.saved || []).length;
    user.favorites = merge(user.favorites, fromFav);
    user.saved = merge(user.saved, fromSaved);
    user.migrated = true;
    user.migratedAt = new Date().toISOString();
    await kv.put('acct:u:' + user.uid, JSON.stringify(user));
    return ok({
      profile: publicProfile(user),
      migrated: { favorites: user.favorites.length - beforeFav, saved: user.saved.length - beforeSaved },
    }, origin);
  }

  if (action === 'logout') return ok({ loggedOut: true }, origin);

  return bad('unknown_action', origin, null, 400);
}
