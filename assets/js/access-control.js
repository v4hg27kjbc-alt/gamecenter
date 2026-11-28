
(function () {
  'use strict';
  var ACCESS_KEY = 'aviation_ai_unlocked';
  function getVisitorId() {
    try {
      var v = localStorage.getItem('aviation_visitor_id');
      if (v) return v;
      v = 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      localStorage.setItem('aviation_visitor_id', v);
      return v;
    } catch (e) { return ''; }
  }
  function isAiUnlocked() {
    try { return localStorage.getItem(ACCESS_KEY) === '1'; } catch (e) { return false; }
  }
  function setAiUnlocked() {
    try { localStorage.setItem(ACCESS_KEY, '1'); } catch (e) {}
  }
  function showMaintenance(cfg) {
    var ov = document.getElementById('siteMaintenanceOverlay');
    if (!ov) return;
    var emojiEl = document.getElementById('mntEmoji');
    if (emojiEl) {
      if (cfg && cfg.assetUrl) {
        emojiEl.innerHTML = '<img class="mnt-gif" src="' + cfg.assetUrl + '" alt="maintenance">';
      } else {
        emojiEl.textContent = (cfg && cfg.emoji) || '\uD83D\uDD27';
      }
    }
    var titleEl = document.getElementById('mntTitle');
    if (titleEl) titleEl.textContent = (cfg && cfg.message) || '站点维护中';
    var subEl = document.getElementById('mntSub');
    if (subEl) subEl.textContent = (cfg && cfg.subMessage) || '我们正在对系统进行例行维护与升级，请稍后再试。感谢您的理解与支持。';
    ov.classList.add('visible');
    ov.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }
  var BLOCK_TEXT = '已拉入黑名单，服务暂停，如有异议请联系站长';
  var blockCfg = null;
  function showBlockCard(cfg) {
    var card = document.getElementById('siteBlockCard');
    if (!card) return;
    blockCfg = cfg || {};
    window.__siteBlocked = true;
    var txt = document.getElementById('blkText');
    if (txt) txt.textContent = BLOCK_TEXT;
    /* 违规原因：后台配置的 blockReason / reason 直接展示给用户 */
    var reasonText = String((cfg && (cfg.blockReason || cfg.reason)) || '').trim();
    var rEl = document.getElementById('blkReason');
    if (rEl) {
      if (reasonText) { rEl.style.display = ''; rEl.textContent = '限制原因：' + reasonText; }
      else { rEl.style.display = 'none'; rEl.textContent = ''; }
    }
    var btn = document.getElementById('blkAppealBtn');
    if (btn) {
      btn.onclick = function () {
        var ta = document.getElementById('blkAppealText');
        var note = ta ? String(ta.value || '').trim() : '';
        btn.disabled = true;
        btn.textContent = '提交中…';
        fetch('/api/account', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'appeal', note: note, visitorId: getVisitorId(), page: location.href, reason: reasonText })
        }).then(function (r) { return r.json().catch(function () { return null; }); }).then(function (res) {
          btn.disabled = false;
          btn.textContent = '提交申诉';
          if (res && res.ok) {
            btn.textContent = '已提交，等待站长处理';
            if (ta) ta.value = '';
            var tx = document.getElementById('blkText');
            if (tx) tx.textContent = BLOCK_TEXT + '（申诉已收到）';
          } else {
            btn.textContent = '提交失败，请稍后重试';
          }
        }).catch(function () {
          btn.disabled = false;
          btn.textContent = '提交失败，请稍后重试';
        });
      };
    }
    var go = document.getElementById('blkAppealGo');
    if (go) {
      go.onclick = function () {
        window.open((cfg && cfg.appealUrl) || 'https://henry126923-admincenter.pages.dev', '_blank', 'noopener');
      };
    }
    card.classList.add('visible');
    card.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }
  /* 全站统一入口：任何模式（AI 各功能、登录、收藏、详情）检测到黑名单都走这里 */
  window.__siteBlockCard = function (cfg) { try { showBlockCard(cfg || {}); } catch (e) {} };
  function applyAiGate(gated) {
    var btn = document.getElementById('aiChatBtn');
    if (!btn) return;
    if (gated && !isAiUnlocked()) {
      btn.classList.add('ai-gated');
      var span = document.getElementById('aiChatBtnText');
      if (span) {
        var txt = span.textContent;
        if (txt.indexOf('问 AI') !== -1) span.textContent = txt.replace('问 AI', 'AI 未解锁');
        else if (txt.indexOf('Ask AI') !== -1) span.textContent = txt.replace('Ask AI', 'AI locked');
      }
    }
    if (window.__origOpenAiChat) return;
    window.__origOpenAiChat = window.openAiChat;
    window.openAiChat = function () {
      if (gated && !isAiUnlocked()) return;
      return window.__origOpenAiChat.apply(this, arguments);
    };
  }
  function init() {
    fetch('/api/maintenance', {
      method: 'GET',
      credentials: 'include',
      headers: { 'X-Visitor-Id': getVisitorId() }
    }).then(function (res) {
      if (!res.ok) return null;
      return res.json();
    }).then(function (data) {
      if (!data || data.ok !== true) return;
      if (data.status === 'maintenance') {
        showMaintenance(data.maintenance || {});
      } else if (data.status === 'blocked') {
        showBlockCard(data.blocked || {});
      } else {
        applyAiGate(data.aiGate === true);
      }
    }).catch(function () { /* 接口不可用默认放行 */ });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  window.__accessControlUnlock = setAiUnlocked;
})();
