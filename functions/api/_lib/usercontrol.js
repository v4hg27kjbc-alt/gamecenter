/**
 * _lib/usercontrol.js —— 「访客协助」核心逻辑（委婉命名的用户访问管控）
 *
 * 命名口径：对外/后台统一叫「访客协助」「受限名单」「协助申请」，不出现"黑名单"字眼。
 *
 * 数据模型（KV：env.AI_RATE_KV）：
 *   uc:visit:<visitorHash>           访问统计 {visits, firstVisit, lastVisit, ip, country, ua}
 *   uc:restrict:user:<visitorHash>   单用户受限 {scope:'user', note, reason, createdAt}
 *   uc:restrict:country:<CC>         地区受限（国家/地区码，如 CN / US）{scope:'country', country, note, reason, createdAt}
 *   uc:restrict:ipprefix:<prefix>    市级小区级受限（IP 前缀，如 123.45.67. / 240e:390:）{scope:'ipprefix', prefix, note, reason, createdAt}
 *   uc:restrict:global               全体受限 {scope:'global', note, reason, createdAt}
 *   uc:appeal:<ts>:<hash>            解除协助申请 {visitorHash, q, note, contact, status:'pending'|'granted'|'denied', createdAt, resolvedAt}
 *
 * 说明：
 *   - 入库一律使用加盐哈希（visitorHash / ipHash），不落原始 IP / 访客 ID，沿用全站隐私口径。
 *   - 访问统计使用「同访客 60 秒窗口合并写入」策略，控制 KV 写次数。
 */

const RESTRICT_PREFIX = 'uc:restrict:';
const VISIT_PREFIX = 'uc:visit:';
const APPEAL_PREFIX = 'uc:appeal:';

function kvOf(env) {
  return env && (env.AI_RATE_KV || env.AI_CACHE_KV);
}

/** 取 IPv4 前三段（/24 近似）或 IPv6 前四段，用于"市级小区"级前缀限制 */
export function ipPrefixOf(ip) {
  var v = String(ip || '').trim();
  if (!v) return '';
  if (v.indexOf(':') >= 0) {
    var parts = v.replace(/^\[|\]$/g, '').split(':');
    return parts.slice(0, 4).join(':') + ':';
  }
  var segs = v.split('.');
  if (segs.length !== 4) return v + '.';
  return segs.slice(0, 3).join('.') + '.';
}

/**
 * 记录一次访问（合并窗口：同一访客 60 秒内只写一次 KV）。
 * 返回当前累计访问次数（读不到时返回 0）。
 */
export async function recordVisit(env, info) {
  try {
    var kv = kvOf(env);
    var hash = info && info.visitorHash;
    if (!kv || !hash) return 0;
    var key = VISIT_PREFIX + hash;
    var now = Date.now();
    var raw = await kv.get(key);
    var rec = null;
    if (raw) {
      try { rec = JSON.parse(raw); } catch (e) { rec = null; }
    }
    if (rec && rec.lastVisit && now - rec.lastVisit < 60000) {
      /* 窗口内：只更新轻量字段，不累加（避免 KV 写放大） */
      if (info.ip) rec.ip = info.ip;
      if (info.country) rec.country = info.country;
      return toVisitCount(rec);
    }
    var visits = (rec ? toVisitCount(rec) : 0) + 1;
    var next = {
      visits: visits,
      firstVisit: rec && rec.firstVisit ? rec.firstVisit : now,
      lastVisit: now,
      ip: info.ip || (rec && rec.ip) || '',
      country: info.country || (rec && rec.country) || '',
      ua: info.ua || (rec && rec.ua) || ''
    };
    await kv.put(key, JSON.stringify(next), { expirationTtl: 15552000 }); // 180 天滚动保留
    return visits;
  } catch (e) {
    return 0;
  }
}

function toVisitCount(rec) {
  var n = parseInt(rec && rec.visits, 10);
  return isNaN(n) || n < 0 ? 0 : n;
}

/**
 * 校验访客是否受限。按优先级：单用户 → 地区（国家/前缀）→ 全体。
 * 返回 { restricted, scope, reason, note, level }
 *   level: 1=单用户 2=地区 3=全体（供前端排序/提示）
 */
export async function checkRestricted(env, info) {
  var out = { restricted: false, scope: '', reason: '', note: '', level: 0 };
  try {
    var kv = kvOf(env);
    if (!kv) return out;
    var hash = info && info.visitorHash;
    var ip = info && info.ip;
    var country = info && info.country;

    if (hash) {
      var userRaw = await kv.get(RESTRICT_PREFIX + 'user:' + hash);
      if (userRaw) return decodeRestrict(JSON.parse(userRaw), 'user', 1);
    }
    var gRaw = await kv.get(RESTRICT_PREFIX + 'global');
    if (gRaw) return decodeRestrict(JSON.parse(gRaw), 'global', 3);

    if (country) {
      var cRaw = await kv.get(RESTRICT_PREFIX + 'country:' + String(country).toUpperCase());
      if (cRaw) return decodeRestrict(JSON.parse(cRaw), 'country', 2);
    }
    if (ip) {
      var p = ipPrefixOf(ip);
      if (p) {
        var pRaw = await kv.get(RESTRICT_PREFIX + 'ipprefix:' + p);
        if (pRaw) return decodeRestrict(JSON.parse(pRaw), 'ipprefix', 2);
      }
    }
    return out;
  } catch (e) {
    return out;
  }
}

function decodeRestrict(rec, scope, level) {
  return {
    restricted: true,
    scope: rec && rec.scope ? rec.scope : scope,
    reason: (rec && rec.reason) || '',
    note: (rec && rec.note) || '',
    level: level
  };
}

/** 追加/更新一条受限记录。scope: user|country|ipprefix|global；target 为对应值 */
export async function addRestriction(env, opts) {
  var kv = kvOf(env);
  if (!kv) throw new Error('KV 未绑定');
  var scope = String(opts.scope || '').toLowerCase();
  var target = String(opts.target || '').trim();
  var key = '';
  if (scope === 'global') {
    key = RESTRICT_PREFIX + 'global';
  } else if (scope === 'user') {
    if (!target) throw new Error('单用户受限需要目标用户标识');
    key = RESTRICT_PREFIX + 'user:' + target;
  } else if (scope === 'country') {
    if (!target) throw new Error('地区受限需要国家/地区码');
    key = RESTRICT_PREFIX + 'country:' + target.toUpperCase();
  } else if (scope === 'ipprefix') {
    if (!target) throw new Error('区域受限需要 IP 前缀');
    key = RESTRICT_PREFIX + 'ipprefix:' + target;
  } else {
    throw new Error('未知的受限范围：' + scope);
  }
  var rec = {
    scope: scope,
    target: target,
    reason: String(opts.reason || '').slice(0, 120),
    note: String(opts.note || '').slice(0, 200),
    createdAt: Date.now()
  };
  await kv.put(key, JSON.stringify(rec), { expirationTtl: 7776000 }); // 90 天滚动
  return rec;
}

/** 解除受限。scope+target 与添加一致；global 时 target 可空 */
export async function removeRestriction(env, opts) {
  var kv = kvOf(env);
  if (!kv) throw new Error('KV 未绑定');
  var scope = String(opts.scope || '').toLowerCase();
  var target = String(opts.target || '').trim();
  var key = '';
  if (scope === 'global') key = RESTRICT_PREFIX + 'global';
  else if (scope === 'user') key = RESTRICT_PREFIX + 'user:' + target;
  else if (scope === 'country') key = RESTRICT_PREFIX + 'country:' + target.toUpperCase();
  else if (scope === 'ipprefix') key = RESTRICT_PREFIX + 'ipprefix:' + target;
  else return { removed: false };
  await kv.delete(key);
  return { removed: true };
}

/** 列出受限记录（全部范围） */
export async function listRestrictions(env) {
  var kv = kvOf(env);
  if (!kv) return [];
  var items = [];
  try {
    var list = await kv.list({ prefix: RESTRICT_PREFIX, limit: 1000 });
    for (var i = 0; i < list.keys.length; i++) {
      var k = list.keys[i].name;
      var raw = await kv.get(k);
      if (!raw) continue;
      try {
        var rec = JSON.parse(raw);
        items.push(Object.assign({ key: k, id: k.slice(RESTRICT_PREFIX.length) }, rec));
      } catch (e) {}
    }
  } catch (e) {}
  return items;
}

/** 列出访问统计（含受限状态标注），limit ≤ 500 */
export async function listVisitors(env, limit) {
  var kv = kvOf(env);
  if (!kv) return [];
  var max = Math.min(parseInt(limit, 10) || 100, 500);
  var out = [];
  try {
    var list = await kv.list({ prefix: VISIT_PREFIX, limit: max });
    for (var i = 0; i < list.keys.length; i++) {
      var k = list.keys[i].name;
      var raw = await kv.get(k);
      if (!raw) continue;
      try {
        var rec = JSON.parse(raw);
        out.push({
          hash: k.slice(VISIT_PREFIX.length),
          visits: toVisitCount(rec),
          firstVisit: rec.firstVisit || 0,
          lastVisit: rec.lastVisit || 0,
          ip: rec.ip || '',
          country: rec.country || '',
          ua: rec.ua || ''
        });
      } catch (e) {}
    }
    out.sort(function (a, b) { return (b.lastVisit || 0) - (a.lastVisit || 0); });
  } catch (e) {}
  return out;
}

/** 提交「解除协助」申请（公开接口） */
export async function submitAppeal(env, opts) {
  var kv = kvOf(env);
  if (!kv) throw new Error('KV 未绑定');
  var hash = String(opts.visitorHash || '').trim();
  if (!hash) throw new Error('缺少访客标识');
  var key = APPEAL_PREFIX + Date.now() + ':' + hash.slice(0, 8);
  var rec = {
    visitorHash: hash,
    q: String(opts.q || '').slice(0, 200),
    note: String(opts.note || '').slice(0, 300),
    contact: String(opts.contact || '').slice(0, 120),
    status: 'pending',
    createdAt: Date.now()
  };
  await kv.put(key, JSON.stringify(rec), { expirationTtl: 2592000 }); // 30 天
  return Object.assign({ id: key }, rec);
}

/** 列出协助申请；status 可过滤 pending|granted|denied */
export async function listAppeals(env, status) {
  var kv = kvOf(env);
  if (!kv) return [];
  var items = [];
  try {
    var list = await kv.list({ prefix: APPEAL_PREFIX, limit: 1000 });
    for (var i = 0; i < list.keys.length; i++) {
      var k = list.keys[i].name;
      var raw = await kv.get(k);
      if (!raw) continue;
      try {
        var rec = JSON.parse(raw);
        if (status && rec.status !== status) continue;
        items.push(Object.assign({ id: k }, rec));
      } catch (e) {}
    }
    items.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  } catch (e) {}
  return items;
}

/** 审核申请：granted → 解除该访客全部受限并标记；denied → 仅标记 */
export async function resolveAppeal(env, opts) {
  var kv = kvOf(env);
  if (!kv) throw new Error('KV 未绑定');
  var id = String(opts.id || '').trim();
  var action = String(opts.action || '').trim();
  if (!id || (action !== 'granted' && action !== 'denied')) throw new Error('参数不合法');
  var raw = await kv.get(id);
  if (!raw) throw new Error('申请不存在或已过期');
  var rec = JSON.parse(raw);
  rec.status = action;
  rec.resolvedAt = Date.now();
  await kv.put(id, JSON.stringify(rec), { expirationTtl: 2592000 });
  if (action === 'granted' && rec.visitorHash) {
    try { await kv.delete(RESTRICT_PREFIX + 'user:' + rec.visitorHash); } catch (e) {}
  }
  return Object.assign({ id: id }, rec);
}
