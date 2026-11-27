/**
 * /api/ads —— 广告位统一数据源（后台可读写，前端按位置/形式渲染）
 *
 * GET  /api/ads
 *   → { ok, items:[ {id,title,sub,href,image,position,form,enabled,order,source,badge} ], count, source }
 *   默认只返回 enabled；KV 为空时返回内置兜底（source=builtin）。
 *   ?position=top|side|bottom|float  仅取指定位置（可逗号分隔多个）
 *   ?all=1  需要管理员令牌，返回全部条目（含停用）
 *
 * POST /api/ads       需要管理员令牌
 *   { items:[...] } 整表覆盖
 *   { action:'upsert'|'delete'|'toggle', item|id|enabled }
 *
 * 位置 position：top（页面顶部横排）/ side（侧栏）/ bottom（页脚上方）/ float（悬浮）
 * 形式 form：button（按钮横排）/ card（图文卡片）/ text（纯文字链接）/ image（图片横幅）
 *
 * 存储：KV 绑定 NEWS_KV，键 site:ads:v1
 */

import { ok, fail, jsonResponse, checkAdminToken } from './_lib/http.js';

const KV_KEY = 'site:ads:v1';
const MAX_ITEMS = 80;
const POSITIONS = ['top', 'side', 'bottom', 'float'];
const FORMS = ['button', 'card', 'text', 'image'];

export const BUILTIN_ADS = [
  {
    id: 'builtin-ads-read-737',
    title: '737 研读 ¥5',
    sub: '波音 737 系列综合研究报告',
    href: '/pay/737.html',
    image: '',
    position: 'top',
    form: 'button',
    badge: '¥5',
    enabled: true,
    order: 10,
    source: 'builtin'
  },
  {
    id: 'builtin-ads-read-a320',
    title: 'A320 研读 ¥5',
    sub: '空客 A320 系列综合研究报告',
    href: '/pay/a320.html',
    image: '',
    position: 'top',
    form: 'button',
    badge: '新上架',
    enabled: true,
    order: 20,
    source: 'builtin'
  },
  {
    id: 'builtin-ads-collection',
    title: '机型图鉴',
    sub: '按航司、代际浏览全部收录机型',
    href: '/aviation-collection.html',
    image: '',
    position: 'top',
    form: 'button',
    badge: '',
    enabled: true,
    order: 30,
    source: 'builtin'
  }
];

function str(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max || 200);
}

function bool(v, dflt) {
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  return dflt;
}

function safeHref(v) {
  const s = str(v, 500);
  if (!s) return '';
  if (/^\//.test(s)) return s;
  if (/^https:\/\//i.test(s)) return s;
  return '';
}

function safeImage(v) {
  const s = str(v, 500);
  if (!s) return '';
  if (/^\//.test(s)) return s;
  if (/^https:\/\//i.test(s)) return s;
  return '';
}

function normId(v, idx) {
  const s = str(v, 64).replace(/[^a-zA-Z0-9_\-:.]/g, '');
  return s || 'ad' + Date.now().toString(36) + '-' + idx;
}

function normalize(raw, idx) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const position = POSITIONS.includes(str(r.position, 16)) ? str(r.position, 16) : 'top';
  const form = FORMS.includes(str(r.form, 16)) ? str(r.form, 16) : 'button';
  const orderNum = Number(r.order);
  return {
    id: normId(r.id, idx),
    title: str(r.title, 120),
    sub: str(r.sub, 300),
    href: safeHref(r.href),
    image: safeImage(r.image),
    position,
    form,
    badge: str(r.badge, 24),
    enabled: bool(r.enabled, true),
    order: Number.isFinite(orderNum) ? Math.round(orderNum) : 100,
    source: str(r.source, 16) || 'admin',
    updatedAt: Number(r.updatedAt) || 0
  };
}

function normalizeList(list) {
  const arr = Array.isArray(list) ? list.slice(0, MAX_ITEMS) : [];
  const seen = new Set();
  const out = [];
  arr.forEach((it, i) => {
    const n = normalize(it, i);
    if (seen.has(n.id)) n.id = n.id + '-' + i;
    seen.add(n.id);
    out.push(n);
  });
  return out.sort((a, b) => (a.order - b.order) || String(a.id).localeCompare(String(b.id)));
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
    return { available: true, items: null, error: String(e && e.message || e) };
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const wantAll = url.searchParams.get('all') === '1';
  const posFilter = str(url.searchParams.get('position'), 60)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => POSITIONS.includes(s));

  const store = await kvGet(env);
  const usedKv = !!(store.items && store.items.length);
  const base = usedKv
    ? store.items.map((b, i) => normalize(b, i))
    : BUILTIN_ADS.map((b, i) => normalize(b, i));

  if (wantAll) {
    const auth = checkAdminToken(request, env);
    if (!auth.ok) return fail('UNAUTHORIZED', '需要管理员令牌', 401);
    return jsonResponse({
      ok: true,
      items: base,
      count: base.length,
      source: usedKv ? 'kv' : 'builtin',
      kvAvailable: store.available
    });
  }

  let items = base.filter((b) => b.enabled);
  if (posFilter.length) items = items.filter((b) => posFilter.includes(b.position));

  return jsonResponse(
    {
      ok: true,
      items,
      count: items.length,
      source: usedKv ? 'kv' : 'builtin',
      kvAvailable: store.available
    },
    200,
    { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=120' }
  );
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = checkAdminToken(request, env);
  if (!auth.ok) {
    return fail(auth.configured ? 'UNAUTHORIZED' : 'NOT_CONFIGURED', auth.configured ? '需要管理员令牌' : '未配置 ADMIN_TOKEN', auth.configured ? 401 : 503);
  }
  if (!env || !env.NEWS_KV) return fail('KV_UNAVAILABLE', '服务端未绑定 NEWS_KV', 503);

  let body = null;
  try {
    body = await request.json();
  } catch (e) {
    return fail('BAD_JSON', '请求体不是合法 JSON', 400);
  }

  const store = await kvGet(env);
  let items = store.items || [];
  const action = str(body && body.action, 16);

  if (action === 'upsert') {
    const n = normalize(body.item, items.length);
    n.updatedAt = Date.now();
    const idx = items.findIndex((x) => x.id === n.id);
    if (idx >= 0) items[idx] = n; else items.push(n);
  } else if (action === 'delete') {
    const id = str(body.id, 64);
    if (!id) return fail('BAD_REQUEST', '缺少 id', 400);
    items = items.filter((x) => x.id !== id);
  } else if (action === 'toggle') {
    const id = str(body.id, 64);
    if (!id) return fail('BAD_REQUEST', '缺少 id', 400);
    const idx = items.findIndex((x) => x.id === id);
    if (idx < 0) return fail('NOT_FOUND', '广告不存在', 404);
    items[idx].enabled = bool(body.enabled, !items[idx].enabled);
    items[idx].updatedAt = Date.now();
  } else if (Array.isArray(body && body.items)) {
    items = normalizeList(body.items);
  } else {
    return fail('BAD_REQUEST', '缺少 items 或 action', 400);
  }

  items = normalizeList(items);
  await env.NEWS_KV.put(
    KV_KEY,
    JSON.stringify({ v: 1, updatedAt: Date.now(), items }),
    { expirationTtl: 60 * 60 * 24 * 365 * 3 }
  );
  return ok({ items, count: items.length, source: 'kv' });
}
