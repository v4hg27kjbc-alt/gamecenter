/**
 * /api/trial —— 免费试运营解锁 + 深度内容在线阅读/下载 + 水印追踪
 *
 * GET  /api/trial?action=info          试运营信息 + 章节目录 + 试读正文（无需登录）
 * POST /api/trial  {action:'content'}  登录后返回全部章节正文
 * POST /api/trial  {action:'track', kind:'read'|'download'}
 *                                      记录追踪码（写入 D1 trial_track），用于水印防伪溯源
 * GET  /api/trial?action=records       管理端：读取最近追踪记录（需 X-Admin-Token）
 */
import { ok, fail, methodNotAllowed, corsPreflight, resolveCors, checkAdminToken } from './_lib/http.js';
import { TRIAL_DOC } from './_lib/data/trial-report.js';

const TRIAL_STAGE = {
  stage: '免费试运营',
  badge: '试运营 · 免费解锁',
  headline: '民航客机收藏馆 · 免费试运营开放中',
  summary: '当前站点处于免费试运营阶段，全部深度研读资料免费解锁，不收取任何费用，也不要求付费会员。试运营期间的内容、功能与界面仍在持续打磨，欢迎随时反馈。',
  benefits: [
    '深度研读资料全文在线阅读（含 C919 研制历程、技术体系、产业化进程）',
    '带溯源码的离线下载，便于个人留档与线下研读',
    '机型库 29 型客机的详细参数、研发历史与收藏档案',
    'AI 问答、收藏签名墙、收藏备份等站内功能全量开放'
  ],
  notes: [
    '试运营内容仅限个人学习研读，未经授权不得转载、二次分发或商用。',
    '每份下载文件内嵌唯一溯源码，与账号一一对应，可通过后台核验来源。',
    '试运营结束后权益规则如有调整，会提前在站内公告，已解锁内容不受影响。'
  ]
};

function secretOf(env) {
  return (env && (env.TOKEN_SECRET || env.AI_HASH_SALT)) || 'gc-account-fallback-secret-v1';
}
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
  } catch (e) { return null; }
}
function dbOf(env) {
  return env.AI_LOG_DB || env.DB || null;
}
async function ensureTrack(db) {
  await db.prepare(
    'CREATE TABLE IF NOT EXISTS trial_track (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER DEFAULT 0, day TEXT DEFAULT \'\', ' +
      'uid TEXT DEFAULT \'\', kind TEXT DEFAULT \'\', code TEXT DEFAULT \'\', ' +
      'ua_hash TEXT DEFAULT \'\', ref TEXT DEFAULT \'\')'
  ).run();
}
async function shortHash(env, s) {
  const sig = await hmac(secretOf(env), s);
  return b64u(sig).slice(0, 10).toUpperCase();
}
function dayStr(d) {
  const t = d || new Date();
  return t.getUTCFullYear() + '-' + String(t.getUTCMonth() + 1).padStart(2, '0') + '-' + String(t.getUTCDate()).padStart(2, '0');
}
function jsonBody(request) {
  try { return request.json(); } catch (e) { return {}; }
}

export async function onRequestOptions(context) {
  return corsPreflight(context.request, context.env);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const action = url.searchParams.get('action') || 'info';

  if (action === 'records') {
    const gate = checkAdminToken(request, env);
    if (!gate.ok) return fail('unauthorized', '需要管理员令牌', 401, resolveCors(request, env).headers);
    const db = dbOf(env);
    if (!db) return fail('no_db', '未配置 D1 绑定', 500, {});
    try {
      await ensureTrack(db);
      const rs = await db.prepare('SELECT ts, day, uid, kind, code FROM trial_track ORDER BY ts DESC LIMIT 200').all();
      return ok({ ok: true, records: (rs && rs.results) || [] }, { 'Cache-Control': 'no-store' });
    } catch (e) {
      return fail('db_error', String((e && e.message) || e), 500, {});
    }
  }

  const catalog = TRIAL_DOC.chapters.map(function (c) {
    return { id: c.id, title: c.title, free: !!c.free };
  });
  /* 内测阶段：文章正文仅登录用户可见，未登录不返回任何正文内容 */
  const authG = request.headers.get('authorization') || '';
  const tkG = (authG.replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '').trim();
  const meG = tkG ? await verifyToken(env, tkG) : null;
  const previewAll = TRIAL_DOC.chapters.filter(function (c) { return c.free; })
    .map(function (c) { return { id: c.id, title: c.title, body: c.body }; });
  const preview = meG ? previewAll : [];

  return ok({
    ok: true,
    trial: TRIAL_STAGE,
    doc: { title: TRIAL_DOC.title, subtitle: TRIAL_DOC.subtitle, project: TRIAL_DOC.project, meta: TRIAL_DOC.meta },
    chapters: catalog,
    preview: preview,
    needLogin: !meG,
    locked: catalog.filter(function (c) { return !c.free; }).length
  }, { 'Cache-Control': meG ? 'private, no-store' : 'public, max-age=60' });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = resolveCors(request, env);
  const body = (await jsonBody(request)) || {};
  const action = String(body.action || '');
  const auth = request.headers.get('authorization') || '';
  const token = (auth.replace(/^Bearer\s+/i, '') || body.token || '').trim();

  if (action === 'content') {
    const payload = await verifyToken(env, token);
    if (!payload) return fail('login_required', '请先登录后解锁全文', 401, cors.headers);
    try {
      const kvB = env.SMS_KV || env.GC_USERS || env.ACCOUNT_KV || null;
      if (kvB) {
        const rawB = await kvB.get('acct:u:' + payload.u);
        if (rawB) {
          const uB = JSON.parse(rawB);
          if (String(uB.status || '') === 'banned') {
            return fail('account_banned', '已拉入黑名单，服务暂停，如有异议请联系站长', 403, cors.headers);
          }
        }
      }
    } catch (e) {}
    return ok({
      ok: true,
      uid: payload.u,
      chapters: TRIAL_DOC.chapters.map(function (c) { return { id: c.id, title: c.title, body: c.body }; })
    }, Object.assign({ 'Cache-Control': 'no-store' }, cors.headers));
  }

  if (action === 'track') {
    const payload = await verifyToken(env, token);
    const uid = payload ? payload.u : 'guest';
    const kind = String(body.kind || 'read').slice(0, 16);
    const now = new Date();
    const raw = uid + '|' + kind + '|' + now.toISOString() + '|' + Math.random().toString(36).slice(2, 8);
    const code = 'TR-' + now.getTime().toString(36).toUpperCase() + '-' + (await shortHash(env, raw));
    const db = dbOf(env);
    if (db) {
      try {
        await ensureTrack(db);
        await db.prepare(
          'INSERT INTO trial_track (ts, day, uid, kind, code, ua_hash, ref) VALUES (?,?,?,?,?,?,?)'
        ).bind(
          Math.floor(now.getTime() / 1000), dayStr(now), uid, kind, code,
          (await shortHash(env, String(request.headers.get('user-agent') || ''))),
          String(body.ref || '').slice(0, 120)
        ).run();
      } catch (e) { /* 追踪失败不阻塞阅读 */ }
    }
    return ok({ ok: true, code: code, uid: uid, issuedAt: now.toISOString() }, Object.assign({ 'Cache-Control': 'no-store' }, cors.headers));
  }

  return fail('bad_action', '不支持的操作', 400, cors.headers);
}

export async function onRequest(context) {
  const method = (context.request && context.request.method) || 'GET';
  if (method === 'GET') return onRequestGet(context);
  if (method === 'POST') return onRequestPost(context);
  if (method === 'OPTIONS') return onRequestOptions(context);
  return methodNotAllowed('GET, POST, OPTIONS', {});
}
