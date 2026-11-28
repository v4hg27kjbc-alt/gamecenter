
(function () {
  function toast(text, ms) {
    var el = document.getElementById('gcToast');
    if (!el) { el = document.createElement('div'); el.id = 'gcToast'; el.className = 'gc-toast'; document.body.appendChild(el); }
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('on'); }, ms || 3200);
  }
  window.gcToast = toast;

  /* ---------- 1. 云记录：自动保存开关 + 自动入库 ---------- */
  function tk() { try { return localStorage.getItem('gc_acct_token') || ''; } catch (e) { return ''; } }
  function autoOn() { try { return localStorage.getItem('gc_chat_autosave') !== '0'; } catch (e) { return true; } }

  function mountAutoRow() {
    var sec = document.getElementById('gcChatSec');
    if (!sec || document.getElementById('gcChatAutoRow')) return;
    var list = document.getElementById('gcChatList');
    var row = document.createElement('div');
    row.id = 'gcChatAutoRow';
    row.className = 'gc-chat-auto';
    row.innerHTML = '<label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="gcChatAuto"' + (autoOn() ? ' checked' : '') + '> 对话结束后自动保存到云端（仅你本人可见）</label>';
    if (list && list.parentNode) list.parentNode.insertBefore(row, list);
    var cb = document.getElementById('gcChatAuto');
    if (cb) cb.addEventListener('change', function () {
      try { localStorage.setItem('gc_chat_autosave', cb.checked ? '1' : '0'); } catch (e) {}
      toast(cb.checked ? '已开启自动保存对话' : '已关闭自动保存对话', 2000);
    });
  }
  mountAutoRow();
  setInterval(mountAutoRow, 2500);

  var lastSavedKey = '';
  function autoSaveTick() {
    if (!autoOn() || !tk()) return;
    var hist = [];
    try { hist = (window.aiConversationHistory || []).slice(-100); } catch (e) { return; }
    if (!hist.length || hist.length < 2) return;
    var last = hist[hist.length - 1] || {};
    var key = hist.length + '|' + String(last.content || '').slice(0, 40);
    if (key === lastSavedKey) return;
    var title = '未命名对话';
    for (var i = hist.length - 1; i >= 0; i--) {
      if (hist[i] && hist[i].role === 'user') { title = String(hist[i].content || '').slice(0, 20) || title; break; }
    }
    lastSavedKey = key;
    fetch('/api/chat-store', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Acct-Token': tk() },
      body: JSON.stringify({ action: 'save', title: title, messages: hist })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.ok && document.getElementById('gcChatSec')) {
        var tip = document.getElementById('gcChatTip');
        if (tip) { tip.style.color = '#047857'; tip.textContent = '已自动保存到云端（共 ' + (d.total || 0) + ' 条会话）。'; }
        if (typeof window.gcLoadChats === 'function') window.gcLoadChats();
      }
    }).catch(function () { });
  }
  setInterval(autoSaveTick, 12000);

  /* ---------- 2. 门控提示：AI 关闭 / 未登录 不再表现为「没反应」 ---------- */
  var rawFetch = window.fetch;
  if (typeof rawFetch === 'function') {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var isChat = url.indexOf('/api/chat') >= 0;
      var pr = rawFetch.apply(this, arguments);
      if (!isChat) return pr;
      return pr.then(function (res) {
        var ct = res.headers.get('Content-Type') || '';
        if (ct.indexOf('application/json') >= 0 && (res.status === 503 || res.status === 403)) {
          res.clone().json().then(function (j) {
            if (!j) return;
            if (j.code === 'AI_GATE_CLOSED' || j.error === 'ai_disabled') {
              toast('AI 功能暂时维护中（站长已关闭），请稍后再试', 4200);
            } else if (j.error === 'invalid_visitor') {
              toast('访客标识已自动修复，正在重试…', 2500);
            } else if (j.error === 'token_replayed' || j.error === 'token_required') {
              toast('会话令牌已刷新，正在重试…', 2200);
            }
          }).catch(function () { });
        }
        return res;
      });
    };
  }

})();
