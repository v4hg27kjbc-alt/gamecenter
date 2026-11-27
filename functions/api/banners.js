/**
 * /api/banners —— 全站横幅统一数据源（后台可读写，前端渲染 + 内置兜底）
 *
 * GET  /api/banners
 *   → { ok, items: [ {id,title,sub,href,position,enabled,source,order,closable,dismissKey} ], count, source }
 *   说明：GET 默认只返回 enabled 的条目；若 KV 为空（或未绑定），
 *       返回内置兜底横幅（source=builtin），保证线上永不空窗。
 *   ?all=1  需要管理员令牌，返回全部条目（含停用），供后台编辑使用。
 *
 * POST /api/banners        需要管理员令牌（X-Admin-Token 或 Authorization: Bearer）
 *   body 支持三种写法：
 *   1) { items:[...] }                      → 整表覆盖
 *   2) { action:'upsert', item:{...} }      → 按 id 新增/更新单条
 *   3) { action:'delete', id:'xxx' }        → 删除单条
 *   4) { action:'toggle', id:'xxx', enabled:false } → 启用/停用单条
 *
 * 字段（全部可选，缺省走规范化默认值）：
 *   id        唯一标识，缺省自动生成
 *   title     横幅主标题
 *   sub       副文案
 *   href      跳转链接（站内相对路径或 https 绝对地址）
 *   position  展示位置：hero（首页顶部主横幅）/ top（顶部通知条）/ launch（新上架条）/ bottom（底部常驻）
 *   form      展示形式：strip（细条）/ card（卡片）/ chip（胶囊按钮）
 *   enabled   是否启用，默认 true
 *   order     排序权重，越小越靠前，默认 100
 *   closable  是否可关闭，默认 true
 *   source    来源标记：builtin（内置兜底）/ admin（后台配置）
 *
 * 存储：KV 绑定 NEWS_KV（与站内其它配置共用），键 site:banners:v1
 */

import { ok, fail, jsonResponse, checkAdminToken } from './_lib/http.js';

const KV_KEY = 'site:banners:v1';
const MAX_ITEMS = 60;
const POSITIONS = ['hero', 'top', 'launch', 'bottom'];
const FORMS = ['strip', 'card', 'chip'];

/** 内置兜底横幅：KV 未配置时前端据此渲染，保证与历史行为一致 */
export const BUILTIN_BANNERS = [
  {
    id: 'builtin-launch-a320',
    title: '新上架 · 空客 A320 系列综合研究报告',
    sub: '约 3.5 万字，¥5 一次购买长期可读，含唯一追踪码',
    href: '/pay/a320.html',
    position: 'launch',
    form: 'strip',
    enabled: true,
    order: 10,
    closable: true,
    source: 'builtin'
  },
  {
    id: 'builtin-update-20260827',
    title: '一封信 & AI 机型故事上线',
    sub: '点顶栏信封读作者告别信，详情页可听 AI 拟人故事；作者最后一次更新，我们寒假再见（2026.8.27）',
    href: '',
    position: 'top',
    form: 'strip',
    enabled: true,
    order: 20,
    closable: true,
    source: 'builtin'
  },
  {
    id: 'builtin-activity-737',
    title: '限时 ¥5 · 深度研读解锁',
    sub: '737 / A320 研读报告同价 ¥5，爱发电支付后券码长期可读',
    href: '/activity.html',
    position: 'bottom',
    form: 'chip',
    enabled: true,
    order: 30,
    closable: true,
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

function normId(v, idx) {
  const s = str(v, 64).replace(/[^a-zA-Z0-9_\-:.]/g, '');
  return s || 'b' + Date.now().toString(36) + '-' + idx;
}

function normalize(raw, idx) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const position = POSITIONS.includes(str(r.position, 16)) ? str(r.position, 16) : 'top';
  const form = FORMS.includes(str(r.form, 16)) ? str(r.form, 16) : 'strip';
  const orderNum = Number(r.order);
  return {
    id: normId(r.id, idx),
    title: str(r.title, 120),
    sub: str(r.sub, 300),
    href: safeHref(r.href),
    position,
    form,
    enabled: bool(r.enabled, true),
    order: Number.isFinite(orderNum) ? Math.round(orderNum) : 100,
    closable: bool(r.closable, true),
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

async function kvPut(env, items) {
  await env.NEWS_KV.put(
    KV_KEY,
    JSON.stringify({ v: 1, updatedAt: Date.now(), items }),
    { expirationTtl: 60 * 60 * 24 * 365 * 3 }
  );
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const wantAll = url.searchParams.get('all') === '1';

  const store = await kvGet(env);

  if (wantAll) {
    const auth = checkAdminToken(request, env);
    if (!auth.ok) return fail('UNAUTHORIZED', '需要管理员令牌', 401);
    const items = store.items && store.items.length ? store.items : BUILTIN_BANNERS.map((b, i) => normalize(b, i));
    return jsonResponse({
      ok: true,
      items,
      count: items.length,
      source: store.items && store.items.length ? 'kv' : 'builtin',
      kvAvailable: store.available
    });
  }

  const base = store.items && store.items.length
    ? store.items.map((b, i) => normalize(b, i))
    : BUILTIN_BANNERS.map((b, i) => normalize(b, i));

  const items = base.filter((b) => b.enabled);
  return jsonResponse(
    {
      ok: true,
      items,
      count: items.length,
      source: store.items && store.items.length ? 'kv' : 'builtin',
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
    const idx = items.findIndex((x) => x.id === n.id);
    n.updatedAt = Date.now();
    if (idx >= 0) items[idx] = n; else items.push(n);
  } else if (action === 'delete') {
    const id = str(body.id, 64);
    if (!id) return fail('BAD_REQUEST', '缺少 id', 400);
    items = items.filter((x) => x.id !== id);
  } else if (action === 'toggle') {
    const id = str(body.id, 64);
    if (!id) return fail('BAD_REQUEST', '缺少 id', 400);
    const idx = items.findIndex((x) => x.id === id);
    if (idx < 0) return fail('NOT_FOUND', '横幅不存在', 404);
    items[idx].enabled = bool(body.enabled, !items[idx].enabled);
    items[idx].updatedAt = Date.now();
  } else if (Array.isArray(body && body.items)) {
    items = normalizeList(body.items);
  } else {
    return fail('BAD_REQUEST', '缺少 items 或 action', 400);
  }

  items = normalizeList(items);
  await kvPut(env, items);
  return ok({ items, count: items.length, source: 'kv' });
}


