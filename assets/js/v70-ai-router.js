
/* ============================================================================
 * v70 阶段1 · 问 AI 双模型路由层
 *   1) 左上角模型选择器：Kimi（3 版：K2.6 / K3 / K2.7-Code）
 *   2) 全站统一 Kimi：快速问答与深度思考均走 Kimi（智谱已全线移除）
 *   3) 每日额度：深度思考每自然日 5 次，localStorage 计数，第 6 次自动切回 Kimi K2.6 并提示
 *   4) 纯增量：不覆盖任何站点既有函数；通过 window.__avAiRoute() 钩子向
 *      AIBridge.chat 提供 provider / model / mode（仅作用于未指定 tier 的主问答）
 *   零密钥：本模块不接触任何 API Key，请求统一由 AIBridge 走同源 /api/chat
 * ========================================================================== */
(function () {
  'use strict';

  var DEEP_LIMIT = 2;
  var LS_QUOTA_PREFIX = 'av_ai_deep_quota_';
  var LS_PREF = 'av_ai_model_pref';
  var FAST_MODEL = { provider: 'kimi', model: 'kimi-k2.6' };
  var DEEP_MODEL = { provider: 'kimi', model: 'kimi-k2.6' };
  var DEGRADE_TEXT = '今日 Kimi K3 次数已用完（每日 5 次），已自动切换 Kimi K2.6 继续回答';

  /* ---------------- 模型目录（全站仅 Kimi；智谱已全部下线） ---------------- */
var CATALOG = [
  { provider: 'kimi', name: 'Kimi（全站统一默认）', mode: 'deep', items: [
    { id: 'kimi-k2.6', label: 'Kimi K2.6', sub: '唯一可用 · 全站统一' },
    { id: 'kimi-k3', label: 'Kimi K3', sub: '暂不可用', disabled: true },
    { id: 'kimi-k3.1-pro', label: 'Kimi K3.1 Pro', sub: '暂不可用', disabled: true }
  ] }
];

  var state = {
    provider: 'kimi',
    model: 'kimi-k2.6',
    pendingDegrade: false
  };

  /* ---------------- 基础工具 ---------------- */
  function el(id) { return document.getElementById(id); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function quotaKey() { return LS_QUOTA_PREFIX + todayKey(); }
  function safeGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* 隐私模式忽略 */ } }
  function findItem(modelId) {
    for (var i = 0; i < CATALOG.length; i++) {
      for (var j = 0; j < CATALOG[i].items.length; j++) {
        if (CATALOG[i].items[j].id === modelId) {
          return { provider: CATALOG[i].provider, group: CATALOG[i].name, item: CATALOG[i].items[j] };
        }
      }
    }
    return null;
  }
  function modelLabel(modelId) {
    var f = findItem(modelId);
    return f ? f.item.label : modelId;
  }
  function modeOf(provider) { return provider === 'kimi' ? 'deep' : 'fast'; }

  /* ---------------- 每日深度额度（localStorage 按自然日计数） ---------------- */
  function getUsed() {
    var v = parseInt(safeGet(quotaKey()) || '0', 10);
    return isNaN(v) || v < 0 ? 0 : v;
  }
  function setUsed(n) { safeSet(quotaKey(), String(n)); }
  function remaining() { return Math.max(0, DEEP_LIMIT - getUsed()); }
  /* 返回 true 表示本次可用深度（已扣减）；false 表示额度已用完需降级 */
  function consumeDeep() {
    var used = getUsed();
    if (used >= DEEP_LIMIT) return false;
    setUsed(used + 1);
    return true;
  }

  /* ---------------- 偏好持久化 ---------------- */
  function loadPref() {
    var raw = safeGet(LS_PREF);
    if (!raw) return;
    try {
      var p = JSON.parse(raw);
      var f = p && p.model ? findItem(p.model) : null;
      if (f && f.provider !== 'zhipu') { state.provider = f.provider; state.model = f.item.id; }
    } catch (e) { /* 忽略非法缓存 */ }
  }
  function savePref() {
    safeSet(LS_PREF, JSON.stringify({ provider: state.provider, model: state.model }));
  }

  /* ---------------- 渲染：模型选择器 ---------------- */
  function renderPicker(force) {
    var box = el('avAiPicker');
    if (!box) return;
    if (!force && !box.classList.contains('open')) return;
    var html = '';
    for (var i = 0; i < CATALOG.length; i++) {
      var g = CATALOG[i];
      html += '<div class="av-ai-group-h">' + g.name + '</div>';
      for (var j = 0; j < g.items.length; j++) {
        var it = g.items[j];
        var active = (it.id === state.model) ? ' active' : '';
        var off = !!it.disabled;
        html += '<button type="button" class="av-ai-item' + active + (off ? ' av-ai-item-off' : '') + '" role="menuitemradio" ' +
          (off ? 'disabled aria-disabled="true" ' : '') +
          'aria-checked="' + (active ? 'true' : 'false') + '" ' +
          (off ? 'onclick="return false"' : 'onclick="avAiSelectModel(\'' + it.id + '\')"') + '>' +
          '<span>' + it.label + '</span>' +
          '<span class="av-ai-item-sub">' + it.sub + '</span>' +
          '</button>';
      }
    }
    html += '<div class="av-ai-quota">今日剩余深度思考 <b>' + remaining() + '/' + DEEP_LIMIT + '</b>' +
      '（深度思考由 Kimi K3 提供，每天 ' + DEEP_LIMIT + ' 次，用完自动切换 Kimi K2.6）</div>';
    box.innerHTML = html;
  }

  /* ---------------- 渲染：左上角按钮 + 顶部徽标 ---------------- */
  function renderHeader() {
    var btn = el('avAiModelBtn');
    var mode = modeOf(state.provider);
    if (btn) {
      btn.innerHTML =
        '<span class="av-ai-model-dot ' + (mode === 'deep' ? 'deep' : 'fast') + '"></span>' +
        '<span class="av-ai-model-btn-label">' + modelLabel(state.model) + '</span>' +
        '<svg class="av-ai-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>';
      btn.setAttribute('title', '当前模型：' + modelLabel(state.model) + '（' + (mode === 'deep' ? '深度思考' : '快速问答') + '）');
      btn.setAttribute('aria-label', '选择 AI 模型，当前 ' + modelLabel(state.model));
    }
    var bModel = el('avAiBadgeModel');
    if (bModel) {
      bModel.textContent = '模型：' + modelLabel(state.model);
      bModel.setAttribute('data-provider', state.provider);
    }
    var bMode = el('avAiBadgeMode');
    if (bMode) {
      bMode.textContent = mode === 'deep' ? '深度思考' : '快速问答';
      bMode.className = 'av-ai-badge ' + (mode === 'deep' ? 'mode-deep' : 'mode-fast');
      bMode.setAttribute('data-mode', mode);
    }
    var bQuota = el('avAiBadgeQuota');
    if (bQuota) {
      bQuota.textContent = '今日剩余深度思考 ' + remaining() + '/' + DEEP_LIMIT;
    }
  }

  function renderAll() { renderPicker(false); renderHeader(); }

  /* ---------------- 对外交互：选择器开合 / 选模型 ---------------- */
  window.avAiTogglePicker = function (ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    var box = el('avAiPicker');
    var btn = el('avAiModelBtn');
    if (!box) return;
    var open = box.classList.toggle('open');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) renderPicker(true);
  };
  window.avAiClosePicker = function () {
    var box = el('avAiPicker');
    var btn = el('avAiModelBtn');
    if (box) box.classList.remove('open');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  };
  window.avAiSelectModel = function (modelId) {
    var f = findItem(modelId);
    if (!f) return;
    if (f.item && f.item.disabled) {
      if (window.avAiClosePicker) window.avAiClosePicker();
      return false;
    }
    state.provider = f.provider;
    state.model = f.item.id;
    savePref();
    renderHeader();
    renderPicker(true);
    window.avAiClosePicker();
  };
  window.avAiCurrentRoute = function () {
    return { provider: state.provider, model: state.model, mode: modeOf(state.provider), remaining: remaining() };
  };

  /* ---------------- 路由钩子：供 AIBridge.chat 在主问答（无 tier）时调用 ---------------- */
  window.__avAiRoute = function () {
    var provider = state.provider;
    var model = state.model;
    var mode = modeOf(provider);
    var degraded = false;
    if (provider === 'kimi' && (model === 'kimi-k3' || model === 'kimi-k3.1-pro')) {
      if (!consumeDeep()) {
        /* 第 6 次起：K3 深度额度用完，自动降级 Kimi K2.6，并预约一条提示（插入到本次回答气泡上方） */
        degraded = true;
        state.pendingDegrade = true;
        provider = 'kimi';
        model = 'kimi-k2.6';
        mode = 'deep';
      }
    }
    renderAll();
    return {
      provider: provider,
      model: model,
      mode: mode,
      degraded: degraded,
      requestedProvider: state.provider,
      requestedModel: state.model
    };
  };

  /* ---------------- 降级提示：插入到回答气泡上方 ---------------- */
  function insertDegradeNote(msgEl) {
    var box = el('aiChatMessages');
    if (!box || !msgEl || !msgEl.parentNode) return;
    var note = document.createElement('div');
    note.className = 'av-ai-degrade-note';
    note.textContent = DEGRADE_TEXT;
    msgEl.parentNode.insertBefore(note, msgEl);
  }
  function watchMessages() {
    var box = el('aiChatMessages');
    if (!box || box.__avWatched) return;
    box.__avWatched = true;
    if (typeof window.MutationObserver !== 'function') return;
    var mo = new window.MutationObserver(function (muts) {
      if (!state.pendingDegrade) return;
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n && n.nodeType === 1 && n.classList && n.classList.contains('ai-msg-ai')) {
            insertDegradeNote(n);
            state.pendingDegrade = false;
            return;
          }
        }
      }
    });
    mo.observe(box, { childList: true });
  }

  /* ---------------- 事件绑定与初始化 ---------------- */
  function bindDismiss() {
    document.addEventListener('click', function (e) {
      var box = el('avAiPicker');
      if (!box || !box.classList.contains('open')) return;
      var t = e.target;
      if (t && t.closest && (t.closest('#avAiPicker') || t.closest('#avAiModelBtn'))) return;
      window.avAiClosePicker();
    }, true);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') window.avAiClosePicker();
    });
  }

  function init() {
    loadPref();
    renderAll();
    bindDismiss();
    watchMessages();
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) renderAll();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
