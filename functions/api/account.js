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
const DEFAULT_PASS = '12345678';

/* ===== 与后台登记表互通（NEWS_KV · admin:users:v1）===== */
const ADMIN_KV_NAME = 'NEWS_KV';
const ADMIN_USERS_KEY = 'admin:users:v1';
const VERIFIED_KEY = 'sms:verified:';
const VERIFIED_TTL = 15552000;

function newsKv(env) {
  const kv = env && env[ADMIN_KV_NAME];
  return (kv && typeof kv.get === 'function' && typeof kv.put === 'function') ? kv : null;
}

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text || '')));
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

async function loadAdminUsers(env) {
  const nkv = newsKv(env);
  if (!nkv) return [];
  try {
    const raw = await nkv.get(ADMIN_USERS_KEY, 'json');
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.users)) return raw.users;
    return [];
  } catch (e) { return []; }
}

async function adminUserByAccount(env, account) {
  const list = await loadAdminUsers(env);
  if (!list.length) return null;
  const lower = normName(account);
  const phone = normPhone(account);
  return list.find(function (x) { return normName(x.username) === lower; }) ||
         (phone ? list.find(function (x) { return normPhone(x.phone) === phone; }) : null) || null;
}

async function adminUserByPhone(env, phone) {
  const p = normPhone(phone);
  if (!p) return null;
  const list = await loadAdminUsers(env);
  return list.find(function (x) { return normPhone(x.phone) === p; }) || null;
}

async function adminUserOf(env, user) {
  const list = await loadAdminUsers(env);
  if (!list.length) return null;
  if (user && user.adminUserId) {
    const hit = list.find(function (x) { return x.id === user.adminUserId; });
    if (hit) return hit;
  }
  const lower = normName(user && user.username);
  const hitName = list.find(function (x) { return normName(x.username) === lower; });
  if (hitName) return hitName;
  const phone = normPhone(user && user.phone);
  return phone ? (list.find(function (x) { return normPhone(x.phone) === phone; }) || null) : null;
}

async function verifiedMarkOf(kv, phone) {
  const p = normPhone(phone);
  if (!p) return '';
  try { return (await kv.get(VERIFIED_KEY + p)) || ''; } catch (e) { return ''; }
}

/** 把前端绑定结果回写后台登记表（best-effort，失败不影响登录） */
async function syncAdminLink(env, user) {
  try {
    const nkv = newsKv(env);
    if (!nkv || !user) return;
    const rawList = await nkv.get(ADMIN_USERS_KEY, 'json');
    const list = Array.isArray(rawList) ? rawList : (rawList && Array.isArray(rawList.users) ? rawList.users : null);
    if (!list || !list.length) return;
    const lower = normName(user.username);
    const phone = normPhone(user.phone);
    let idx = -1;
    if (user.adminUserId) idx = list.findIndex(function (x) { return x.id === user.adminUserId; });
    if (idx < 0) idx = list.findIndex(function (x) { return normName(x.username) === lower; });
    if (idx < 0 && phone) idx = list.findIndex(function (x) { return normPhone(x.phone) === phone; });
    if (idx < 0) return;
    const au = list[idx] || {};
    let dirty = false;
    if (au.siteUid !== user.uid) { au.siteUid = user.uid; dirty = true; }
    if (!au.siteBoundAt) { au.siteBoundAt = new Date().toISOString(); dirty = true; }
    if (user.phoneVerified && !au.phoneVerified) {
      au.phoneVerified = true;
      au.phoneVerifiedAt = user.phoneBoundAt || new Date().toISOString();
      dirty = true;
    }
    if (!normPhone(au.phone) && phone) { au.phone = phone; dirty = true; }
    if (dirty) {
      list[idx] = au;
      await nkv.put(ADMIN_USERS_KEY, JSON.stringify({ users: list }));
    }
  } catch (e) {}
}

/** 后台创建的用户首次在前端登录时，自动生成主站账号 */
async function provisionFromAdmin(env, kv, au, password) {
  const now = new Date().toISOString();
  const uid = await nextUid(kv);
  const salt = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  const pass = await hashPassword(String(password || DEFAULT_PASS), salt);
  let phone = normPhone(au.phone);
  let phoneVerified = false;
  let phoneConflict = false;
  if (phone) {
    const holder = await kv.get('acct:p:' + phone);
    if (holder) { phoneConflict = true; phone = ''; }
    else {
      phoneVerified = !!(au.phoneVerified) || !!(await verifiedMarkOf(kv, phone));
      try { await kv.put('acct:p:' + phone, uid); } catch (e) {}
    }
  }
  const user = {
    uid: uid,
    username: au.username,
    displayName: au.username,
    salt: salt,
    pass: pass,
    phone: phone,
    avatar: '',
    createdAt: now,
    favorites: [],
    saved: [],
    tier: 'member',
    migrated: false,
    status: 'active',
    loginCount: 0,
    logins: [],
    source: 'admin',
    adminUserId: au.id || '',
    adminLinkedAt: now,
    phoneVerified: phoneVerified,
    phoneSource: phone ? 'admin' : '',
    phoneAddedAt: phone ? now : '',
    phoneConflict: phoneConflict,
  };
  await kv.put('acct:u:' + uid, JSON.stringify(user));
  const lower = normName(au.username);
  const exist = await kv.get('acct:n:' + lower);
  if (!exist) { try { await kv.put('acct:n:' + lower, uid); } catch (e) {} }
  await syncAdminLink(env, user);
  return user;
}

function normPhone(v) {
  const s = String(v || '').replace(/[\s-]/g, '');
  return /^1[3-9]\d{9}$/.test(s) ? s : '';
}

/** 校验并消耗短信验证码（与 /api/sms-verify 共用 sms:code:<phone> 存储） */
async function consumeSmsCode(kv, phone, code) {
  const c = String(code || '').trim();
  if (!/^\d{4,8}$/.test(c)) return { ok: false, error: 'code_invalid', hint: '请输入短信验证码' };
  let raw = null;
  try { raw = await kv.get('sms:code:' + phone); } catch (e) { raw = null; }
  if (!raw) return { ok: false, error: 'code_expired', hint: '验证码已过期，请重新获取' };
  let rec = null;
  try { rec = JSON.parse(raw); } catch (e) { rec = null; }
  const stored = rec && rec.code ? String(rec.code) : String(raw);
  if (stored !== c) return { ok: false, error: 'code_wrong', hint: '验证码不正确' };
  try { await kv.delete('sms:code:' + phone); } catch (e) {}
  try { await kv.put(VERIFIED_KEY + phone, new Date().toISOString(), { expirationTtl: VERIFIED_TTL }); } catch (e) {}
  return { ok: true };
}

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

/**
 * 密码哈希（轻量加盐 SHA-256）
 * 历史实现用 PBKDF2(120000 迭代)，在 Cloudflare Pages Functions 免费额度下会超出 CPU 时间限制，
 * 直接抛异常导致接口返回 500「服务内部异常」（注册 / 登录 / 改密全部不可用）。
 * 改为两次加盐 SHA-256：CPU 消耗可忽略，输出带 s1$ 版本前缀便于后续升级。
 */
async function hashPassword(password, salt) {
  const first = await sha256hex('s1:' + String(password || '') + '::' + String(salt || ''));
  const second = await sha256hex(first + '::' + String(salt || '') + ':gc-acct');
  return 's1$' + second;
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
    phone: u.phone ? (String(u.phone).slice(0, 3) + '****' + String(u.phone).slice(-4)) : '',
    lastLoginAt: u.lastLoginAt || '',
    loginCount: Number(u.loginCount || 0) || 0,
    status: u.status || 'active',
    phoneVerified: !!u.phoneVerified,
    phoneSource: u.phoneSource || '',
    source: u.source || 'site',
    adminLinked: !!u.adminUserId,
    phoneConflict: !!u.phoneConflict,
    phoneChangeCount: Number(u.phoneChangeCount || 0) || 0,
    phoneChangeMax: 2,
    phoneChangeRemaining: Math.max(0, 2 - (Number(u.phoneChangeCount || 0) || 0)),
  };
}

/** 计算“是否需要提示绑定手机号”：已绑定/已验证 → 不再提示 */
async function bindState(kv, user) {
  const phone = normPhone(user && user.phone);
  let verified = !!(user && user.phoneVerified);
  if (phone && !verified) verified = !!(await verifiedMarkOf(kv, phone));
  if (phone && verified) return { needBindPhone: false, phoneVerified: true, bindReason: '' };
  if (phone) return { needBindPhone: true, phoneVerified: false, bindReason: 'phone_unverified' };
  return { needBindPhone: true, phoneVerified: false, bindReason: 'no_phone' };
}

async function profileView(kv, user) {
  const p = publicProfile(user);
  const b = await bindState(kv, user);
  /* 券码：兑换后写回 acct:u:<uid>.coupons，登录 / 换设备即可同步看到 */
  p.coupons = Array.isArray(user.coupons) ? user.coupons.slice(0, 200) : [];
  return Object.assign(p, b);
}

/** 读取全部投票计数：{ articleId: { option: n } } */
function blockInfoOf(src) {
  const o = src || {};
  const reason = String(o.bannedReason || o.banReason || o.blockReason || o.reason || '').slice(0, 120);
  return {
    reason: reason || '违反站内使用规则',
    at: String(o.bannedAt || o.blockAt || '').slice(0, 40),
    until: String(o.bannedUntil || '').slice(0, 40),
    appealAllowed: true,
  };
}

async function readVoteCounts(kv) {
  let counts = {};
  try {
    const raw = await kv.get('vote:counts:v1');
    counts = raw ? JSON.parse(raw) : {};
  } catch (e) { counts = {}; }
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) counts = {};
  return counts;
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
  try {
    const u = JSON.parse(raw);
    if (u && String(u.status || '') === 'banned') return null;
    return u;
  } catch (e) { return null; }
}

export async function onRequest(context) {
  try {
    return await handleRequest(context);
  } catch (e) {
    // 未捕获异常给出可读原因，避免前端只看到笼统的“服务内部异常”无法排查
    const msg = (e && (e.message || e.name)) ? String(e.message || e.name).slice(0, 200) : '未知错误';
    return bad('internal_error', (context.request.headers.get('origin') || '*'), { hint: '账号服务异常：' + msg }, 500);
  }
}

async function handleRequest(context) {
  const { request, env } = context;
  const origin = request.headers.get('origin') || '*';

  if (request.method === 'OPTIONS') return json({ ok: true }, 200, origin);
  if (request.method !== 'POST') return bad('method_not_allowed', origin, null, 405);

  const kv = env && env[KV_NAME];
  if (!kv) return bad(ERR.kv, origin, null, 503);

  const body = await readBody(request);
  if (!body || !body.action) return bad(ERR.bad, origin);

  const action = String(body.action);

  // ---- 注册（手机号 + 短信验证码）----
  if (action === 'register') {
    const username = String(body.username || '').trim();
    const password = String(body.password || '') || DEFAULT_PASS;
    const phone = normPhone(body.phone);
    const code = String(body.code || '').trim();

    if (!phone) return bad('phone_invalid', origin, { hint: '请输入正确的 11 位手机号' });
    const check = await consumeSmsCode(kv, phone, code);
    if (!check.ok) return bad(check.error, origin, { hint: check.hint });
    if (!validName(username)) return bad('username_invalid', origin, { hint: '用户名 2-16 位，中文/字母/数字/下划线/短横线' });
    if (password.length < PASS_MIN) return bad('password_too_short', origin, { hint: '密码至少 6 位' });

    const lower = normName(username);
    const dup = await kv.get('acct:n:' + lower);
    if (dup) return bad(ERR.exists, origin, null, 409);
    const phoneHolder = await kv.get('acct:p:' + phone);
    if (phoneHolder) return bad('phone_taken', origin, { hint: '该手机号已注册，请直接登录' }, 409);

    const uid = await nextUid(kv);
    const salt = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    const pass = await hashPassword(password, salt);
    const now = new Date().toISOString();
    const user = {
      uid, username, displayName: username, salt, pass, phone,
      avatar: String(body.avatar || '').slice(0, MAX_AVATAR),
      createdAt: now, favorites: [], saved: [], tier: 'member', migrated: false,
      status: 'active', loginCount: 0, logins: [],
      phoneVerified: true, phoneSource: 'sms', phoneAddedAt: now, phoneBoundAt: now,
    };
    await kv.put('acct:u:' + uid, JSON.stringify(user));
    await kv.put('acct:n:' + lower, uid);
    await kv.put('acct:p:' + phone, uid);
    const token = await issueToken(env, uid);
    const pvReg = await profileView(kv, user);
    return ok({ token, profile: pvReg, needBindPhone: pvReg.needBindPhone, bindReason: pvReg.bindReason }, origin);
  }

  // ---- 登录（mode: 'password' 密码登录 | 'code' 验证码登录）----
  if (action === 'login') {
    const mode = String(body.mode || 'password');
    let uid = '';
    let user = null;

    if (mode === 'code') {
      const phone = normPhone(body.phone);
      const code = String(body.code || '').trim();
      if (!phone) return bad('phone_invalid', origin, { hint: '请输入正确的 11 位手机号' });
      const check = await consumeSmsCode(kv, phone, code);
      if (!check.ok) return bad(check.error, origin, { hint: check.hint });
      uid = (await kv.get('acct:p:' + phone)) || '';
      if (!uid) {
        // 后台登记过该手机号 → 自动开通前端账号
        const auPhone = await adminUserByPhone(env, phone);
        if (!auPhone) return bad('phone_not_registered', origin, { hint: '该手机号还没有注册，请先注册' }, 404);
        if (String(auPhone.status || '') === 'banned') {
          return bad('account_banned', origin, {
            hint: '已拉入黑名单，服务暂停，如有异议请联系站长',
            blocked: blockInfoOf(auPhone),
          }, 403);
        }
        user = await provisionFromAdmin(env, kv, auPhone, '');
        uid = user.uid;
      }
    } else {
      const account = String(body.username || body.phone || '').trim();
      const password = String(body.password || '');
      if (!account || !password) return bad(ERR.bad, origin, { hint: '请输入账号和密码' });
      const lower = normName(account);
      uid = (await kv.get('acct:n:' + lower)) || '';
      if (!uid) {
        const p = normPhone(account);
        if (p) uid = (await kv.get('acct:p:' + p)) || '';
      }
      if (!uid && /^GC\d{6}-\d{3}$/i.test(account)) uid = account.toUpperCase();
      if (!uid) {
        // 前端无此账号 → 回落后台登记表，实现“后台注册的用户可直接登录前端”
        const au = await adminUserByAccount(env, account);
        if (!au) return bad(ERR.noUser, origin, { hint: '账号不存在，请先注册' }, 404);
        if (String(au.status || '') === 'banned') {
          return bad('account_banned', origin, {
            hint: '已拉入黑名单，服务暂停，如有异议请联系站长',
            blocked: blockInfoOf(au),
          }, 403);
        }
        let passOk = false;
        if (au.passwordHash) {
          passOk = (await sha256hex(password)).toLowerCase() === String(au.passwordHash).toLowerCase();
        }
        if (!passOk) {
          const auPhoneHint = normPhone(au.phone);
          if (!au.passwordHash) {
            return bad('admin_no_password', origin, {
              hint: auPhoneHint ? '该账号由后台创建，尚未设置密码，请改用「手机验证码登录」' : '该账号尚未设置密码，请联系管理员设置后再登录',
            }, 401);
          }
          return bad(ERR.badPass, origin, {
            hint: auPhoneHint ? '密码不正确；也可用手机号 + 验证码登录' : '密码不正确',
          }, 401);
        }
        user = await provisionFromAdmin(env, kv, au, password);
        uid = user.uid;
      } else {
        const rawPwd = await kv.get('acct:u:' + uid);
        if (!rawPwd) return bad(ERR.noUser, origin, null, 404);
        const u0 = JSON.parse(rawPwd);
        const pass0 = await hashPassword(password, u0.salt);
        if (pass0 !== u0.pass) return bad(ERR.badPass, origin, null, 401);
      }
    }

    if (!user) {
      const raw = await kv.get('acct:u:' + uid);
      if (!raw) return bad(ERR.noUser, origin, null, 404);
      user = JSON.parse(raw);
    }
    if (String(user.status || '') === 'banned') {
      return bad('account_banned', origin, {
          hint: '已拉入黑名单，服务暂停，如有异议请联系站长',
          blocked: blockInfoOf(user),
        }, 403);
    }

    // 与后台登记表互认：后台封禁即时生效、后台手机号自动补全
    const auLinked = await adminUserOf(env, user);
    if (auLinked) {
      if (String(auLinked.status || '') === 'banned') {
        return bad('account_banned', origin, {
          hint: '已拉入黑名单，服务暂停，如有异议请联系站长',
          blocked: blockInfoOf(auLinked),
        }, 403);
      }
      if (auLinked.id && user.adminUserId !== auLinked.id) user.adminUserId = auLinked.id;
      const auPhone = normPhone(auLinked.phone);
      if (!normPhone(user.phone) && auPhone) {
        const holder = await kv.get('acct:p:' + auPhone);
        if (!holder) {
          user.phone = auPhone;
          user.phoneSource = 'admin';
          user.phoneAddedAt = user.phoneAddedAt || new Date().toISOString();
          try { await kv.put('acct:p:' + auPhone, user.uid); } catch (e) {}
        }
      }
    }

    const nowAt = new Date().toISOString();
    user.lastLoginAt = nowAt;
    user.loginCount = (Number(user.loginCount) || 0) + 1;
    const ip = request.headers.get('cf-connecting-ip') || '';
    const ua = (request.headers.get('user-agent') || '').slice(0, 120);
    const hist = Array.isArray(user.logins) ? user.logins : [];
    hist.unshift({ at: nowAt, ip: ip, ua: ua, mode: mode });
    user.logins = hist.slice(0, 10);
    await kv.put('acct:u:' + user.uid, JSON.stringify(user));
    await syncAdminLink(env, user);
    const pvLogin = await profileView(kv, user);
    const token = await issueToken(env, user.uid);
    return ok({
      token: token,
      profile: pvLogin,
      needBindPhone: pvLogin.needBindPhone,
      bindReason: pvLogin.bindReason,
      adminLinked: !!user.adminUserId,
    }, origin);
  }

  // ---- 绑定手机号（登录后凭短信验证码绑定，绑定成功不再提示）----
  if (action === 'bindphone') {
    const user = await userOfToken(env, kv, request, body);
    if (!user) return bad(ERR.denied, origin, null, 401);
    const phone = normPhone(body.phone);
    const code = String(body.code || '').trim();
    if (!phone) return bad('phone_invalid', origin, { hint: '请输入正确的 11 位手机号' });
    const check = await consumeSmsCode(kv, phone, code);
    if (!check.ok) return bad(check.error, origin, { hint: check.hint });
    const holder = await kv.get('acct:p:' + phone);
    if (holder && holder !== user.uid) {
      return bad('phone_taken', origin, { hint: '该手机号已绑定其他账号，请更换或先在原账号解绑' }, 409);
    }
    const oldPhone = normPhone(user.phone);
    const isChange = !!(oldPhone && oldPhone !== phone);
    /* 每个账号手机号最多更换 2 次（首次绑定不计入），达到上限需联系站长 */
    const PHONE_CHANGE_MAX = 2;
    let changeCount = Number(user.phoneChangeCount || 0);
    if (!isFinite(changeCount) || changeCount < 0) changeCount = 0;
    if (isChange) {
      if (changeCount >= PHONE_CHANGE_MAX) {
        return bad('phone_change_limit', origin, {
          hint: '该账号手机号已更换 ' + PHONE_CHANGE_MAX + ' 次，达到上限，如需再次更换请联系站长',
          changeCount: changeCount,
          changeMax: PHONE_CHANGE_MAX,
          remaining: 0
        }, 403);
      }
      changeCount += 1;
      user.phoneChangeCount = changeCount;
      user.phoneChangedAt = new Date().toISOString();
      try { await kv.delete('acct:p:' + oldPhone); } catch (e) {}
    } else if (user.phoneChangeCount === undefined) {
      user.phoneChangeCount = 0;
    }
    const wasBound = !!user.phoneVerified;
    user.phone = phone;
    user.phoneVerified = true;
    user.phoneSource = 'sms';
    user.phoneAddedAt = user.phoneAddedAt || new Date().toISOString();
    user.phoneBoundAt = new Date().toISOString();
    await kv.put('acct:p:' + phone, user.uid);
    await kv.put('acct:u:' + user.uid, JSON.stringify(user));
    await syncAdminLink(env, user);
    const pvBind = await profileView(kv, user);
    return ok({
      profile: pvBind,
      needBindPhone: false,
      bindReason: '',
      phoneBound: true,
      alreadyBound: wasBound,
      changed: isChange,
      changeCount: changeCount,
      changeMax: PHONE_CHANGE_MAX,
      remaining: Math.max(0, PHONE_CHANGE_MAX - changeCount),
    }, origin);
  }

  // ---- 资料 ----
  if (action === 'profile') {
    /* 先识别黑名单：被封禁账号返回明确错误码，前端统一弹站内通知（不做静默封禁） */
    const authPB = request.headers.get('authorization') || '';
    const tkPB = (authPB.replace(/^Bearer\s+/i, '') || (body && body.token) || '').trim();
    const pPB = tkPB ? await verifyToken(env, tkPB) : null;
    if (pPB) {
      const rawPB = await kv.get('acct:u:' + pPB.u);
      if (rawPB) {
        let uPB = null;
        try { uPB = JSON.parse(rawPB); } catch (e) { uPB = null; }
        if (uPB && String(uPB.status || '') === 'banned') {
          return bad('account_banned', origin, {
            hint: '已拉入黑名单，服务暂停，如有异议请联系站长',
            blocked: blockInfoOf(uPB),
          }, 403);
        }
      }
    }
    const user = await userOfToken(env, kv, request, body);
    if (!user) return bad(ERR.denied, origin, null, 401);
    const pvMe = await profileView(kv, user);
    return ok({ profile: pvMe, needBindPhone: pvMe.needBindPhone, bindReason: pvMe.bindReason }, origin);
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
    if (body.password !== undefined) {
      const np = String(body.password || '');
      if (np.length < 6) return bad('password_too_short', origin, { hint: '密码至少 6 位' });
      if (body.oldPassword !== undefined) {
        const oldHash = await hashPassword(String(body.oldPassword || ''), user.salt);
        if (oldHash !== user.pass) return bad(ERR.badPass, origin, { hint: '原密码不正确' }, 401);
      }
      user.pass = await hashPassword(np, user.salt);
      user.passUpdatedAt = new Date().toISOString();
    }
    if (body.avatar !== undefined) {
      const av = String(body.avatar || '');
      if (av.length > MAX_AVATAR) return bad('avatar_too_large', origin, { hint: '头像过大，请换一张小图' });
      user.avatar = av;
    }
    await kv.put('acct:u:' + user.uid, JSON.stringify(user));
    const pvMe = await profileView(kv, user);
    return ok({ profile: pvMe, needBindPhone: pvMe.needBindPhone, bindReason: pvMe.bindReason }, origin);
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
    const pvMe = await profileView(kv, user);
    return ok({ profile: pvMe, needBindPhone: pvMe.needBindPhone, bindReason: pvMe.bindReason }, origin);
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
    const pvMig = await profileView(kv, user);
    return ok({
      profile: pvMig,
      needBindPhone: pvMig.needBindPhone,
      bindReason: pvMig.bindReason,
      migrated: { favorites: user.favorites.length - beforeFav, saved: user.saved.length - beforeSaved },
    }, origin);
  }

  // ---- 黑名单申诉（被限制用户提交，站长在后台查看处理）----
  if (action === 'appeal') {
    const note = String(body.note || '').slice(0, 300);
    const reason = String(body.reason || '').slice(0, 200);
    const page = String(body.page || '').slice(0, 300);
    const visitorId = String(body.visitorId || '').slice(0, 80);
    const auth0 = request.headers.get('authorization') || '';
    const tk0 = (auth0.replace(/^Bearer\s+/i, '') || (body && body.token) || '').trim();
    let uid0 = '';
    if (tk0) {
      const p0 = await verifyToken(env, tk0);
      if (p0) uid0 = String(p0.u || '');
    }
    const item = {
      id: 'ap_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      uid: uid0,
      visitorId: visitorId,
      ip: request.headers.get('cf-connecting-ip') || '',
      ua: String(request.headers.get('user-agent') || '').slice(0, 200),
      reason: reason,
      note: note,
      page: page,
      at: new Date().toISOString(),
      done: false
    };
    const rawA = await kv.get('appeal:list:v1');
    let listA = [];
    try { listA = rawA ? JSON.parse(rawA) : []; } catch (e) { listA = []; }
    if (!Array.isArray(listA)) listA = [];
    listA.unshift(item);
    if (listA.length > 500) listA = listA.slice(0, 500);
    await kv.put('appeal:list:v1', JSON.stringify(listA));
    return ok({ appeal: item, loggedIn: !!uid0 }, origin);
  }

  // ---- 内测文章：投票（登录用户，一人一票）----
  if (action === 'articleVote') {
    const user = await userOfToken(env, kv, request, body);
    if (!user) return bad(ERR.denied, origin, { hint: '请先登录后参与投票' }, 401);
    const aid = String(body.articleId || '').slice(0, 80);
    const opt = String(body.option || '').slice(0, 20);
    if (!aid || !opt) return bad(ERR.bad, origin);
    user.votes = (user.votes && typeof user.votes === 'object') ? user.votes : {};
    if (user.votes[aid]) {
      return ok({ already: true, myVote: user.votes[aid], counts: (await readVoteCounts(kv))[aid] || {} }, origin);
    }
    user.votes[aid] = opt;
    await kv.put('acct:u:' + user.uid, JSON.stringify(user));
    const counts = await readVoteCounts(kv);
    if (!counts[aid]) counts[aid] = {};
    counts[aid][opt] = (Number(counts[aid][opt] || 0) || 0) + 1;
    await kv.put('vote:counts:v1', JSON.stringify(counts));
    const rawV = await kv.get('vote:list:v1');
    let listV = [];
    try { listV = rawV ? JSON.parse(rawV) : []; } catch (e) { listV = []; }
    if (!Array.isArray(listV)) listV = [];
    listV.unshift({ uid: user.uid, articleId: aid, option: opt, at: new Date().toISOString() });
    if (listV.length > 2000) listV = listV.slice(0, 2000);
    await kv.put('vote:list:v1', JSON.stringify(listV));
    return ok({ myVote: opt, counts: counts[aid] || {} }, origin);
  }

  // ---- 内测文章：读后一次性评价（每篇仅记录一次）----
  if (action === 'articleFeedback') {
    const user = await userOfToken(env, kv, request, body);
    if (!user) return bad(ERR.denied, origin, { hint: '请先登录后提交评价' }, 401);
    const aid = String(body.articleId || '').slice(0, 80);
    if (!aid) return bad(ERR.bad, origin);
    user.feedbackSeen = (user.feedbackSeen && typeof user.feedbackSeen === 'object') ? user.feedbackSeen : {};
    if (user.feedbackSeen[aid]) return ok({ already: true, at: user.feedbackSeen[aid] }, origin);
    const score = Math.max(0, Math.min(5, Number(body.score || 0) || 0));
    const text = String(body.text || '').slice(0, 300);
    const at = new Date().toISOString();
    user.feedbackSeen[aid] = at;
    await kv.put('acct:u:' + user.uid, JSON.stringify(user));
    const rawF = await kv.get('feedback:list:v1');
    let listF = [];
    try { listF = rawF ? JSON.parse(rawF) : []; } catch (e) { listF = []; }
    if (!Array.isArray(listF)) listF = [];
    listF.unshift({ uid: user.uid, username: user.username || '', articleId: aid, score: score, text: text, at: at });
    if (listF.length > 2000) listF = listF.slice(0, 2000);
    await kv.put('feedback:list:v1', JSON.stringify(listF));
    return ok({ recorded: true, at: at }, origin);
  }

  // ---- 内测文章：统计（投票数 + 我是否已投/已评）----
  if (action === 'articleStats') {
    const aid = String((body && body.articleId) || '').slice(0, 80);
    let uidS = '';
    const authS = request.headers.get('authorization') || '';
    const tkS = (authS.replace(/^Bearer\s+/i, '') || (body && body.token) || '').trim();
    if (tkS) {
      const pS = await verifyToken(env, tkS);
      if (pS) uidS = String(pS.u || '');
    }
    let myVote = '';
    let myFeedback = '';
    if (uidS) {
      const rawU = await kv.get('acct:u:' + uidS);
      if (rawU) {
        try {
          const uS = JSON.parse(rawU);
          myVote = (uS.votes && uS.votes[aid]) || '';
          myFeedback = (uS.feedbackSeen && uS.feedbackSeen[aid]) || '';
        } catch (e) {}
      }
    }
    const counts = await readVoteCounts(kv);
    return ok({ articleId: aid, counts: counts[aid] || {}, myVote: myVote, myFeedback: myFeedback, loggedIn: !!uidS }, origin);
  }

  if (action === 'logout') return ok({ loggedOut: true }, origin);

  // ---- 收藏功能下线：管理员批量清空所有用户的收藏 / 保存 ----
  if (action === 'purgefavorites') {
    const h = request.headers.get('X-Admin-Token') || '';
    const ck = request.headers.get('Cookie') || '';
    const want = (env && (env.ADMIN_TOKEN || env.TOKEN_SECRET)) || '';
    const isAdmin = (ck && /mv_admin=/.test(ck)) || !!(want && h && h === want);
    if (!isAdmin) return bad('unauthorized', origin, null, 401);
    const dry = String(body.dry || '') === '1' || body.dry === true;
    let cursor = null;
    let scanned = 0;
    let changed = 0;
    for (let round = 0; round < 10; round++) {
      const page = await kv.list({ prefix: 'acct:u:', limit: 500, cursor: cursor || undefined });
      for (const k of (page.keys || [])) {
        scanned++;
        const raw = await kv.get(k.name);
        if (!raw) continue;
        let u = null;
        try { u = JSON.parse(raw); } catch (e) { continue; }
        const hasFav = (Array.isArray(u.favorites) && u.favorites.length) || (Array.isArray(u.saved) && u.saved.length);
        if (!hasFav) continue;
        if (dry) { changed++; continue; }
        u.favorites = [];
        u.saved = [];
        u.favPurgedAt = new Date().toISOString();
        await kv.put(k.name, JSON.stringify(u));
        changed++;
      }
      if (page.list_complete) break;
      cursor = page.cursor;
    }
    return ok({ dry: dry, scanned: scanned, changed: changed, message: dry ? '统计完成（未修改）' : '收藏数据已清空' }, origin);
  }

  return bad('unknown_action', origin, null, 400);
}
