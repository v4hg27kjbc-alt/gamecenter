
/* ===== v70 阶段2 · 模型入口单点收敛 · 识图场景图片按钮 · 快速问答难题引导 ===== */
(function () {
  'use strict';
  if (window.__avStage2) { return; }
  window.__avStage2 = '1.0';

  var PHOTO_INTENT_WINDOW = 3 * 60 * 1000;   /* 3 分钟内使用过「照片识机」→ 视为识图意图 */
  var DEEP_LIMIT_HINT = 5;

  var state = { imageMode: false, photoIntentAt: 0 };
  var pendingQuestion = '';

  function el(id) { return document.getElementById(id); }
  function mm() { return window.AiMultimodal; }
  function route() {
    try { return (typeof window.avAiCurrentRoute === 'function') ? window.avAiCurrentRoute() : null; }
    catch (e) { return null; }
  }
  function isDeepMode() { var r = route(); return !!(r && r.mode === 'deep'); }
  function remainingDeep() { var r = route(); return (r && typeof r.remaining === 'number') ? r.remaining : 0; }

  /* ---------------- ① 模型入口单点收敛：内部多模态模型跟随左上角选择器 ---------------- */
  function syncMmModel() {
    var m = mm();
    if (!m || typeof m.setModel !== 'function') { return; }
    try { m.setModel(state.imageMode ? 'vision' : (isDeepMode() ? 'reason' : 'fast'), true); } catch (e) { }
  }

  /* ---------------- ② 识图场景：图片按钮随场景显隐 + 问答类型 chip ---------------- */
  function renderScene() {
    var ov = el('aiChatOverlay');
    var btn = el('avAiImageModeBtn');
    if (ov) { ov.classList.toggle('av-ai-imaging', state.imageMode === true); }
    if (btn) {
      btn.textContent = state.imageMode ? '识图问答' : '纯文字问答';
      btn.className = 'av-ai-badge ' + (state.imageMode ? 'mode-image' : 'mode-text');
      btn.setAttribute('aria-pressed', state.imageMode ? 'true' : 'false');
      btn.setAttribute('title', state.imageMode
        ? '当前：识图问答（可上传照片识别）· 点击切回纯文字'
        : '当前：纯文字问答 · 点击切换到识图问答');
    }
    syncMmModel();
  }
  function setImageMode(on) {
    state.imageMode = on === true;
    renderScene();
  }
  window.avAiToggleImageMode = function (ev) {
    if (ev && ev.preventDefault) { ev.preventDefault(); }
    if (ev && ev.stopPropagation) { ev.stopPropagation(); }
    setImageMode(!state.imageMode);
  };
  window.avAiImageMode = function () { return state.imageMode === true; };

  /* ---------------- 浮层入口包装：默认场景 + 内部模型复位覆盖 ---------------- */
  function wrapOpenAiChat() {
    if (typeof window.openAiChat !== 'function' || window.openAiChat.__avStage2) { return; }
    var orig = window.openAiChat;
    var wrapped = function () {
      var photoIntent = state.photoIntentAt > 0 && (Date.now() - state.photoIntentAt) < PHOTO_INTENT_WINDOW;
      var r = orig.apply(this, arguments);
      setImageMode(photoIntent);
      /* 基线 AiMultimodal 约 60ms 后按 localStorage 复位其内部模型，这里延后覆盖为当前场景模型 */
      setTimeout(syncMmModel, 150);
      return r;
    };
    wrapped.__avStage2 = true;
    window.openAiChat = wrapped;
  }
  function wrapOpenPhotoAi() {
    if (typeof window.openPhotoAi !== 'function' || window.openPhotoAi.__avStage2) { return; }
    var orig = window.openPhotoAi;
    var wrapped = function () {
      state.photoIntentAt = Date.now();
      return orig.apply(this, arguments);
    };
    wrapped.__avStage2 = true;
    window.openPhotoAi = wrapped;
  }
  function wrapSelectModel() {
    if (typeof window.avAiSelectModel !== 'function' || window.avAiSelectModel.__avStage2) { return; }
    var orig = window.avAiSelectModel;
    var wrapped = function () {
      var r = orig.apply(this, arguments);
      renderScene();
      return r;
    };
    wrapped.__avStage2 = true;
    window.avAiSelectModel = wrapped;
  }

  /* ---------------- ③ 快速问答答不上来 → 深度思考引导 ---------------- */
  var GUIDE_NOTE = '这个问题有点难，要不要切到深度思考模式？';
  var GUIDE_BTN = '切换深度思考（Kimi）';
  var GUIDE_EMPTY_TEXT = '今日深度思考次数已用完，明天恢复';

  function clearGuides() {
    var box = el('aiChatMessages');
    if (!box) { return; }
    var olds = box.querySelectorAll('.av-ai-guide');
    for (var i = 0; i < olds.length; i++) {
      if (olds[i].parentNode) { olds[i].parentNode.removeChild(olds[i]); }
    }
  }

  function buildGuide() {
    var wrap = document.createElement('div');
    wrap.className = 'av-ai-guide';

    var note = document.createElement('div');
    note.className = 'av-ai-guide-note';
    note.textContent = GUIDE_NOTE;
    wrap.appendChild(note);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'av-ai-guide-btn';
    var left = remainingDeep();
    if (left > 0) {
      btn.textContent = GUIDE_BTN + '（今日剩余 ' + left + '/' + DEEP_LIMIT_HINT + '）';
      btn.addEventListener('click', function (e) {
        if (e && e.preventDefault) { e.preventDefault(); }
        if (e && e.stopPropagation) { e.stopPropagation(); }
        goDeep();
      });
    } else {
      btn.textContent = GUIDE_EMPTY_TEXT;
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
    }
    wrap.appendChild(btn);
    return wrap;
  }

  function goDeep() {
    if (remainingDeep() <= 0) { return; }
    var q = pendingQuestion;
    clearGuides();
    if (!q) { return; }
    /* 复用左上角选择器切到 Kimi 默认深度模型（自动持久化偏好） */
    if (typeof window.avAiSelectModel === 'function') { window.avAiSelectModel('kimi-k2.6'); }
    var input = el('aiChatInput');
    if (input) {
      input.value = q;
      if (typeof window.updateAiCharCount === 'function') { window.updateAiCharCount(); }
    }
    /* 走站内既有发送链：RAG 检索 / 额度扣减 / 降级提示 / 问答日志全部沿用 */
    if (typeof window.sendAiMessage === 'function') { window.sendAiMessage(); }
  }

  /* 由 sendAiMessage 在主问答判定「答不上来」时调用 */
  window.__avAiDifficultyGuide = function (question, noMatch) {
    if (!noMatch) { return; }
    if (state.imageMode) { return; }
    if (isDeepMode()) { return; }
    var box = el('aiChatMessages');
    if (!box) { return; }
    var nodes = box.querySelectorAll('.ai-msg-ai');
    if (!nodes.length) { return; }
    var last = nodes[nodes.length - 1];
    if (!last || !last.parentNode) { return; }
    clearGuides();
    pendingQuestion = String(question == null ? '' : question);
    last.parentNode.insertBefore(buildGuide(), last.nextSibling);
  };

  /* ---------------- 初始化 ---------------- */
  function init() {
    wrapSelectModel();
    wrapOpenAiChat();
    wrapOpenPhotoAi();
    renderScene();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
