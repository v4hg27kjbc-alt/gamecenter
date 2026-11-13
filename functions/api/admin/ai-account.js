/**
 * /api/admin/ai-account —— Kimi（Moonshot）账户真实余额 + 真实可用模型探测
 *
 * 背景：后台 Kimi 端口此前只能显示对话次数，看不到余额与真实用量。本接口直接向
 *      Moonshot 官方接口拉取余额与模型清单，不依赖任何本地估算值。
 *
 * 路由：
 *   GET /api/admin/ai-account            余额 + 模型清单 + 目标模型可用性探测
 *   GET /api/admin/ai-account?probe=1    仅探测（模型可用性）
 *
 * 鉴权：X-Admin-Token / Authorization: Bearer / ?token=
 *
 * 上游（真实数据，不缓存）：
 *   GET https://api.moonshot.cn/v1/users/me/balance
 *   GET https://api.moonshot.cn/v1/models
 */
import { checkAdminToken } from '../_lib/http.js';

const CN_BASE = 'https://api.moonshot.cn/v1';

// 需要探测的目标模型（K3 与新增的 K3.1 Pro）
const TARGETS = [
  { key: 'k3', ids: ['kimi-k3'] },
  { key: 'k31pro', ids: ['kimi-k3.1-pro', 'kimi-k3.1-pro-preview', 'kimi-k3.1', 'kimi-k3-1-pro'] },
  { key: 'k26', ids: ['kimi-k2.6'] },
  { key: 'k27code', ids: ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed'] }
];

function json(data, status, request) {
  const h = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': (function () {
      try {
        const origin = request && request.headers.get('Origin');
        const allow = (request && request.headers.get('Host')) || '';
        if (origin && allow && origin.indexOf(allow) >= 0) return origin;
      } catch (e) {}
      return '*';
    })(),
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  });
  return new Response(JSON.stringify(data), { status: status || 200, headers: h });
}

function keyOf(env) {
  return String((env && (env.MOONSHOT_API_KEY || env.KIMI_API_KEY || env.AI_UPSTREAM_KEY)) || '');
}

async function getJson(url, key, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 12000);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
      signal: ctrl.signal
    });
    const txt = await res.text();
    let data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = { raw: txt.slice(0, 300) }; }
    return { status: res.status, data: data };
  } catch (e) {
    return { status: 0, data: null, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

function yuan(v) {
  const n = Number(v);
  if (!isFinite(n)) return null;
  return Math.round(n * 10000) / 10000;
}

export async function onRequestOptions(context) {
  return json({ ok: true }, 200, context && context.request);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const auth = checkAdminToken(request, env);
  if (!auth.ok) {
    return json({ ok: false, error: auth.configured ? '管理员令牌无效' : '服务端未配置 ADMIN_TOKEN' }, 401, request);
  }

  const key = keyOf(env);
  if (!key) {
    return json({
      ok: false,
      configured: false,
      error: '服务端未配置 MOONSHOT_API_KEY，无法获取真实余额',
      hint: '请在 Cloudflare Pages 环境变量中设置 MOONSHOT_API_KEY 后重新部署'
    }, 200, request);
  }

  const out = {
    ok: true,
    configured: true,
    provider: 'kimi',
    endpoint: CN_BASE,
    keyMask: key.slice(0, 6) + '••••' + key.slice(-4),
    fetchedAt: new Date().toISOString(),
    balance: null,
    models: [],
    probe: {},
    errors: []
  };

  // 1) 真实余额
  const bal = await getJson(CN_BASE + '/users/me/balance', key);
  if (bal.status === 200 && bal.data) {
    const d = bal.data.data || bal.data;
    out.balance = {
      currency: 'CNY',
      available: yuan(d.available_balance),
      cash: yuan(d.cash_balance),
      voucher: yuan(d.voucher_balance),
      raw: d
    };
  } else {
    out.errors.push({
      step: 'balance',
      status: bal.status,
      message: (bal.data && (bal.data.error && bal.data.error.message || bal.data.message)) || bal.error || '余额查询失败'
    });
  }

  // 2) 真实模型清单
  const ms = await getJson(CN_BASE + '/models', key);
  let ids = [];
  if (ms.status === 200 && ms.data && Array.isArray(ms.data.data)) {
    ids = ms.data.data.map(function (m) { return String(m.id || ''); }).filter(Boolean);
    out.models = ms.data.data.map(function (m) {
      return { id: m.id, ownedBy: m.owned_by || '', created: m.created || null };
    });
  } else {
    out.errors.push({
      step: 'models',
      status: ms.status,
      message: (ms.data && (ms.data.error && ms.data.error.message || ms.data.message)) || ms.error || '模型清单查询失败'
    });
  }

  // 3) 目标模型可用性（以真实清单为准）
  TARGETS.forEach(function (t) {
    const hit = t.ids.find(function (id) { return ids.indexOf(id) >= 0; });
    out.probe[t.key] = {
      wanted: t.ids,
      available: !!hit,
      modelId: hit || null,
      exact: hit ? ids.indexOf(hit) : -1
    };
  });

  out.modelCount = ids.length;
  out.usable = ids.filter(function (id) { return /^kimi-k3/i.test(id) || /^kimi-k2\.\d/i.test(id); });
  return json(out, 200, request);
}
