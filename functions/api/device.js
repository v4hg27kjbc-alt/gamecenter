/**
 * /api/device —— 多端互联 · 扫码登录（v3.3）
 *
 * 场景：手机扫描电脑上的二维码 → 电脑端直接登录（免输密码）。
 *
 * 流程：
 *   1. 未登录设备（电脑）POST {action:'create'} → 返回 8 位 code（5 分钟有效）
 *   2. 已登录设备（手机）扫码后 POST {action:'approve', code, token} → 绑定 uid
 *   3. 电脑轮询 GET ?action=poll&code=xxx → 拿到一次性登录令牌（领取后即失效）
 *
 * 存储：SMS_KV（与账号系统同库） key = device:<CODE>
 * 安全：approve 必须携带有效账号令牌；令牌一次性领取；默认 5 分钟过期。
 */

const KV_NAMES = ['SMS_KV', 'NEWS_KV', 'AI_RATE_KV'];
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // 去易混字符
const TTL_SEC = 300;

function kvOf(env) {
  for (let i = 0; i < KV_NAMES.length; i++) {
    const kv = env && env[KV_NAMES[i]];
    if (kv && typeof kv.get === 'function') return kv;
  }
  return null;
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Account-Token'
  };
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }, cors())
  });
}

function randCode(len) {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[buf[i] % ALPHABET.length];
  return out;
}

function normCode(v) {
  return String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
}

// ---- 令牌（与 /api/account 同源 HMAC 方案）----
function secretOf(env) {
  return (env && (env.TOKEN_SECRET || env.AI_HASH_SALT)) || 'gc-account-fallback-secret-v1';
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
}

function b64u(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uDecode(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  return atob(s + pad);
}

async function verifyToken(env, token) {
  if (!token) return null;
  const parts = String(token).split('.');
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

async function issueToken(env, uid, days) {
  const exp = Math.floor(Date.now() / 1000) + (days || 30) * 86400;
  const payload = { u: uid, e: exp, i: Math.floor(Date.now() / 1000), n: Math.random().toString(36).slice(2, 10) };
  const p = b64u(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = b64u(await hmac(secretOf(env), p));
  return 'v1.' + p + '.' + sig;
}

function tokenFromRequest(request) {
  const h = request.headers.get('Authorization') || '';
  if (/^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  const alt = request.headers.get('X-Account-Token') || '';
  return alt.trim();
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: cors() });
}

export async function onRequestPost({ request, env }) {
  const kv = kvOf(env);
  if (!kv) return json({ ok: false, code: 'kv_unavailable', message: '服务端未绑定存储' }, 503);
  let body = {};
  try { body = await request.json(); } catch (e) { }
  const action = String(body.action || '');

  // ---- 创建扫码（电脑端发起）----
  if (action === 'create') {
    for (let i = 0; i < 6; i++) {
      const code = randCode(8);
      const key = 'device:' + code;
      const exist = await kv.get(key);
      if (exist) continue;
      const rec = {
        code: code,
        status: 'pending',
        createdAt: new Date().toISOString(),
        device: String(body.device || '').slice(0, 60)
      };
      await kv.put(key, JSON.stringify(rec), { expirationTtl: TTL_SEC });
      return json({ ok: true, code: code, expireIn: TTL_SEC });
    }
    return json({ ok: false, code: 'gen_failed', message: '生成失败，请重试' }, 500);
  }

  // ---- 手机端确认（需已登录）----
  if (action === 'approve') {
    const code = normCode(body.code);
    if (!code) return json({ ok: false, code: 'bad_code' }, 400);
    const payload = await verifyToken(env, tokenFromRequest(request) || String(body.token || ''));
    if (!payload) return json({ ok: false, code: 'login_required', message: '请先在该设备登录' }, 401);
    const key = 'device:' + code;
    const raw = await kv.get(key);
    if (!raw) return json({ ok: false, code: 'expired', message: '二维码已过期，请刷新' }, 410);
    let rec = null;
    try { rec = JSON.parse(raw); } catch (e) { rec = null; }
    if (!rec) return json({ ok: false, code: 'expired' }, 410);
    if (rec.status === 'claimed') return json({ ok: false, code: 'used', message: '该二维码已被使用' }, 409);
    rec.status = 'approved';
    rec.uid = payload.u;
    rec.approvedAt = new Date().toISOString();
    await kv.put(key, JSON.stringify(rec), { expirationTtl: TTL_SEC });
    return json({ ok: true, code: code, status: 'approved', uid: payload.u });
  }

  return json({ ok: false, code: 'bad_action' }, 400);
}

export async function onRequestGet({ request, env }) {
  const kv = kvOf(env);
  if (!kv) return json({ ok: false, code: 'kv_unavailable' }, 503);
  const url = new URL(request.url);
  const action = url.searchParams.get('action') || 'poll';
  const code = normCode(url.searchParams.get('code'));

  if (action !== 'poll') return json({ ok: false, code: 'bad_action' }, 400);
  if (!code) return json({ ok: false, code: 'bad_code' }, 400);

  const key = 'device:' + code;
  const raw = await kv.get(key);
  if (!raw) return json({ ok: true, status: 'expired' });
  let rec = null;
  try { rec = JSON.parse(raw); } catch (e) { rec = null; }
  if (!rec) return json({ ok: true, status: 'expired' });

  if (rec.status !== 'approved' || !rec.uid) {
    return json({ ok: true, status: rec.status === 'claimed' ? 'claimed' : 'pending' });
  }

  // 一次性领取登录令牌
  const uid = rec.uid;
  const token = await issueToken(env, uid, 30);
  rec.status = 'claimed';
  rec.claimedAt = new Date().toISOString();
  delete rec.uid;
  await kv.put(key, JSON.stringify(rec), { expirationTtl: 120 });
  return json({ ok: true, status: 'approved', token: token, uid: uid });
}
