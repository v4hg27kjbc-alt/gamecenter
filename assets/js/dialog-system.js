
/* =====================================================================
   v70 · 阶段④ —— 全站弹窗设计系统运行时（Dialog System Runtime v2）
   ---------------------------------------------------------------------
   职责：
     ① 打标：为旧站 22 个弹窗 + overlayContainer 动态弹窗 + 图片灯箱自动
        打上 [data-dlg]/[data-dlg-self] 等设计系统属性，并注入拖拽把手；
     ② 镜像：把旧站开启类（.visible/.show/.active）镜像为 [data-dlg-open]，
        由 CSS 层据此播放入场动画（开 340ms 弹簧过冲）；
     ③ 退场：拦截用户点击的关闭路径（关闭按钮 / 遮罩空白区），改走
        「先播 200ms 非对称出场动画，再把点击回放给旧站既有处理函数」，
        即真实退场；不动 innerHTML、不自行移除元素、不改旧函数；
     ④ 拖拽：把手/顶部热区按下 → 跟手下滑、反向橡皮筋阻尼、释放弹簧回弹、
        越过阈值（面板高度 32%）直接关闭（移动端与桌面一致）；
     ⑤ 开关：window.__DLG_SYS__（on / off / status / dialogs / open / close）。

   兼容性：仅使用 pointer events（Safari 13+ / Chrome 55+）；
           全程不新增全局函数名、不改写任何既有函数与类名。
   ===================================================================== */
(function () {
  'use strict';

  var WIN = window;
  var VER = 'v2';

  /* ---------------- 0 · 幂等：同版本只初始化一次，旧版本先卸载 ---------------- */
  if (WIN.__DLG_SYS__) {
    if (WIN.__DLG_SYS__.ver === VER) {
      try { WIN.__DLG_SYS__.on(); } catch (e) {}
      return;
    }
    try { WIN.__DLG_SYS__.off(); } catch (e) {}
  }

  /* ---------------- 1 · 常量 ---------------- */
  var A_ROOT = 'data-dlg', A_SELF = 'data-dlg-self', A_OPEN = 'data-dlg-open',
      A_FORM = 'data-dlg-form', A_SIZE = 'data-dlg-size', A_SCRIM = 'data-dlg-scrim',
      C_SYS = 'dlg-sys', C_PANEL = 'dlg-panel', C_HANDLE = 'dlg-handle',
      C_CLOSE = 'dlg-close', C_NEW = 'dlg-new',
      C_DRAG = 'is-dragging', C_FREE = 'is-free', C_CLOSING = 'is-closing',
      KEY = '__dlgSys';

  var CLOSE_SEL = ['.' + C_CLOSE, '.modal-close', '.ann-modal-close', '.privacy-close',
    '.cf-close', '.cf-detail-close', '.badge-detail-close', '.ai-chat-close',
    '.ai-review-close', '.pa-close', '.kg-close', '.quiz-close'].join(',');

  var INTERACTIVE = 'button,a,input,textarea,select,label,[onclick],[data-no-drag]';

  /* 静态登记表：无面板的 fullscreen 为「自身即遮罩＋面板」；
     card 为「遮罩层 + 面板」；open 列出旧站全部开启类名（多写无副作用）。 */
  var RECS = [
    /* —— fullscreen（满屏面板）：旧站 id 自带满屏几何，本层只接管动效/圆角/把手 —— */
    { k: 'aiChat',          sel: '#aiChatOverlay',          form: 'fullscreen', size: '4', open: ['visible'] },
    { k: 'aiReview',        sel: '#aiReviewOverlay',        form: 'fullscreen', size: '4', open: ['visible'] },
    { k: 'newsPanel',       sel: '#newsPanelOverlay',       form: 'fullscreen', size: '4', open: ['visible', 'active'] },
    { k: 'aiExpo',          sel: '#aiExpoOverlay',           form: 'fullscreen', size: '4', open: ['visible', 'active'] },
    { k: 'flyBoard',        sel: '#flyBoardOverlay',         form: 'fullscreen', size: '4', open: ['visible'] },
    { k: 'quiz',            sel: '#quizOverlay',            form: 'fullscreen', size: '3', open: ['visible'] },
    { k: 'badge',           sel: '#badgeOverlay',           form: 'fullscreen', size: '3', open: ['visible'] },
    { k: 'photoAi',         sel: '#photoAiOverlay',         form: 'fullscreen', size: '4', open: ['visible'] },
    { k: 'collectAnalysis', sel: '#collectAnalysisOverlay', form: 'fullscreen', size: '3', open: ['visible'] },
    { k: 'kg',              sel: '#kgOverlay',              form: 'fullscreen', size: '4', open: ['active'] },
    /* —— card（遮罩层 + 面板）：桌面居中卡片，移动端底部抽屉 —— */
    { k: 'livery',        sel: '#liveryOverlay',        form: 'card', panel: '.livery-panel',         size: '3', scrim: '2', open: ['visible', 'show'] },
    { k: 'cabin',         sel: '#cabinOverlay',         form: 'card', panel: '.livery-panel',         size: '3', scrim: '2', open: ['visible', 'show'] },
    { k: 'recommend',     sel: '#recommendOverlay',     form: 'card', panel: '.livery-panel',         size: '3', scrim: '2', open: ['visible', 'show'] },
    { k: 'myRec',         sel: '#myRecOverlay',         form: 'card', panel: '.livery-panel',         size: '3', scrim: '2', open: ['visible', 'show'] },
    { k: 'myFb',          sel: '#myFbOverlay',          form: 'card', panel: '.livery-panel',         size: '3', scrim: '2', open: ['visible', 'show'] },
    { k: 'collectRecord', sel: '#collectRecordOverlay', form: 'card', panel: '.collect-record-panel', size: '3', scrim: '2', open: ['visible'] },
    { k: 'ann',           sel: '#annOverlay',           form: 'card', panel: '.ann-modal',            size: '2', scrim: '2', open: ['visible'] },
    { k: 'addModal',      sel: '#addModalOverlay',      form: 'card', panel: '.add-modal',            size: '2', scrim: '2', open: ['show'] },
    { k: 'feedback',      sel: '#feedbackOverlay',      form: 'card', panel: '.feedback-card',        size: '2', scrim: '2', open: ['show'] },
    { k: 'privacy',       sel: '#privacyOverlay',        form: 'card', panel: '.privacy-card',        size: '3', scrim: '2', open: ['show'] },
    { k: 'letter',        sel: '#letterOverlay',        form: 'card', panel: '.letter-card',         size: '3', scrim: '3', open: ['visible'] },
    { k: 'coldfact',      sel: '#coldfactOverlay',      form: 'card', panel: '.cf-panel',            size: '3', scrim: '3', open: ['visible'] },
    { k: 'cfDetail',      sel: '#cfDetailOverlay',      form: 'card', panel: '.cf-detail-panel',     size: '3', scrim: '3', open: ['visible'] },
    { k: 'badgeDetail',   sel: '#badgeDetailOverlay',   form: 'card', panel: '.badge-detail-card',   size: '2', scrim: '3', open: ['visible'] }
  ];

  /* overlayContainer 动态注入的弹窗（存在即开启，无类名可依） */
  var CONTAINER_CFG = {
    k: 'overlayDyn', sel: '', form: 'card', panel: '.detail-modal, .compare-modal',
    size: '3', scrim: '2', open: [], closeFn: 'closeDetail'
  };

  /* 按需生成、关闭即销毁的存在型弹窗 */
  var PRESENCE = [
    { k: 'lightbox', sel: '.image-lightbox', form: 'fullscreen', size: '4', open: [], closeFn: 'closeImageLightbox' }
  ];

  /* ---------------- 2 · 状态 ---------------- */
  var on_ = false, recs = [], hb = 0, clickBound = false, bodyMo = null, boxMo = null, obMo = null;
  var PASS = 0, HANDBACK = 0;

  /* ---------------- 3 · 小工具 ---------------- */
  function q(sel, root) { try { return (root || document).querySelector(sel); } catch (e) { return null; } }
  function numVar(el, name, fb) {
    if (!el) return fb;
    var v = getComputedStyle(el).getPropertyValue(name);
    var n = parseFloat(v);
    return isNaN(n) ? fb : n;
  }
  function msVar(el, name, fb) { return numVar(el, name, fb); }
  function inside(root, el) { return !!(root && el && (root === el || (root.contains && root.contains(el)))); }

  /* ---------------- 4 · 登记 / 解析 / 打标 ---------------- */
  function bind(cfg, el, dyn) {
    if (!el || el[KEY]) return null;
    var rec = {
      cfg: cfg, k: cfg.k || (cfg.sel + '#' + recs.length), root: el, panel: null,
      open: cfg.open || [], form: cfg.form || 'card', closeFn: cfg.closeFn || '',
      on: false, animating: false, dyn: !!dyn, drag: null, handle: null, bound: false
    };
    el[KEY] = rec;
    /* 打标：不覆盖既有属性值（作者显式写的 data-dlg-form / data-dlg-size 优先） */
    try {
      el.setAttribute(A_ROOT, '1');
      /* 作者显式声明优先：先读 data-dlg-form，再据此决定是否标记满屏面板；
         否则 <div class="dlg-new" data-dlg-form="fullscreen"> 会漏掉 data-dlg-self。 */
      var f = el.getAttribute(A_FORM);
      if (f) rec.form = f; else el.setAttribute(A_FORM, rec.form);
      if (rec.form === 'fullscreen') el.setAttribute(A_SELF, '1');
      if (cfg.size && !el.getAttribute(A_SIZE)) el.setAttribute(A_SIZE, cfg.size);
      if (cfg.scrim && !el.getAttribute(A_SCRIM)) el.setAttribute(A_SCRIM, cfg.scrim);
    } catch (e) {}
    recs.push(rec);
    /* 开启类镜像必须同步（下一帧前）完成，否则入场动画会晚一帧/一跳，
       故对 root 的 class 变更做属性级观察，而非依赖心跳轮询。 */
    if (WIN.MutationObserver) {
      rec.classMo = new MutationObserver(function () { mirror(rec); });
      try { rec.classMo.observe(el, { attributes: true, attributeFilter: ['class'] }); } catch (e) {}
    }
    /* 面板解析（存在型弹窗的面板随后才注入，故此处允许为空） */
    resolvePanel(rec);
    mirror(rec);
    return rec;
  }

  function unbind(rec) {
    if (!rec) return;
    try {
      if (rec.mo) rec.mo.disconnect();
      if (rec.classMo) rec.classMo.disconnect();
      if (rec.root) {
        rec.root.removeAttribute(A_ROOT);
        rec.root.removeAttribute(A_SELF);
        rec.root.removeAttribute(A_FORM);
        rec.root.removeAttribute(A_SIZE);
        rec.root.removeAttribute(A_SCRIM);
        rec.root.removeAttribute(A_OPEN);
        rec.root.classList.remove(C_CLOSING);
        rec.root[KEY] = null;
      }
      if (rec.panel) {
        rec.panel.classList.remove(C_PANEL, C_DRAG, C_FREE);
        rec.panel.style.removeProperty('--dlg-drag-k');
        if (rec.bound) rec.panel.removeEventListener('pointerdown', onDown, false);
        rec.panel[KEY] = null;
      }
      if (rec.handle && rec.handle.parentNode) rec.handle.parentNode.removeChild(rec.handle);
    } catch (e) {}
  }

  function resolvePanel(rec) {
    if (rec.panel) return rec.panel;
    if (rec.form === 'fullscreen') rec.panel = rec.root;
    else {
      var p = rec.cfg.panel ? q(rec.cfg.panel, rec.root) : null;
      /* 未显式声明面板时退回「根的第一个元素子节点」，以覆盖未来新增弹窗 */
      if (!p && rec.root.firstElementChild) p = rec.root.firstElementChild;
      rec.panel = p;
    }
    if (!rec.panel) return null;
    rec.panel[KEY] = rec;
    if (rec.form !== 'fullscreen') rec.panel.classList.add(C_PANEL);
    ensureHandle(rec);
    if (!rec.bound) { rec.panel.addEventListener('pointerdown', onDown, false); rec.bound = true; }
    /* 动态面板：观察其内部变化以补齐开启态镜像 */
    if (rec.dyn && WIN.MutationObserver && !rec.mo) {
      rec.mo = new MutationObserver(function () { mirror(rec); });
      try { rec.mo.observe(rec.panel, { childList: true, subtree: true }); } catch (e) {}
    }
    return rec.panel;
  }

  function ensureHandle(rec) {
    if (rec.handle || !rec.panel) return;
    var h = document.createElement('div');
    h.className = C_HANDLE;
    h.setAttribute('aria-hidden', 'true');
    rec.panel.insertBefore(h, rec.panel.firstChild);
    rec.handle = h;
  }

  /* ---------------- 5 · 开启态镜像（旧类 → [data-dlg-open]） ---------------- */
  function isOpenNow(rec) {
    var el = rec.root;
    if (!el || !el.isConnected) return false;
    if (rec.open.length) {
      for (var i = 0; i < rec.open.length; i++) if (el.classList.contains(rec.open[i])) return true;
      return false;
    }
    /* 无类名可依（动态/存在型）：以是否产生渲染盒为开启判据 */
    try { return el.getClientRects().length > 0; } catch (e) { return false; }
  }

  function mirror(rec) {
    var want = isOpenNow(rec);
    if (want === rec.on) {
      if (want && !rec.panel) resolvePanel(rec);
      return;
    }
    rec.on = want;
    if (want) {
      if (!rec.panel) resolvePanel(rec);     /* 面板注入晚于弹窗出现：此刻补解析 */
      rec.root.setAttribute(A_OPEN, '1');
    } else {
      rec.root.removeAttribute(A_OPEN);
      rec.root.classList.remove(C_CLOSING);
      rec.animating = false;
      clearDrag(rec.panel);
    }
  }

  /* ---------------- 6 · 点击拦截：真实退场 ---------------- */
  function isCloseEl(el) {
    try { if (el.matches && el.matches(CLOSE_SEL)) return true; } catch (e) {}
    var oc = el.getAttribute && el.getAttribute('onclick');
    /* 旧站存在「无关闭类、仅 inline onclick=closeXxx()」的关闭控件（如一封信） */
    return !!(oc && /\bclose[A-Za-z0-9_]*\s*\(/.test(oc));
  }

  function classify(rec, t) {
    if (!inside(rec.root, t)) return null;
    if (t === rec.root) return rec.root;                       /* 遮罩空白区 */
    var el = t, d = 0;
    while (el && el.nodeType === 1 && d < 5 && el !== rec.root) {
      if (isCloseEl(el)) return el;
      el = el.parentElement; d++;
    }
    return null;                                               /* 面板空白：不关闭 */
  }

  function onClickCapture(e) {
    if (!on_) return;
    if (PASS > 0) { PASS--; return; }                          /* 回放事件放行 */
    var t = e.target;
    if (!t || t.nodeType !== 1) return;
    for (var i = 0; i < recs.length; i++) {
      var rec = recs[i];
      if (!rec.on || rec.animating) continue;
      if (!isOpenNow(rec)) continue;
      var trig = classify(rec, t);
      if (!trig) continue;
      e.preventDefault();
      e.stopPropagation();                                     /* 推迟旧站关闭 */
      closeAnimated(rec, trig);
      return;
    }
  }

  function closeAnimated(rec, trig) {
    if (rec.animating) return;
    rec.animating = true;
    try { rec.root.classList.add(C_CLOSING); } catch (e) {}
    var wait = msVar(rec.root, '--dlg-close-dur', 200) + 20;
    setTimeout(function () {
      rec.animating = false;
      try { rec.root.classList.remove(C_CLOSING); } catch (e) {}
      clearDrag(rec.panel);
      if (rec.root.classList.contains(C_NEW)) {               /* 新弹窗：出场已播完，撤下开启态即关闭 */
        try { rec.root.removeAttribute(A_OPEN); } catch (e) {}
      } else if (trig && trig.click) {                        /* 回放旧站点关闭路径 */
        HANDBACK++;
        PASS++;
        try { trig.click(); } catch (e) { PASS--; }
      } else if (rec.closeFn && typeof WIN[rec.closeFn] === 'function') {
        try { WIN[rec.closeFn](); } catch (e) {}
      } else {
        for (var i = 0; i < rec.open.length; i++) rec.root.classList.remove(rec.open[i]);
      }
      mirror(rec);
    }, wait);
  }

  /* ---------------- 7 · 拖拽把手 + 边界橡皮筋 + 释放回弹 ---------------- */
  function clearDrag(panel) {
    if (!panel) return;
    panel.classList.remove(C_DRAG, C_FREE);
    panel.style.removeProperty('--dlg-drag-k');
  }

  function onDown(e) {
    if (!on_) return;
    var rec = this[KEY];
    if (!rec || !rec.panel || rec.animating || rec.drag) return;
    if (e.button !== undefined && e.button !== 0) return;
    if (e.pointerType === 'mouse' && e.buttons !== 1) return;
    var panel = rec.panel;
    var handle = e.target && e.target.closest ? e.target.closest('.' + C_HANDLE) : null;
    if (!handle) {
      /* 顶部热区（--dlg-handle-zone）也可发起拖拽；命中交互元素时让位 */
      var top = panel.getBoundingClientRect().top;
      var zone = numVar(panel, '--dlg-handle-zone', 56);
      var dy0 = e.clientY - top;
      var hitInteractive = e.target && e.target.closest ? e.target.closest(INTERACTIVE) : null;
      if (hitInteractive || dy0 < -4 || dy0 > zone) return;
    }
    rec.drag = { id: e.pointerId, y0: e.clientY, dy: 0, moved: false, start: 0 };
    try { panel.setPointerCapture(e.pointerId); } catch (err) {}
    panel.addEventListener('pointermove', onMove, false);
    panel.addEventListener('pointerup', onUp, false);
    panel.addEventListener('pointercancel', onUp, false);
  }

  function onMove(e) {
    if (!on_) return;
    var rec = this[KEY];
    if (!rec || !rec.drag || e.pointerId !== rec.drag.id) return;
    var panel = rec.panel, d = rec.drag;
    var dy = e.clientY - d.y0;
    d.dy = dy;
    if (!d.moved) {
      if (Math.abs(dy) < 6) return;                            /* 未越过阈值仍是点击 */
      d.moved = true;
      d.start = numVar(panel, '--dlg-drag-k', 0) || 0;
      rec.animating = true;                                    /* 拖拽期间冻结开闭动画 */
      panel.classList.add(C_DRAG);
    }
    if (e.cancelable) e.preventDefault();
    var raw = (d.start || 0) + dy;
    var R = numVar(panel, '--dlg-rubber-max', 140);
    var y = raw >= 0
      ? raw                                                    /* 关闭方向：跟手 */
      : raw * R / (R + (-raw));                                /* 反向：橡皮筋阻尼 */
    panel.style.setProperty('--dlg-drag-k', Math.round(y) + 'px');
  }

  function onUp(e) {
    if (!on_) return;
    var rec = this[KEY];
    if (!rec || !rec.drag || e.pointerId !== rec.drag.id) return;
    var panel = rec.panel, d = rec.drag;
    panel.removeEventListener('pointermove', onMove, false);
    panel.removeEventListener('pointerup', onUp, false);
    panel.removeEventListener('pointercancel', onUp, false);
    rec.drag = null;
    if (!d.moved) { rec.animating = false; return; }            /* 纯点击：不干预 */
    try { panel.releasePointerCapture(d.id); } catch (err) {}
    var ratio = numVar(panel, '--dlg-dismiss-ratio', .32);
    var h = panel.getBoundingClientRect().height || 1;
    if (d.dy > h * ratio) {                                    /* 越过阈值：关闭 */
      rec.animating = false;
      clearDrag(panel);
      closeAnimated(rec, null);
      return;
    }
    /* 未越阈值：真实回弹 —— 保持当前 --dlg-drag-k 起值，摘除冻结类让
       translate 在基态 spring 过渡下回归 0（560ms 弹簧曲线即回弹本体） */
    panel.classList.remove(C_DRAG);
    panel.classList.add(C_FREE);
    void panel.offsetHeight;                                   /* 触发一次样式重算 */
    panel.classList.remove(C_FREE);
    var dur = msVar(panel, '--dlg-spring-dur', 560) + 40;
    setTimeout(function () {
      panel.style.removeProperty('--dlg-drag-k');
      rec.animating = false;
    }, dur);
  }

  /* ---------------- 8 · 扫描 / 心跳 ---------------- */
  function scan() {
    var i, el, cfg;
    for (i = 0; i < RECS.length; i++) {
      cfg = RECS[i];
      el = q(cfg.sel);
      if (el && !el[KEY]) bind(cfg, el, false);
    }
    var box = q('#overlayContainer');
    if (box) {
      var kids = box.children;
      for (i = kids.length - 1; i >= 0; i--) {
        el = kids[i];
        if (el && !el[KEY]) bind(CONTAINER_CFG, el, true);
      }
    }
    for (i = 0; i < PRESENCE.length; i++) {
      cfg = PRESENCE[i];
      el = q(cfg.sel);
      if (el && !el[KEY]) bind(cfg, el, true);
    }
    /* 显式接入的新弹窗（.dlg-new） */
    var news = document.querySelectorAll('.' + C_NEW);
    for (i = 0; i < news.length; i++) {
      el = news[i];
      if (!el[KEY]) bind({
        k: 'dlgNew' + i, sel: '', panel: '.dlg-panel', form: 'card', open: [], size: '2', scrim: '2'
      }, el, true);
    }
    /* 回收已销毁的动态项 */
    for (i = recs.length - 1; i >= 0; i--) {
      if (recs[i].dyn && !recs[i].root.isConnected) recs.splice(i, 1);
      else mirror(recs[i]);
    }
  }

  function beat() { if (on_) scan(); }

  /* ---------------- 9 · 开关 / 自检 API ---------------- */
  function status() {
    var out = { ver: VER, on: on_, count: recs.length, opened: [], forms: {}, handback: HANDBACK };
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i];
      out.forms[r.form] = (out.forms[r.form] || 0) + 1;
      if (r.on) out.opened.push(r.k);
    }
    return out;
  }

  function dialogs() {
    return recs.map(function (r) {
      return { k: r.k, form: r.form, panel: !!r.panel, handle: !!r.handle, open: r.on, closeFn: r.closeFn };
    });
  }

  function on() {
    if (on_) return;
    on_ = true;
    document.body.classList.add(C_SYS);
    scan();
    if (!clickBound) { document.addEventListener('click', onClickCapture, true); clickBound = true; }
    if (WIN.MutationObserver) {
      if (!bodyMo) {
        bodyMo = new MutationObserver(function () { beat(); });
        try { bodyMo.observe(document.body, { childList: true }); } catch (e) {}
      }
      boxMo = q('#overlayContainer');
      if (boxMo && WIN.MutationObserver) {
        if (!obMo) {
          obMo = new MutationObserver(function () { beat(); });
          try { obMo.observe(boxMo, { childList: true }); } catch (e) {}
        }
      }
    }
    if (!hb) hb = setInterval(beat, 500);
  }

  function off() {
    if (!on_) return;
    on_ = false;
    if (hb) { clearInterval(hb); hb = 0; }
    if (clickBound) { document.removeEventListener('click', onClickCapture, true); clickBound = false; }
    if (obMo) { try { obMo.disconnect(); } catch (e) {} obMo = null; }
    if (bodyMo) { try { bodyMo.disconnect(); } catch (e) {} bodyMo = null; }
    document.body.classList.remove(C_SYS);
    for (var i = recs.length - 1; i >= 0; i--) unbind(recs[i]);
    recs.length = 0;
  }

  /* 新弹窗 API：open / close 由设计系统接管 [data-dlg-open] */
  function openEl(el) { if (el) el.setAttribute(A_OPEN, '1'); }
  function closeEl(el) {
    if (!el || !el.hasAttribute(A_OPEN)) return;
    /* 带真实退场：先播 --dlg-close-dur 出场曲线，再撤下 [data-dlg-open]，
       避免「新弹窗啪一下消失」；旧站弹窗不走这里（由 onClickCapture 回放旧关闭路径）。 */
    try { el.classList.add(C_CLOSING); } catch (e) {}
    setTimeout(function () {
      try { el.classList.remove(C_CLOSING); el.removeAttribute(A_OPEN); } catch (e) {}
      var rec = el[KEY];
      if (rec) { mirror(rec); clearDrag(rec.panel); }
    }, msVar(el, '--dlg-close-dur', 200) + 20);
  }

  WIN.__DLG_SYS__ = {
    ver: VER,
    on: on, off: off, status: status, dialogs: dialogs,
    open: openEl, close: closeEl, scan: scan, handle: ensureHandle
  };

  /* ---------------- 10 · 启动（默认开启；可 off() 一键回退） ---------------- */
  function boot() {
    if (!document.body) { setTimeout(boot, 30); return; }
    scan();
    on();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, false);
  else boot();
})();
