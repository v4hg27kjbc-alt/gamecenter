/**
 * AI 调用日志与成本核算（对应条目 B-20 / B-32 / B-41 / B-42）
 *
 * 能力：
 *   1) 逐次调用写明细（模型、档位、token、耗时、成本、缓存命中、降级标记）
 *   2) 按天 × 模型 × 功能 汇总
 *   3) 提问记录（用于人工挑选可入库内容；**不自动入库**）
 *   4) 管理端查询、聚合与 CSV 导出
 *
 * 存储策略（按优先级自动选择，保证功能不中断）：
 *   D1（AI_LOG_DB）可用 → 写 D1
 *   否则 KV（AI_LOG_KV / AI_RATE_KV）可用 → 写 KV 缓冲列表（供管理端读取与导出）
 *   否则 → console 输出结构化 JSON（Cloudflare 日志可查）
 *
 * 隐私：访客 ID / IP / UA 仅存加盐哈希前 32 位；提问原文按 AI_LOG_ASK_TEXT=1 才记录全文，
 *       默认记录截断文本（AI_LOG_ASK_MAX，默认 500 字符）。
 */

import { dayString, nowSec, truncate, toInt, hashId } from './http.js';

/* ------------------------------------------------------------------ */
/* 价格表（单位：元 / 百万 token；可通过环境变量覆盖，便于上游调价）    */
/* ------------------------------------------------------------------ */

export const DEFAULT_PRICING = {
  'kimi-k3': { in: 0, out: 0, note: '旗舰档：单位「元 / 百万 token」，默认 0，务必用 AI_PRICING_JSON 按 Moonshot 官方最新价填写' },
  'kimi-k2.6': { in: 0, out: 0, note: '标准/视觉档：默认 0，务必用 AI_PRICING_JSON 按官方最新价填写' },
  'kimi-k2.7-code': { in: 0, out: 0, note: '代码档：默认 0，务必用 AI_PRICING_JSON 按官方最新价填写' },
  'kimi-k2.7-code-highspeed': { in: 0, out: 0, note: '代码高速档：默认 0，务必用 AI_PRICING_JSON 按官方最新价填写' },
  'local-fallback': { in: 0, out: 0, note: '本地兜底，无成本' }
};

export function pricingTable(env) {
  var table = Object.assign({}, DEFAULT_PRICING);
  var override = env && env.AI_PRICING_JSON;
  if (override) {
    try {
      var parsed = JSON.parse(override);
      Object.keys(parsed).forEach(function (k) {
        if (parsed[k] && typeof parsed[k] === 'object') {
          table[k] = { in: toInt(parsed[k].in, 0), out: toInt(parsed[k].out, 0), note: '环境变量覆盖' };
        } else if (typeof parsed[k] === 'number') {
          table[k] = { in: parsed[k], out: parsed[k], note: '环境变量覆盖' };
        }
      });
    } catch (e) {
      /* 解析失败沿用默认表 */
    }
  }
  return table;
}

/**
 * 成本计算，返回「百万分之一元」整数（micro 元），避免浮点误差。
 * @returns {{costMicro:number, price:object, unknown:boolean}}
 */
export function computeCost(env, model, promptTokens, completionTokens) {
  var table = pricingTable(env);
  var price = table[model];
  var unknown = false;
  if (!price) {
    price = { in: 0, out: 0, note: '未登记模型，按 0 计' };
    unknown = true;
  }
  var cost = (promptTokens / 1000000) * price.in + (completionTokens / 1000000) * price.out;
  return { costMicro: Math.round(cost * 1000000), price: price, unknown: unknown };
}

export function formatCost(costMicro) {
  return (costMicro / 1000000).toFixed(6) + ' 元';
}

/* ------------------------------------------------------------------ */
/* 存储后端选择                                                        */
/* ------------------------------------------------------------------ */

export function d1(env) {
  var db = env && env.AI_LOG_DB;
  return db && typeof db.prepare === 'function' ? db : null;
}

function logKv(env) {
  return (env && (env.AI_LOG_KV || env.AI_RATE_KV)) || null;
}

export function storageMode(env) {
  if (d1(env)) return 'd1';
  if (logKv(env)) return 'kv';
  return 'console';
}

const KV_LOG_LIMIT = 300;
const KV_LOG_KEY = 'ai:log:ring';

async function kvAppend(env, record) {
  var kv = logKv(env);
  if (!kv) return false;
  try {
    var list = (await kv.get(KV_LOG_KEY, 'json')) || [];
    if (!Array.isArray(list)) list = [];
    list.push(record);
    if (list.length > KV_LOG_LIMIT) list = list.slice(list.length - KV_LOG_LIMIT);
    await kv.put(KV_LOG_KEY, JSON.stringify(list), { expirationTtl: 604800 });
    return true;
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 写日志                                                             */
/* ------------------------------------------------------------------ */

/**
 * 写一条调用明细。
 * @param {object} record {
 *   feature, tier, routeReason, model, stream, cached, cacheSource, ragHit, ragDocs,
 *   glossaryHits, degraded, degradeKind, status, errorCode, promptTokens, completionTokens,
 *   costMicro, latencyMs, visitorHash, ipHash, uaHash, fp, requestId, ts
 * }
 */
export async function logCall(env, record) {
  var r = record || {};
  var ts = r.ts || nowSec();
  var row = {
    ts: ts,
    day: dayString(ts),
    request_id: r.requestId || '',
    feature: r.feature || 'chat',
    tier: r.tier || '',
    route_reason: r.routeReason || '',
    model: r.model || '',
    stream: r.stream ? 1 : 0,
    cached: r.cached ? 1 : 0,
    rag_hit: r.ragHit ? 1 : 0,
    rag_docs: toInt(r.ragDocs, 0),
    glossary_hits: toInt(r.glossaryHits, 0),
    degraded: r.degraded ? 1 : 0,
    status: toInt(r.status, 200),
    error_code: r.errorCode || (r.degradeKind ? 'degraded:' + r.degradeKind : ''),
    prompt_tokens: toInt(r.promptTokens, 0),
    completion_tokens: toInt(r.completionTokens, 0),
    total_tokens: toInt(r.promptTokens, 0) + toInt(r.completionTokens, 0),
    cost_micro: toInt(r.costMicro, 0),
    latency_ms: toInt(r.latencyMs, 0),
    visitor_hash: r.visitorHash || '',
    ip_hash: r.ipHash || '',
    ua_hash: r.uaHash || '',
    fp: r.fp || ''
  };

  var db = d1(env);
  if (db) {
    try {
      await db
        .prepare(
          'INSERT INTO ai_call_log (ts, day, request_id, feature, tier, route_reason, model, stream, cached, rag_hit, rag_docs, glossary_hits, degraded, status, error_code, prompt_tokens, completion_tokens, total_tokens, cost_micro, latency_ms, visitor_hash, ip_hash, ua_hash, fp) ' +
            'VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)'
        )
        .bind(
          row.ts, row.day, row.request_id, row.feature, row.tier, row.route_reason, row.model, row.stream,
          row.cached, row.rag_hit, row.rag_docs, row.glossary_hits, row.degraded, row.status, row.error_code,
          row.prompt_tokens, row.completion_tokens, row.total_tokens, row.cost_micro, row.latency_ms,
          row.visitor_hash, row.ip_hash, row.ua_hash, row.fp
        )
        .run();
      await upsertSummary(env, row);
      return { ok: true, stored: 'd1' };
    } catch (e) {
      // D1 写失败 → 落到 KV 环形缓冲，绝不阻塞主流程
      var kvOk = await kvAppend(env, Object.assign({ storedFallback: 'kv' }, row));
      if (kvOk) return { ok: true, stored: 'kv', note: 'd1_failed' };
    }
  }

  if (await kvAppend(env, row)) return { ok: true, stored: 'kv' };

  try {
    console.log(JSON.stringify({ tag: 'ai_call_log', row: row }));
  } catch (e) {
    /* 忽略 */
  }
  return { ok: true, stored: 'console' };
}

/** 汇总表 upsert（按 天 × 模型 × 功能） */
export async function upsertSummary(env, row) {
  var db = d1(env);
  if (!db) return { ok: false };
  try {
    await db
      .prepare(
        'INSERT INTO ai_call_summary (day, model, feature, calls, cached_calls, degraded_calls, prompt_tokens, completion_tokens, total_tokens, cost_micro, latency_sum_ms, updated_at) ' +
          'VALUES (?1,?2,?3,1,?4,?5,?6,?7,?8,?9,?10,?11) ' +
          'ON CONFLICT(day, model, feature) DO UPDATE SET ' +
          'calls = calls + 1, ' +
          'cached_calls = cached_calls + ?4, ' +
          'degraded_calls = degraded_calls + ?5, ' +
          'prompt_tokens = prompt_tokens + ?6, ' +
          'completion_tokens = completion_tokens + ?7, ' +
          'total_tokens = total_tokens + ?8, ' +
          'cost_micro = cost_micro + ?9, ' +
          'latency_sum_ms = latency_sum_ms + ?10, ' +
          'updated_at = ?11'
      )
      .bind(
        row.day, row.model, row.feature, row.cached, row.degraded,
        row.prompt_tokens, row.completion_tokens, row.total_tokens, row.cost_micro, row.latency_ms, nowSec()
      )
      .run();
    return { ok: true };
  } catch (e) {
    return { ok: false };
  }
}

/** 提问记录（不自动入库；供管理端人工筛选） */
export async function logAsk(env, record) {
  var db = d1(env);
  if (!db) return { ok: false, reason: 'd1_unavailable' };
  var r = record || {};
  var ts = r.ts || nowSec();
  try {
    await db
      .prepare(
        'INSERT INTO ai_ask_log (ts, day, request_id, feature, question, answer_digest, answer_id, tier, model, cached, rag_hit, degraded, visitor_hash, curated, created_note) ' +
          'VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,0,?14)'
      )
      .bind(
        ts,
        dayString(ts),
        r.requestId || '',
        r.feature || 'chat',
        truncate(r.question || '', toInt(env.AI_LOG_ASK_MAX, 500)),
        truncate(r.answerDigest || '', toInt(env.AI_LOG_ASK_MAX, 500)),
        r.answerId || '',
        r.tier || '',
        r.model || '',
        r.cached ? 1 : 0,
        r.ragHit ? 1 : 0,
        r.degraded ? 1 : 0,
        r.visitorHash || '',
        '记录于 AI 问答日志，待人工判断是否入库'
      )
      .run();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'd1_insert_failed' };
  }
}

/* ------------------------------------------------------------------ */
/* 查询与聚合                                                          */
/* ------------------------------------------------------------------ */

function logFilterSql(filter, alias) {
  var f = filter || {};
  var a = alias || '';
  var where = [];
  var binds = [];
  if (f.from) { where.push(a + 'ts >= ?'); binds.push(toInt(f.from, 0)); }
  if (f.to) { where.push(a + 'ts <= ?'); binds.push(toInt(f.to, 0)); }
  if (f.day) { where.push(a + 'day = ?'); binds.push(String(f.day)); }
  if (f.model) { where.push(a + 'model = ?'); binds.push(String(f.model)); }
  if (f.feature) { where.push(a + 'feature = ?'); binds.push(String(f.feature)); }
  if (f.tier) { where.push(a + 'tier = ?'); binds.push(String(f.tier)); }
  if (f.onlyDegraded) where.push(a + 'degraded = 1');
  if (f.onlyCached) where.push(a + 'cached = 1');
  return { clause: where.length ? ' WHERE ' + where.join(' AND ') : '', binds: binds };
}

export async function queryLogs(env, filter) {
  var db = d1(env);
  var f = filter || {};
  var limit = Math.min(500, Math.max(1, toInt(f.limit, 100)));
  if (!db) {
    var kv = logKv(env);
    if (!kv) return { ok: false, reason: 'no_storage', rows: [] };
    var list = (await kv.get(KV_LOG_KEY, 'json')) || [];
    if (!Array.isArray(list)) list = [];
    var filtered = list.filter(function (row) {
      if (f.from && row.ts < f.from) return false;
      if (f.to && row.ts > f.to) return false;
      if (f.day && row.day !== f.day) return false;
      if (f.model && row.model !== f.model) return false;
      if (f.feature && row.feature !== f.feature) return false;
      if (f.onlyDegraded && !row.degraded) return false;
      if (f.onlyCached && !row.cached) return false;
      return true;
    });
    return { ok: true, storage: 'kv', rows: filtered.slice(-limit).reverse(), truncated: filtered.length > limit };
  }
  var built = logFilterSql(f, '');
  try {
    var res = await db
      .prepare('SELECT * FROM ai_call_log' + built.clause + ' ORDER BY ts DESC, id DESC LIMIT ' + limit)
      .bind.apply(null, built.binds)
      .all();
    return { ok: true, storage: 'd1', rows: (res && res.results) || [] };
  } catch (e) {
    return { ok: false, reason: 'query_failed', rows: [] };
  }
}

export async function summarizeLogs(env, filter) {
  var db = d1(env);
  var f = filter || {};
  var days = toInt(f.days, 7);
  var since = nowSec() - days * 86400;
  if (!db) {
    var q = await queryLogs(env, { from: since, limit: 500 });
    var rows = q.rows || [];
    var agg = { calls: rows.length, costMicro: 0, promptTokens: 0, completionTokens: 0, cached: 0, degraded: 0, byModel: {}, byFeature: {} };
    rows.forEach(function (r) {
      agg.costMicro += r.cost_micro || 0;
      agg.promptTokens += r.prompt_tokens || 0;
      agg.completionTokens += r.completion_tokens || 0;
      if (r.cached) agg.cached++;
      if (r.degraded) agg.degraded++;
      var mk = r.model || 'unknown';
      var fk = r.feature || 'chat';
      agg.byModel[mk] = (agg.byModel[mk] || 0) + 1;
      agg.byFeature[fk] = (agg.byFeature[fk] || 0) + 1;
    });
    agg.costYuan = (agg.costMicro / 1000000).toFixed(6);
    return { ok: true, storage: 'kv', days: days, summary: agg };
  }
  try {
    var byDay = await db
      .prepare(
        'SELECT day, SUM(calls) AS calls, SUM(cost_micro) AS cost_micro, SUM(total_tokens) AS total_tokens, SUM(cached_calls) AS cached_calls, SUM(degraded_calls) AS degraded_calls ' +
          'FROM ai_call_summary WHERE updated_at >= ? GROUP BY day ORDER BY day DESC LIMIT 60'
      )
      .bind(since)
      .all();
    var byModel = await db
      .prepare(
        'SELECT model, SUM(calls) AS calls, SUM(cost_micro) AS cost_micro, SUM(total_tokens) AS total_tokens, SUM(latency_sum_ms) AS latency_sum_ms ' +
          'FROM ai_call_summary WHERE updated_at >= ? GROUP BY model ORDER BY calls DESC LIMIT 20'
      )
      .bind(since)
      .all();
    var byFeature = await db
      .prepare(
        'SELECT feature, SUM(calls) AS calls, SUM(cost_micro) AS cost_micro, SUM(cached_calls) AS cached_calls, SUM(degraded_calls) AS degraded_calls ' +
          'FROM ai_call_summary WHERE updated_at >= ? GROUP BY feature ORDER BY calls DESC LIMIT 20'
      )
      .bind(since)
      .all();
    var totals = await db
      .prepare('SELECT SUM(calls) AS calls, SUM(cost_micro) AS cost_micro, SUM(total_tokens) AS total_tokens FROM ai_call_summary WHERE updated_at >= ?')
      .bind(since)
      .all();
    var t = (totals && totals.results && totals.results[0]) || {};
    return {
      ok: true,
      storage: 'd1',
      days: days,
      summary: {
        calls: t.calls || 0,
        costMicro: t.cost_micro || 0,
        costYuan: ((t.cost_micro || 0) / 1000000).toFixed(6),
        totalTokens: t.total_tokens || 0
      },
      byDay: (byDay && byDay.results) || [],
      byModel: (byModel && byModel.results) || [],
      byFeature: (byFeature && byFeature.results) || []
    };
  } catch (e) {
    return { ok: false, reason: 'query_failed' };
  }
}

/* ------------------------------------------------------------------ */
/* CSV 导出                                                            */
/* ------------------------------------------------------------------ */

function csvCell(v) {
  var s = v === undefined || v === null ? '' : String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function logsToCsv(rows) {
  var columns = [
    'id', 'ts', 'day', 'request_id', 'feature', 'tier', 'route_reason', 'model', 'stream', 'cached',
    'rag_hit', 'rag_docs', 'glossary_hits', 'degraded', 'status', 'error_code',
    'prompt_tokens', 'completion_tokens', 'total_tokens', 'cost_micro', 'latency_ms'
  ];
  var out = [columns.join(',')];
  (rows || []).forEach(function (r) {
    out.push(
      columns
        .map(function (c) {
          return csvCell(r[c] === undefined && c === 'id' ? '' : r[c]);
        })
        .join(',')
    );
  });
  return out.join('\n');
}

export function asksToCsv(rows) {
  var columns = ['id', 'ts', 'day', 'request_id', 'feature', 'question', 'answer_digest', 'tier', 'model', 'cached', 'rag_hit', 'curated'];
  var out = [columns.join(',')];
  (rows || []).forEach(function (r) {
    out.push(
      columns
        .map(function (c) {
          return csvCell(r[c]);
        })
        .join(',')
    );
  });
  return out.join('\n');
}

export async function queryAsks(env, filter) {
  var db = d1(env);
  if (!db) return { ok: false, reason: 'd1_unavailable', rows: [] };
  var f = filter || {};
  var limit = Math.min(500, Math.max(1, toInt(f.limit, 100)));
  var where = [];
  var binds = [];
  if (f.from) { where.push('ts >= ?'); binds.push(toInt(f.from, 0)); }
  if (f.to) { where.push('ts <= ?'); binds.push(toInt(f.to, 0)); }
  if (f.curated === 0 || f.curated === 1) { where.push('curated = ?'); binds.push(f.curated); }
  var sql = 'SELECT * FROM ai_ask_log' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY ts DESC, id DESC LIMIT ' + limit;
  try {
    var res = await db.prepare(sql).bind.apply(null, binds).all();
    return { ok: true, rows: (res && res.results) || [] };
  } catch (e) {
    return { ok: false, reason: 'query_failed', rows: [] };
  }
}

/**
 * 把某条提问标记为「待人工评估入库」（仅改标记，不写正式数据表）。
 * 这是"AI 生成内容不自动入库"的落地实现：入库必须由人工二次操作。
 */
export async function markAskCurated(env, id, note) {
  var db = d1(env);
  if (!db) return { ok: false, reason: 'd1_unavailable' };
  try {
    await db
      .prepare('UPDATE ai_ask_log SET curated = 1, created_note = ? WHERE id = ?')
      .bind(note || '人工标记为待评估入库', toInt(id, 0))
      .run();
    return { ok: true, autoIngest: false };
  } catch (e) {
    return { ok: false, reason: 'update_failed' };
  }
}

export { hashId };
