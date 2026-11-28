
/* ===========================================================================
   v70 特性③ runtime · AI 助手「多模态 + 多模型」
   —— 零改动既有业务逻辑：不重定义 sendAiMessage / addMessage / AI_CONFIG 等，
      而是复用站内既有全局函数（addMessage / addLoadingIndicator /
      removeLoadingIndicator / ragRetrieveAircraft / buildRagContext /
      renderAiReplyWithCards / reportQaLog / AI_SYSTEM_PROMPTS / RAG_RULES /
      aiConversationHistory / AI_CONFIG）另开一条多模态发送通道。
   —— 纯文本（未附图）时完全走既有 sendAiMessage，行为与线上一致。
   =========================================================================== */
(function () {
  'use strict';
  if (window.AiMultimodal && window.AiMultimodal.__v) { return; }

  var MAX_IMAGES = 4;
  var MAX_SIDE = 1024;
  var MODEL_KEY = 'aiChatModel';
  var MODELS = {
    reason: { id: 'flagship', vision: false, zh: '深度推理', en: 'Deep Reason' },
    vision: { id: 'vision', vision: true, zh: '视觉识图', en: 'Vision' },
    fast: { id: 'light', vision: false, zh: '快速应答', en: 'Fast Reply' }
  };
  var FALLBACK_TEXT = 'light';
  var FALLBACK_VISION = 'vision';

  var pending = [];      /* [{url, name}] 压缩后的 dataURL */
  var busy = false;

  function q(id) { return document.getElementById(id); }
  function esc(s) { return (typeof escapeHtml === 'function') ? escapeHtml(s) : String(s); }
  function isEn() {
    try { if (typeof currentLang !== 'undefined' && currentLang === 'en') { return true; } } catch (e) { }
    return /^en/i.test(document.documentElement.getAttribute('lang') || '');
  }
  function label(key) { return isEn() ? (MODELS[key] || {}).en : (MODELS[key] || {}).zh; }
  function toast(msg) {
    try { if (typeof showToast === 'function') { showToast(msg); return; } } catch (e) { }
    console.log('[AiMultimodal] ' + msg);
  }
  function cfg() {
    try { if (typeof AI_CONFIG !== 'undefined') { return AI_CONFIG; } } catch (e) { }
    return null;
  }

  /* ---------- 模型切换 ---------- */
  function currentModel() {
    var k = null;
    try { k = localStorage.getItem(MODEL_KEY); } catch (e) { }
    if (!k || !MODELS[k]) { k = 'reason'; }
    return k;
  }
  function setModel(key, silent) {
    if (!MODELS[key]) { return; }
    try { localStorage.setItem(MODEL_KEY, key); } catch (e) { }
    var chips = document.querySelectorAll('.ai-mm-chip');
    for (var i = 0; i < chips.length; i++) {
      var on = chips[i].getAttribute('data-mm-model') === key;
      chips[i].classList.toggle('on', on);
      chips[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    updateHint();
    applyLangLabels();
    if (!silent) { toast((isEn() ? 'Model: ' : '已切换模型：') + label(key)); }
  }
  function visionKeyFor(key) {
    if (MODELS[key] && MODELS[key].vision) { return key; }
    return 'vision';
  }

  /* ---------- 图片输入 ---------- */
  function compress(file, cb) {
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var scale = Math.min(1, MAX_SIDE / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * scale));
        var ch = Math.max(1, Math.round(h * scale));
        var cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        var cx = cv.getContext('2d');
        cx.fillStyle = '#fff';
        cx.fillRect(0, 0, cw, ch);
        cx.drawImage(img, 0, 0, cw, ch);
        var url = '';
        try { url = cv.toDataURL('image/jpeg', 0.85); } catch (e) { url = reader.result; }
        if (url.length > 1400000) {
          try { url = cv.toDataURL('image/jpeg', 0.62); } catch (e2) { }
        }
        cb({ url: url, name: file.name || ('image-' + Date.now() + '.jpg') });
      };
      img.onerror = function () { cb(null); };
      img.src = reader.result;
    };
    reader.onerror = function () { cb(null); };
    reader.readAsDataURL(file);
  }

  function addFiles(files) {
    var list = [];
    for (var i = 0; i < files.length; i++) { list.push(files[i]); }
    list = list.filter(function (f) { return f && /^image\//.test(f.type || ''); });
    if (!list.length) { return; }
    var room = MAX_IMAGES - pending.length;
    if (room <= 0) { toast(isEn() ? ('Up to ' + MAX_IMAGES + ' images') : ('最多支持 ' + MAX_IMAGES + ' 张图片')); return; }
    if (list.length > room) {
      list = list.slice(0, room);
      toast(isEn() ? ('Only first ' + room + ' images kept') : ('仅保留前 ' + room + ' 张图片'));
    }
    var left = list.length;
    list.forEach(function (f) {
      if (f.size > 10 * 1024 * 1024) { left--; toast(isEn() ? 'Image too large (>10MB)' : '图片过大（>10MB），已跳过'); if (!left) { renderPreview(); } return; }
      compress(f, function (item) {
        if (item) { pending.push(item); }
        left--;
        if (left <= 0) { renderPreview(); }
      });
    });
  }

  function renderPreview() {
    var box = q('aiMmPreview');
    if (!box) { return; }
    box.innerHTML = '';
    for (var i = 0; i < pending.length; i++) {
      var d = document.createElement('div');
      d.className = 'ai-mm-thumb';
      d.innerHTML = '<img src="' + pending[i].url + '" alt="' + esc(pending[i].name) + '">'
        + '<button type="button" class="ai-mm-thumb-x" data-mm-del="' + i + '" title="移除">×</button>';
      box.appendChild(d);
    }
    box.classList.toggle('has', pending.length > 0);
    var at = q('aiMmAttach');
    if (at) { at.classList.toggle('busy', pending.length >= MAX_IMAGES); }
    updateHint();
  }

  function clearPending() {
    pending = [];
    renderPreview();
  }

  function updateHint() {
    var h = q('aiMmHint');
    if (!h) { return; }
    if (pending.length) {
      h.textContent = (isEn() ? pending.length + ' image(s) · vision on' : pending.length + ' 张图片 · 视觉通道已开启');
    } else {
      h.textContent = isEn() ? 'Images supported' : '支持图片输入';
    }
  }

  /* 模型条静态文案随站点语言切换（不改站内 i18n 逻辑，仅跟随 <html lang>） */
  function applyLangLabels() {
    var en = isEn();
    var lab = document.querySelector('#aiChatOverlay .ai-mm-label');
    if (lab) { lab.textContent = en ? 'Model' : '模型'; }
    var chips = document.querySelectorAll('.ai-mm-chip');
    for (var i = 0; i < chips.length; i++) {
      var k = chips[i].getAttribute('data-mm-model');
      var t = chips[i].querySelector('.ai-mm-chip-t');
      if (t && MODELS[k]) { t.textContent = label(k); }
      if (MODELS[k] && MODELS[k].vision) { chips[i].setAttribute('data-vision', '1'); }
    }
    var at = q('aiMmAttach');
    if (at) { at.setAttribute('title', en ? 'Attach images' : '上传图片'); }
    var rb = q('aiMmRemoveAll');
    if (rb) { rb.setAttribute('title', en ? 'Clear' : '清空图片'); }
    updateHint();
  }

  /* ---------- 多模态发送（仅在附图时接管） ---------- */
  async function sendMultimodal() {
    if (busy) { return; }
    var input = q('aiChatInput');
    var sendBtn = q('aiChatSendBtn');
    var C = cfg();
    if (!input || !C) { return; }
    var text = input.value.trim();
    if (!text && !pending.length) { return; }

    var mused = pending.slice();
    var mk = currentModel();
    var useKey = mused.length ? visionKeyFor(mk) : mk;
    var modelId = (MODELS[useKey] || MODELS.fast).id;
    if (mused.length && useKey !== mk) {
      toast(isEn() ? 'Images detected → switched to Vision model' : '检测到图片输入，已自动切换到「视觉识图」模型');
      setModel(useKey, true);
    }

    /* 用户消息（复用站内 addMessage 保证样式一致） */
    try {
      if (typeof addMessage === 'function') {
        addMessage(text || (isEn() ? '[Image]' : '[图片]'), 'user');
        var container = q('aiChatMessages');
        var last = container ? container.lastElementChild : null;
        if (last && mused.length) {
          var wrap = document.createElement('div');
          wrap.className = 'ai-mm-msg-imgs';
          for (var i = 0; i < mused.length; i++) {
            var im = document.createElement('img');
            im.src = mused[i].url;
            im.alt = mused[i].name;
            wrap.appendChild(im);
          }
          last.insertBefore(wrap, last.querySelector('.ai-msg-time') || null);
        }
      }
    } catch (e0) { }

    input.value = '';
    try { if (typeof updateAiCharCount === 'function') { updateAiCharCount(); } } catch (e1) { }
    clearPending();
    if (sendBtn) { sendBtn.disabled = true; }
    busy = true;
    try { if (typeof addLoadingIndicator === 'function') { addLoadingIndicator(); } } catch (e2) { }

    var ragHits = [];
    if (text) { try { ragHits = ragRetrieveAircraft(text, 5); } catch (e3) { ragHits = []; } }
    var ragBlock = '';
    try { ragBlock = buildRagContext(ragHits); } catch (e4) { ragBlock = ''; }

    var content = [];
    content.push({ type: 'text', text: text || (isEn() ? 'Identify and describe the aircraft in this image.' : '请识别并介绍图片中的客机/机型信息。') });
    for (var j = 0; j < mused.length; j++) {
      content.push({ type: 'image_url', image_url: { url: mused[j].url } });
    }

    var history = [];
    try { if (typeof aiConversationHistory !== 'undefined' && aiConversationHistory.slice) { history = aiConversationHistory.slice(-20); } } catch (e5) { history = []; }
    var sysPrompt = '';
    try {
      var lang = (typeof currentLang !== 'undefined') ? currentLang : 'zh';
      sysPrompt = (AI_SYSTEM_PROMPTS[lang] || AI_SYSTEM_PROMPTS.zh) + RAG_RULES;
    } catch (e6) { sysPrompt = ''; }

    var messages = [];
    if (sysPrompt) { messages.push({ role: 'system', content: sysPrompt }); }
    if (ragBlock) { messages.push({ role: 'system', content: ragBlock }); }
    for (var k = 0; k < history.length; k++) { messages.push(history[k]); }
    messages.push({ role: 'user', content: content });

    var reply = await requestOnce(modelId, messages, C);
    if (!reply && modelId !== (mused.length ? FALLBACK_VISION : FALLBACK_TEXT)) {
      var fb = mused.length ? FALLBACK_VISION : FALLBACK_TEXT;
      toast(isEn() ? 'Model unavailable, auto fallback…' : '当前模型不可用，已自动回退到可用模型');
      reply = await requestOnce(fb, messages, C);
    }

    try { if (typeof removeLoadingIndicator === 'function') { removeLoadingIndicator(); } } catch (e7) { }
    if (sendBtn) { sendBtn.disabled = false; }
    busy = false;

    if (reply) {
      try {
        aiConversationHistory.push({ role: 'user', content: text + (mused.length ? (' [' + (isEn() ? mused.length + ' image(s)' : mused.length + ' 张图片') + ']') : '') });
        aiConversationHistory.push({ role: 'assistant', content: reply });
      } catch (e8) { }
      var rres = null;
      try { rres = renderAiReplyWithCards(reply, ragHits); } catch (e9) { rres = null; }
      try {
        if (rres && rres.text) { addMessage(rres.text, 'ai', rres.cards); } else { addMessage(reply, 'ai'); }
        if (text) { reportQaLog(text, ragHits, ''); }
      } catch (e10) { }
    } else {
      try { addMessage(isEn() ? 'Image request failed. Please try again later.' : '图片请求失败，请稍后重试。', 'ai'); } catch (e11) { }
    }
  }

  async function requestOnce(tierId, messages, C) {
    try {
      var controller = new AbortController();
      var timeoutId = setTimeout(function () { controller.abort(); }, (C && C.timeout) || (AI_CONFIG && AI_CONFIG.timeout) || 90000);
      var data = await AIBridge.chat({
        tier: tierId,
        feature: 'mm_' + tierId,
        messages: messages,
        max_tokens: 900,
        temperature: 0.7,
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      var reply = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (Array.isArray(reply)) {
        var buf = '';
        for (var i = 0; i < reply.length; i++) { if (reply[i] && reply[i].text) { buf += reply[i].text; } }
        reply = buf;
      }
      return reply || null;
    } catch (e) { return null; }
  }


  /* ---------- 注入多模态 UI（纯增量：动态建节点，既有 DOM 与事件不变） ---------- */
  var ATTACH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="8.6" cy="10" r="1.7"/><path d="M3.4 17.2 8.8 12l3.6 3.6 3-3 5.2 5.2"/></svg>';

  function chipHTML(key) {
    return '<button type="button" class="ai-mm-chip" data-mm-model="' + key + '" role="tab" aria-selected="false">'
      + '<span class="ai-mm-dot"></span><span class="ai-mm-chip-t">' + label(key) + '</span></button>';
  }

  function buildUI() {
    var overlay = q('aiChatOverlay');
    if (!overlay || q('aiMmPreview')) { return; }

    var bar = document.createElement('div');
    bar.className = 'ai-mm-bar';
    bar.id = 'aiMmBar';
    bar.setAttribute('role', 'tablist');
    bar.innerHTML = '<span class="ai-mm-label">模型</span>'
      + chipHTML('reason') + chipHTML('vision') + chipHTML('fast')
      + '<span class="ai-mm-hint" id="aiMmHint">支持图片输入</span>';
    var header = overlay.querySelector('.ai-chat-header');
    if (header && header.nextSibling) { overlay.insertBefore(bar, header.nextSibling); }
    else { overlay.insertBefore(bar, overlay.firstChild); }

    var prev = document.createElement('div');
    prev.className = 'ai-mm-preview';
    prev.id = 'aiMmPreview';
    var inputArea = overlay.querySelector('.ai-chat-input-area');
    if (inputArea) { overlay.insertBefore(prev, inputArea); } else { overlay.appendChild(prev); }

    var file = document.createElement('input');
    file.type = 'file';
    file.id = 'aiMmFile';
    file.accept = 'image/*';
    file.multiple = true;
    file.style.display = 'none';
    overlay.appendChild(file);

    var row = overlay.querySelector('.ai-chat-input-row');
    var send = q('aiChatSendBtn');
    if (row && send) {
      var at = document.createElement('button');
      at.type = 'button';
      at.className = 'ai-mm-attach';
      at.id = 'aiMmAttach';
      at.title = '上传图片';
      at.innerHTML = ATTACH_SVG;
      row.insertBefore(at, send);
    }
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    buildUI();
    var overlay = q('aiChatOverlay');
    if (!overlay) { return; }

    var chips = overlay.querySelectorAll('.ai-mm-chip');
    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener('click', function () { setModel(this.getAttribute('data-mm-model')); });
    }

    var file = q('aiMmFile');
    if (file) {
      file.addEventListener('change', function () { addFiles(this.files || []); this.value = ''; });
    }
    var at = q('aiMmAttach');
    if (at && file) { at.addEventListener('click', function () { file.click(); }); }

    var box = q('aiMmPreview');
    if (box) {
      box.addEventListener('click', function (e) {
        var b = e.target && e.target.closest ? e.target.closest('[data-mm-del]') : null;
        if (!b) { return; }
        var idx = parseInt(b.getAttribute('data-mm-del'), 10);
        if (!isNaN(idx)) { pending.splice(idx, 1); renderPreview(); }
      });
    }

    /* 回车 / 发送按钮：仅在“已附图”时接管（捕获阶段先于站内内联处理器） */
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.keyCode !== 13) { return; }
      var t = e.target;
      if (!t || t.id !== 'aiChatInput') { return; }
      if (!pending.length) { return; }
      e.preventDefault();
      e.stopPropagation();
      sendMultimodal();
    }, true);
    document.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('#aiChatSendBtn') : null;
      if (!b) { return; }
      if (!pending.length) { return; }
      e.preventDefault();
      e.stopPropagation();
      sendMultimodal();
    }, true);

    /* 粘贴与拖拽图片 */
    var input = q('aiChatInput');
    if (input) {
      input.addEventListener('paste', function (e) {
        var items = (e.clipboardData && e.clipboardData.items) || [];
        var files = [];
        for (var i = 0; i < items.length; i++) {
          if (items[i].kind === 'file') { var f = items[i].getAsFile(); if (f) { files.push(f); } }
        }
        if (files.length) { e.preventDefault(); addFiles(files); }
      });
    }
    overlay.addEventListener('dragover', function (e) { e.preventDefault(); });
    overlay.addEventListener('drop', function (e) {
      var dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length) { e.preventDefault(); addFiles(dt.files); }
    });

    /* 关闭浮层时清空待发图片 */
    document.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('.ai-chat-close') : null;
      if (b) { clearPending(); }
    }, true);

    /* 打开浮层时同步一次 UI */
    document.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[onclick*="openAiChat"], .ai-fab, #fabAiBtn') : null;
      if (b) { setTimeout(function () { setModel(currentModel(), true); renderPreview(); }, 60); }
    }, true);

    setModel(currentModel(), true);
    applyLangLabels();
    try {
      new MutationObserver(applyLangLabels)
        .observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    } catch (eL) { /* 老浏览器忽略 */ }
    console.log('[AiMultimodal] 多模态+多模型已就绪 | 模型: ' + Object.keys(MODELS).join(' / ') + ' | 图片上限: ' + MAX_IMAGES + ' 张');
  }

  function boot() {
    bind();
    window.AiMultimodal = {
      __v: '1.0',
      models: MODELS,
      getModel: currentModel,
      setModel: setModel,
      pending: function () { return pending.slice(); },
      addFiles: addFiles,
      applyLang: applyLangLabels,
      state: function () {
        return { model: currentModel(), modelId: (MODELS[currentModel()] || {}).id, images: pending.length, busy: busy };
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

