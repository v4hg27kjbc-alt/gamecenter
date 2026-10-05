/**
 * 术语词典服务（对应条目 B-17）
 *
 * 数据源：_lib/data/glossary-data.js（代码内置，可被 D1 表 ai_glossary_term 覆盖/扩充）。
 * 能力：
 *   1) /api/glossary 按关键词/首字母检索术语
 *   2) /api/glossary?term=ETOPS 精确查询单条
 *   3) /api/glossary?list=1 输出全部术语目录（含中英文名，供前端做词条列表）
 *   4) 为 /api/chat 提供术语注入块（glossaryBlock），使模型解释与本词典口径一致
 *
 * 边界：词典只解释通用航空术语，不回答机型参数；机型问题一律走 RAG 机型库。
 */

import { GLOSSARY, GLOSSARY_META } from './data/glossary-data.js';
import { normalizeText } from './http.js';

export { GLOSSARY_META };
export const GLOSSARY_STAMP = GLOSSARY_META.version + ':' + GLOSSARY.length;

function normKey(s) {
  return String(s || '').trim().toLowerCase();
}

/** 单条术语的全部可检索键 */
function termKeys(item) {
  var keys = [item.term, item.zh, item.en].concat(item.aliases || []);
  return keys.filter(Boolean).map(normKey);
}

/**
 * 精确查询：term 全等（大小写不敏感，匹配 term/中文名/英文名/别名）。
 */
export function lookupExact(term, extraTerms) {
  var target = normKey(term);
  if (!target) return null;
  var pool = mergeTerms(extraTerms);
  for (var i = 0; i < pool.length; i++) {
    var keys = termKeys(pool[i]);
    if (keys.indexOf(target) >= 0) return pool[i];
  }
  return null;
}

/** 合并 D1 覆盖层（同 term 覆盖，新 term 追加） */
export function mergeTerms(extraTerms) {
  if (!extraTerms || !extraTerms.length) return GLOSSARY;
  var map = {};
  var order = [];
  GLOSSARY.forEach(function (item) {
    map[normKey(item.term)] = item;
    order.push(normKey(item.term));
  });
  extraTerms.forEach(function (item) {
    if (!item || !item.term) return;
    var k = normKey(item.term);
    if (!map[k]) order.push(k);
    map[k] = item;
  });
  return order.map(function (k) { return map[k]; });
}

/**
 * 模糊检索术语。
 * @param {string} query 用户问题或关键词
 * @param {number} topN 默认 3
 * @returns {{hits:Array, miss:boolean}}
 */
export function searchGlossary(query, topN, extraTerms) {
  var n = topN || 3;
  var q = normKey(query);
  var pool = mergeTerms(extraTerms);
  if (!q) return { hits: [], miss: true };

  var scored = [];
  for (var i = 0; i < pool.length; i++) {
    var item = pool[i];
    var score = 0;
    var keys = termKeys(item);
    for (var j = 0; j < keys.length; j++) {
      var k = keys[j];
      if (!k) continue;
      if (k === q) {
        score = Math.max(score, 20);
      } else if (k.length >= 3 && q.indexOf(k) >= 0) {
        score = Math.max(score, k.length >= 5 ? 12 : 9);
      } else if (k.length >= 4 && k.length >= q.length && k.indexOf(q) >= 0) {
        score = Math.max(score, 6);
      }
    }
    // 定义正文关键词命中
    var body = normKey((item.definition || '') + (item.misconception || ''));
    if (body.indexOf(q) >= 0 && q.length >= 3) score = Math.max(score, 5);
    if (score > 0) scored.push({ item: item, score: score });
  }

  scored.sort(function (a, b) { return b.score - a.score; });
  var hits = scored.slice(0, n).map(function (s) { return { term: s.item, score: s.score }; });
  return { hits: hits, miss: hits.length === 0 };
}

/** 术语目录（供前端列表页与搜索提示） */
export function listTerms(extraTerms) {
  return mergeTerms(extraTerms).map(function (item) {
    return {
      term: item.term,
      zh: item.zh,
      en: item.en,
      aliases: item.aliases || [],
      related: item.related || []
    };
  });
}

/**
 * 构造注入模型的术语块（限制在预算字符内）。
 */
export function buildGlossaryBlock(hits, budgetChars) {
  if (!hits || !hits.length) return '';
  var budget = budgetChars || 1800;
  var out = [];
  var chars = 0;
  for (var i = 0; i < hits.length; i++) {
    var t = hits[i].term || hits[i];
    var line = '· ' + t.term + '（' + (t.zh || '') + '）：' + (t.definition || '');
    if (t.misconception) line += ' 常见误解：' + t.misconception;
    if (chars + line.length > budget) break;
    out.push(line);
    chars += line.length;
  }
  return out.join('\n');
}

/** 供 /api/glossary 使用的单条输出（裁剪字段，避免把内部结构透出） */
export function publicTerm(item) {
  if (!item) return null;
  return {
    term: item.term,
    zh: item.zh || '',
    en: item.en || '',
    aliases: item.aliases || [],
    definition: item.definition || '',
    misconception: item.misconception || '',
    related: item.related || []
  };
}

/** 判断问题是否属于"术语类"（用于 RAG 与词典的分工） */
export function isTermQuestion(query) {
  var q = String(query || '');
  if (!q) return false;
  var termHints = ['是什么', '什么是', '什么意思', '定义', '解释一下', '怎么理解', '代表什么', '含义'];
  var hasHint = termHints.some(function (h) { return q.indexOf(h) >= 0; });
  if (!hasHint) return false;
  // 若同时提到机型，则交给 RAG（机型问题优先）
  var aircraftHint = /[A-Za-z]{0,4}\d{3}|空客|波音|A3\d\d|B7\d\d/i.test(q);
  return !aircraftHint;
}

/** D1 覆盖层读取（可选；失败时静默回落到代码内置词典） */
export async function loadDbTerms(env) {
  var db = env && env.AI_LOG_DB;
  if (!db || typeof db.prepare !== 'function') return [];
  try {
    var res = await db
      .prepare('SELECT term, zh, en, aliases, definition, misconception, related FROM ai_glossary_term WHERE enabled = 1 LIMIT 500')
      .all();
    var rows = (res && res.results) || [];
    return rows.map(function (r) {
      var aliases = [];
      var related = [];
      try { aliases = JSON.parse(r.aliases || '[]'); } catch (e) { aliases = []; }
      try { related = JSON.parse(r.related || '[]'); } catch (e) { related = []; }
      return {
        term: r.term,
        zh: r.zh,
        en: r.en,
        aliases: aliases,
        definition: r.definition,
        misconception: r.misconception,
        related: related
      };
    });
  } catch (e) {
    return [];
  }
}
