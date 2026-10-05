/**
 * 请求指纹缓存模块（对应条目 B-14）
 *
 * 目标：同一问题、同一参数、同一知识快照 → 直接返回缓存答案，不再调用上游模型。
 *      这是成本控制的第一道闸门，也是「预生成」生效的载体。
 *
 * 指纹组成（任一变化 → 指纹不同 → 视为不同请求，保证答案与上下文一致）：
 *   fp = sha256(版本 | 归一化消息文本 | 图片哈希 | 模型 | 档位 | 生成参数 | RAG快照戳 | 术语快照戳)
 *
 * 存储：
 *   一级：实例内内存缓存（服务当前 isolate，短 TTL，命中即返，零成本）
 *   二级：KV（跨实例、跨请求持久，TTL 由环境变量控制，默认 7 天）
 *
 * 约束：
 *   1) 图片请求默认不缓存（AI_CACHE_VISION=0），视觉识别结果时效性强且体积大；
 *   2) 命中缓存同样写日志，标记 cached=1、cost=0，便于核算真实节省；
 *   3) 缓存内容为纯文本答案，不含任何用户隐私字段。
 */

import { sha256Hex, normalizeText, toInt } from './http.js';

export const CACHE_VERSION = 'v1';
export const CACHE_KEY_PREFIX = 'ai:cache:' + CACHE_VERSION + ':';
export const DEFAULT_CACHE_TTL = 604800;   // 7 天
export const MEMORY_MAX_ENTRIES = 128;
export const MEMORY_TTL_MS = 30000;        // 内存层 30 秒，抵消同一波请求的抖动

var memoryCache = new Map();
var stats = { memHit: 0, kvHit: 0, miss: 0, put: 0, skipped: 0 };

export function cacheStats() {
  return {
    memHit: stats.memHit,
    kvHit: stats.kvHit,
    miss: stats.miss,
    put: stats.put,
    skipped: stats.skipped,
    memoryEntries: memoryCache.size
  };
}

function memGet(key) {
  var entry = memoryCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    memoryCache.delete(key);
    return null;
  }
  return entry.value;
}

function memSet(key, value) {
  if (memoryCache.size >= MEMORY_MAX_ENTRIES) {
    var firstKey = memoryCache.keys().next().value;
    if (firstKey) memoryCache.delete(firstKey);
  }
  memoryCache.set(key, { value: value, expiresAt: Date.now() + MEMORY_TTL_MS });
}

/**
 * 构造请求指纹。
 * @param {object} input { messages, model, tier, params, docText, imageHash, ragStamp, glossaryStamp, systemPrompt }
 * @returns {Promise<string>} 32 位十六进制指纹
 */
export async function buildFingerprint(input) {
  var i = input || {};
  var parts = [];
  parts.push('v=' + CACHE_VERSION);
  parts.push('model=' + (i.model || ''));
  parts.push('tier=' + (i.tier || ''));

  var params = i.params || {};
  parts.push('mt=' + (params.max_tokens === undefined ? '' : params.max_tokens));
  parts.push('tp=' + (params.temperature === undefined ? '' : params.temperature));
  parts.push('top_p=' + (params.top_p === undefined ? '' : params.top_p));

  parts.push('rag=' + (i.ragStamp || 'none'));
  parts.push('glo=' + (i.glossaryStamp || 'none'));
  parts.push('sys=' + (i.systemPrompt ? i.systemPrompt.length + ':' + (await sha256Hex(i.systemPrompt)).slice(0, 16) : 'none'));

  var msgs = i.messages || [];
  var textParts = [];
  for (var k = 0; k < msgs.length; k++) {
    var m = msgs[k];
    var role = m && m.role ? m.role : 'user';
    if (typeof m.content === 'string') {
      textParts.push(role + ':' + normalizeText(m.content));
    } else if (Array.isArray(m.content)) {
      for (var j = 0; j < m.content.length; j++) {
        var part = m.content[j];
        if (part && part.type === 'text') textParts.push(role + ':text:' + normalizeText(part.text));
        if (part && part.type === 'image_url') textParts.push(role + ':image:' + (i.imageHash || 'raw'));
      }
    }
  }
  parts.push('msg=' + (await sha256Hex(textParts.join('\u0001'))));

  return (await sha256Hex(parts.join('|'))).slice(0, 32);
}

/** 图片内容哈希（用于指纹；图片本体不入缓存） */
export async function imageHashOf(messages) {
  var chunks = [];
  for (var k = 0; k < (messages || []).length; k++) {
    var m = messages[k];
    if (!m || !Array.isArray(m.content)) continue;
    for (var j = 0; j < m.content.length; j++) {
      var part = m.content[j];
      if (part && part.type === 'image_url' && part.image_url && part.image_url.url) {
        var url = String(part.image_url.url);
        chunks.push(url.length + ':' + url.slice(-64));
      }
    }
  }
  if (!chunks.length) return '';
  return (await sha256Hex(chunks.join('|'))).slice(0, 16);
}

export function cacheEnabled(env, hasImage) {
  if (!env || env.AI_CACHE_ENABLED === '0') return false;
  if (hasImage && env.AI_CACHE_VISION !== '1') return false;
  var kv = env.AI_CACHE_KV || env.AI_RATE_KV;
  return !!(kv && typeof kv.get === 'function');
}

function cacheKv(env) {
  return (env && (env.AI_CACHE_KV || env.AI_RATE_KV)) || null;
}

/**
 * 读缓存。
 * @returns {Promise<{hit:boolean, source?:string, entry?:object}>}
 * entry: { answer, model, tier, feature, ragHit, ragDocs, createdAt, source }
 */
export async function cacheGet(env, fp) {
  if (!fp) return { hit: false };
  var mem = memGet(CACHE_KEY_PREFIX + fp);
  if (mem) {
    stats.memHit++;
    return { hit: true, source: 'memory', entry: mem };
  }
  var kv = cacheKv(env);
  if (!kv) {
    stats.miss++;
    return { hit: false };
  }
  try {
    var raw = await kv.get(CACHE_KEY_PREFIX + fp, 'json');
    if (raw && raw.answer) {
      stats.kvHit++;
      memSet(CACHE_KEY_PREFIX + fp, raw);
      return { hit: true, source: 'kv', entry: raw };
    }
  } catch (e) {
    /* KV 读取失败按未命中处理 */
  }
  stats.miss++;
  return { hit: false };
}

/**
 * 写缓存。
 * @param {object} entry { answer, model, tier, feature, ragHit, ragDocs, source }
 */
export async function cachePut(env, fp, entry, ttlSeconds) {
  if (!fp || !entry || !entry.answer) {
    stats.skipped++;
    return { ok: false, reason: 'empty' };
  }
  var ttl = toInt(ttlSeconds, toInt(env && env.AI_CACHE_TTL, DEFAULT_CACHE_TTL));
  ttl = Math.min(Math.max(300, ttl), 2592000);   // 5 分钟 ~ 30 天
  var payload = {
    answer: entry.answer,
    model: entry.model || '',
    tier: entry.tier || '',
    feature: entry.feature || '',
    ragHit: entry.ragHit ? 1 : 0,
    ragDocs: entry.ragDocs || 0,
    source: entry.source || 'live',
    createdAt: Math.floor(Date.now() / 1000)
  };
  memSet(CACHE_KEY_PREFIX + fp, payload);
  stats.put++;
  var kv = cacheKv(env);
  if (!kv) return { ok: true, stored: 'memory' };
  try {
    await kv.put(CACHE_KEY_PREFIX + fp, JSON.stringify(payload), { expirationTtl: ttl });
    return { ok: true, stored: 'kv', ttl: ttl };
  } catch (e) {
    return { ok: true, stored: 'memory', error: 'kv_put_failed' };
  }
}

/** 主动失效（管理端使用）：按指纹删除 */
export async function cacheDelete(env, fp) {
  memoryCache.delete(CACHE_KEY_PREFIX + fp);
  var kv = cacheKv(env);
  if (!kv || !fp) return { ok: false };
  try {
    await kv.delete(CACHE_KEY_PREFIX + fp);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'kv_delete_failed' };
  }
}

/** 缓存元信息，写入响应头，便于前端与运维观测 */
export function cacheHeaders(hit, source) {
  return {
    'X-AI-Cache': hit ? 'HIT' : 'MISS',
    'X-AI-Cache-Source': hit ? source || 'kv' : 'none'
  };
}

export { memSet as _memSet };
