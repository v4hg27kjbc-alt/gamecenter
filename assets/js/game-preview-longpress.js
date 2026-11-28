
/* ===========================================================================
   游戏预告卡 · 长按详情（长按手势统一入口 + 单例弹层 + 视频降级）
   —— 长按手势统一入口：document 级事件委托（capture）+ 500ms / 10px 阈值
   —— 单例弹层：填充式打开、清空式关闭、暂停媒体、不重复注入 DOM
   —— 动效一致性：按压 / 进度 / 入场 / 关闭时长与曲线全部取自站点既有
      CSS 变量（--dur-450 / --dur-250 / --ease-out-expo / --ease-standard），
      弹层入场复用站点既有 @keyframes overlayIn 与 modalSlideIn，不另造动画
   —— 宣传片：相对路径 + preload=metadata，失败时优雅降级为封面与提示
   =========================================================================== */
(function () {
  "use strict";

  if (window.__rlnSheetInit) { return; }
  window.__rlnSheetInit = true;

  var HOLD_MS = 500;
  var MOVE_PX = 10;
  var CLOSE_MS = 250;


  var mask = document.getElementById("rlnSheet");
  if (!mask) { return; }

  var kickerEl = mask.querySelector(".rln-sheet-kicker");
  var titleEl = mask.querySelector(".rln-sheet-title");
  var bodyEl = mask.querySelector(".rln-sheet-body");
  var closeBtn = mask.querySelector(".rln-sheet-close");

  var META = {
    game: { kicker: "游戏预告", title: "无应答 NO REPLY" }
  };

  var TPL = {
    game: "rlnTplGame"
  };

  var pressTimer = null;
  var pressEl = null;
  var startX = 0;
  var startY = 0;
  var suppressClick = false;
  var lastFocus = null;
  var closeTimer = null;

  function cancelPress() {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    if (pressEl && pressEl.classList) { pressEl.classList.remove("rln-pressing"); }
    pressEl = null;
  }

  function bindMedia(root) {
    var vids = root.querySelectorAll("video[data-rln-video]");
    for (var i = 0; i < vids.length; i++) {
      (function (v) {
        var wrap = v.closest ? v.closest(".rln-video") : v.parentNode;
        function degrade() {
          if (!wrap) { return; }
          wrap.classList.remove("is-ready");
          wrap.classList.add("is-fallback");
        }
        v.addEventListener("error", degrade);
        v.addEventListener("loadedmetadata", function () {
          if (!wrap) { return; }
          wrap.classList.remove("is-fallback");
          wrap.classList.add("is-ready");
        });
        if (v.error) { degrade(); }
      })(vids[i]);
    }
  }

  function pauseMedia(root) {
    var vids = root.querySelectorAll("video");
    for (var i = 0; i < vids.length; i++) {
      try { vids[i].pause(); } catch (err) { /* noop */ }
    }
  }

  function openSheet(key) {
    var tplId = TPL[key];
    var tpl = tplId ? document.getElementById(tplId) : null;
    if (!tpl) { return; }

    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
      mask.classList.remove("is-closing");
    }

    var meta = META[key] || { kicker: "发布公告", title: "详情" };
    if (kickerEl) { kickerEl.textContent = meta.kicker; }
    if (titleEl) { titleEl.textContent = meta.title; }

    bodyEl.innerHTML = "";
    bodyEl.appendChild(tpl.content.cloneNode(true));
    bindMedia(bodyEl);

    lastFocus = document.activeElement;
    mask.hidden = false;
    document.documentElement.classList.add("rln-lock");
    void mask.offsetWidth;
    mask.classList.add("is-open");

    if (closeBtn) {
      try { closeBtn.focus({ preventScroll: true }); }
      catch (err) { try { closeBtn.focus(); } catch (e2) { /* noop */ } }
    }
  }

  function closeSheet() {
    if (mask.hidden || mask.classList.contains("is-closing")) { return; }
    pauseMedia(bodyEl);
    document.documentElement.classList.remove("rln-lock");
    mask.classList.remove("is-open");
    mask.classList.add("is-closing");
    if (closeTimer) { clearTimeout(closeTimer); }
    closeTimer = setTimeout(function () {
      closeTimer = null;
      mask.classList.remove("is-closing");
      mask.hidden = true;
      bodyEl.innerHTML = "";
      if (lastFocus && typeof lastFocus.focus === "function") {
        try { lastFocus.focus({ preventScroll: true }); } catch (err) { /* noop */ }
      }
      lastFocus = null;
    }, CLOSE_MS);
  }

  // 供同批特性复用（如游戏预告卡）
  window.__rlnOpenSheet = openSheet;

  function onPointerDown(e) {
    if (!e.target || !e.target.closest) { return; }
    if (e.target.closest("[data-no-sheet]")) { return; }
    if (e.pointerType === "mouse" && e.button !== 0) { return; }
    var card = e.target.closest("[data-rln-sheet]");
    if (!card) { return; }
    cancelPress();
    pressEl = card;
    startX = e.clientX;
    startY = e.clientY;
    card.classList.add("rln-pressing");
    pressTimer = setTimeout(function () {
      pressTimer = null;
      var el = pressEl;
      cancelPress();
      if (!el) { return; }
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 650);
      if (navigator.vibrate) { try { navigator.vibrate(18); } catch (err) { /* noop */ } }
      openSheet(el.getAttribute("data-rln-sheet"));
    }, HOLD_MS);
  }

  function onPointerMove(e) {
    if (!pressTimer) { return; }
    if (Math.abs(e.clientX - startX) > MOVE_PX || Math.abs(e.clientY - startY) > MOVE_PX) {
      cancelPress();
    }
  }

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerup", cancelPress, true);
  document.addEventListener("pointercancel", cancelPress, true);

  // 长按命中后抑制随之而来的 click
  document.addEventListener("click", function (e) {
    if (!suppressClick || !e.target || !e.target.closest) { return; }
    if (e.target.closest("[data-rln-sheet]")) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  // 卡片长按期间不唤出系统菜单
  document.addEventListener("contextmenu", function (e) {
    if (e.target && e.target.closest && e.target.closest("[data-rln-sheet]")) {
      e.preventDefault();
    }
  });

  // 键盘可达：卡片 Enter / Space 打开；Esc 关闭（打开时优先处理，不打扰站内弹窗）
  document.addEventListener("keydown", function (e) {
    var key = e.key;
    var code = e.keyCode;
    if (key === "Escape" || code === 27) {
      if (!mask.hidden) {
        e.stopPropagation();
        closeSheet();
      }
      return;
    }
    if (key !== "Enter" && key !== " " && key !== "Spacebar" && code !== 13 && code !== 32) { return; }
    if (!e.target || !e.target.closest) { return; }
    var card = e.target.closest("[data-rln-sheet]");
    if (!card) { return; }
    e.preventDefault();
    openSheet(card.getAttribute("data-rln-sheet"));
  }, true);

  // 关闭：按钮 / 遮罩 / Esc
  if (closeBtn) { closeBtn.addEventListener("click", closeSheet); }
  mask.addEventListener("click", function (e) { if (e.target === mask) { closeSheet(); } });
})();
