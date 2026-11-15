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
import { normProjectKeys, projectTitle, isFreeProject } from './_lib/data/projects.js';

const KV_NAME = 'SMS_KV';
const INDEX_KEY = 'order:index:v1';
const MAX_INDEX = 2000;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PRICE = 5;
const COUPON_USE_LIMIT = 2;   // 订单券码可用次数：2 次后自动过期

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

// 联系方式归一化：去空格/横线，手机号或邮箱
export function contactKey(v) {
  return String(v || '').toLowerCase().replace(/[\s\-()]/g, '');
}

// 券码脱敏：GC-3K7P-9Q2M → GC-3K7P-••••
function maskCode(code) {
  const s = String(code || '');
  const parts = s.split('-');
  if (parts.length >= 3) return parts[0] + '-' + parts[1] + '-••••';
  return s ? s.slice(0, 4) + '••••' : '';
}

const STATUS_TEXT = { pending: '待确认', confirmed: '已完成', rejected: '未通过', cancelled: '已取消', refunded: '已退款' };

/* ---- v3.5 待支付超时策略 ---------------------------------------------
 *  0 ~ 1h    ：活跃待支付 → 前端在「购买」现场继续引导爱发电支付
 *  1h ~ 24h  ：不再主动打扰，只在「我购买的商品」历史里显示「待完成支付」
 *  ≥ 24h     ：自动取消（status = cancelled），页面不再展示支付入口
 * 正常支付后由后台/回调置为 confirmed，不参与超时。
 */
export const PAY_ACTIVE_MS = 60 * 60 * 1000;
export const PAY_EXPIRE_MS = 24 * 60 * 60 * 1000;
export const REFUND_NOTICE = '工作人员已为你安排退款，退款将在一个月内到账';
export const REFUND_NOTICE_AT = '';

function ageOf(o) {
  const t = Date.parse(o && o.createdAt ? o.createdAt : '');
  if (!isFinite(t)) return 0;
  return Date.now() - t;
}

/** 待支付订单的时效分档：active / history / expired */
export function payPhase(o) {
  if (!o) return '';
  const st = String(o.status || '');
  if (st !== 'pending') return st;
  const age = ageOf(o);
  if (age >= PAY_EXPIRE_MS) return 'expired';
  if (age >= PAY_ACTIVE_MS) return 'history';
  return 'active';
}

/** 读取时顺手把超过 24h 的 pending 落库为 cancelled（幂等） */
async function sweepPending(kv, list) {
  const now = Date.now();
  let changed = false;
  const next = [];
  for (const o of (Array.isArray(list) ? list : [])) {
    if (String(o.status || '') === 'pending') {
      const t = Date.parse(o.createdAt || '');
      if (isFinite(t) && now - t >= PAY_EXPIRE_MS) {
        const full = await readJson(kv, 'order:item:' + o.id, null);
        const rec = full || o;
        rec.status = 'cancelled';
        rec.statusAt = new Date().toISOString();
        rec.note = (rec.note ? rec.note + ' · ' : '') + '超 24 小时未支付自动取消';
        await kv.put('order:item:' + rec.id, JSON.stringify(rec));
        next.push(brief(rec));
        changed = true;
        continue;
      }
    }
    next.push(o);
  }
  if (changed) await kv.put(INDEX_KEY, JSON.stringify(next.slice(0, MAX_INDEX)));
  return next;
}


// 面向用户的订单视图（不含明文券码）
function orderView(o) {
  const phase = payPhase(o);
  const st = String(o.status || '');
  const phaseText = st === 'pending'
    ? (phase === 'active' ? '等待支付' : (phase === 'history' ? '待完成支付' : '已取消'))
    : (st === 'refunded' ? REFUND_NOTICE : (STATUS_TEXT[st] || st));
  return {
    id: o.id,
    orderNo: o.id,
    project: o.project || '',
    projectTitle: projectTitle(o.project || '') || o.product || '',
    product: o.product || '',
    price: Number(o.price || PRICE),
    contact: o.contact || '',
    afdianOrder: o.afdianOrder || '',
    status: o.status,
    statusText: STATUS_TEXT[o.status] || o.status,
    phase: phase,
    phaseText: phaseText,
    /* 1 小时内可继续支付；1 小时后不再主动展示支付入口，仅历史可见 */
    payable: phase === 'active',
    showOnHome: phase === 'active',
    createdAt: o.createdAt,
    expireAt: (function () {
      const t = Date.parse(o.createdAt || '');
      return isFinite(t) ? new Date(t + PAY_ACTIVE_MS).toISOString() : '';
    })(),
    cancelAt: (function () {
      const t = Date.parse(o.createdAt || '');
      return isFinite(t) ? new Date(t + PAY_EXPIRE_MS).toISOString() : '';
    })(),
    statusAt: o.statusAt || '',
    paidAt: o.paidAt || '',
    refundAt: o.refundAt || '',
    refundNotice: st === 'refunded' ? REFUND_NOTICE : '',
    note: o.note || '',
    couponMasked: maskCode(o.couponCode),
    /* 已确认订单给明文码：与爱发电「配置码 / 私信码」必须是同一串 */
    couponCode: (String(o.status || '') === 'confirmed' ? (o.couponCode || '') : ''),
    forcedAt: o.forcedAt || '',
    couponStatus: o.couponCode ? (o.usedAt ? 'used' : 'active') : '',
    couponUsedAt: o.usedAt || '',
    revealed: !!o.revealedAt,
    revealedAt: o.revealedAt || '',
    /* 完成消费/注册后可直接下载文档（免费项目 c919 也走这里） */
    docUrl: '/api/project-doc?project=' + encodeURIComponent(o.project || 'b737') + '&download=1',
    readUrl: '/read/' + (o.project || 'b737') + '.html',
    thanksUrl: '/thanks.html?project=' + encodeURIComponent(o.project || 'b737') + '&order=' + encodeURIComponent(o.id || '')
  };
}


// 同步更新索引中的对应订单
async function patchIndex(kv, id, patch) {
  const idx = await readJson(kv, INDEX_KEY, []);
  const list = Array.isArray(idx) ? idx : [];
  let hit = false;
  const next = list.map((o) => {
    if (String(o.id || '') !== id) return o;
    hit = true;
    return Object.assign({}, o, patch);
  });
  if (hit) await kv.put(INDEX_KEY, JSON.stringify(next.slice(0, MAX_INDEX)));
}


function displayOfRec(rec) {
  const c = String((rec && rec.couponCode) || '');
  return c || normCode(rec && rec.code);
}

// 券码实时状态：返回 { status, useLimit, usedCount, remaining, expired }
async function couponState(kv, code) {
  const norm = normCode(code);
  if (!norm) return null;
  const rec = await readJson(kv, 'coupon:code:' + norm, null);
  if (!rec) return null;
  const limit = Number(rec.useLimit || 1);
  const used = Number(rec.usedCount || 0);
  let status = String(rec.status || 'active');
  if (status === 'active' && used >= limit) status = 'used';
  return {
    status: status, useLimit: limit, usedCount: used,
    remaining: Math.max(0, limit - used),
    projectKeys: Array.isArray(rec.projectKeys) ? rec.projectKeys : []
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
      exp: '', usedBy: '', usedByName: '', usedAt: '',
      useLimit: COUPON_USE_LIMIT, usedCount: 0, usedLog: []
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
    const v = orderView(o);
    // 券码实时状态（是否用完两次、是否过期）
    const cInfo = o.couponCode ? await couponState(kv, o.couponCode) : null;
    return ok({
      found: true, status: o.status, phase: v.phase, phaseText: v.phaseText,
      refundNotice: v.refundNotice, refundAt: v.refundAt,
      project: o.project, docUrl: v.docUrl, readUrl: v.readUrl, thanksUrl: v.thanksUrl,
      product: o.product || '', price: Number(o.price || PRICE),
      createdAt: o.createdAt || '', statusAt: o.statusAt || '',
      couponMasked: maskCode(o.couponCode), revealed: !!o.revealedAt,
      // 已确认的订单直接回明文码：前端与爱发电「配置码 / 私信码」必须是同一串
      couponCode: o.status === 'confirmed' ? (o.couponCode || '') : '',
      coupon: cInfo,
      afdianOrder: o.afdianOrder || '', forcedAt: o.forcedAt || '',
      contact: o.contact || ''
    });
  }

  // ── 追踪码查询：凭券码查订单与使用情况（脱敏）─────────────────────
  if (action === 'trace') {
    const code = normCode(url.searchParams.get('code') || '');
    if (!code || code.length < 6) return bad('bad_code', '请输入完整券码');
    const rec = await readJson(kv, 'coupon:code:' + code, null);
    if (!rec) return ok({ found: false, status: 'not_found' });
    const idx = await readJson(kv, INDEX_KEY, []);
    const hit = (Array.isArray(idx) ? idx : []).find((o) => {
      return normCode(o && o.couponCode) === code || String((o && o.note) || '').indexOf(code) >= 0;
    }) || null;
    const limit = Number(rec.useLimit || 1);
    const used = Number(rec.usedCount || 0) + (Array.isArray(rec.usedLog) ? 0 : 0);
    return ok({
      found: true,
      codeMasked: maskCode(displayOfRec(rec)),
      status: String(rec.status || 'active'),
      useLimit: limit, usedCount: used, remaining: Math.max(0, limit - used),
      projectKeys: Array.isArray(rec.projectKeys) ? rec.projectKeys : [],
      projectTitles: (Array.isArray(rec.projectKeys) ? rec.projectKeys : []).map(projectTitle),
      createdAt: String(rec.createdAt || ''),
      usedLog: Array.isArray(rec.usedLog) ? rec.usedLog.slice(-5) : [],
      orderId: hit ? String(hit.id || '') : '',
      orderStatus: hit ? String(hit.status || '') : '',
      orderCreatedAt: hit ? String(hit.createdAt || '') : ''
    });
  }

  // 我的订单：?action=myorders&contact=手机号/邮箱，或 &id=订单号
  if (action === 'myorders') {
    const contact = String(url.searchParams.get('contact') || '').trim();
    const id = String(url.searchParams.get('id') || '').trim();
    if (!id && contact.length < 3) return bad('bad_contact', '请输入下单时填写的手机号或邮箱');
    const idx = await readJson(kv, INDEX_KEY, []);
    const list = await sweepPending(kv, Array.isArray(idx) ? idx : []);
    let sel = list;
    if (id) {
      sel = list.filter((o) => String(o.id || '') === id);
    } else {
      const key = contactKey(contact);
      sel = list.filter((o) => contactKey(o.contact) === key);
    }
    const orders = [];
    for (const o of sel.slice(0, 100)) {
      const full = await readJson(kv, 'order:item:' + o.id, null);
      orders.push(orderView(full || o));
    }
    orders.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const active = orders.filter((o) => o.phase === 'active');
    return ok({ total: orders.length, orders, active });
  }

  // 活跃待支付：?action=active&contact= / &id=   —— 仅返回 1 小时内的 pending，供首页判断是否回滚
  if (action === 'active') {
    const contact = String(url.searchParams.get('contact') || '').trim();
    const id = String(url.searchParams.get('id') || '').trim();
    if (!id && contact.length < 3) return ok({ active: null, count: 0 });
    const idx = await readJson(kv, INDEX_KEY, []);
    const list = await sweepPending(kv, Array.isArray(idx) ? idx : []);
    const key = contactKey(contact);
    const hit = list.find((o) => {
      const p = payPhase(o);
      if (p !== 'active') return false;
      if (id) return String(o.id || '') === id;
      return contactKey(o.contact) === key;
    });
    if (!hit) return ok({ active: null, count: 0 });
    const full = await readJson(kv, 'order:item:' + hit.id, null);
    return ok({ active: orderView(full || hit), count: 1 });
  }


  if (action === 'feedbacklist') {
    if (!isAdmin(request, env)) return bad('unauthorized', '需要管理员令牌', null, 401);
    const list = await readJson(kv, 'order:feedback:v1', []);
    const arr = Array.isArray(list) ? list : [];
    return ok({ total: arr.length, feedbacks: arr.slice(0, 200) });
  }

  if (action === 'list') {
    if (!isAdmin(request, env)) return bad('unauthorized', '需要管理员令牌', null, 401);
    const idx = await readJson(kv, INDEX_KEY, []);
    const list = await sweepPending(kv, Array.isArray(idx) ? idx : []);
    const st = String(url.searchParams.get('status') || '').trim();
    const q = String(url.searchParams.get('q') || '').trim().toUpperCase();
    const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);
    /* 后台按订单号 / 联系方式 / 爱发电单号模糊搜索 */
    let filtered = st ? list.filter((o) => String(o.status || '') === st) : list;
    if (q) {
      filtered = filtered.filter((o) => {
        const hay = [o.id, o.contact, o.afdianOrder, o.project, o.product].join(' ').toUpperCase();
        return hay.indexOf(q) >= 0;
      });
    }
    const stats = { total: list.length, pending: 0, confirmed: 0, rejected: 0, cancelled: 0, refunded: 0 };
    list.forEach((o) => { if (stats[o.status] !== undefined) stats[o.status]++; });
    return ok({
      stats, total: filtered.length, query: q,
      orders: filtered.slice(0, limit).map((o) => {
        const b = brief(o);
        const p = payPhase(o);
        b.phase = p;
        b.phaseText = o.status === 'pending'
          ? (p === 'active' ? '等待支付' : (p === 'history' ? '待完成支付' : '已取消'))
          : (o.status === 'refunded' ? '已退款' : (STATUS_TEXT[o.status] || o.status));
        return b;
      })
    });
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

  // ── 领取券码：仅首次返回明文，之后只返回脱敏码 ──────────────────────
  if (action === 'claim') {
    const id = String(body.id || '').trim();
    const contact = String(body.contact || '').trim();
    if (!id) return bad('bad_id', '缺少订单号');
    const o = await readJson(kv, 'order:item:' + id, null);
    if (!o) return bad('not_found', '订单不存在', null, 404);
    if (contact && o.contact && contactKey(contact) !== contactKey(o.contact)) {
      return bad('contact_mismatch', '联系方式与订单不匹配', null, 403);
    }
    if (o.status !== 'confirmed') {
      return ok({ ready: false, status: o.status, statusText: STATUS_TEXT[o.status] || o.status, order: orderView(o) });
    }
    if (!o.couponCode) return bad('no_coupon', '该订单尚未生成券码，请联系站长', null, 409);
    if (o.revealedAt) {
      return ok({
        ready: true, once: false, alreadyRevealed: true,
        couponCode: maskCode(o.couponCode), revealedAt: o.revealedAt,
        order: orderView(o)
      });
    }
    o.revealedAt = new Date().toISOString();
    o.revealCount = 1;
    await kv.put('order:item:' + id, JSON.stringify(o));
    await patchIndex(kv, id, { revealedAt: o.revealedAt });
    return ok({
      ready: true, once: true, couponCode: o.couponCode, revealedAt: o.revealedAt,
      order: orderView(Object.assign({}, o, { couponCode: '' }))
    });
  }

  // ── 购买反馈：用户带订单号向站长提交问题 ──────────────────────────
  if (action === 'feedback') {
    const id = String(body.id || '').trim();
    const text = String(body.text || '').slice(0, 500).trim();
    const contact = String(body.contact || '').slice(0, 100).trim();
    if (!id) return bad('bad_id', '缺少订单号');
    if (text.length < 4) return bad('bad_text', '请描述您的问题（至少 4 个字）');
    const o = await readJson(kv, 'order:item:' + id, null);
    if (!o) return bad('not_found', '订单不存在', null, 404);
    const fb = {
      id: 'FB-' + Date.now().toString(36).toUpperCase(),
      orderId: id, text: text, contact: contact || o.contact || '',
      createdAt: new Date().toISOString(), status: 'open'
    };
    const list = await readJson(kv, 'order:feedback:v1', []);
    const arr = Array.isArray(list) ? list : [];
    arr.unshift(fb);
    await kv.put('order:feedback:v1', JSON.stringify(arr.slice(0, 1000)));
    return ok({ feedback: fb, message: '反馈已提交，站长会尽快处理' });
  }

  if (action === 'create') {
    const project = (normProjectKeys([body.project || 'b737'])[0]) || 'b737';
    const contact = String(body.contact || '').slice(0, 100).trim();
    if (!contact) return bad('bad_contact', '请填写手机号或邮箱，便于核对到账与补发');
    /* v3.5：免费项目（C919）不允许下单购买 */
    if (isFreeProject(project)) {
      return ok({
        free: true, project: project, status: 'free',
        message: '该项目为免费项目，无需购买，可直接查看与下载',
        readUrl: '/read/' + project + '.html',
        docUrl: '/api/project-doc?project=' + project + '&download=1'
      });
    }
    /* v3.5：同一用户在该项目上已有可用券 → 直接拦截，禁止重复购买 */
    {
      const idx0 = await readJson(kv, INDEX_KEY, []);
      const list0 = Array.isArray(idx0) ? idx0 : [];
      const key = contactKey(contact);
      const dup = list0.filter((x) => contactKey(x.contact) === key
        && String(x.project || '') === project
        && (x.status === 'confirmed' || x.status === 'pending'))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
      if (dup && dup.status === 'confirmed' && dup.couponCode) {
        const rec = await kv.get('coupon:code:' + normCode(dup.couponCode), { type: 'json' });
        const alive = rec ? (String(rec.status || '') !== 'revoked') : true;
        if (alive) {
          return json({
            ok: false, code: 'duplicate_coupon', alreadyOwned: true,
            message: '你已经有这个券了，不可以再购买',
            couponMasked: maskCode(dup.couponCode),
            orderId: dup.id, project: project,
            readUrl: '/read/' + project + '.html'
          }, 409);
        }
      }
    }
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

  // ── 后台「强制完成支付」：待完成 / 已过期 / 待核验 → 直接确认并发码 ──
  if (action === 'force-confirm') {
    if (!isAdmin(request, env)) return bad('unauthorized', '需要管理员令牌', null, 401);
    const id = String(body.id || '').trim();
    if (!id) return bad('bad_id', '缺少订单号');
    const o = await readJson(kv, 'order:item:' + id, null);
    if (!o) return bad('not_found', '订单不存在');
    let display = o.couponCode || '';
    if (!display) {
      display = await issueCoupon(kv, o.project, id, o.contact);
      o.couponCode = display;
    } else {
      // 旧订单缺次数限制：补写成 2 次
      const rec = await readJson(kv, 'coupon:code:' + normCode(display), null);
      if (rec && !rec.useLimit) {
        rec.useLimit = COUPON_USE_LIMIT;
        rec.usedCount = Number(rec.usedCount || 0);
        await kv.put('coupon:code:' + normCode(display), JSON.stringify(rec));
      }
    }
    const prev = String(o.status || '');
    o.status = 'confirmed';
    o.statusAt = new Date().toISOString();
    o.forcedAt = o.statusAt;
    o.forcedBy = 'admin';
    o.note = (o.note ? o.note + ' · ' : '') + '后台强制完成支付（原状态 ' + (STATUS_TEXT[prev] || prev || '-') + '）';
    await kv.put('order:item:' + id, JSON.stringify(o));
    const idx = await readJson(kv, INDEX_KEY, []);
    const list = Array.isArray(idx) ? idx : [];
    let hit = false;
    for (let i = 0; i < list.length; i++) if (list[i].id === id) { list[i] = brief(o); hit = true; }
    if (!hit) list.unshift(brief(o));
    await kv.put(INDEX_KEY, JSON.stringify(list.slice(0, MAX_INDEX)));
    return ok({ id: id, status: 'confirmed', couponCode: display, useLimit: COUPON_USE_LIMIT, previousStatus: prev });
  }

  // ── 用户回站内核验：粘贴爱发电订单号（付款后无法自动核验时的兜底）─────
  if (action === 'bind-afdian') {
    const id = String(body.id || '').trim();
    const contact = String(body.contact || '').trim();
    const afdianOrder = String(body.afdianOrder || '').trim().slice(0, 60);
    if (!id) return bad('bad_id', '缺少订单号');
    if (afdianOrder.length < 4) return bad('bad_afdian', '请粘贴爱发电订单号（至少 4 位）');
    const o = await readJson(kv, 'order:item:' + id, null);
    if (!o) return bad('not_found', '订单不存在', null, 404);
    if (contact && o.contact && contactKey(contact) !== contactKey(o.contact)) {
      return bad('contact_mismatch', '联系方式与订单不匹配', null, 403);
    }
    if (o.status === 'rejected' || o.status === 'cancelled') {
      return bad('status_locked', '该订单已关闭，请联系站长重新下单', null, 409);
    }
    o.afdianOrder = afdianOrder;
    o.afdianBoundAt = new Date().toISOString();
    // 开启自动核验模式时直接确认发码；否则进入「待核验」，由后台一键强制完成
    const auto = String((env && env.AUTO_CONFIRM_AFDIAN) || '1') !== '0';
    let display = o.couponCode || '';
    if (auto) {
      if (!display) display = await issueCoupon(kv, o.project, id, o.contact);
      o.couponCode = display;
      o.status = 'confirmed';
      o.statusAt = new Date().toISOString();
      o.autoVerified = true;
      o.note = (o.note ? o.note + ' · ' : '') + '用户回填爱发电订单号 ' + afdianOrder;
    } else {
      o.status = o.status === 'confirmed' ? 'confirmed' : 'pending';
      o.note = (o.note ? o.note + ' · ' : '') + '用户回填爱发电订单号 ' + afdianOrder + '（待站长核验）';
    }
    await kv.put('order:item:' + id, JSON.stringify(o));
    const idx2 = await readJson(kv, INDEX_KEY, []);
    const list2 = Array.isArray(idx2) ? idx2 : [];
    let hit2 = false;
    for (let i = 0; i < list2.length; i++) if (list2[i].id === id) { list2[i] = brief(o); hit2 = true; }
    if (!hit2) list2.unshift(brief(o));
    await kv.put(INDEX_KEY, JSON.stringify(list2.slice(0, MAX_INDEX)));
    return ok({
      id: id, status: o.status, verified: o.status === 'confirmed',
      couponCode: o.status === 'confirmed' ? display : '',
      couponMasked: maskCode(display),
      message: o.status === 'confirmed' ? '已核验通过，券码已开通' : '已提交，站长核对到账后会立即开通'
    });
  }

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

  // ── 后台退款：状态置 refunded，用户端订单详情固定展示退款到账文案 ──
  if (action === 'refund') {
    if (!isAdmin(request, env)) return bad('unauthorized', '需要管理员令牌', null, 401);
    const id = String(body.id || '').trim();
    if (!id) return bad('bad_id', '缺少订单号');
    const o = await readJson(kv, 'order:item:' + id, null);
    if (!o) return bad('not_found', '订单不存在');
    o.status = 'refunded';
    o.statusAt = new Date().toISOString();
    o.refundAt = o.statusAt;
    o.refundNotice = REFUND_NOTICE;
    o.note = String(body.reason || '后台安排退款').slice(0, 200);
    if (o.couponCode) o.revokedAt = o.statusAt;
    await kv.put('order:item:' + id, JSON.stringify(o));
    await patchIndex(kv, id, brief(o));
    /* 通知队列：用户端「我的」红点 + 后台通知中心 + 可选微信推送 */
    try {
      const nk = await readJson(kv, 'notify:admin:v1', []);
      const nlist = Array.isArray(nk) ? nk : [];
      nlist.unshift({
        id: 'NT-' + Date.now().toString(36).toUpperCase(),
        type: 'refund', level: 'warn',
        title: '已为订单安排退款',
        text: '订单 ' + id + ' · ' + (o.contact || '') + ' · ' + REFUND_NOTICE,
        createdAt: new Date().toISOString(), read: false, orderId: id
      });
      await kv.put('notify:admin:v1', JSON.stringify(nlist.slice(0, 300)));
      if (o.contact) {
        const ub = await readJson(kv, 'notify:user:' + contactKey(o.contact), []);
        const ulist = Array.isArray(ub) ? ub : [];
        ulist.unshift({
          id: 'NU-' + Date.now().toString(36).toUpperCase(),
          type: 'refund', level: 'warn', orderId: id,
          title: '退款已安排',
          text: REFUND_NOTICE,
          createdAt: new Date().toISOString(), read: false
        });
        await kv.put('notify:user:' + contactKey(o.contact), JSON.stringify(ulist.slice(0, 100)));
      }
    } catch (e) { /* 通知失败不影响退款 */ }
    return ok({ id: id, status: 'refunded', refundNotice: REFUND_NOTICE, refundAt: o.refundAt });
  }

  return bad('bad_action', '未知 action');
}
