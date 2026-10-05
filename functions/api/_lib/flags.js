/**
 * 功能开关与一键熔断（对应条目 B-19 的开关部分）
 *
 * 三级配置优先级（高 → 低）：
 *   1) D1 表 ai_flags（运维可在后台一键切换，无需重新部署）
 *   2) 环境变量（Cloudflare Pages 环境变量 / Secret）
 *   3) 代码内置默认值
 *
 * 内置开关（key 与含义）：
 *   ai_enabled    AI 总开关（false = 全站 AI 熔断，所有 AI 接口返回降级内容）
 *   ai_chat       对话接口
 *   ai_stream     流式输出（false 时忽略 stream 参数，强制非流式）
 *   ai_vision     图片识别
 *   ai_cache      请求指纹缓存
 *   ai_prewarm    预生成与预热
 *   ai_rag        知识锚定检索
 *   ai_glossary   术语词典注入
 *   ai_ask_log    提问日志（关闭后不记录提问，仍记录调用明细）
 *   ai_admin      管理端接口（false = 管理接口直接 404，防止公网探测）
 *   ai_read       只读数据接口（机型/术语/健康检查）
 *   write_enabled 非 AI 数据写接口总开关（默认 false，即"不自动入库/不接受外部写入"）
 *   contact_write 留言表单写入（默认 false，需人工开启）
 *
 * 环境变量映射：AI_FLAG_<大写KEY>，例如 AI_FLAG_AI_ENABLED=0、AI_FLAG_WRITE_ENABLED=1；
 * 另兼容历史变量 AI_DISABLED=1（等价 ai_enabled=false）。
 */

import { toBool, toInt, nowSec } from './http.js';

export const FLAG_DEFAULTS = {
  ai_enabled: true,
  ai_chat: true,
  ai_stream: true,
  ai_vision: true,
  ai_cache: true,
  ai_prewarm: true,
  ai_rag: true,
  ai_glossary: true,
  ai_ask_log: true,
  ai_admin: true,
  ai_read: true,
  write_enabled: false,
  contact_write: false
};

export const FLAG_KEYS = Object.keys(FLAG_DEFAULTS);

export const FLAG_DESCRIPTIONS = {
  ai_enabled: 'AI 总开关（关闭=全站 AI 熔断）',
  ai_chat: 'AI 对话接口',
  ai_stream: 'SSE 流式输出',
  ai_vision: '图片识别（视觉档）',
  ai_cache: '请求指纹缓存',
  ai_prewarm: '预生成与预热',
  ai_rag: '机型库知识锚定检索',
  ai_glossary: '术语词典注入',
  ai_ask_log: '提问日志记录',
  ai_admin: '管理端接口',
  ai_read: '只读数据接口',
  write_enabled: '非 AI 数据写入总开关（默认关闭）',
  contact_write: '留言写入开关（默认关闭）'
};

var cacheHolder = { value: null, expiresAt: 0 };
const FLAG_CACHE_MS = 20000;

function envFlagValue(env, key) {
  var upper = 'AI_FLAG_' + key.toUpperCase();
  if (env && env[upper] !== undefined && env[upper] !== '') return toBool(env[upper], FLAG_DEFAULTS[key]);
  if (key === 'ai_enabled' && env && env.AI_DISABLED === '1') return false;
  if (key === 'ai_enabled' && env && env.AI_ENABLED === '0') return false;
  return undefined;
}

async function loadDbFlags(env) {
  var db = env && env.AI_LOG_DB;
  if (!db || typeof db.prepare !== 'function') return null;
  try {
    var res = await db.prepare('SELECT key, value FROM ai_flags').all();
    var rows = (res && res.results) || [];
    var map = {};
    rows.forEach(function (r) {
      map[r.key] = toBool(r.value, FLAG_DEFAULTS[r.key]);
    });
    return map;
  } catch (e) {
    return null;
  }
}

/**
 * 读取全部开关。
 * @param {object} env
 * @param {object} options { fresh:true 跳过内存缓存 }
 */
export async function getFlags(env, options) {
  var o = options || {};
  if (!o.fresh && cacheHolder.value && cacheHolder.expiresAt > Date.now()) return cacheHolder.value;

  var flags = Object.assign({}, FLAG_DEFAULTS);
  FLAG_KEYS.forEach(function (k) {
    var v = envFlagValue(env, k);
    if (v !== undefined) flags[k] = v;
  });
  var dbFlags = await loadDbFlags(env);
  if (dbFlags) {
    Object.keys(dbFlags).forEach(function (k) {
      flags[k] = dbFlags[k];
    });
  }
  cacheHolder.value = flags;
  cacheHolder.expiresAt = Date.now() + FLAG_CACHE_MS;
  return flags;
}

export async function isEnabled(env, key) {
  var flags = await getFlags(env);
  return flags[key] !== false;
}

/** 写入 D1 开关（管理端使用）；D1 不可用时返回错误由调用方处理 */
export async function setFlag(env, key, value, updatedBy) {
  var db = env && env.AI_LOG_DB;
  if (!db || typeof db.prepare !== 'function') {
    return { ok: false, reason: 'd1_unavailable', hint: '未绑定 AI_LOG_DB，开关只能通过环境变量修改' };
  }
  if (FLAG_KEYS.indexOf(key) < 0) return { ok: false, reason: 'unknown_flag', known: FLAG_KEYS };
  var v = toBool(value, FLAG_DEFAULTS[key]) ? 1 : 0;
  try {
    await db
      .prepare(
        'INSERT INTO ai_flags (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4) ' +
          'ON CONFLICT(key) DO UPDATE SET value = ?2, updated_by = ?3, updated_at = ?4'
      )
      .bind(key, v, updatedBy || 'admin', nowSec())
      .run();
    cacheHolder.value = null;
    return { ok: true, key: key, value: !!v };
  } catch (e) {
    return { ok: false, reason: 'd1_write_failed' };
  }
}

/** 供管理端展示的开关快照 */
export async function flagsSnapshot(env) {
  var flags = await getFlags(env, { fresh: true });
  var db = env && env.AI_LOG_DB;
  var dbAvailable = !!(db && typeof db.prepare === 'function');
  return {
    flags: flags,
    descriptions: FLAG_DESCRIPTIONS,
    source: dbAvailable ? 'd1+env+default' : 'env+default',
    d1Available: dbAvailable
  };
}

/** 一键熔断：关闭全部 AI 能力（写 D1；D1 不可用则提示改用环境变量） */
export async function killSwitch(env, enabled, updatedBy) {
  var targets = ['ai_enabled', 'ai_chat', 'ai_stream', 'ai_vision', 'ai_prewarm'];
  var results = [];
  for (var i = 0; i < targets.length; i++) {
    var r = await setFlag(env, targets[i], enabled, updatedBy);
    results.push({ key: targets[i], ok: r.ok, value: !!enabled });
    if (!r.ok) return { ok: false, reason: r.reason, applied: results };
  }
  return { ok: true, applied: results };
}

export function quotaDefaults(env) {
  return {
    ipPerMin: toInt(env && env.AI_RATE_IP_PER_MIN, 20),
    ipPerDay: toInt(env && env.AI_RATE_IP_PER_DAY, 800),
    vidPerMin: toInt(env && env.AI_RATE_VID_PER_MIN, 10),
    vidPerDay: toInt(env && env.AI_RATE_VID_PER_DAY, 300)
  };
}
