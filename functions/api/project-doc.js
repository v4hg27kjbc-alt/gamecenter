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
    return bad('coupon_project_mismatch', '该券码仅可用于：' +
      (Array.isArray(rec.projectKeys) ? rec.projectKeys.map(projectTitle).join('、') : ''), { projectKeys: rec.projectKeys || [] });
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
