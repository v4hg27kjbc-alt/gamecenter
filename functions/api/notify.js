/**
 * /api/notify —— 站内通知中心 + 微信推送（v3.5）
 *
 * GET  ?action=list&scope=admin|user&contact=xxx   → 通知列表（含未读数）
 * POST { action:'push', scope, title, text, type, level, contact, orderId }
 *      → 写入通知队列，并在配置了微信通道时同步推送
 * POST { action:'read', id } / { action:'readall', scope, contact }
 * POST { action:'settings', ... }                  → 保存通知开关（KV: notify:settings:v1）
 * GET  ?action=channels                            → 返回当前已配置的微信通道状态
 *
 * 微信通道（无需额外依赖，任选其一配置即可）：
 *   WECHAT_WEBHOOK  企业微信群机器人 webhook 地址
 *   SERVERCHAN_KEY  Server酱 SendKey（推送到微信服务号）
 *   PUSHPLUS_TOKEN  PushPlus token
 * 未配置时通知仍会进站内通知中心，后台徽章照常亮起。
 */
import { contactKey } from './order.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Visitor-Id,X-Admin-Token'
};

const ADMIN_KEY = 'notify:admin:v1';
const SETTINGS_KEY = 'notify:settings:v1';
const MAX_ADMIN = 300;
const MAX_USER = 100;

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, CORS)
  });
}
const ok = (d) => json(Object.assign({ ok: true }, d));
const bad = (code, message, status) => json({ ok: false, code, message }, status || 400);

function kvOf(env) {
  const kv = env && env.SMS_KV;
  if (kv && typeof kv.get === 'function') return kv;
  const alt = env && env.NEWS_KV;
  return (alt && typeof alt.get === 'function') ? alt : null;
}

function isAdmin(request, env) {
  const tok = request.headers.get('X-Admin-Token') || '';
  const want = (env && env.ADMIN_TOKEN) || '';
  return !!want && tok === want;
}

const userKey = (contact) => 'notify:user:' + contactKey(contact || 'anon');

/* 默认全部开启 */
const DEFAULT_SETTINGS = {
  order: true, refund: true, coupon: true, register: true, chat: true,
  feedback: true, ai: true, admin: true, wechat: true, board: true
};

async function readSettings(kv) {
  const s = await kv.get(SETTINGS_KEY, { type: 'json' });
  return Object.assign({}, DEFAULT_SETTINGS, s && typeof s === 'object' ? s : {});
}

/* ── 微信推送通道 ── */
function channelStatus(env) {
  const e = env || {};
  return {
    wechatWebhook: !!(e.WECHAT_WEBHOOK && String(e.WECHAT_WEBHOOK).length > 10),
    serverchan: !!(e.SERVERCHAN_KEY && String(e.SERVERCHAN_KEY).length > 5),
    pushplus: !!(e.PUSHPLUS_TOKEN && String(e.PUSHPLUS_TOKEN).length > 5),
    any: !!(e.WECHAT_WEBHOOK || e.SERVERCHAN_KEY || e.PUSHPLUS_TOKEN)
  };
}

async function pushWechat(env, title, text) {
  const out = { tried: [], sent: false, error: '' };
  const e = env || {};
  try {
    if (e.WECHAT_WEBHOOK && String(e.WECHAT_WEBHOOK).indexOf('http') === 0) {
      out.tried.push('wechatWebhook');
      const r = await fetch(e.WECHAT_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'markdown',
          markdown: { content: '### ' + title + '\n' + text + '\n> ' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) }
        })
      });
      if (r.ok) out.sent = true; else out.error += 'wechat_' + r.status + ';';
    }
    if (!out.sent && e.SERVERCHAN_KEY && String(e.SERVERCHAN_KEY).length > 5) {
      out.tried.push('serverchan');
      const key = String(e.SERVERCHAN_KEY);
      const url = key.indexOf('sctp') === 0
        ? 'https://' + key.split('t')[1] + '.push.ft07.com/send/' + key + '.send'
        : 'https://sctapi.ftqq.com/' + key + '.send';
      const body = new URLSearchParams({ title: title, desp: text });
      const r = await fetch(url, { method: 'POST', body: body });
      if (r.ok) out.sent = true; else out.error += 'serverchan_' + r.status + ';';
    }
    if (!out.sent && e.PUSHPLUS_TOKEN && String(e.PUSHPLUS_TOKEN).length > 5) {
      out.tried.push('pushplus');
      const r = await fetch('https://www.pushplus.plus/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: e.PUSHPLUS_TOKEN, title: title, content: text, template: 'markdown' })
      });
      if (r.ok) out.sent = true; else out.error += 'pushplus_' + r.status + ';';
    }
  } catch (err) {
    out.error += 'exception:' + (err && err.message ? err.message : 'unknown');
  }
  if (!out.tried.length) out.error = 'no_channel_configured';
  return out;
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  const kv = kvOf(env);
  if (!kv) return bad('kv_missing', '存储未配置', 503);
  const u = new URL(request.url);
  const action = String(u.searchParams.get('action') || 'list').toLowerCase();

  if (action === 'channels') {
    const st = channelStatus(env);
    const s = await readSettings(kv);
    return ok({ channels: st, settings: s, hint: st.any ? '' : '尚未配置微信通道：在 Pages 项目环境变量中加入 WECHAT_WEBHOOK（企业微信群机器人）或 SERVERCHAN_KEY / PUSHPLUS_TOKEN 即可收到微信通知' });
  }

  if (action === 'list') {
    const scope = String(u.searchParams.get('scope') || 'admin').toLowerCase();
    if (scope === 'admin') {
      if (!isAdmin(request, env)) return bad('unauthorized', '需要管理员令牌', 401);
      const list = await kv.get(ADMIN_KEY, { type: 'json' });
      const arr = Array.isArray(list) ? list : [];
      return ok({
        scope: 'admin', total: arr.length,
        unread: arr.filter((x) => !x.read).length,
        items: arr.slice(0, 100),
        channels: channelStatus(env), settings: await readSettings(kv)
      });
    }
    const contact = String(u.searchParams.get('contact') || '').trim();
    if (!contact) return ok({ scope: 'user', total: 0, unread: 0, items: [] });
    const list = await kv.get(userKey(contact), { type: 'json' });
    const arr = Array.isArray(list) ? list : [];
    return ok({
      scope: 'user', total: arr.length,
      unread: arr.filter((x) => !x.read).length,
      items: arr.slice(0, 50)
    });
  }

  return bad('bad_action', '未知 action');
}

export async function onRequestPost({ request, env }) {
  const kv = kvOf(env);
  if (!kv) return bad('kv_missing', '存储未配置', 503);
  let body = {};
  try { body = await request.json(); } catch (e) { }
  const action = String(body.action || 'push').toLowerCase();

  if (action === 'settings') {
    if (!isAdmin(request, env)) return bad('unauthorized', '需要管理员令牌', 401);
    const cur = await readSettings(kv);
    const next = Object.assign({}, cur);
    ['order', 'refund', 'coupon', 'register', 'chat', 'feedback', 'ai', 'admin', 'wechat', 'board'].forEach((k) => {
      if (body[k] !== undefined) next[k] = !!body[k];
    });
    await kv.put(SETTINGS_KEY, JSON.stringify(next));
    return ok({ settings: next });
  }

  if (action === 'read') {
    const id = String(body.id || '');
    const scope = String(body.scope || 'admin').toLowerCase();
    if (scope === 'admin') {
      if (!isAdmin(request, env)) return bad('unauthorized', '需要管理员令牌', 401);
      const arr = await kv.get(ADMIN_KEY, { type: 'json' });
      const list = Array.isArray(arr) ? arr : [];
      list.forEach((x) => { if (x && x.id === id) x.read = true; });
      await kv.put(ADMIN_KEY, JSON.stringify(list));
      return ok({ id: id, read: true });
    }
    const contact = String(body.contact || '').trim();
    if (!contact) return bad('bad_contact', '缺少联系方式');
    const arr = await kv.get(userKey(contact), { type: 'json' });
    const list = Array.isArray(arr) ? arr : [];
    list.forEach((x) => { if (!id || (x && x.id === id)) x.read = true; });
    await kv.put(userKey(contact), JSON.stringify(list));
    return ok({ ok: true, readAll: !id });
  }

  if (action === 'readall') {
    const scope = String(body.scope || 'admin').toLowerCase();
    if (scope === 'admin') {
      if (!isAdmin(request, env)) return bad('unauthorized', '需要管理员令牌', 401);
      const arr = await kv.get(ADMIN_KEY, { type: 'json' });
      const list = (Array.isArray(arr) ? arr : []).map((x) => Object.assign({}, x, { read: true }));
      await kv.put(ADMIN_KEY, JSON.stringify(list));
      return ok({ readAll: true, total: list.length });
    }
    const contact = String(body.contact || '').trim();
    if (!contact) return bad('bad_contact', '缺少联系方式');
    const arr = await kv.get(userKey(contact), { type: 'json' });
    const list = (Array.isArray(arr) ? arr : []).map((x) => Object.assign({}, x, { read: true }));
    await kv.put(userKey(contact), JSON.stringify(list));
    return ok({ readAll: true, total: list.length });
  }

  if (action === 'push') {
    const scope = String(body.scope || 'admin').toLowerCase();
    const settings = await readSettings(kv);
    const type = String(body.type || 'system');
    /* 通知开关：对应类型关闭时仍记录，但不推送微信 */
    const allowWechat = settings.wechat !== false && settings[type] !== false;
    const item = {
      id: 'NT-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase(),
      type: type,
      level: String(body.level || 'info'),
      title: String(body.title || '新通知').slice(0, 120),
      text: String(body.text || '').slice(0, 800),
      orderId: String(body.orderId || ''),
      url: String(body.url || ''),
      createdAt: new Date().toISOString(),
      read: false
    };

    if (scope === 'admin') {
      const arr = await kv.get(ADMIN_KEY, { type: 'json' });
      const list = Array.isArray(arr) ? arr : [];
      list.unshift(item);
      await kv.put(ADMIN_KEY, JSON.stringify(list.slice(0, MAX_ADMIN)));
      let wx = { sent: false, skipped: !allowWechat, error: '' };
      if (allowWechat) wx = await pushWechat(env, '【民航客机收藏馆】' + item.title, item.text + (item.orderId ? '\n订单号：' + item.orderId : ''));
      return ok({ scope: 'admin', item: item, unread: list.filter((x) => !x.read).length, wechat: wx });
    }

    const contact = String(body.contact || '').trim();
    if (!contact) return bad('bad_contact', '缺少联系方式');
    const uarr = await kv.get(userKey(contact), { type: 'json' });
    const ulist = Array.isArray(uarr) ? uarr : [];
    ulist.unshift(item);
    await kv.put(userKey(contact), JSON.stringify(ulist.slice(0, MAX_USER)));
    return ok({ scope: 'user', item: item, unread: ulist.filter((x) => !x.read).length });
  }

  return bad('bad_action', '未知 action');
}
