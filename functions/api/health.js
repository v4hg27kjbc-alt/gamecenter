/**
 * GET /api/health —— 服务端自检（部署验证 / 监控探针）
 *
 * 用途：
 *   1. 部署后一眼确认「密钥是否配齐、绑定是否生效、数据是否就绪」，免去翻日志。
 *   2. 供外部监控（如 cron-job.org / UptimeRobot）做存活探测。
 *
 * 双上游：同时自检 kimi（Moonshot 中国区）与 zhipu（智谱 BigModel）两条上游。
 *
 * 安全边界（重要）：
 *   本接口**不需要鉴权**，因此**只返回布尔值与计数**，绝不返回：
 *     · 密钥明文、密钥前缀/后缀、密钥长度；
 *     · 访客标识、IP、请求正文；
 *     · 任何上游返回内容。
 *   密钥相关一律只回答「已配置 / 未配置」与「来自哪个变量名」。
 *
 * 返回字段见 docs/接口契约.md「GET /api/health」。
 */

import { ok, withSecurity, methodNotAllowed, resolveCors, toInt, toBool } from './_lib/http.js';
import { getFlags } from './_lib/flags.js';
import { routingTable, routingTableAll, TIERS } from './_lib/router.js';
import {
  modelCatalog,
  modelCaps,
  providerCatalog,
  providerEndpoint,
  providerConcurrency,
  providerKeySource,
  normalizeProvider,
  DEFAULT_PROVIDER,
  PROVIDERS
} from './_lib/upstream.js';
import { queueSnapshot } from './_lib/queue.js';
import { storageMode } from './_lib/logging.js';
import { tokenSecretInfo } from './_lib/auth.js';
import { aircraftBriefs } from './_lib/rag.js';
import { listTerms } from './_lib/glossary.js';
import { PREWARM_META } from './_lib/data/prewarm-questions.js';

function baseHeaders(context) {
  var h = Object.assign({ 'Cache-Control': 'no-store' }, withSecurity({}));
  return Object.assign(h, resolveCors(context.request, context.env));
}

/** 只回答「有没有」，不回显任何内容 */
function configured(value) {
  return !!(value && String(value).trim());
}

/** 只取端点主机名（便于部署核对，不含任何凭据） */
function endpointHost(url) {
  try {
    return new URL(String(url)).host || '';
  } catch (e) {
    return '';
  }
}

export async function onRequestGet(context) {
  var env = context.env;
  var flags = await getFlags(env, { fresh: false });

  /* ---------- 上游清单（只报「来自哪个变量名」，不回显内容） ---------- */
  var providers = providerCatalog(env);
  var providerChecks = {};
  var configuredCount = 0;
  providers.forEach(function (p) {
    if (p.configured) configuredCount++;
    providerChecks[p.provider] = {
      label: p.label,
      configured: p.configured,
      keySource: p.keySource,
      endpoint: p.endpoint,
      endpointHost: endpointHost(providerEndpoint(env, p.provider)),
      concurrency: p.concurrency,
      modelCount: p.models.length,
      default: p.default
    };
  });

  /* ---------- 队列自检（并发上限恒为 1，按 provider 分域串行） ---------- */
  var queue = await queueSnapshot(env);
  var queueByProvider = {};
  PROVIDERS.forEach(function (p) {
    var item = (queue.perProvider && queue.perProvider[p]) || {};
    queueByProvider[p] = {
      concurrencyLimit: 1,
      serialized: true,
      kvLease: !!item.kvLease,
      locked: !!item.locked,
      memoryWaiting: toInt(item.memoryWaiting, 0)
    };
  });

  /* ---------- 档位（默认上游 kimi 保持旧结构；另附双上游全表） ---------- */
  var tiers = routingTable(env);
  var tiersByProvider = {};
  routingTableAll(env).forEach(function (row) {
    if (!tiersByProvider[row.provider]) tiersByProvider[row.provider] = [];
    tiersByProvider[row.provider].push(row);
  });

  /* ---------- 旧字段（kimi 语义，向后兼容） ---------- */
  var secret = tokenSecretInfo(env);
  var kimiKeySource = providerKeySource(env, DEFAULT_PROVIDER);
  var kimiTierCount = TIERS.length;
  var kimiOverridden = 0;
  tiers.forEach(function (t) { if (configured(env[t.envKey])) kimiOverridden++; });

  var selfCheck = {
    // —— 旧字段：语义仍为「默认上游（kimi）」 ——
    upstreamKey: kimiKeySource !== 'none',
    upstreamKeySource: kimiKeySource,
    upstreamProvider: 'moonshot',
    upstreamEndpoint: env.AI_UPSTREAM_ENDPOINT ? providerEndpoint(env, DEFAULT_PROVIDER) : 'default-cn',
    upstreamConcurrency: providerConcurrency(env, DEFAULT_PROVIDER),
    queueMode: 'serial',

    // —— 新字段：双上游 ——
    dualUpstream: true,
    providerDefault: normalizeProvider(env.AI_PROVIDER_DEFAULT) || DEFAULT_PROVIDER,
    providerFallback: true,
    providersConfigured: configuredCount,
    providersTotal: PROVIDERS.length,
    providers: providerChecks,
    queueModeByProvider: 'serial-per-provider',
    queueByProvider: queueByProvider,
    tierOverrides: { kimi: kimiOverridden + '/' + kimiTierCount },

    // —— 基础设施绑定 ——
    circuit: env.AI_CIRCUIT_STATE || 'closed',
    tokenSecret: secret.source,
    adminToken: configured(env.AI_ADMIN_TOKEN || env.ADMIN_TOKEN),
    rateKv: !!(env.AI_RATE_KV && typeof env.AI_RATE_KV.get === 'function'),
    cacheKv: !!(env.AI_CACHE_KV && typeof env.AI_CACHE_KV.get === 'function'),
    logD1: !!(env.AI_LOG_DB && typeof env.AI_LOG_DB.prepare === 'function'),
    storage: storageMode(env)
  };

  var data = {
    status: kimiKeySource !== 'none' ? 'ready' : 'degraded',
    version: env.AI_API_VERSION || '1.0',
    time: new Date().toISOString(),
    region: (context.request.cf && context.request.cf.colo) || '',
    selfCheck: selfCheck,
    tiers: tiers,
    tiersByProvider: tiersByProvider,
    models: modelCatalog(),
    modelsByProvider: {
      kimi: modelCatalog('kimi'),
      zhipu: modelCatalog('zhipu')
    },
    flags: flags,
    data: {
      aircraft: aircraftBriefs().length,
      glossary: listTerms().length,
      prewarmQuestions: toInt(PREWARM_META.count, 0),
      prewarmVersion: PREWARM_META.version,
      units: '2026-09-26'
    },
    hint: buildHint(providerChecks, kimiKeySource)
  };

  return ok(data, baseHeaders(context));
}

function buildHint(providerChecks, kimiKeySource) {
  var kimi = providerChecks.kimi || {};
  var zhipu = providerChecks.zhipu || {};
  if (kimiKeySource !== 'none' && zhipu.configured) {
    return '双上游均已配置（' + kimi.keySource + ' + ' + zhipu.keySource + '）；默认上游 kimi，可传 provider=zhipu 走智谱。若仍返回降级答案，请检查 Secret 生效环境、KV/D1 绑定与模型档位变量';
  }
  if (kimiKeySource !== 'none') {
    return '仅配置了默认上游（' + kimi.keySource + '）；若需启用智谱上游，请配置 ZHIPU_API_KEY（仅服务端环境变量）';
  }
  if (zhipu.configured) {
    return '仅配置了智谱上游（' + zhipu.keySource + '）；默认上游 kimi 缺密钥，调用方需显式传 provider=zhipu';
  }
  return '未检测到任何上游密钥：请在 Cloudflare 项目配置 Secret MOONSHOT_API_KEY（kimi）与 ZHIPU_API_KEY（智谱），仅存服务端环境变量，切勿写入前端';
}

export async function onRequest(context) {
  var m = context.request.method;
  if (m === 'OPTIONS') return new Response(null, { status: 204, headers: baseHeaders(context) });
  if (m === 'GET' || m === 'HEAD') return onRequestGet(context);
  return methodNotAllowed('GET, OPTIONS', baseHeaders(context));
}
