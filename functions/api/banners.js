/**
 * /api/banners —— 后台「横幅管理」接口（横幅分类，共 4 项内置登记）
 *
 * 数据：KV 绑定 NEWS_KV，键 site:banners:v1；主站 /api/banners 读同一份数据。
 * 内置登记依据主站首开实测（2026-11-27 三次清空站点数据首访取证）：
 *   1 #gcMhBar       AI 模型提示条        页面最顶端横贯全宽
 *   2 #gcLaunchBanner 新上架 A320 推广条   顶部第 2 行
 *   3 #updateBanner  一封信更新条          主视觉下方
 *   4 #heroBanner    首屏主视觉轮播        首屏正中
 *
 * GET  /api/banners        公开只读：仅 enabled 条目（主站渲染用）
 * GET  /api/banners?all=1  需管理员：全部条目（KV 为空时回退内置登记清单）
 * POST /api/banners        需管理员：
 *   { action:'upsert', item:{...} }              新增 / 按 id 更新
 *   { action:'delete', id }                      删除（删除后主站立即不展示）
 *   { action:'toggle', id, enabled }             启用 / 停用
 *   { action:'order',  id, order }               仅改优先级序号
 *   { action:'reorder', ids:[...] }              按给定顺序整体重排
 *   { items:[...] }                              整表覆盖
 *
 * 字段：id / key(前端元素标记) / name(管理名) / title / sub / href / image / defaultImage /
 *       useDefaultImage / position(hero|top|launch|bottom，主站兼容) / form(strip|card|chip，主站兼容) /
 *       slot(投放位置) / freq(显示次数) / enabled / order(优先级) / closable / source / note / updatedAt
 *
 * 响应统一 Cache-Control: no-store（含 CDN-Cache-Control / Pragma），保证后台改动后主站拉取到最新状态。
 */

import { isAdmin, json, fail, preflight, readBody, str, genId } from './_lib/admutils.js';
import { remoteItems } from './_lib/remote.js';

const KV_KEY = 'site:banners:v1';
const MAX_ITEMS = 60;
const POSITIONS = ['hero', 'top', 'launch', 'bottom'];
const FORMS = ['strip', 'card', 'chip'];
const SLOTS = ['page-top', 'top-second-row', 'below-hero', 'hero-center', 'top-bar', 'side-bar', 'footer-top', 'custom'];
const FREQS = ['once-open', 'once-session', 'once-day', 'always'];

export const DEFAULT_IMAGE = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='200'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%230ea5e9'/%3E%3Cstop offset='1' stop-color='%230f766e'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='640' height='200' fill='url(%23g)'/%3E%3Ctext x='320' y='112' font-size='28' fill='%23ffffff' font-family='sans-serif' text-anchor='middle'%3E%E6%B0%91%E8%88%AA%E5%AE%A2%E6%9C%BA%E6%94%B6%E8%97%8F%E9%A6%86%3C/text%3E%3C/svg%3E";

/** 内置登记：主站首开实测的全部 4 项横幅 */
export const BUILTIN_BANNERS = [
  {
    id: 'builtin-gcmhbar',
    key: 'gcMhBar',
    name: 'AI 模型提示条',
    title: 'AI 模型提示 · 当前仅 kimi-k2.6 可用',
    sub: 'kimi-k3 / kimi-k3.1-pro 暂不可用，含时间戳与「收起提示」',
    href: '',
    position: 'top',
    form: 'strip',
    slot: 'page-top',
    freq: 'once-open',
    enabled: true,
    order: 10,
    closable: true,
    image: '',
    useDefaultImage: true,
    note: '系统注入条，每次首开由脚本生成，关闭仅本会话生效',
    source: 'builtin'
  },
  {
    id: 'builtin-gclaunchbanner',
    key: 'gcLaunchBanner',
    name: '新上架 A320 推广条',
    title: 'NEW 新上架 · 空客 A320 系列综合研究报告',
    sub: '约 3.5 万字，¥5 一次购买长期可读',
    href: '/pay/a320.html',
    position: 'launch',
    form: 'strip',
    slot: 'top-second-row',
    freq: 'once-open',
    enabled: true,
    order: 20,
    closable: true,
    image: '',
    useDefaultImage: true,
    note: '关闭后写 localStorage，清理站点数据后复现',
    source: 'builtin'
  },
  {
    id: 'builtin-updatebanner',
    key: 'updateBanner',
    name: '一封信更新条',
    title: '一封信 & AI 机型故事上线',
    sub: '点顶栏信封读作者告别信（2026.8.27）',
    href: '',
    position: 'top',
    form: 'strip',
    slot: 'below-hero',
    freq: 'once-open',
    enabled: true,
    order: 30,
    closable: true,
    image: '',
    useDefaultImage: true,
    note: '关闭后写 localStorage，清理站点数据后复现',
    source: 'builtin'
  },
  {
    id: 'builtin-herobanner',
    key: 'heroBanner',
    name: '首屏主视觉轮播',
    title: '主视觉轮播横幅',
    sub: '波音 747-8 / 空客 A330-300 等 4 帧，1240×400',
    href: '',
    position: 'hero',
    form: 'card',
    slot: 'hero-center',
    freq: 'always',
    enabled: true,
    order: 40,
    closable: false,
    image: '',
    useDefaultImage: true,
    note: '首屏主视觉，不可关闭，含 4 帧轮播图',
    source: 'builtin'
  }
];

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
  const s = str(v, 2000);
  if (!s) return '';
  if (/^\//.test(s)) return s;
  if (/^https:\/\//i.test(s)) return s;
  if (/^data:image\//i.test(s)) return s;
  return '';
}

function pick(v, allowed, dflt) {
  const s = str(v, 32);
  return allowed.indexOf(s) >= 0 ? s : dflt;
}

function normId(v, idx) {
  const s = str(v, 64).replace(/[^a-zA-Z0-9_\-:.]/g, '');
  return s || ('b' + Date.now().toString(36) + '-' + idx);
}

function normalize(raw, idx) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const orderNum = Number(r.order);
  const image = safeImage(r.image);
  const useDefault = bool(r.useDefaultImage, true);
  return {
    id: normId(r.id, idx),
    key: str(r.key, 64),
    name: str(r.name, 60),
    title: str(r.title, 120),
    sub: str(r.sub, 300),
    href: safeHref(r.href),
    image: image,
    defaultImage: safeImage(r.defaultImage) || DEFAULT_IMAGE,
    useDefaultImage: useDefault,
    position: pick(r.position, POSITIONS, 'top'),
    form: pick(r.form, FORMS, 'strip'),
    slot: pick(r.slot, SLOTS, 'page-top'),
    freq: pick(r.freq, FREQS, 'once-open'),
    enabled: bool(r.enabled, true),
    order: Number.isFinite(orderNum) ? Math.round(orderNum) : 100,
    closable: bool(r.closable, true),
    note: str(r.note, 300),
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

function builtinList() {
  return normalizeList(BUILTIN_BANNERS.map(function (b, i) { return normalize(b, i); }));
}

const BUILTIN_ID_SET = (function () {
  const m = {};
  BUILTIN_BANNERS.forEach(function (b) { if (b && b.id) m[b.id] = true; });
  return m;
})();

// 把内置登记清单并入 KV 条目：既不在 KV 也不在墓碑列表中的内置项自动补齐
function mergeBuiltin(items, deleted) {
  const list = Array.isArray(items) ? items.slice() : [];
  const seen = {};
  list.forEach(function (it) { if (it && it.id) seen[it.id] = true; });
  (Array.isArray(deleted) ? deleted : []).forEach(function (id) { seen[String(id)] = true; });
  builtinList().forEach(function (b) { if (!seen[b.id]) list.push(b); });
  return normalizeList(list);
}

async function kvGet(env) {
  if (!env || !env.NEWS_KV) return { available: false, items: null, deleted: [] };
  try {
    const raw = await env.NEWS_KV.get(KV_KEY);
    if (!raw) return { available: true, items: null, deleted: [] };
    const parsed = JSON.parse(raw);
    const version = (parsed && !Array.isArray(parsed) && Number(parsed.v)) || 1;
    let items = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items) ? parsed.items : null);
    // v1 旧数据条目与当前内置登记清单不是同一套 id：丢弃后交由 mergeBuiltin 以新清单补齐
    if (version < 2 && items) {
      items = items.filter(function (it) { return !!it && !!BUILTIN_ID_SET[String(it.id)]; });
    }
    const deleted = (parsed && !Array.isArray(parsed) && Array.isArray(parsed.deleted) ? parsed.deleted : [])
      .map(function (x) { return String(x); });
    return { available: true, items: items && items.length ? normalizeList(items) : null, deleted: deleted };
  } catch (e) {
    return { available: true, items: null, deleted: [], error: String((e && e.message) || e) };
  }
}

async function kvPut(env, items, deleted) {
  await env.NEWS_KV.put(
    KV_KEY,
    JSON.stringify({ v: 2, updatedAt: Date.now(), items: items, deleted: Array.isArray(deleted) ? deleted : [] }),
    { expirationTtl: 60 * 60 * 24 * 365 * 3 }
  );
}

/** 统一出口：强制无缓存，保证启停/删除后主站立即拿到最新状态 */
function out(data, status, request) {
  return json(data, status, request, {
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'CDN-Cache-Control': 'no-store',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
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
  const _baseOf = function (store, hasKv) { return mergeBuiltin(store.items || [], store.deleted); };

  let base = _baseOf(store, hasKv);
  let remoteUsed = false;
  if (!hasKv) {
    const remote = await remoteItems(env, 'banners');
    if (remote) { base = remote.map(function (x, i) { return normalize(x, i); }); remoteUsed = true; }
  }
  const srcLabel = remoteUsed ? 'remote' : (hasKv ? 'kv' : 'builtin');

  if (wantAll) {
    if (!(await isAdmin(request, env))) return fail('未授权：请先登录后台', 401, request);
    return out({
      ok: true,
      kind: 'banner',
      items: base,
      count: base.length,
      source: srcLabel,
      kvAvailable: store.available
    }, 200, request);
  }

  const items = base.filter(function (b) { return b.enabled; });
  return out({
    ok: true,
    kind: 'banner',
    items: items,
    count: items.length,
    source: srcLabel,
    kvAvailable: store.available
  }, 200, request);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const pf = preflight(request);
  if (pf) return pf;
  if (!(await isAdmin(request, env))) return fail('未授权：请先登录后台', 401, request);
  if (!env || !env.NEWS_KV) return fail('服务端未绑定 NEWS_KV，无法保存横幅', 503, request);

  const body = await readBody(request);
  const store = await kvGet(env);
  // KV 为空时以内置登记清单为基线：管理员可直接启停/删除内置条目，无需先「导入」
  let items = mergeBuiltin(store.items || [], store.deleted);
  let deleted = (store.deleted || []).slice();
  const action = str(body.action, 16);

  if (action === 'reset') {
    await env.NEWS_KV.delete(KV_KEY);
    const base = builtinList();
    return out({ ok: true, kind: 'banner', items: base, count: base.length, source: 'builtin' }, 200, request);
  }

  if (action === 'upsert') {
    const src = body.item && typeof body.item === 'object' ? body.item : {};
    const n = normalize(src, items.length);
    n.updatedAt = Date.now();
    if (!str(src.id, 64)) n.id = genId('banner');
    n.source = str(src.source, 16) || 'admin';
    deleted = deleted.filter(function (x) { return x !== n.id; });
    let hit = -1;
    for (let i = 0; i < items.length; i++) { if (items[i].id === n.id) { hit = i; break; } }
    if (hit >= 0) items[hit] = n; else items.push(n);
  } else if (action === 'delete') {
    const id = str(body.id, 64);
    if (!id) return fail('缺少 id', 400, request);
    const hitList = items.filter(function (x) { return x.id === id || x.key === id; });
    if (!hitList.length && !BUILTIN_ID_SET[id]) return fail('横幅不存在', 404, request);
    hitList.forEach(function (x) { if (BUILTIN_ID_SET[x.id] && deleted.indexOf(x.id) < 0) deleted.push(x.id); });
    items = items.filter(function (x) { return x.id !== id && x.key !== id; });
  } else if (action === 'toggle') {
    const id = str(body.id, 64);
    if (!id) return fail('缺少 id', 400, request);
    let hit = -1;
    for (let i = 0; i < items.length; i++) {
      if (items[i].id === id || items[i].key === id) { hit = i; break; }
    }
    if (hit < 0) return fail('横幅不存在', 404, request);
    items[hit].enabled = bool(body.enabled, !items[hit].enabled);
    items[hit].updatedAt = Date.now();
  } else if (action === 'order') {
    const id = str(body.id, 64);
    const orderNum = Number(body.order);
    if (!id) return fail('缺少 id', 400, request);
    if (!Number.isFinite(orderNum)) return fail('order 必须为数字', 400, request);
    let hit = -1;
    for (let i = 0; i < items.length; i++) {
      if (items[i].id === id || items[i].key === id) { hit = i; break; }
    }
    if (hit < 0) return fail('横幅不存在', 404, request);
    items[hit].order = Math.round(orderNum);
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
  await kvPut(env, items, deleted);
  return out({ ok: true, kind: 'banner', items: items, count: items.length, source: 'kv' }, 200, request);
}
