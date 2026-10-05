/**
 * 对话上下文构造（RAG + 术语注入），供 /api/chat 与预生成（prewarm）共用
 *
 * 关键约束：
 *   1) 客户端的 system 消息一律丢弃，改用服务端统一提示词，杜绝提示词注入与越权指令；
 *   2) 机型事实只允许来自机型库检索结果，检索不到即声明「库内无记录」；
 *   3) 上下文与提示词的构造是确定性的（同样的输入 → 同样的提示词），这是缓存指纹与
 *      预生成能够命中的前提。
 */

import { normalizeText } from './http.js';
import { searchAircraft, buildRagContext, buildSystemPrompt, NO_RECORD_TEXT, RAG_STAMP } from './rag.js';
import { searchGlossary, buildGlossaryBlock, isTermQuestion, GLOSSARY_STAMP } from './glossary.js';
import { lastUserText, extractDocText } from './router.js';

export { NO_RECORD_TEXT };

/**
 * @param {object} env
 * @param {Array} messages 已通过校验的消息
 * @param {object} options { feature, ragEnabled, glossaryEnabled, ragTopN, ragBudget }
 * @returns {Promise<object>} 上下文对象
 */
export async function buildChatContext(env, messages, options) {
  var o = options || {};
  var query = normalizeText(lastUserText(messages));
  var ragEnabled = o.ragEnabled !== false;
  var glossaryEnabled = o.glossaryEnabled !== false;

  var rag = { hits: [], miss: true, aircraftMentioned: false, maybeMissing: false };
  var ragCtx = { context: '', used: [], truncated: false, chars: 0 };
  if (ragEnabled) {
    rag = searchAircraft(query, o.ragTopN || 3);
    ragCtx = buildRagContext(rag.hits, o.ragBudget || 6000);
  }

  var glossaryHits = [];
  if (glossaryEnabled) {
    var g = searchGlossary(query, isTermQuestion(query) ? 2 : 3);
    glossaryHits = g.hits.filter(function (h) {
      return isTermQuestion(query) || h.score >= 9;
    });
  }
  var glossaryBlock = buildGlossaryBlock(glossaryHits, 1800);

  var systemPrompt = buildSystemPrompt(ragCtx.context, glossaryBlock);

  return {
    query: query,
    systemPrompt: systemPrompt,
    rag: {
      enabled: ragEnabled,
      hit: ragCtx.used.length > 0,
      docs: ragCtx.used,
      docsCount: ragCtx.used.length,
      miss: ragCtx.used.length === 0,
      aircraftMentioned: !!rag.aircraftMentioned,
      mentionedTokens: rag.mentionedTokens || [],
      maybeMissing: !!rag.maybeMissing,
      chars: ragCtx.chars,
      truncated: ragCtx.truncated
    },
    glossary: {
      enabled: glossaryEnabled,
      count: glossaryHits.length,
      terms: glossaryHits.map(function (h) { return h.term.term; })
    },
    stamps: { rag: RAG_STAMP, glossary: GLOSSARY_STAMP },
    noRecordNotice: ragCtx.used.length === 0 && rag.aircraftMentioned ? NO_RECORD_TEXT : ''
  };
}

/**
 * 组装送给上游的消息：服务端 system + 客户端 user/assistant（丢弃客户端 system）。
 */
export function messagesForUpstream(messages, systemPrompt) {
  var out = [{ role: 'system', content: systemPrompt }];
  for (var i = 0; i < (messages || []).length; i++) {
    var m = messages[i];
    if (!m || m.role === 'system') continue;
    out.push(m);
  }
  return out;
}

/** 用于日志与提问记录的答案摘要（去空白、限长） */
export function digestAnswer(text, max) {
  var t = normalizeText(text);
  return t.length > (max || 200) ? t.slice(0, max || 200) + '…' : t;
}

export { extractDocText };
