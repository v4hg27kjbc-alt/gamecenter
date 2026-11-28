/**
 * /api/project-doc —— 付费文档阅读（券码鉴权 + 唯一追踪码水印）
 *
 * POST { code, project }  → { ok, project, title, traceCode, markdown, issuedAt }
 * 规则：
 *   1. 券码不存在 / 已作废 → 拒绝
 *   2. 券码绑定了项目且不含请求项目 → coupon_project_mismatch（沿用主站券码规则）
 *   3. 通过后返回正文，并在正文头部插入唯一追踪码（=券码本身），用于追溯泄露来源
 */
import { normProjectKeys, couponAllowsProject, PROJECTS, projectTitle } from './_lib/data/projects.js';
import { productGate, PRODUCT_OFFLINE_MESSAGE } from './_lib/product-gate.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Visitor-Id'
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, CORS)
  });
}
const ok = (d) => json(Object.assign({ ok: true }, d));
const bad = (code, message, extra) => json(Object.assign({ ok: false, code, message }, extra || {}), 400);
const deny = (code, message, extra) => json(Object.assign({ ok: false, code, message }, extra || {}), 403);

function kvOf(env) {
  const kv = env && env.SMS_KV;
  if (kv && typeof kv.get === 'function') return kv;
  const alt = env && env.NEWS_KV;
  return (alt && typeof alt.get === 'function') ? alt : null;
}
function normCode(v) {
  return String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  const kv = kvOf(env);
  if (!kv) return bad('kv_missing', '存储未配置');
  let body = {};
  try { body = await request.json(); } catch (e) { }
  let code = normCode(body.code);
  let reqProject = (normProjectKeys([body.project || 'b737'])[0]) || 'b737';

  // 商品下架守卫（v5.5）：后台停用该商品后，阅读与下载一律拦截
  {
    const gate = await productGate(env, reqProject);
    if (gate.offline) return bad('product_offline', PRODUCT_OFFLINE_MESSAGE);
  }

  // 订单模式：兑换码只展示一次，事后可凭订单号取回阅读权限
  const orderId = String(body.order || '').trim();
  if (orderId && code.length < 6) {
    const o = await kv.get('order:item:' + orderId, { type: 'json' });
    if (!o) return bad('order_not_found', '订单不存在，请核对订单号');
    if (o.status !== 'confirmed') return bad('order_pending', '订单尚未完成核对，请稍后再试');
    const cc = normCode(o.couponCode);
    if (!cc) return bad('no_coupon', '订单尚未发券，请联系站长');
    code = cc;
    reqProject = (normProjectKeys([o.project || reqProject])[0]) || reqProject;
  }

  if (code.length < 6) return bad('coupon_invalid', '请输入完整的券码');

  const rec = await kv.get('coupon:code:' + code, { type: 'json' });
  if (!rec) return bad('coupon_not_found', '券码不存在，请核对后重试');
  if (String(rec.status || '') === 'revoked') return bad('coupon_revoked', '该券码已作废，请联系站长');
  if (rec.exp) {
    const t = Date.parse(rec.exp);
    if (Number.isFinite(t) && t < Date.now()) return bad('coupon_expired', '该券码已过期');
  }
  if (!couponAllowsProject(rec, reqProject)) {
    const pk = Array.isArray(rec.projectKeys) ? rec.projectKeys.filter(Boolean) : [];
    const why = pk.length
      ? '该券码仅可用于 ' + pk.map(projectTitle).join('、') + '，当前文档不在授权范围内'
      : '该券码未关联任何项目，请联系站长补关联后使用';
    return deny('coupon_project_mismatch', '券码当前无权限：' + why, { projectKeys: pk });
  }

  const hit = PROJECTS.filter((p) => p.key === reqProject)[0];
  if (!hit) return bad('bad_project', '项目不存在');

  let markdown = '';
  try {
    const u = new URL(hit.file, request.url);
    const res = await env.ASSETS.fetch(u);
    if (res.ok) markdown = await res.text();
  } catch (e) { }
  if (!markdown) return bad('doc_missing', '文档暂不可用，请稍后重试或联系站长');

  const display = String(rec.couponCode || code);
  const trace = [
    '> **本份文档为付费授权副本**',
    '> 追踪码：`' + display + '`　授权项目：' + projectTitle(reqProject),
    '> 仅供购买者本人阅读，禁止转载、转售、公开分享。文档内嵌追踪码，泄露可溯源至该授权码。',
    ''
  ].join('\n');

  return ok({
    project: reqProject,
    title: hit.title,
    traceCode: display,
    issuedAt: rec.createdAt || '',
    markdown: trace + '\n' + markdown
  });
}

/**
 * v3.5 GET 模式：直接下载 / 阅读
 *   /api/project-doc?project=c919&download=1              免费项目，直接给文件
 *   /api/project-doc?project=b737&download=1&code=GCXXXX   付费项目，凭券下载
 *   /api/project-doc?project=b737&download=1&order=GC-...  付费项目，凭订单号下载
 *   &inline=1  → 返回 text/markdown 供阅读页渲染；默认 attachment 触发浏览器下载
 */
export async function onRequestGet({ request, env }) {
  const kv = kvOf(env);
  const u = new URL(request.url);
  const projectKey = (normProjectKeys([u.searchParams.get('project') || 'c919'])[0]) || 'c919';
  const inline = u.searchParams.get('inline') === '1';
  const dl = u.searchParams.get('download') !== '0';

  const hit = PROJECTS.filter((p) => p.key === projectKey)[0];
  if (!hit) return json({ ok: false, code: 'bad_project', message: '项目不存在' }, 400);

  // 商品下架守卫（v5.5）
  {
    const gate = await productGate(env, projectKey);
    if (gate.offline) return json({ ok: false, code: 'product_offline', message: PRODUCT_OFFLINE_MESSAGE }, 409);
  }

  let markdown = '';
  try {
    const res = await env.ASSETS.fetch(new URL(hit.file, request.url));
    if (res.ok) markdown = await res.text();
  } catch (e) { }
  if (!markdown) return json({ ok: false, code: 'doc_missing', message: '文档暂不可用，请稍后重试或联系站长' }, 404);

  // v3.5.1：阅读页通过 GET 拉正文，需要结构化 JSON（原实现只回 markdown 原文，导致「文档加载失败」）
  const accept = String(request.headers.get('Accept') || '');
  const wantJson = u.searchParams.get('json') === '1' || accept.indexOf('application/json') >= 0;

  // 免费项目：无需任何鉴权
  if (hit.free) {
    const head = [
      '<!-- ' + hit.title + ' -->',
      '> 本份文档为**免费公开版本**（' + (hit.badge || '免费') + '），可自由查看与下载。',
      ''
    ].join('\n');
    const body = head + markdown;
    if (wantJson) {
      return json({ ok: true, free: true, project: projectKey, title: hit.title, badge: hit.badge || '', markdown: body }, 200);
    }
    if (inline) {
      return new Response(body, {
        status: 200,
        headers: Object.assign({ 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'public, max-age=300' }, CORS)
      });
    }
    const fn = 'C919-CAAC-REPORT.md';
    return new Response(body, {
      status: 200,
      headers: Object.assign({
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': (dl ? 'attachment' : 'inline') + '; filename="' + fn + '"; filename*=UTF-8\'\'' + encodeURIComponent('C919综合研究报告.md'),
        'Cache-Control': 'public, max-age=300'
      }, CORS)
    });
  }

  // 付费项目：凭券码或订单号
  if (!kv) return json({ ok: false, code: 'kv_missing', message: '存储未配置' }, 503);
  let code = normCode(u.searchParams.get('code'));
  const orderId = String(u.searchParams.get('order') || '').trim();
  if (orderId && code.length < 6) {
    const o = await kv.get('order:item:' + orderId, { type: 'json' });
    if (!o) return json({ ok: false, code: 'order_not_found', message: '订单不存在' }, 404);
    if (o.status !== 'confirmed') return json({ ok: false, code: 'order_pending', message: '订单尚未完成核对' }, 403);
    code = normCode(o.couponCode);
  }
  if (code.length < 6) return json({ ok: false, code: 'coupon_required', message: '需要券码或已完成订单' }, 401);
  const rec = await kv.get('coupon:code:' + code, { type: 'json' });
  if (!rec) return json({ ok: false, code: 'coupon_not_found', message: '券码不存在' }, 404);
  if (String(rec.status || '') === 'revoked') return json({ ok: false, code: 'coupon_revoked', message: '该券码已作废' }, 403);
  if (!couponAllowsProject(rec, projectKey)) return json({ ok: false, code: 'coupon_project_mismatch', message: '券码当前无权限' }, 403);

  const trace = [
    '> **本份文档为付费授权副本**',
    '> 追踪码：`' + String(rec.couponCode || code) + '`　授权项目：' + projectTitle(projectKey),
    '> 仅供购买者本人阅读，禁止转载、转售、公开分享。',
    ''
  ].join('\n');
  const out = trace + '\n' + markdown;
  if (wantJson) {
    return json({ ok: true, project: projectKey, title: projectTitle(projectKey), traceCode: String(rec.couponCode || code), markdown: out }, 200);
  }
  const fn2 = projectKey.toUpperCase() + '-REPORT.md';
  return new Response(out, {
    status: 200,
    headers: Object.assign({
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': (dl ? 'attachment' : 'inline') + '; filename="' + fn2 + '"'
    }, CORS)
  });
}
