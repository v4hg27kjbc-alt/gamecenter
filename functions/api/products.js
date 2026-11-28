/**
 * /api/products —— 后台「商品管理」接口（上架简介 + 操作按钮）
 *
 * 管理已上架商品（研读报告等）的展示信息：
 *   intro    上架简介（用户端弹窗/卡片展示的简介文案，可在后台随时修改）
 *   actions  操作按钮清单（[{label, href, style}]，style: primary | ghost | link）
 *   及名称、价格、角标、阅读/付款链接、启停、排序
 *
 * 存储：KV 绑定 NEWS_KV，键 site:products:v1（与主站其它配置共用同一 KV 命名空间）。
 * 主站可 GET https://henry126923-admincenter.pages.dev/api/products 读取（已放行跨域）。
 *
 * GET  /api/products          → 公开只读：enabled 条目
 * GET  /api/products?all=1    → 需管理员：全部条目（KV 为空时回退内置清单）
 * POST /api/products          → 需管理员：upsert / delete / toggle / reorder / seed / reset / items
 */

import { isAdmin, json, fail, preflight, readBody, str, genId } from './_lib/admutils.js';

// 与 banners / ads / notices 对齐：商品启停需即时生效，禁止浏览器与 CDN 缓存
const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Pragma': 'no-cache',
  'Expires': '0'
};
import { remoteItems } from './_lib/remote.js';

const KV_KEY = 'site:products:v1';
const MAX_ITEMS = 100;
const MAX_ACTIONS = 6;
const STYLES = ['primary', 'ghost', 'link'];

/** 内置商品：与主站 PROJECTS 白名单（c919 / a320 / b737）对齐 */
export const BUILTIN_PRODUCTS = [
  {
    id: 'c919',
    name: '国产大型客机 C919：研制历程、技术体系与产业化进程综合研究报告',
    short: 'C919 综合研究报告',
    intro: '完整梳理 C919 从立项、总装到商业运营的研制历程，解析总体设计、气动布局、航电与飞控技术体系，并评估产能爬坡与产业链国产化进程。',
    price: '免费',
    badge: '免费上线',
    readHref: '/read/c919.html',
    payHref: '',
    actions: [
      { label: '立即阅读', href: '/read/c919.html', style: 'primary' },
      { label: '下载报告', href: '/projects/c919.md', style: 'ghost' }
    ],
    enabled: true,
    order: 10,
    source: 'builtin'
  },
  {
    id: 'a320',
    name: '空客 A320 系列综合研究报告',
    short: 'A320 系列报告',
    intro: '约 3.5 万字。系统梳理 A320 家族的型号谱系、电传飞控与系统架构、发动机选型与运营经济性，并结合订单与交付数据分析其市场地位。',
    price: '¥5',
    badge: '新上架',
    readHref: '/read/a320.html',
    payHref: '/pay/a320.html',
    actions: [
      { label: '立即阅读', href: '/read/a320.html', style: 'primary' },
      { label: '¥5 购买解锁', href: '/pay/a320.html', style: 'ghost' }
    ],
    enabled: true,
    order: 20,
    source: 'builtin'
  },
  {
    id: 'b737',
    name: '波音 737 系列综合研究报告',
    short: '737 系列报告',
    intro: '从 737 Original 到 MAX 的完整代际演进，解析机身与系统设计取舍、CFM56/LEAP 动力演进及两次重大事故后的适航整改与市场影响。',
    price: '¥5',
    badge: '热销',
    readHref: '/read/737.html',
    payHref: '/pay/737.html',
    actions: [
      { label: '立即阅读', href: '/read/737.html', style: 'primary' },
      { label: '¥5 购买解锁', href: '/pay/737.html', style: 'ghost' }
    ],
    enabled: true,
    order: 30,
    source: 'builtin'
  }
];

function bool(v, dflt) {
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  return dflt;
}

function safeLink(v) {
  const s = str(v, 500);
  if (!s) return '';
  if (/^\//.test(s)) return s;
  if (/^https:\/\//i.test(s)) return s;
  return '';
}

function normId(v, idx) {
  const s = str(v, 64).replace(/[^a-zA-Z0-9_\-:.]/g, '');
  return s || ('p' + Date.now().toString(36) + '-' + idx);
}

function normActions(raw) {
  const arr = Array.isArray(raw) ? raw.slice(0, MAX_ACTIONS) : [];
  const out = [];
  arr.forEach(function (a) {
    const r = a && typeof a === 'object' ? a : {};
    const label = str(r.label, 24);
    const href = safeLink(r.href);
    const styleRaw = str(r.style, 12);
    if (!label && !href) return;
    out.push({
      label: label || '查看',
      href: href,
      style: STYLES.indexOf(styleRaw) >= 0 ? styleRaw : 'ghost'
    });
  });
  return out;
}

function normalize(raw, idx) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const orderNum = Number(r.order);
  return {
    id: normId(r.id, idx),
    name: str(r.name, 120),
    short: str(r.short, 60),
    intro: str(r.intro, 600),
    price: str(r.price, 24),
    badge: str(r.badge, 24),
    readHref: safeLink(r.readHref),
    payHref: safeLink(r.payHref),
    actions: normActions(r.actions),
    enabled: bool(r.enabled, true),
    order: Number.isFinite(orderNum) ? Math.round(orderNum) : 100,
    source: str(r.source, 16) || 'admin',
    updatedAt: Number(r.updatedAt) || 0
  };
}

function normalizeList(list) {
  const arr = Array.isArray(list) ? list.slice(0, MAX_ITEMS) : [];
  const seen = {};
  const out = [];
  arr.forEach(function (it, i) {
    const n = normalize(it, i);
    if (seen[n.id]) n.id = n.id + '-' + i;
    seen[n.id] = true;
    out.push(n);
  });
  return out.sort(function (a, b) {
    return (a.order - b.order) || String(a.id).localeCompare(String(b.id));
  });
}

async function kvGet(env) {
  if (!env || !env.NEWS_KV) return { available: false, items: null };
  try {
    const raw = await env.NEWS_KV.get(KV_KEY);
    if (!raw) return { available: true, items: null };
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items) ? parsed.items : null);
    return { available: true, items: items ? normalizeList(items) : null };
  } catch (e) {
    return { available: true, items: null, error: String((e && e.message) || e) };
  }
}

async function kvPut(env, items) {
  await env.NEWS_KV.put(
    KV_KEY,
    JSON.stringify({ v: 1, updatedAt: Date.now(), items: items }),
    { expirationTtl: 60 * 60 * 24 * 365 * 3 }
  );
}

export async function onRequestOptions(context) {
  return preflight(context.request) || new Response(null, { status: 204 });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const pf = preflight(request);
  if (pf) return pf;
  const url = new URL(request.url);
  const wantAll = url.searchParams.get('all') === '1';
  const store = await kvGet(env);
  const hasKv = !!(store.items && store.items.length);
  const _baseOf = function (store, hasKv) { return hasKv ? store.items : BUILTIN_PRODUCTS.map(function (p, i) { return normalize(p, i); }); };

  let base = _baseOf(store, hasKv);
  let remoteUsed = false;
  if (!hasKv) {
    const remote = await remoteItems(env, 'products');
    if (remote) { base = remote.map(function (x, i) { return normalize(x, i); }); remoteUsed = true; }
  }
  const srcLabel = remoteUsed ? 'remote' : (hasKv ? 'kv' : 'builtin');

  if (wantAll) {
    if (!(await isAdmin(request, env))) return fail('未授权：请先登录后台', 401, request);
    return json({
      ok: true,
      items: base,
      count: base.length,
      source: srcLabel,
      kvAvailable: store.available
    }, 200, request);
  }

  // 公开返回全部条目并带 enabled 标记：前端据此展示「目前已下架，无法进行操作」，
  // 而不是让下架商品静默消失（避免用户误以为商品不存在）。
  const online = base.filter(function (p) { return p.enabled; });
  return json({
    ok: true,
    items: base,
    count: base.length,
    online: online.length,
    offlineIds: base.filter(function (p) { return !p.enabled; }).map(function (p) { return p.id; }),
    source: srcLabel,
    kvAvailable: store.available
  }, 200, request, NO_STORE);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const pf = preflight(request);
  if (pf) return pf;
  if (!(await isAdmin(request, env))) return fail('未授权：请先登录后台', 401, request);
  if (!env || !env.NEWS_KV) return fail('服务端未绑定 NEWS_KV，无法保存商品', 503, request);

  const body = await readBody(request);
  const store = await kvGet(env);
  let items = store.items && store.items.length ? store.items.slice() : [];
  const action = str(body.action, 16);

  // KV 为空时先用内置商品播种，保证 toggle / delete / reorder 能命中已有商品
  if (!items.length && action !== 'reset') {
    BUILTIN_PRODUCTS.forEach(function (bp, bi) {
      const seeded = normalize(bp, bi);
      seeded.source = 'builtin';
      items.push(seeded);
    });
  }

  if (action === 'seed') {
    const existing = {};
    items.forEach(function (it) { existing[it.id] = true; });
    BUILTIN_PRODUCTS.forEach(function (p, i) {
      if (existing[p.id]) return;
      const n = normalize(p, i);
      n.source = 'builtin';
      items.push(n);
    });
  } else if (action === 'reset') {
    items = [];
  } else if (action === 'upsert') {
    const n = normalize(body.item, items.length);
    n.updatedAt = Date.now();
    if (!body.item || !str(body.item.id, 64)) n.id = genId('product');
    n.source = str((body.item || {}).source, 16) || 'admin';
    let hit = -1;
    for (let i = 0; i < items.length; i++) { if (items[i].id === n.id) { hit = i; break; } }
    if (hit >= 0) items[hit] = n; else items.push(n);
  } else if (action === 'delete') {
    const id = str(body.id, 64);
    if (!id) return fail('缺少 id', 400, request);
    items = items.filter(function (x) { return x.id !== id; });
  } else if (action === 'toggle') {
    const id = str(body.id, 64);
    if (!id) return fail('缺少 id', 400, request);
    let hit = -1;
    for (let i = 0; i < items.length; i++) { if (items[i].id === id) { hit = i; break; } }
    if (hit < 0) return fail('商品不存在', 404, request);
    items[hit].enabled = bool(body.enabled, !items[hit].enabled);
    items[hit].updatedAt = Date.now();
  } else if (action === 'reorder') {
    const ids = Array.isArray(body.ids) ? body.ids.map(function (v) { return str(v, 64); }) : [];
    if (!ids.length) return fail('缺少 ids', 400, request);
    const map = {};
    items.forEach(function (it) { map[it.id] = it; });
    const ordered = [];
    ids.forEach(function (id, i) {
      const it = map[id];
      if (!it) return;
      it.order = (i + 1) * 10;
      it.updatedAt = Date.now();
      ordered.push(it);
      delete map[id];
    });
    Object.keys(map).forEach(function (id) {
      const it = map[id];
      it.order = (ordered.length + 1) * 10;
      ordered.push(it);
    });
    items = ordered;
  } else if (Array.isArray(body.items)) {
    items = normalizeList(body.items);
  } else {
    return fail('缺少 items 或 action', 400, request);
  }

  items = normalizeList(items);
  if (action === 'reset') {
    await env.NEWS_KV.delete(KV_KEY);
    return json({ ok: true, items: BUILTIN_PRODUCTS.map(function (p, i) { return normalize(p, i); }), count: BUILTIN_PRODUCTS.length, source: 'builtin' }, 200, request, NO_STORE);
  }
  await kvPut(env, items);
  return json({ ok: true, items: items, count: items.length, source: 'kv' }, 200, request, NO_STORE);
}
