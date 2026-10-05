/**
 * 知识锚定 RAG 模块（对应条目 B-16）
 *
 * 事实来源：站内机型库（_lib/data/aircraft-index.js，由 aircraft-data.json 提取生成）。
 * 硬约束：模型回答机型参数时**只能**使用检索到的库内文本；库内无记录必须回答
 *        「库内无记录」，严禁编造机型、参数、航司或历史事件。
 *
 * 检索策略（无外部依赖，纯词法 + 别名加权）：
 *   1) 别名精确/包含命中：+12（机型名、代号、数字型号，如 "A380"、"787"）
 *   2) 中文名/英文名命中：+10
 *   3) 标签命中：+4
 *   4) 全文词命中：+1/词（上限 8）
 *   5) 国别/类别词命中：+2
 * 命中数不足时返回 miss，交由调用方决定「提示库内无记录」还是「按通用知识作答」。
 */

import { normalizeText } from './http.js';
import { AIRCRAFT_LIST, AIRCRAFT_DOCS, RAG_META } from './data/aircraft-index.js';

export { RAG_META };

/** RAG 快照戳：机型库内容指纹，库更新后缓存自动失效 */
export const RAG_STAMP = RAG_META.count + ':' + (RAG_META.generatedAt || '');

/** 库内无记录时的标准话术（模型必须照此口径回答） */
export const NO_RECORD_TEXT = '库内无记录';

/**
 * 系统提示词。RAG 与通用问答共用一段总约束，RAG 片段由 buildRagContext 追加。
 */
export const SYSTEM_PROMPT_BASE = [
  '你是「民航客机收藏馆」站内 AI 助手，服务于航空爱好者。',
  '回答要求：',
  '1) 机型相关的事实（型号、参数、航司、历史、趣闻）只能使用下方【机型库资料】中的内容，禁止凭记忆补充、推测或改写数字。',
  '2) 若【机型库资料】中没有对应记录，必须明确回答「库内无记录」，并可提示用户站内未收录该机型；严禁编造。',
  '3) 术语与原理类问题可结合通用航空知识回答，需与术语词典口径一致。',
  '4) 回答使用简体中文，结构清晰、篇幅克制；涉及参数时保留原始单位与数值，不要换算成估算值。',
  '5) 不涉及政治、军事敏感评价；不输出与本站航空收藏主题无关的内容。'
].join('\n');

/* ------------------------------------------------------------------ */
/* 检索                                                               */
/* ------------------------------------------------------------------ */

function tokenize(query) {
  var q = normalizeText(query).toLowerCase();
  var tokens = [];
  // 拉丁/数字词（型号、缩写）
  var latin = q.match(/[a-z0-9][a-z0-9\-.]{1,}/g) || [];
  for (var i = 0; i < latin.length; i++) {
    var t = latin[i].replace(/[.\-]+$/, '');
    if (t.length >= 2) tokens.push(t);
  }
  // 中文 2~4 字滑窗，命中率高且无需分词词典
  var cjk = q.match(/[\u4e00-\u9fa5]+/g) || [];
  for (var j = 0; j < cjk.length; j++) {
    var seg = cjk[j];
    if (seg.length <= 4) {
      tokens.push(seg);
    } else {
      for (var k = 0; k < seg.length - 1; k++) {
        tokens.push(seg.slice(k, k + 2));
        if (k + 4 <= seg.length) tokens.push(seg.slice(k, k + 4));
      }
    }
  }
  return tokens.filter(function (v, idx, arr) { return v.length >= 2 && arr.indexOf(v) === idx; }).slice(0, 40);
}

function scoreDoc(doc, query, tokens) {
  var q = normalizeText(query).toLowerCase();
  var score = 0;
  var matched = [];

  var aliases = doc.aliases || [];
  for (var i = 0; i < aliases.length; i++) {
    var a = String(aliases[i]).toLowerCase();
    if (!a) continue;
    if (q.indexOf(a) >= 0) {
      score += a.length >= 3 ? 12 : 8;
      matched.push('alias:' + a);
      break;
    }
  }

  var names = [doc.nameZh, doc.nameEn, doc.code];
  for (var j = 0; j < names.length; j++) {
    var n = names[j] ? String(names[j]).toLowerCase() : '';
    if (n && q.indexOf(n) >= 0) {
      score += 10;
      matched.push('name:' + n);
      break;
    }
  }

  var haystack = (doc.text || '').toLowerCase();
  var tags = doc.tags || [];
  for (var t = 0; t < tags.length; t++) {
    if (q.indexOf(String(tags[t]).toLowerCase()) >= 0) {
      score += 4;
      matched.push('tag:' + tags[t]);
      break;
    }
  }

  var wordHits = 0;
  for (var k = 0; k < tokens.length; k++) {
    if (haystack.indexOf(tokens[k]) >= 0) {
      wordHits++;
      if (wordHits <= 8) matched.push('kw:' + tokens[k]);
    }
  }
  score += wordHits;

  if (doc.country && q.indexOf(String(doc.country).toLowerCase()) >= 0) score += 2;
  if (doc.category && q.indexOf(String(doc.category).toLowerCase()) >= 0) score += 2;

  return { score: score, matched: matched.slice(0, 8), wordHits: wordHits };
}

/**
 * 检索机型库。
 * @param {string} query 用户问题
 * @param {number} topN 返回条数（默认 3）
 * @returns {{hits:Array, miss:boolean, aircraftMentioned:boolean, mentionedTokens:Array, total:number}}
 */
export function searchAircraft(query, topN) {
  var n = topN || 3;
  var tokens = tokenize(query);
  var scored = [];
  for (var i = 0; i < AIRCRAFT_DOCS.length; i++) {
    var doc = AIRCRAFT_DOCS[i];
    var s = scoreDoc(doc, query, tokens);
    if (s.score > 0) {
      scored.push({ doc: doc, score: s.score, matched: s.matched, wordHits: s.wordHits });
    }
  }
  scored.sort(function (a, b) { return b.score - a.score || a.doc.id - b.doc.id; });

  // 阈值：至少要有「别名/名称命中」或 3 个以上关键词命中，避免噪声机型被注入
  var strong = scored.filter(function (item) {
    var hasName = item.matched.some(function (m) { return m.indexOf('alias:') === 0 || m.indexOf('name:') === 0 || m.indexOf('tag:') === 0; });
    return hasName || item.wordHits >= 3;
  });
  var hits = (strong.length ? strong : scored).slice(0, n);

  var mentionTokens = detectMentionTokens(query);
  var mentionedButMissing = mentionTokens.length > 0 && !hits.some(function (h) { return scoreDoc(h.doc, query, tokens).matched.some(function (m) { return m.indexOf('alias:') === 0 || m.indexOf('name:') === 0; }) || h.score >= 10; });

  return {
    hits: hits.map(function (h) {
      return {
        id: h.doc.id,
        slug: h.doc.slug,
        nameZh: h.doc.nameZh,
        nameEn: h.doc.nameEn,
        code: h.doc.code,
        score: h.score,
        matched: h.matched,
        doc: h.doc
      };
    }),
    miss: hits.length === 0,
    aircraftMentioned: mentionTokens.length > 0,
    mentionedTokens: mentionTokens,
    maybeMissing: mentionedButMissing,
    total: AIRCRAFT_DOCS.length
  };
}

/** 抽取问题中"疑似机型型号"的词（用于库内无记录判定） */
export function detectMentionTokens(query) {
  var q = normalizeText(query);
  var tokens = [];
  var latin = q.match(/[A-Za-z]{0,4}\s?-?\s?\d{2,4}[A-Za-z]{0,4}/g) || [];
  for (var i = 0; i < latin.length; i++) {
    var t = latin[i].replace(/\s+/g, '').toLowerCase();
    if (t.length >= 3) tokens.push(t);
  }
  var zhNames = q.match(/[\u4e00-\u9fa5]{2,6}(客机|飞机|机型|运输机)/g) || [];
  for (var j = 0; j < zhNames.length; j++) tokens.push(zhNames[j]);
  return tokens.filter(function (v, idx, arr) { return arr.indexOf(v) === idx; }).slice(0, 6);
}

/* ------------------------------------------------------------------ */
/* 上下文构造                                                          */
/* ------------------------------------------------------------------ */

export function formatDocCompact(doc, withHistory) {
  var lines = [];
  lines.push('【' + doc.nameZh + '（' + doc.nameEn + '）】');
  lines.push('类别：' + (doc.category || '') + '；研制国家/地区：' + (doc.country || ''));
  var specLines = [];
  var specsZh = doc.specsZh || {};
  Object.keys(specsZh).forEach(function (k) {
    specLines.push(k + ' ' + specsZh[k]);
  });
  if (specLines.length) lines.push('主要参数：' + specLines.join('；'));
  if (doc.tags && doc.tags.length) lines.push('特征标签：' + doc.tags.join('、'));
  if (doc.airlines && doc.airlines.length) lines.push('运营航司：' + doc.airlines.join('、'));
  if (doc.desc) lines.push('简介：' + doc.desc);
  if (withHistory) {
    if (doc.history) lines.push('研发历史：' + doc.history);
    if (doc.tech) lines.push('技术特点：' + doc.tech);
    if (doc.trivia) lines.push('趣闻：' + doc.trivia);
  }
  return lines.join('\n');
}

/**
 * 构造 RAG 上下文文本块。
 * @param {Array} hits searchAircraft 的 hits
 * @param {number} budgetChars 上下文预算（默认 6000 字符，超预算截断到紧凑版）
 */
export function buildRagContext(hits, budgetChars) {
  var budget = budgetChars || 6000;
  if (!hits || !hits.length) {
    return { context: '', used: [], truncated: false, chars: 0 };
  }
  var blocks = [];
  var used = [];
  var chars = 0;
  var truncated = false;

  for (var pass = 0; pass < 2; pass++) {
    for (var i = 0; i < hits.length; i++) {
      if (used.indexOf(hits[i].slug) >= 0) continue;
      var text = pass === 0 ? formatDocCompact(hits[i].doc, true) : formatDocCompact(hits[i].doc, false);
      if (chars + text.length > budget) {
        truncated = true;
        continue;
      }
      blocks.push(text);
      used.push(hits[i].slug);
      chars += text.length;
    }
  }

  return {
    context: blocks.join('\n\n'),
    used: used,
    truncated: truncated,
    chars: chars
  };
}

/** 把 RAG 上下文拼进 system 消息 */
export function buildSystemPrompt(ragContext, glossaryBlock) {
  var parts = [SYSTEM_PROMPT_BASE];
  if (glossaryBlock) parts.push('\n【术语词典（站内口径）】\n' + glossaryBlock);
  if (ragContext) {
    parts.push('\n【机型库资料（唯一事实来源，回答机型问题必须依据本节）】\n' + ragContext);
  } else {
    parts.push(
      '\n【机型库资料】本次未检索到与问题匹配的机型记录。若用户询问具体机型，请直接回答「' +
        NO_RECORD_TEXT +
        '」，不要依据记忆作答。'
    );
  }
  return parts.join('\n');
}

/* ------------------------------------------------------------------ */
/* 只读接口用辅助                                                      */
/* ------------------------------------------------------------------ */

export function aircraftBriefs() {
  return AIRCRAFT_LIST.map(function (a) {
    return {
      id: a.id,
      slug: a.slug,
      code: a.code,
      nameZh: a.nameZh,
      nameEn: a.nameEn,
      country: a.country,
      category: a.category,
      tags: a.tags || []
    };
  });
}

export function aircraftDetail(slug) {
  for (var i = 0; i < AIRCRAFT_DOCS.length; i++) {
    if (AIRCRAFT_DOCS[i].slug === slug) return AIRCRAFT_DOCS[i];
  }
  return null;
}

export function libraryStats() {
  var byCountry = {};
  var byTag = {};
  for (var i = 0; i < AIRCRAFT_LIST.length; i++) {
    var a = AIRCRAFT_LIST[i];
    byCountry[a.country] = (byCountry[a.country] || 0) + 1;
    (a.tags || []).forEach(function (t) {
      byTag[t] = (byTag[t] || 0) + 1;
    });
  }
  return { count: AIRCRAFT_LIST.length, byCountry: byCountry, byTag: byTag, meta: RAG_META };
}

export { AIRCRAFT_LIST, AIRCRAFT_DOCS };
