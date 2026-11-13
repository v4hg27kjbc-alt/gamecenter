/**
 * /api/order —— 付费订单（爱发电 5 元 · 波音737 系列研究报告）
 *
 * KV（SMS_KV）：
 *   order:item:<id>   → { id, project, product, price, contact, afdianOrder, status, createdAt, statusAt, couponCode, note }
 *   order:index:v1    → [ 订单摘要 ... ]（后台列表，最多 2000 条）
 *
 * 路由：
 *   POST { action:'create', project, contact, afdianOrder, note }  → { id, status:'pending' }
 *   GET  ?action=status&id=ORD-XXXX                                → { status, couponCode? }
 *   GET  ?action=list&status=&limit=（需 X-Admin-Token）           → 订单列表 + 统计
 *   POST { action:'confirm', id }（需 X-Admin-Token）              → 生成关联项目券码并写回订单
 *   POST { action:'reject',  id, reason }（需 X-Admin-Token）
 *
 * 说明：爱发电无开放回调时，采用「用户下单 → 后台核对爱发电到账 → 一键确认发券」的闭环；
 * 券码一旦生成即可在 /read/737.html 兑换阅读（正文带唯一追踪码水印）。
 */
import { normProjectKeys, projectTitle } from './_lib/data/projects.js';

const KV_NAME = 'SMS_KV';
const INDEX_KEY = 'order:index:v1';
const MAX_INDEX = 2000;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PRICE = 5;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Admin-Token,X-Visitor-Id'
};

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': origin || '*'
    }, CORS)
  });
}
const ok = (d, o) => json(Object.assign({ ok: true }, d), 200, o);
const bad = (code, message, o, status) => json({ ok: false, code, message }, status || 400, o);

function kvOf(env) {
  const kv = env && env.SMS_KV;
  if (kv && typeof kv.get === 'function') return kv;
  const alt = env && env.NEWS_KV;
  return (alt && typeof alt.get === 'function') ? alt : null;
}

async function readJson(kv, key, dft) {
  try { const t = await kv.get(key); return t ? JSON.parse(t) : dft; } catch (e) { return dft; }
}

function isAdmin(request, env) {
  const h = request.headers.get('X-Admin-Token') || '';
  const want = (env && (env.ADMIN_TOKEN || env.TOKEN_SECRET)) || '';
  const ck = request.headers.get('Cookie') || '';
  if (ck && /mv_admin=/.test(ck)) return true;
  return !!(want && h && h === want);
}

function rand(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[a[i] % ALPHABET.length];
  return s;
}
function orderId() {
  const d = new Date();
  const p = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  return 'ORD-' + p + '-' + rand(6);
}
function normCode(v) {
  return String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}
function brief(o) {
  return {
    id: o.id, project: o.project, product: o.product, price: o.price,
    contact: o.contact, afdianOrder: o.afdianOrder || '', status: o.status,
    createdAt: o.createdAt, statusAt: o.statusAt || '', couponCode: o.couponCode || '',
    note: o.note || ''
  };
}

// 生成关联商品的券码（与后台 /api/coupons 记录结构保持一致）
async function issueCoupon(kv, project, orderIdv, contact) {
  const prefix = 'GC';
  for (let i = 0; i < 8; i++) {
    const norm = normCode(prefix + rand(8));
    const hit = await kv.get('coupon:code:' + norm);
    if (hit) continue;
    const display = prefix + '-' + norm.slice(2, 6) + '-' + norm.slice(6, 10);
    const rec = {
      code: norm, couponCode: display, status: 'active',
      projectKeys: project ? [project] : [],
      type: '付费文档券', value: '¥' + PRICE,
      note: '爱发电订单 ' + orderIdv + (contact ? ' · ' + contact : ''),
      batch: 'AFD-' + orderIdv.slice(-6), prefix: prefix,
      createdAt: new Date().toISOString(), createdBy: 'afdian-order',
      exp: '', usedBy: '', usedByName: '', usedAt: ''
    };
    await kv.put('coupon:code:' + norm, JSON.stringify(rec));
    const idx = await readJson(kv, 'coupon:index:v1', []);
    const list = Array.isArray(idx) ? idx : [];
    list.unshift(Object.assign({}, rec));
    await kv.put('coupon:index:v1', JSON.stringify(list.slice(0, 5000)));
    return display;
  }
  return '';
}

export function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  const kv = kvOf(env);
  if (!kv) return bad('kv_missing', '存储未配置');
  const url = new URL(request.url);
  const action = url.searchParams.get('action') || 'status';

  if (action === 'status') {
    const id = String(url.searchParams.get('id') || '').trim();
    if (!id) return bad('bad_id', '缺少订单号');
    const o = await readJson(kv, 'order:item:' + id, null);
    if (!o) return ok({ found: false, status: 'not_found' });
    return ok({ found: true, status: o.status, couponCode: o.couponCode || '', project: o.project });
  }

  if (action === 'list') {
    if (!isAdmin(request, env)) return bad('unauthorized', '需要管理员令牌', null, 401);
    const idx = await readJson(kv, INDEX_KEY, []);
    const list = Array.isArray(idx) ? idx : [];
    const st = String(url.searchParams.get('status') || '').trim();
    const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);
    const filtered = st ? list.filter((o) => String(o.status || '') === st) : list;
    const stats = { total: list.length, pending: 0, confirmed: 0, rejected: 0 };
    list.forEach((o) => { if (stats[o.status] !== undefined) stats[o.status]++; });
    return ok({ stats, total: filtered.length, orders: filtered.slice(0, limit).map(brief) });
  }

  return bad('bad_action', '未知 action');
}

export async function onRequestPost({ request, env }) {
  const kv = kvOf(env);
  if (!kv) return bad('kv_missing', '存储未配置');
  let body = {};
  try { body = await request.json(); } catch (e) { }
  const action = String(body.action || '');

  // ── 爱发电支付回调（webhook）: body 形如 { ec:200, data:{ order:{ out_trade_no, remark, ... } } }
  if (action === '' && (body.ec !== undefined || body.data)) {
    const expect = String((env && (env.AFD_WEBHOOK_TOKEN || env.AFDIAN_WEBHOOK_TOKEN)) || '');
    if (expect) {
      const got = String(body.token || body.sign || request.headers.get('x-afd-token') || '');
      if (got !== expect) return json({ ec: 400, em: 'bad token' }, 200);
    }
    const o0 = (body.data && body.data.order) || {};
    const raw = [o0.remark, o0.out_trade_no, o0.remark_reason, body.remark].filter(Boolean).join(' ');
    const m = String(raw).match(/ORD-\d{8}-[A-Z0-9]{6}/);
    if (!m) return json({ ec: 200, em: 'ignored: no order id' }, 200);
    const id = m[0];
    const o = await readJson(kv, 'order:item:' + id, null);
    if (!o) return json({ ec: 200, em: 'ignored: unknown order' }, 200);
    if (o.status === 'confirmed' && o.couponCode) return json({ ec: 200, em: 'already' }, 200);
    const display = await issueCoupon(kv, o.project, id, o.contact);
    o.status = 'confirmed'; o.statusAt = new Date().toISOString(); o.couponCode = display;
    o.afdianOrder = String(o0.out_trade_no || o.afdianOrder || '').slice(0, 60);
    o.paidAt = String(o0.create_time || new Date().toISOString()).slice(0, 40);
    o.note = '爱发电回调自动开通';
    await kv.put('order:item:' + id, JSON.stringify(o));
    const idx0 = await readJson(kv, INDEX_KEY, []);
    const list0 = Array.isArray(idx0) ? idx0 : [];
    for (let i = 0; i < list0.length; i++) if (list0[i].id === id) list0[i] = brief(o);
    await kv.put(INDEX_KEY, JSON.stringify(list0.slice(0, MAX_INDEX)));
    return json({ ec: 200, em: 'confirmed ' + id }, 200);
  }

  if (action === 'create') {
    const project = (normProjectKeys([body.project || 'b737'])[0]) || 'b737';
    const contact = String(body.contact || '').slice(0, 100).trim();
    if (!contact) return bad('bad_contact', '请填写手机号或邮箱，便于核对到账与补发');
    const id = orderId();
    const now = new Date().toISOString();
    const o = {
      id: id, project: project, product: projectTitle(project) + ' 付费阅读', price: PRICE,
      contact: contact, afdianOrder: String(body.afdianOrder || '').slice(0, 60).trim(),
      status: 'pending', createdAt: now, statusAt: now, couponCode: '', note: String(body.note || '').slice(0, 200)
    };
    await kv.put('order:item:' + id, JSON.stringify(o));
    const idx = await readJson(kv, INDEX_KEY, []);
    const list = Array.isArray(idx) ? idx : [];
    list.unshift(brief(o));
    await kv.put(INDEX_KEY, JSON.stringify(list.slice(0, MAX_INDEX)));
    return ok({ id: id, status: 'pending', price: PRICE, message: '订单已登记，支付到账后自动开通' });
  }

  if (action === 'confirm') {
    if (!isAdmin(request, env)) return bad('unauthorized', '需要管理员令牌', null, 401);
    const id = String(body.id || '').trim();
    if (!id) return bad('bad_id', '缺少订单号');
    const o = await readJson(kv, 'order:item:' + id, null);
    if (!o) return bad('not_found', '订单不存在');
    if (o.status === 'confirmed' && o.couponCode) return ok({ id: id, status: 'confirmed', couponCode: o.couponCode, reused: true });
    const display = await issueCoupon(kv, o.project, id, o.contact);
    o.status = 'confirmed'; o.statusAt = new Date().toISOString(); o.couponCode = display;
    await kv.put('order:item:' + id, JSON.stringify(o));
    const idx = await readJson(kv, INDEX_KEY, []);
    const list = Array.isArray(idx) ? idx : [];
    for (let i = 0; i < list.length; i++) if (list[i].id === id) list[i] = brief(o);
    await kv.put(INDEX_KEY, JSON.stringify(list.slice(0, MAX_INDEX)));
    return ok({ id: id, status: 'confirmed', couponCode: display });
  }

  if (action === 'reject') {
    if (!isAdmin(request, env)) return bad('unauthorized', '需要管理员令牌', null, 401);
    const id = String(body.id || '').trim();
    const o = await readJson(kv, 'order:item:' + id, null);
    if (!o) return bad('not_found', '订单不存在');
    o.status = 'rejected'; o.statusAt = new Date().toISOString(); o.note = String(body.reason || '后台驳回').slice(0, 200);
    await kv.put('order:item:' + id, JSON.stringify(o));
    const idx = await readJson(kv, INDEX_KEY, []);
    const list = Array.isArray(idx) ? idx : [];
    for (let i = 0; i < list.length; i++) if (list[i].id === id) list[i] = brief(o);
    await kv.put(INDEX_KEY, JSON.stringify(list.slice(0, MAX_INDEX)));
    return ok({ id: id, status: 'rejected' });
  }

  return bad('bad_action', '未知 action');
}
