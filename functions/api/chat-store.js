/**
 * 聊天记录云端保存接口（登录用户专用）
 *
 * 存储：KV（SMS_KV / NEWS_KV 兼容）
 *   chat:<uid>:<convId>   单条会话正文（JSON）
 *   chat:idx:<uid>        会话索引（最多 200 条）
 *
 * 鉴权：请求头 Authorization: Bearer <账号 token> 或 X-Acct-Token
 *   token 格式 v1.<payload>.<sig>，与 /api/account 登录下发的 token 一致
 *
 * 动作（POST body.action）：
 *   save  {convId?, title, messages}      新建/覆盖保存，返回 convId
 *   list  {limit?}                         列出会话索引（不含正文）
 *   get   {convId}                         读取单条会话正文
 *   del   {convId}                         删除单条会话
 *   clear                                  清空该用户全部云端会话
 */

const KV_NAMES = ['SMS_KV', 'NEWS_KV', 'AI_RATE_KV'];
const MAX_SESSIONS = 200;
const MAX_MESSAGES = 200;
const MAX_BYTES = 900 * 1024;

export async function onRequest(context) {
  try {
    return await handle(context);
  } catch (e) {
    return json({ ok: false, error: 'internal_error', message: String((e && e.message) || e).slice(0, 200) }, 500);
  }
}

function corsHeaders(request) {
  const origin = request.headers.get('origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Acct-Token',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    Vary: 'Origin'
  };
}

function json(obj, status, request) {
  const h = request ? corsHeaders(request) : { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, h)
  });
}

function kvOf(env) {
  if (!env) return null;
  for (const n of KV_NAMES) {
    if (env[n] && typeof env[n].get === 'function') return env[n];
  }
  return null;
}

function b64uToStr(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  let out = '';
  for (let i = 0; i < bin.length; i++) out += '%' + ('00' + bin.charCodeAt(i).toString(16)).slice(-2);
  return decodeURIComponent(out);
}

async function uidOf(env, request) {
  const auth = request.headers.get('authorization') || '';
  const token = (request.headers.get('x-acct-token') || auth.replace(/^Bearer\s+/i, '') || '').trim();
  if (!token) return '';
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return '';
  const secret = (env && (env.TOKEN_SECRET || env.AI_HASH_SALT)) || 'gc-account-fallback-secret-v1';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(parts[1]));
  const bytes = new Uint8Array(sigBuf);
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  const expect = btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (expect !== parts[2]) return '';
  let payload;
  try {
    payload = JSON.parse(b64uToStr(parts[1]));
  } catch (e) {
    return '';
  }
  if (!payload || !payload.u) return '';
  if (payload.e && payload.e < Math.floor(Date.now() / 1000)) return '';
  return String(payload.u);
}

function safeConvId(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(s)) return '';
  return s;
}

function newConvId() {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return 'c' + t + r;
}

async function readIndex(kv, uid) {
  try {
    const raw = await kv.get('chat:idx:' + uid);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

async function writeIndex(kv, uid, arr) {
  const list = arr.slice(0, MAX_SESSIONS);
  await kv.put('chat:idx:' + uid, JSON.stringify(list));
}

function trimMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(-MAX_MESSAGES).map(function (m) {
    if (!m || typeof m !== 'object') return null;
    const role = String(m.role || 'user');
    let content = m.content;
    if (Array.isArray(content)) content = content;
    else content = String(content == null ? '' : content).slice(0, 20000);
    return { role: role, content: content };
  }).filter(Boolean);
}

async function handle(context) {
  const { request, env } = context;
  const hd = corsHeaders(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: hd });
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, request);

  const kv = kvOf(env);
  if (!kv) return json({ ok: false, error: 'not_configured', message: '云端存储未配置（需绑定 KV）' }, 503, request);

  const uid = await uidOf(env, request);
  if (!uid) return json({ ok: false, error: 'login_required', message: '请先登录后再使用云端聊天记录' }, 401, request);

  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    body = {};
  }
  const action = String((body && body.action) || 'list');

  if (action === 'list') {
    const idx = await readIndex(kv, uid);
    return json({ ok: true, total: idx.length, sessions: idx }, 200, request);
  }

  if (action === 'save') {
    const title = String((body && body.title) || '未命名对话').slice(0, 60);
    const messages = trimMessages(body && body.messages);
    if (!messages.length) return json({ ok: false, error: 'empty_messages', message: '没有可保存的消息' }, 400, request);
    const convId = safeConvId(body && body.convId) || newConvId();
    const record = {
      convId: convId,
      title: title,
      messages: messages,
      count: messages.length,
      updatedAt: new Date().toISOString(),
      size: 0
    };
    let payload = JSON.stringify(record);
    if (payload.length > MAX_BYTES) return json({ ok: false, error: 'too_large', message: '对话内容过长，建议新建会话后再保存' }, 413, request);
    await kv.put('chat:' + uid + ':' + convId, payload);

    const idx = await readIndex(kv, uid);
    const rest = idx.filter(function (x) { return x && x.convId !== convId; });
    rest.unshift({ convId: convId, title: title, count: messages.length, updatedAt: record.updatedAt });
    // 超出上限的旧会话连同正文一起清理
    const overflow = rest.slice(MAX_SESSIONS);
    for (const o of overflow) {
      if (o && o.convId) {
        try { await kv.delete('chat:' + uid + ':' + o.convId); } catch (e) { /* 忽略 */ }
      }
    }
    await writeIndex(kv, uid, rest);
    return json({ ok: true, convId: convId, total: Math.min(rest.length, MAX_SESSIONS) }, 200, request);
  }

  if (action === 'get') {
    const convId = safeConvId(body && body.convId);
    if (!convId) return json({ ok: false, error: 'bad_conv_id' }, 400, request);
    const raw = await kv.get('chat:' + uid + ':' + convId);
    if (!raw) return json({ ok: false, error: 'not_found', message: '该会话不存在或已删除' }, 404, request);
    return new Response(raw, {
      status: 200,
      headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, hd)
    });
  }

  if (action === 'del') {
    const convId = safeConvId(body && body.convId);
    if (!convId) return json({ ok: false, error: 'bad_conv_id' }, 400, request);
    try { await kv.delete('chat:' + uid + ':' + convId); } catch (e) { /* 忽略 */ }
    const idx = await readIndex(kv, uid);
    await writeIndex(kv, uid, idx.filter(function (x) { return x && x.convId !== convId; }));
    return json({ ok: true, deleted: convId }, 200, request);
  }

  if (action === 'clear') {
    const idx = await readIndex(kv, uid);
    for (const o of idx) {
      if (o && o.convId) {
        try { await kv.delete('chat:' + uid + ':' + o.convId); } catch (e) { /* 忽略 */ }
      }
    }
    await writeIndex(kv, uid, []);
    return json({ ok: true, cleared: idx.length }, 200, request);
  }

  return json({ ok: false, error: 'unknown_action' }, 400, request);
}
