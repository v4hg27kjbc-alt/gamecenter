/**
 * /api/model-health —— AI 模型可用性上报与访问提示（v3.6）
 *
 * 背景：当前站点只有 kimi-k2.6 可用，其余模型（kimi-k3 / kimi-k3.1-pro）不可用。
 * 要求：每次用户访问都要提示，并标注时间；同时做好记录（站长后台可见）。
 *
 * GET  /api/model-health            → { ok, last:{at,available,unavailable,visits}, logs:[...] , notice }
 * POST /api/model-health {action:'report', available:[], unavailable:[], ua:''}
 *      → 记录本次访问（累计 visits），不可用集合变化或距上次推送超过 6 小时时推送到后台通知中心
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Visitor-Id,X-Admin-Token'
};

const LAST_KEY = 'model:health:last';
const LOG_KEY = 'model:health:log';
const MAX_LOG = 60;
const PUSH_GAP_MS = 6 * 3600 * 1000;

const DEFAULT_AVAILABLE = ['kimi-k2.6'];
const DEFAULT_UNAVAILABLE = ['kimi-k3', 'kimi-k3.1-pro'];

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }, CORS)
  });
}

function kvOf(env) {
  const kv = env && env.SMS_KV;
  if (kv && typeof kv.get === 'function') return kv;
  const alt = env && env.NEWS_KV;
  return (alt && typeof alt.get === 'function') ? alt : null;
}

function beijingTime(iso) {
  const t = Date.parse(iso || '');
  if (!isFinite(t)) return iso || '';
  const d = new Date(t + 8 * 3600 * 1000);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate())
    + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

async function readJson(kv, key, fallback) {
  try {
    const raw = await kv.get(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch (e) { return fallback; }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet(context) {
  const { env } = context;
  const kv = kvOf(env);
  if (!kv) return json({ ok: false, code: 'kv_missing', message: '存储未配置' }, 500);
  const last = await readJson(kv, LAST_KEY, null);
  const logs = await readJson(kv, LOG_KEY, []);
  return json({
    ok: true,
    last: last,
    logs: Array.isArray(logs) ? logs.slice(0, 20) : [],
    atText: last ? beijingTime(last.at) : '',
    notice: last
      ? ('当前仅 ' + (last.available || DEFAULT_AVAILABLE).join(' / ') + ' 可用，'
        + (last.unavailable || DEFAULT_UNAVAILABLE).join(' / ') + ' 暂不可用')
      : '当前仅 kimi-k2.6 可用，其余模型暂不可用',
    staleLimitMs: PUSH_GAP_MS
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const kv = kvOf(env);
  if (!kv) return json({ ok: false, code: 'kv_missing', message: '存储未配置' }, 500);

  let body = {};
  try { body = await request.json(); } catch (e) { body = {}; }
  const action = String(body.action || 'report');

  const available = Array.isArray(body.available) && body.available.length
    ? body.available.map(String) : DEFAULT_AVAILABLE;
  const unavailable = Array.isArray(body.unavailable) && body.unavailable.length
    ? body.unavailable.map(String) : DEFAULT_UNAVAILABLE;
  const now = new Date().toISOString();

  const prev = await readJson(kv, LAST_KEY, null);
  const visits = Number((prev && prev.visits) || 0) + 1;

  const record = {
    at: now,
    atText: beijingTime(now),
    available: available,
    unavailable: unavailable,
    visits: visits,
    ua: String(body.ua || request.headers.get('user-agent') || '').slice(0, 180),
    ip: String(request.headers.get('cf-connecting-ip') || '').slice(0, 60)
  };
  await kv.put(LAST_KEY, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 30 });

  /* 访问记录：同一天同一不可用集合只保留首个时间 + 累计次数，最多 60 天 */
  if (action === 'report') {
    const logs = await readJson(kv, LOG_KEY, []);
    const list = Array.isArray(logs) ? logs : [];
    const today = beijingTime(now).slice(0, 10);
    const sig = unavailable.join(',');
    const idx = list.findIndex((x) => x && x.day === today && x.sig === sig);
    if (idx >= 0) {
      list[idx].count = Number(list[idx].count || 1) + 1;
      list[idx].lastAt = now;
      list[idx].lastAtText = beijingTime(now);
    } else {
      list.unshift({ day: today, sig: sig, unavailable: unavailable, count: 1, firstAt: now, firstAtText: beijingTime(now), lastAt: now, lastAtText: beijingTime(now) });
    }
    await kv.put(LOG_KEY, JSON.stringify(list.slice(0, MAX_LOG)), { expirationTtl: 60 * 60 * 24 * 120 });

    /* 推送提醒：不可用集合变化，或距上次推送超过 6 小时 */
    const prevSig = prev ? (prev.unavailable || []).join(',') : '';
    const lastPushAt = prev && prev.pushedAt ? Date.parse(prev.pushedAt) : 0;
    const needPush = (!prev) || prevSig !== sig || !isFinite(lastPushAt) || (Date.now() - lastPushAt) > PUSH_GAP_MS;
    if (needPush) {
      const origin = new URL(request.url).origin;
      const text = '模型可用性：仅 ' + available.join(' / ') + ' 可用；'
        + unavailable.join(' / ') + ' 不可用。\n发生时间：' + beijingTime(now)
        + '\n今日累计访问提示 ' + Number((list[0] && list[0].count) || 1) + ' 次';
      try {
        await fetch(origin + '/api/notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'push', scope: 'admin', type: 'model',
            level: 'warn', title: 'AI 模型不可用提醒（' + beijingTime(now) + '）', text: text
          })
        });
        record.pushedAt = now;
        await kv.put(LAST_KEY, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 30 });
      } catch (e) { /* 通知失败不影响记录 */ }
    }
  }

  return json({ ok: true, last: record, atText: beijingTime(now), visits: visits });
}
