
/* ===== 云端聊天记录 + BYOK（自带 API Key）===== */
(function () {
  var BYOK_LS = 'gc_byok_key';
  function $(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function tk() { try { return localStorage.getItem('gc_acct_token') || ''; } catch (e) { return ''; } }
  function fmt(v) { return v ? String(v).replace('T', ' ').slice(0, 16) : '—'; }

  /* ---------- BYOK ---------- */
  function refreshByok() {
    var v = '';
    try { v = localStorage.getItem(BYOK_LS) || ''; } catch (e) {}
    var st = $('gcByokState');
    if (st) st.textContent = v ? ('已设置（' + v.slice(0, 5) + '…' + v.slice(-4) + '）') : '未设置';
    var inp = $('gcByokInput');
    if (inp && v) inp.value = v;
  }
  function bindByok() {
    if (document.body.dataset.gcByokBound === '1') return;
    document.body.dataset.gcByokBound = '1';
    var save = $('gcByokSave');
    if (save) save.addEventListener('click', function () {
      var v = (($('gcByokInput') || {}).value || '').trim();
      if (v.length < 20) { alert('Key 长度不正确，请粘贴完整的 API Key'); return; }
      if (!/^[A-Za-z0-9_\-\.]+$/.test(v)) { alert('Key 含有不支持的字符，请只粘贴申请到的 Key 本体'); return; }
      var warn = '请注意：API Key 保存在本机浏览器中，有可能会泄露，请注意隐私防护安全。\n\n本站绝不泄露您的 API Key：服务端仅在本次请求中透传使用，不写入数据库、不写入日志、不会用于其他用户。\n\n确认保存吗？';
      if (!window.confirm(warn)) return;
      try { localStorage.setItem(BYOK_LS, v); } catch (e) { alert('浏览器本地存储不可用，保存失败'); return; }
      refreshByok();
      alert('已保存。之后使用 AI 时将优先使用您自己的 Key，不再消耗本站额度。');
    });
    var clr = $('gcByokClear');
    if (clr) clr.addEventListener('click', function () {
      try { localStorage.removeItem(BYOK_LS); } catch (e) {}
      var inp = $('gcByokInput');
      if (inp) inp.value = '';
      refreshByok();
      alert('已清除本机保存的 API Key。');
    });
    refreshByok();
  }

  /* ---------- 云端聊天记录 ---------- */
  function api(body) {
    var t = tk();
    if (!t) return Promise.reject(new Error('login_required'));
    return fetch('/api/chat-store', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Acct-Token': t },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); });
  }
  function renderChats(sessions) {
    var box = $('gcChatList');
    var cnt = $('gcChatCount');
    sessions = sessions || [];
    if (cnt) cnt.textContent = sessions.length;
    if (!box) return;
    if (!sessions.length) { box.innerHTML = '<span class="gc-pf-empty">还没有云端会话</span>'; return; }
    box.innerHTML = sessions.map(function (x) {
      return '<div class="gc-pf-item" style="display:block">' +
        '<div style="display:flex;justify-content:space-between;gap:8px;align-items:center">' +
        '<b style="font-size:13px">' + esc(x.title || '未命名对话') + '</b>' +
        '<span style="font-size:12px;color:#64748b">' + esc(fmt(x.updatedAt)) + '</span></div>' +
        '<div style="font-size:12px;color:#64748b;margin-top:4px">' + esc(x.count || 0) + ' 条消息 · ' + esc(x.convId || '') + '</div>' +
        '<div style="margin-top:8px;display:flex;gap:8px"><button class="gc-pf-btn primary" data-load="' + esc(x.convId) + '" type="button" style="padding:6px 12px;font-size:12.5px">载入到对话</button>' +
        '<button class="gc-pf-btn" data-del="' + esc(x.convId) + '" type="button" style="padding:6px 12px;font-size:12.5px">删除</button></div></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-del]'), function (b) {
      b.addEventListener('click', function () {
        if (!confirm('删除后不可恢复，确认删除这条云端会话？')) return;
        api({ action: 'del', convId: b.getAttribute('data-del') }).then(loadChats).catch(function () { alert('删除失败，请稍后重试'); });
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-load]'), function (b) {
      b.addEventListener('click', function () {
        var cid = b.getAttribute('data-load');
        api({ action: 'get', convId: cid }).then(function (d) {
          if (!d || !d.messages) { alert('会话不存在或已删除'); return; }
          try { window.aiConversationHistory = d.messages.slice(-40); } catch (e) {}
          var tip = $('gcChatTip');
          if (tip) { tip.style.color = '#047857'; tip.textContent = '已载入「' + (d.title || '未命名对话') + '」（' + d.messages.length + ' 条），回到 AI 对话即可继续提问。'; }
        }).catch(function () { alert('载入失败，请稍后重试'); });
      });
    });
  }
  function loadChats() {
    if (!tk()) {
      var box = $('gcChatList');
      if (box) box.innerHTML = '<span class="gc-pf-empty">登录后可使用云端聊天记录</span>';
      return;
    }
    api({ action: 'list' }).then(function (d) {
      if (d && d.ok) renderChats(d.sessions || []);
    }).catch(function () {});
  }
  function bindChat() {
    if (document.body.dataset.gcChatBound === '1') return;
    document.body.dataset.gcChatBound = '1';
    var save = $('gcChatSave');
    if (save) save.addEventListener('click', function () {
      var hist = [];
      try { hist = (window.aiConversationHistory || []).slice(-100); } catch (e) { hist = []; }
      if (!hist.length) { alert('当前还没有可保存的对话内容，先去和 AI 聊几句吧'); return; }
      var title = '未命名对话';
      for (var i = hist.length - 1; i >= 0; i--) {
        if (hist[i] && hist[i].role === 'user') { title = String(hist[i].content || '').slice(0, 20) || title; break; }
      }
      var tip = $('gcChatTip');
      api({ action: 'save', title: title, messages: hist }).then(function (d) {
        if (d && d.ok) {
          if (tip) { tip.style.color = '#047857'; tip.textContent = '已保存到云端（' + d.total + ' 条会话）。'; }
          loadChats();
        } else {
          alert((d && d.message) || '保存失败，请稍后重试');
        }
      }).catch(function (e) {
        alert(e && e.message === 'login_required' ? '请先登录后再保存到云端' : '保存失败，请稍后重试');
      });
    });
    var rf = $('gcChatRefresh');
    if (rf) rf.addEventListener('click', loadChats);
    loadChats();
  }

  function boot() {
    bindByok();
    bindChat();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  setTimeout(boot, 1200);
})();
