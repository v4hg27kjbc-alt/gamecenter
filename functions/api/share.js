/**
 * /api/share —— 多端互联 · 图片 / 文本速传（v3.3）
 *
 * 场景：手机与电脑之间互传图片或一段文字，不需要登录、不需要任何 App。
 *       发起端上传后拿到 6 位速传码（或二维码），另一端输入码即可取回。
 *
 * 路由：
 *   POST { action:'upload', name?, kind?, dataUrl|text }  → { code, expireIn }
 *   GET  ?action=get&code=XXXXXX                          → { name, kind, dataUrl|text }
 *
 * 存储：SMS_KV  key = share:<CODE>，TTL 30 分钟
 * 限制：图片 dataUrl 上限 2.5MB（KV 单值 25MB，留足余量）；文本上限 8000 字
 */

const KV_NAMES = ['SMS_KV', 'NEWS_KV', 'AI_RATE_KV'];
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TTL_SEC = 1800;
const MAX_DATA = 2500000;
const MAX_TEXT = 8000;

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
    'Access-Control-Allow-Headers': 'Content-Type'
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

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: cors() });
}

export async function onRequestPost({ request, env }) {
  const kv = kvOf(env);
  if (!kv) return json({ ok: false, code: 'kv_unavailable', message: '服务端未绑定存储' }, 503);
  let body = {};
  try { body = await request.json(); } catch (e) { }
  const action = String(body.action || 'upload');
  if (action !== 'upload') return json({ ok: false, code: 'bad_action' }, 400);

  const dataUrl = String(body.dataUrl || '');
  const text = String(body.text || '');
  const kind = dataUrl ? 'image' : (text ? 'text' : '');
  if (!kind) return json({ ok: false, code: 'empty', message: '没有可传输的内容' }, 400);
  if (dataUrl && dataUrl.length > MAX_DATA) return json({ ok: false, code: 'too_large', message: '图片过大，请压缩后再传（上限约 1.8MB）' }, 413);
  if (text && text.length > MAX_TEXT) return json({ ok: false, code: 'too_large', message: '文字过长（上限 8000 字）' }, 413);
  if (dataUrl && !/^data:image\//.test(dataUrl)) return json({ ok: false, code: 'bad_type', message: '仅支持图片格式' }, 400);

  for (let i = 0; i < 8; i++) {
    const code = randCode(6);
    const key = 'share:' + code;
    const exist = await kv.get(key);
    if (exist) continue;
    const rec = {
      code: code,
      kind: kind,
      name: String(body.name || (kind === 'image' ? 'image.png' : '文本')).slice(0, 80),
      dataUrl: dataUrl || '',
      text: text || '',
      createdAt: new Date().toISOString(),
      views: 0
    };
    await kv.put(key, JSON.stringify(rec), { expirationTtl: TTL_SEC });
    return json({ ok: true, code: code, kind: kind, expireIn: TTL_SEC });
  }
  return json({ ok: false, code: 'gen_failed', message: '生成失败，请重试' }, 500);
}

export async function onRequestGet({ request, env }) {
  const kv = kvOf(env);
  if (!kv) return json({ ok: false, code: 'kv_unavailable' }, 503);
  const url = new URL(request.url);
  const code = normCode(url.searchParams.get('code'));
  const action = url.searchParams.get('action') || 'get';
  if (!code) return json({ ok: false, code: 'bad_code', message: '请输入 6 位速传码' }, 400);

  const key = 'share:' + code;
  const raw = await kv.get(key);
  if (!raw) return json({ ok: false, code: 'expired', message: '速传码不存在或已过期（有效期 30 分钟）' }, 404);
  let rec = null;
  try { rec = JSON.parse(raw); } catch (e) { rec = null; }
  if (!rec) return json({ ok: false, code: 'expired' }, 404);

  if (action === 'meta') {
    return json({ ok: true, kind: rec.kind, name: rec.name, size: (rec.dataUrl || rec.text || '').length, createdAt: rec.createdAt });
  }

  // 领取计数（不删除，便于多端重复查看，TTL 自动过期）
  rec.views = (Number(rec.views) || 0) + 1;
  rec.lastViewAt = new Date().toISOString();
  try { await kv.put(key, JSON.stringify(rec), { expirationTtl: TTL_SEC }); } catch (e) { }

  return json({
    ok: true,
    kind: rec.kind,
    name: rec.name,
    dataUrl: rec.dataUrl || '',
    text: rec.text || '',
    createdAt: rec.createdAt
  });
}
