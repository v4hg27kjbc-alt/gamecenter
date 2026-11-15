/* ============================================================
 * 民航客机收藏馆 · v3.5 前端增强包
 * 1) 首页开屏弹窗广告（含 C919 免费上线）
 * 2) 「问AI」板块内嵌小广告 → 点击直达对应模块
 * 3) AI 对话记录侧边栏（自动保存 + 就地展开阅读）
 * 4) 站内通知中心（未读角标 + 详情）
 * 5) 待支付订单浮条（1 小时回滚 / 24 小时取消提示）
 * ============================================================ */
(function () {
  'use strict';
  if (window.__GC_V35__) return;
  window.__GC_V35__ = true;

  var LS = {
    token: 'gc_acct_token',
    conv: 'gc_cur_conv_v35',
    chatLocal: 'gc_chat_local_v35',
    adSeen: 'gc_ad_open_v35'
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function tk() { try { return localStorage.getItem(LS.token) || ''; } catch (e) { return ''; } }
  function isHome() {
    var p = location.pathname.replace(/\/+$/, '');
    return p === '' || p === '/index.html';
  }

  /* -------------------- 通用提示 -------------------- */
  var toastEl = null;
  function toast(text, ms) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'gcV35Toast';
      toastEl.style.cssText = 'position:fixed;left:50%;bottom:40px;transform:translateX(-50%) translateY(12px);z-index:2147483600;' +
        'background:rgba(15,23,42,.93);color:#fff;font-size:13px;line-height:1.6;padding:11px 20px;border-radius:999px;max-width:82vw;' +
        'opacity:0;transition:opacity .26s,transform .26s;pointer-events:none;text-align:center;' +
        'font-family:-apple-system,"PingFang SC",sans-serif;box-shadow:0 14px 34px rgba(0,0,0,.28)';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    requestAnimationFrame(function () {
      toastEl.style.opacity = '1';
      toastEl.style.transform = 'translateX(-50%) translateY(0)';
    });
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(function () {
      toastEl.style.opacity = '0';
      toastEl.style.transform = 'translateX(-50%) translateY(12px)';
    }, ms || 2400);
  }

  /* ============================================================
   * 1) 首页开屏弹窗广告
   * ============================================================ */
  var AD_CSS = ''
    + '.gcv-mask{position:fixed;inset:0;background:rgba(8,18,33,.5);backdrop-filter:blur(4px);z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:18px;opacity:0;transition:opacity .3s}'
    + '.gcv-mask.on{opacity:1}'
    + '.gcv-ad{position:relative;width:100%;max-width:430px;background:#fff;border-radius:22px;overflow:hidden;box-shadow:0 34px 80px rgba(8,18,33,.4);transform:translateY(20px) scale(.96);transition:transform .38s cubic-bezier(.34,1.42,.64,1)}'
    + '.gcv-mask.on .gcv-ad{transform:none}'
    + '.gcv-ad-hero{position:relative;padding:26px 24px 22px;background:linear-gradient(135deg,#0b2340,#164a8a 55%,#2f6fd0);color:#fff;overflow:hidden}'
    + '.gcv-ad-hero::after{content:"";position:absolute;right:-50px;top:-60px;width:200px;height:200px;border-radius:50%;background:rgba(255,255,255,.1)}'
    + '.gcv-ad-hero::before{content:"";position:absolute;right:44px;bottom:-70px;width:140px;height:140px;border-radius:50%;background:rgba(255,255,255,.07)}'
    + '.gcv-ad-badge{display:inline-block;font-size:11.5px;letter-spacing:.6px;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.32);border-radius:999px;padding:3px 11px;margin-bottom:12px}'
    + '.gcv-ad-h{font-size:21px;font-weight:800;letter-spacing:.3px;margin:0 0 8px;position:relative;z-index:1}'
    + '.gcv-ad-sub{font-size:13px;line-height:1.75;opacity:.92;margin:0;position:relative;z-index:1;max-width:330px}'
    + '.gcv-ad-body{padding:18px 22px 20px}'
    + '.gcv-ad-list{list-style:none;margin:0 0 16px;padding:0}'
    + '.gcv-ad-list li{display:flex;gap:9px;align-items:flex-start;font-size:13px;color:#3f5266;line-height:1.7;margin-bottom:8px}'
    + '.gcv-ad-list i{flex:0 0 17px;height:17px;border-radius:50%;background:#e8f3ff;color:#2f6fd0;font-size:11px;font-style:normal;display:flex;align-items:center;justify-content:center;margin-top:3px;font-weight:700}'
    + '.gcv-ad-btns{display:flex;gap:10px}'
    + '.gcv-ad-btn{flex:1;border:0;border-radius:12px;padding:12.5px;font-size:14px;font-weight:700;cursor:pointer;transition:transform .16s,box-shadow .2s}'
    + '.gcv-ad-btn.pri{background:linear-gradient(135deg,#2f6fd0,#1b4b96);color:#fff;box-shadow:0 10px 24px rgba(47,111,208,.34)}'
    + '.gcv-ad-btn.pri:hover{transform:translateY(-2px);box-shadow:0 14px 28px rgba(47,111,208,.42)}'
    + '.gcv-ad-btn.sec{flex:0 0 112px;background:#f2f6fc;color:#40566e;border:1px solid #e2ebf6}'
    + '.gcv-ad-btn.sec:hover{background:#e9f1fb}'
    + '.gcv-ad-x{position:absolute;right:12px;top:12px;width:30px;height:30px;border-radius:50%;border:0;background:rgba(255,255,255,.16);color:#fff;font-size:16px;line-height:1;cursor:pointer;z-index:2}'
    + '.gcv-ad-x:hover{background:rgba(255,255,255,.3)}'
    + '.gcv-ad-foot{padding:0 22px 16px;font-size:11.5px;color:#9aa8bb;text-align:center}';

  function styleOnce(id, css) {
    if (document.getElementById(id)) return;
    var s = document.createElement('style');
    s.id = id;
    s.textContent = css;
    document.head.appendChild(s);
  }

  function showOpenAd() {
    styleOnce('gcV35AdCss', AD_CSS);
    var mask = document.createElement('div');
    mask.className = 'gcv-mask';
    mask.id = 'gcV35Ad';
    mask.innerHTML = ''
      + '<div class="gcv-ad" role="dialog" aria-label="站点公告">'
      + '<button class="gcv-ad-x" id="gcAdX" aria-label="关闭">&times;</button>'
      + '<div class="gcv-ad-hero">'
      + '<span class="gcv-ad-badge">新报告上线 · 永久免费</span>'
      + '<h3 class="gcv-ad-h">C919 综合研究报告 · 免费开放</h3>'
      + '<p class="gcv-ad-sub">国产大飞机全链路梳理：项目沿革、总体与气动、供应链、取证历程与商业运营。无需券码、无需登录。</p>'
      + '</div>'
      + '<div class="gcv-ad-body">'
      + '<ul class="gcv-ad-list">'
      + '<li><i>1</i><span>C919 报告全文在线研读，永久免费</span></li>'
      + '<li><i>2</i><span>支持一键下载 Markdown 文档留存</span></li>'
      + '<li><i>3</i><span>737 / A320 深度报告限时 ¥5 解锁</span></li>'
      + '</ul>'
      + '<div class="gcv-ad-btns">'
      + '<button class="gcv-ad-btn pri" id="gcAdGo">免费阅读 C919</button>'
      + '<button class="gcv-ad-btn sec" id="gcAdLater">稍后再说</button>'
      + '</div></div>'
      + '<div class="gcv-ad-foot">本次浏览不再打扰 · 可在「问AI」板块随时进入</div>'
      + '</div>';
    document.body.appendChild(mask);
    requestAnimationFrame(function () { mask.classList.add('on'); });

    function close() {
      mask.classList.remove('on');
      setTimeout(function () { mask.parentNode && mask.parentNode.removeChild(mask); }, 320);
      try { sessionStorage.setItem(LS.adSeen, '1'); } catch (e) {}
    }
    $('gcAdX').onclick = close;
    $('gcAdLater').onclick = close;
    $('gcAdGo').onclick = function () { close(); location.href = '/read/c919.html'; };
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
  }

  /* ============================================================
   * 2)「问AI」板块内嵌小广告
   * ============================================================ */
  function injectAiMiniAd() {
    var host = document.querySelector('#aiChatOverlay .av-ai-badges');
    if (!host || document.getElementById('gcAiMiniAd')) return;
    var ad = document.createElement('a');
    ad.id = 'gcAiMiniAd';
    ad.href = '/read/c919.html';
    ad.style.cssText = 'display:flex;align-items:center;gap:8px;margin:8px 12px 0;padding:8px 12px;border-radius:11px;' +
      'background:linear-gradient(135deg,#eef5ff,#e6f0ff);border:1px solid #d6e6fb;color:#1e4fa3;font-size:12.5px;' +
      'text-decoration:none;transition:transform .16s,box-shadow .2s;line-height:1.4';
    ad.innerHTML = '<span style="flex:0 0 auto;background:#2f6fd0;color:#fff;border-radius:6px;padding:1px 6px;font-size:11px;font-weight:700">FREE</span>'
      + '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">C919 综合研究报告已免费开放，点此直接阅读 →</span>';
    ad.addEventListener('mouseenter', function () { ad.style.transform = 'translateY(-1px)'; ad.style.boxShadow = '0 8px 18px rgba(47,111,208,.18)'; });
    ad.addEventListener('mouseleave', function () { ad.style.transform = 'none'; ad.style.boxShadow = 'none'; });
    ad.addEventListener('click', function () {
      try { window.gcTrack && window.gcTrack('ad_ai_mini', { to: 'c919' }); } catch (e) {}
    });
    host.parentNode.insertBefore(ad, host.nextSibling);
  }

  /* ============================================================
   * 3) AI 对话记录侧边栏
   * ============================================================ */
  var DOCK_CSS = ''
    + '.gcv-dock-btn{position:fixed;right:18px;bottom:152px;z-index:99991;width:46px;height:46px;border-radius:14px;border:0;cursor:pointer;'
    + 'background:linear-gradient(135deg,#38bdf8,#2f6fd0);color:#fff;box-shadow:0 10px 24px rgba(47,111,208,.36);display:flex;align-items:center;justify-content:center;'
    + 'transition:transform .2s cubic-bezier(.34,1.5,.64,1),box-shadow .2s}'
    + '.gcv-dock-btn:hover{transform:translateY(-3px) scale(1.05);box-shadow:0 15px 30px rgba(47,111,208,.46)}'
    + '.gcv-dock-btn svg{width:22px;height:22px}'
    + '.gcv-dock{position:fixed;right:0;top:0;bottom:0;width:min(376px,92vw);z-index:2147483500;background:#fbfcfe;border-left:1px solid #e4ecf7;'
    + 'box-shadow:-18px 0 48px rgba(15,23,42,.14);transform:translateX(104%);transition:transform .32s cubic-bezier(.4,0,.2,1);display:flex;flex-direction:column}'
    + '.gcv-dock.on{transform:none}'
    + '.gcv-dock-mask{position:fixed;inset:0;background:rgba(10,20,36,.38);backdrop-filter:blur(2px);z-index:2147483490;opacity:0;pointer-events:none;transition:opacity .28s}'
    + '.gcv-dock-mask.on{opacity:1;pointer-events:auto}'
    + '.gcv-dock-head{display:flex;align-items:center;gap:10px;padding:15px 16px;border-bottom:1px solid #e9eef7;background:#fff}'
    + '.gcv-dock-head b{font-size:14.5px;color:#12243a}'
    + '.gcv-dock-head .cnt{font-size:11.5px;color:#7d8ca0;background:#f1f5fb;border-radius:999px;padding:2px 9px}'
    + '.gcv-dock-head .x{margin-left:auto;border:0;background:#f1f4fa;color:#64748b;width:29px;height:29px;border-radius:9px;cursor:pointer;font-size:16px;line-height:1}'
    + '.gcv-dock-body{flex:1;overflow:auto;padding:12px 14px 20px}'
    + '.gcv-dock-empty{font-size:12.5px;color:#8593a6;line-height:1.8;padding:26px 8px;text-align:center}'
    + '.gcv-conv{border:1px solid #e6edf7;border-radius:13px;background:#fff;padding:11px 12px;margin-bottom:9px;cursor:pointer;transition:border-color .18s,box-shadow .2s,transform .18s}'
    + '.gcv-conv:hover{border-color:#c9dffa;box-shadow:0 8px 20px rgba(47,111,208,.12);transform:translateY(-1px)}'
    + '.gcv-conv .t{display:flex;justify-content:space-between;gap:8px;align-items:baseline}'
    + '.gcv-conv .ti{font-size:13px;font-weight:700;color:#12243a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.gcv-conv .tm{flex:0 0 auto;font-size:11px;color:#9aa8bb}'
    + '.gcv-conv .ex{font-size:12px;color:#7d8ca0;margin-top:4px;line-height:1.6;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}'
    + '.gcv-conv .ops{display:flex;gap:8px;margin-top:8px}'
    + '.gcv-conv .ops button{border:1px solid #e2ebf6;background:#fff;color:#3d6b9e;font-size:11.5px;border-radius:8px;padding:4px 10px;cursor:pointer}'
    + '.gcv-conv .ops button:hover{background:#f2f8ff}'
    + '.gcv-conv .ops button.del{color:#b45309;border-color:#f0e0cc}'
    + '.gcv-msgs{padding:4px 2px 8px}'
    + '.gcv-msg{margin-bottom:11px;display:flex;gap:8px}'
    + '.gcv-msg .av{flex:0 0 26px;height:26px;border-radius:9px;font-size:11px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700}'
    + '.gcv-msg.u .av{background:#2f6fd0}'
    + '.gcv-msg.a .av{background:#12b886}'
    + '.gcv-msg .bd{flex:1;min-width:0;background:#fff;border:1px solid #e9eff8;border-radius:11px;padding:9px 11px;font-size:12.8px;line-height:1.72;color:#2b3b4d;white-space:pre-wrap;word-break:break-word}'
    + '.gcv-back{display:inline-flex;align-items:center;gap:5px;border:1px solid #e2ebf6;background:#fff;color:#3d6b9e;font-size:12px;border-radius:8px;padding:5px 11px;cursor:pointer;margin-bottom:10px}'
    + '.gcv-dock-foot{padding:10px 14px;border-top:1px solid #e9eef7;background:#fff;display:flex;gap:8px}'
    + '.gcv-dock-foot button{flex:1;border:1px solid #dfe8f3;background:#fff;border-radius:10px;padding:9px;font-size:12.5px;color:#476179;cursor:pointer}'
    + '.gcv-dock-foot button.pri{background:linear-gradient(135deg,#2f6fd0,#1b4b96);color:#fff;border:0;font-weight:600}';

  var chatCache = { list: [], detail: null };

  function chatApi(body) {
    var t = tk();
    return fetch('/api/chat-store', {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Acct-Token': t || '' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); });
  }

  function localSessions() {
    try {
      var arr = JSON.parse(localStorage.getItem(LS.chatLocal) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function saveLocal(arr) {
    try { localStorage.setItem(LS.chatLocal, JSON.stringify(arr.slice(0, 60))); } catch (e) {}
  }
  function mergeSessions(remote) {
    var map = {}, out = [];
    (remote || []).forEach(function (x) { if (x && x.convId) { map[x.convId] = 1; out.push(x); } });
    localSessions().forEach(function (x) { if (x && x.convId && !map[x.convId]) out.push(x); });
    out.sort(function (a, b) { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); });
    return out;
  }

  function fmtTime(t) {
    if (!t) return '';
    var d = new Date(t);
    if (isNaN(d.getTime())) return String(t).slice(0, 16);
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    if (sameDay) return p(d.getHours()) + ':' + p(d.getMinutes());
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function buildDock() {
    if (document.getElementById('gcChatDockBtn')) return;
    styleOnce('gcV35DockCss', DOCK_CSS);

    var btn = document.createElement('button');
    btn.id = 'gcChatDockBtn';
    btn.className = 'gcv-dock-btn';
    btn.title = 'AI 对话记录';
    btn.setAttribute('aria-label', '打开 AI 对话记录');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 21l1.9-4.1a8.4 8.4 0 0 1-.9-3.9 8.4 8.4 0 0 1 8.5-8.5 8.4 8.4 0 0 1 8.5 7z"/>'
      + '<line x1="8" y1="11" x2="16" y2="11"/><line x1="8" y1="14.6" x2="13" y2="14.6"/></svg>';
    btn.style.display = 'none';   /* v3.5.1 撤回悬浮按钮 */
    document.body.appendChild(btn);

    var mask = document.createElement('div');
    mask.className = 'gcv-dock-mask';
    mask.id = 'gcChatDockMask';
    document.body.appendChild(mask);

    var dock = document.createElement('aside');
    dock.className = 'gcv-dock';
    dock.id = 'gcChatDock';
    dock.innerHTML = ''
      + '<div class="gcv-dock-head"><b>AI 对话记录</b><span class="cnt" id="gcDockCnt">0</span>'
      + '<button class="x" id="gcDockX" aria-label="关闭">&times;</button></div>'
      + '<div class="gcv-dock-body" id="gcDockBody"></div>'
      + '<div class="gcv-dock-foot"><button class="pri" id="gcDockSave">保存当前对话</button><button id="gcDockRefresh">刷新</button></div>';
    document.body.appendChild(dock);

    $('gcDockX').onclick = closeDock;
    mask.onclick = closeDock;
    $('gcDockRefresh').onclick = function () { loadList(true); };
    $('gcDockSave').onclick = function () { autoSave(true); };
  }

  function openDock() {
    buildDock();
    $('gcChatDockMask').classList.add('on');
    $('gcChatDock').classList.add('on');
    loadList(true);
  }
  function closeDock() {
    var d = $('gcChatDock'), m = $('gcChatDockMask');
    if (d) d.classList.remove('on');
    if (m) m.classList.remove('on');
  }

  function renderList() {
    var box = $('gcDockBody');
    var cnt = $('gcDockCnt');
    if (!box) return;
    var list = chatCache.list;
    if (cnt) cnt.textContent = list.length;
    if (!tk()) {
      box.innerHTML = '<div class="gcv-dock-empty">登录后对话会自动云端同步，换设备也能看到。<br>未登录状态下这里只显示本机最近记录。</div>'
        + renderCards(list);
      bindCards();
      return;
    }
    if (!list.length) {
      box.innerHTML = '<div class="gcv-dock-empty">还没有对话记录。<br>去「问AI」聊几句，记录会自动保存到这里。</div>';
      return;
    }
    box.innerHTML = renderCards(list);
    bindCards();
  }

  function renderCards(list) {
    if (!list || !list.length) return '';
    return list.map(function (x) {
      return '<div class="gcv-conv" data-cid="' + esc(x.convId) + '">'
        + '<div class="t"><span class="ti">' + esc(x.title || '未命名对话') + '</span><span class="tm">' + esc(fmtTime(x.updatedAt)) + '</span></div>'
        + '<div class="ex">' + esc(x.preview || (x.count ? x.count + ' 条消息' : '')) + '</div>'
        + '<div class="ops"><button data-open="' + esc(x.convId) + '">展开</button>'
        + '<button data-into="' + esc(x.convId) + '">载入问AI</button>'
        + '<button class="del" data-del="' + esc(x.convId) + '">删除</button></div>'
        + '</div>';
    }).join('');
  }

  function bindCards() {
    var body = $('gcDockBody');
    if (!body) return;
    Array.prototype.forEach.call(body.querySelectorAll('[data-open]'), function (b) {
      b.onclick = function (e) { e.stopPropagation(); openConv(b.getAttribute('data-open')); };
    });
    Array.prototype.forEach.call(body.querySelectorAll('[data-into]'), function (b) {
      b.onclick = function (e) { e.stopPropagation(); intoAi(b.getAttribute('data-into')); };
    });
    Array.prototype.forEach.call(body.querySelectorAll('[data-del]'), function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        var cid = b.getAttribute('data-del');
        if (!window.confirm('删除后不可恢复，确认删除该对话记录？')) return;
        var local = localSessions().filter(function (x) { return x.convId !== cid; });
        saveLocal(local);
        if (!tk()) { chatCache.list = mergeSessions([]); renderList(); toast('已删除本地记录'); return; }
        chatApi({ action: 'del', convId: cid }).then(function () { loadList(true); toast('已删除'); })
          .catch(function () { toast('删除失败，请稍后重试'); });
      };
    });
  }

  function openConv(cid) {
    var box = $('gcDockBody');
    box.innerHTML = '<div class="gcv-dock-empty">正在读取会话…</div>';
    function paint(title, messages) {
      var html = '<button class="gcv-back" id="gcDockBack">‹ 返回列表</button>'
        + '<div style="font-size:13.5px;font-weight:700;color:#12243a;margin:0 4px 10px">' + esc(title || '未命名对话') + '</div>'
        + '<div class="gcv-msgs">' + (messages || []).map(function (m) {
          var role = m && m.role === 'assistant' ? 'a' : 'u';
          var txt = m && (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
          return '<div class="gcv-msg ' + role + '"><div class="av">' + (role === 'a' ? 'AI' : '我') + '</div><div class="bd">' + esc(txt) + '</div></div>';
        }).join('') + '</div>';
      box.innerHTML = html;
      $('gcDockBack').onclick = function () { renderList(); };
      box.scrollTop = 0;
    }
    var hit = chatCache.list.filter(function (x) { return x.convId === cid; })[0];
    if (!tk() || (hit && hit._local)) {
      paint((hit && hit.title) || '未命名对话', (hit && hit.messages) || []);
      return;
    }
    chatApi({ action: 'get', convId: cid }).then(function (d) {
      if (d && d.ok) {
        paint(d.title, d.messages || []);
        try {
          (d.messages || []).slice(-40).forEach(function (m) {});
        } catch (e) {}
      } else if (hit && hit.messages) {
        paint(hit.title, hit.messages);
      } else {
        box.innerHTML = '<div class="gcv-dock-empty">该会话不存在或已删除。</div>';
      }
    }).catch(function () {
      if (hit && hit.messages) paint(hit.title, hit.messages);
      else box.innerHTML = '<div class="gcv-dock-empty">读取失败，请稍后重试。</div>';
    });
  }

  function intoAi(cid) {
    function put(messages, title) {
      try { window.aiConversationHistory = (messages || []).slice(-40); } catch (e) {}
      closeDock();
      if (window.openAiChat) { try { window.openAiChat(); } catch (e) {} }
      else {
        var fab = document.querySelector('[onclick*="openAiChat"]');
        if (fab) fab.click();
      }
      toast('已载入「' + (title || '对话') + '」，回到问AI 继续提问即可');
    }
    var hit = chatCache.list.filter(function (x) { return x.convId === cid; })[0];
    if (!tk() || (hit && hit._local)) return put((hit && hit.messages) || [], hit && hit.title);
    chatApi({ action: 'get', convId: cid }).then(function (d) {
      if (d && d.ok) put(d.messages, d.title);
      else toast('载入失败，请稍后重试');
    }).catch(function () { toast('载入失败，请稍后重试'); });
  }

  function loadList(force) {
    if (document.getElementById('gcDockBody') || force) {
      var box = $('gcDockBody');
      if (box && !chatCache.list.length) box.innerHTML = '<div class="gcv-dock-empty">正在加载…</div>';
    }
    var local = localSessions();
    if (!tk()) {
      chatCache.list = mergeSessions([]);
      renderList();
      return;
    }
    chatApi({ action: 'list' }).then(function (d) {
      chatCache.list = mergeSessions((d && d.sessions) || []);
      renderList();
    }).catch(function () {
      chatCache.list = mergeSessions([]);
      renderList();
    });
  }

  /* ---------- 自动保存当前对话 ---------- */
  var lastSavedText = '';
  function grabMessages() {
    var out = [];
    try {
      var hi = window.aiConversationHistory;
      if (Array.isArray(hi) && hi.length) {
        return hi.filter(function (m) { return m && m.content; }).map(function (m) {
          return { role: m.role === 'assistant' ? 'assistant' : 'user', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
        });
      }
    } catch (e) {}
    var nodes = document.querySelectorAll('#aiChatMessages .ai-message, #aiChatMessages > div');
    Array.prototype.forEach.call(nodes, function (n) {
      var txt = (n.textContent || '').trim();
      if (!txt) return;
      var cls = n.className || '';
      var isAi = /ai|assistant|bot|answer/i.test(cls);
      out.push({ role: isAi ? 'assistant' : 'user', content: txt.slice(0, 4000) });
    });
    return out;
  }

  function autoSave(manual) {
    var msgs = grabMessages();
    if (!msgs.length) { if (manual) toast('当前还没有可保存的对话，先去问AI 聊几句吧'); return; }
    var sig = msgs.length + '|' + (msgs[msgs.length - 1].content || '').slice(0, 40);
    if (!manual && sig === lastSavedText) return;
    lastSavedText = sig;

    var convId = '';
    try { convId = localStorage.getItem(LS.conv) || ''; } catch (e) {}
    if (!convId) {
      convId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      try { localStorage.setItem(LS.conv, convId); } catch (e) {}
    }
    var title = '未命名对话';
    for (var i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user' && msgs[i].content) { title = String(msgs[i].content).slice(0, 24); break; }
    }
    var preview = (msgs[msgs.length - 1].content || '').slice(0, 60);
    var rec = { convId: convId, title: title, count: msgs.length, updatedAt: new Date().toISOString(), preview: preview, messages: msgs.slice(-120) };

    var local = localSessions().filter(function (x) { return x.convId !== convId; });
    local.unshift(rec);
    saveLocal(local);

    if (!tk()) { if (manual) toast('已保存到本机（登录后可云端同步）'); return; }
    chatApi({
      action: 'save',
      convId: convId,
      title: title,
      messages: msgs.slice(-120)
    }).then(function (d) {
      if (d && d.ok) {
        chatCache.list = mergeSessions(chatCache.list.filter(function (x) { return x.convId !== convId; }));
        if (manual) toast('已保存到云端（共 ' + (d.total || 1) + ' 条会话）');
      } else if (manual) {
        toast((d && d.message) || '云端保存失败，已保留在本机');
      }
    }).catch(function () { if (manual) toast('网络异常，已保留在本机'); });
  }

  function watchChat() {
    var timer = null;
    function kick() {
      clearTimeout(timer);
      timer = setTimeout(function () { autoSave(false); }, 4000);
    }
    var target = document.getElementById('aiChatMessages');
    if (target) {
      new MutationObserver(kick).observe(target, { childList: true, subtree: true, characterData: true });
    } else {
      var t2 = setInterval(function () {
        var el = document.getElementById('aiChatMessages');
        if (el) { clearInterval(t2); new MutationObserver(kick).observe(el, { childList: true, subtree: true, characterData: true }); }
      }, 1500);
      setTimeout(function () { clearInterval(t2); }, 60000);
    }
    // 关闭问AI 时立即保存
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (t && t.closest && t.closest('.ai-chat-close')) setTimeout(function () { autoSave(false); }, 600);
    }, true);
  }

  /* ============================================================
   * 4) 站内通知中心
   * ============================================================ */
  var notifySeen = {};
  function notifyApi(qs, body) {
    var url = '/api/notify' + (qs || '');
    var opt = { cache: 'no-store', credentials: 'include' };
    var t = tk();
    if (t) opt.headers = { 'X-Acct-Token': t, 'Content-Type': 'application/json' };
    else opt.headers = { 'Content-Type': 'application/json' };
    if (body) { opt.method = 'POST'; opt.body = JSON.stringify(body); }
    return fetch(url, opt).then(function (r) { return r.json(); });
  }

  function buildBell() {
    if (document.getElementById('gcNotifyBell')) return;
    styleOnce('gcV35BellCss',
      '.gcv-bell{position:fixed;right:18px;bottom:210px;z-index:99991;width:46px;height:46px;border-radius:14px;border:0;cursor:pointer;'
      + 'background:linear-gradient(135deg,#f0b429,#e0902a);color:#fff;box-shadow:0 10px 24px rgba(224,144,42,.34);display:flex;align-items:center;justify-content:center;'
      + 'transition:transform .2s cubic-bezier(.34,1.5,.64,1)}'
      + '.gcv-bell:hover{transform:translateY(-3px) scale(1.05)}'
      + '.gcv-bell .dot{position:absolute;right:9px;top:8px;min-width:8px;height:8px;border-radius:99px;background:#ef4444;border:1.5px solid #fff;display:none}'
      + '.gcv-bell.has .dot{display:block}'
      + '.gcv-panel{position:fixed;right:16px;bottom:266px;width:min(360px,92vw);max-height:64vh;overflow:auto;background:#fff;border:1px solid #e6edf7;'
      + 'border-radius:16px;box-shadow:0 26px 60px rgba(15,23,42,.22);z-index:2147483400;display:none;padding:8px}'
      + '.gcv-panel.on{display:block;animation:gcvIn .24s ease}'
      + '@keyframes gcvIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}'
      + '.gcv-panel h4{margin:6px 8px 8px;font-size:13.5px;color:#12243a;display:flex;align-items:center;gap:8px}'
      + '.gcv-nitem{padding:9px 10px;border-radius:11px;background:#f8fbff;border:1px solid #eaf1fa;margin-bottom:6px;font-size:12.5px;color:#2b3b4d;line-height:1.65}'
      + '.gcv-nitem .nt{font-weight:700;color:#12243a;margin-bottom:2px;display:flex;justify-content:space-between;gap:8px}'
      + '.gcv-nitem .nt span{font-weight:400;color:#9aa8bb;font-size:11px}'
      + '.gcv-nempty{font-size:12.5px;color:#8593a6;text-align:center;padding:22px 8px}');

    var b = document.createElement('button');
    b.id = 'gcNotifyBell';
    b.className = 'gcv-bell';
    b.title = '消息通知';
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>'
      + '<span class="dot"></span>';
    b.style.display = 'none';     /* v3.5.1 撤回悬浮铃铛 */
    document.body.appendChild(b);

    var p = document.createElement('div');
    p.className = 'gcv-panel';
    p.id = 'gcNotifyPanel';
    p.innerHTML = '<h4>消息通知<span style="margin-left:auto;font-size:11.5px;color:#8593a6" id="gcNotifyAll">全部已读</span></h4><div id="gcNotifyList"></div>';
    document.body.appendChild(p);

    b.onclick = function () {
      p.classList.toggle('on');
      if (p.classList.contains('on')) loadNotify();
    };
    document.getElementById('gcNotifyAll').onclick = function () {
      notifyApi('?action=readall&scope=user').then(function () { loadNotify(); }).catch(function () {});
    };
    document.addEventListener('click', function (e) {
      if (!p.classList.contains('on')) return;
      if (p.contains(e.target) || b.contains(e.target)) return;
      p.classList.remove('on');
    });
  }

  function loadNotify() {
    var list = document.getElementById('gcNotifyList');
    if (!list) return;
    list.innerHTML = '<div class="gcv-nempty">加载中…</div>';
    var contact = '';
    try { contact = localStorage.getItem('gc_contact') || localStorage.getItem('gc_order_contact') || ''; } catch (e) {}
    notifyApi('?action=list&scope=user' + (contact ? '&contact=' + encodeURIComponent(contact) : '')).then(function (d) {
      var items = (d && (d.items || d.list)) || [];
      if (!items.length) { list.innerHTML = '<div class="gcv-nempty">暂时没有新消息</div>'; return; }
      list.innerHTML = items.slice(0, 30).map(function (x) {
        return '<div class="gcv-nitem"><div class="nt">' + esc(x.title || x.type || '通知')
          + '<span>' + esc(fmtTime(x.at || x.createdAt)) + '</span></div>' + esc(x.text || x.message || '') + '</div>';
      }).join('');
      var unread = items.filter(function (x) { return !x.read; }).length;
      var bell = document.getElementById('gcNotifyBell');
      if (bell) bell.classList.toggle('has', unread > 0);
    }).catch(function () {
      list.innerHTML = '<div class="gcv-nempty">通知加载失败</div>';
    });
  }

  function pollNotify() {
    if (!document.getElementById('gcNotifyBell')) return;
    var contact = '';
    try { contact = localStorage.getItem('gc_contact') || localStorage.getItem('gc_order_contact') || ''; } catch (e) {}
    notifyApi('?action=list&scope=user' + (contact ? '&contact=' + encodeURIComponent(contact) : '')).then(function (d) {
      var items = (d && (d.items || d.list)) || [];
      var unread = items.filter(function (x) { return !x.read; }).length;
      var bell = document.getElementById('gcNotifyBell');
      if (bell) bell.classList.toggle('has', unread > 0);
      var panel = document.getElementById('gcNotifyPanel');
      if (panel && panel.classList.contains('on')) {
        /* 面板打开时刷新内容 */
        if (unread !== notifySeen.last) { notifySeen.last = unread; loadNotify(); }
      }
    }).catch(function () {});
  }

  /* ============================================================
   * 5) 待支付订单浮条（1h / 24h 逻辑）
   * ============================================================ */
  function pendingBar() {
    if (document.getElementById('gcPendingBar')) return;
    var contact = '';
    try { contact = localStorage.getItem('gc_contact') || localStorage.getItem('gc_order_contact') || ''; } catch (e) {}
    if (!contact) return;
    fetch('/api/order?action=active&contact=' + encodeURIComponent(contact), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var o = d && d.order;
        if (!o) return;
        var bar = document.createElement('div');
        bar.id = 'gcPendingBar';
        bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:20px;z-index:2147483200;display:flex;align-items:center;gap:12px;' +
          'background:#fffbe8;border:1px solid #f2dfa6;color:#8a5a09;border-radius:14px;padding:10px 16px;font-size:12.8px;box-shadow:0 14px 32px rgba(138,90,9,.16);max-width:92vw';
        bar.innerHTML = '<span style="flex:1;min-width:0">你有 1 笔待支付订单（' + esc(o.id || '') + '），剩余 <b id="gcPendLeft">--</b> 自动取消</span>'
          + '<a href="/pay/737.html?order=' + encodeURIComponent(o.id || '') + '" style="flex:0 0 auto;background:#8a5a09;color:#fff;text-decoration:none;border-radius:9px;padding:6px 13px;font-weight:600">继续支付</a>'
          + '<button id="gcPendX" style="flex:0 0 auto;border:0;background:transparent;color:#b08948;font-size:16px;cursor:pointer">&times;</button>';
        document.body.appendChild(bar);
        var deadline = new Date(o.cancelAt || o.createdAt || Date.now());
        if (!o.cancelAt && o.createdAt) deadline = new Date(new Date(o.createdAt).getTime() + 24 * 3600 * 1000);
        function tick() {
          var left = deadline.getTime() - Date.now();
          var el = document.getElementById('gcPendLeft');
          if (!el) return;
          if (left <= 0) { bar.parentNode && bar.parentNode.removeChild(bar); return; }
          var h = Math.floor(left / 3600000), m = Math.floor((left % 3600000) / 60000);
          el.textContent = (h > 0 ? h + ' 小时 ' : '') + m + ' 分钟';
        }
        tick();
        setInterval(tick, 30000);
        var x = document.getElementById('gcPendX');
        if (x) x.onclick = function () { bar.parentNode && bar.parentNode.removeChild(bar); };
      })
      .catch(function () {});
  }

  /* ============================================================
   * 启动
   * ============================================================ */
  function boot() {
    /* 开屏广告：仅首页、会话内只弹一次 */
    try {
      var seenAd = sessionStorage.getItem(LS.adSeen) === '1';
      if (isHome() && !seenAd) setTimeout(showOpenAd, 1400);
    } catch (e) {}

    /* 问AI 小广告 */
    injectAiMiniAd();
    var t = setInterval(function () {
      injectAiMiniAd();
      if (document.getElementById('gcAiMiniAd')) clearInterval(t);
    }, 1200);
    setTimeout(function () { clearInterval(t); }, 30000);

    /* 对话记录侧边栏（v3.5.1：不再生成悬浮按钮，仅保留侧栏能力） */
    buildDock();
    injectEntryLinks();
    watchChat();
    loadList(false);

    /* 通知中心 */
    buildBell();
    setTimeout(pollNotify, 2000);
    setInterval(pollNotify, 60000);

    /* 待支付订单浮条 */
    setTimeout(pendingBar, 2500);
  }

  /* v3.5.1：把「AI 对话记录」「消息通知」做成低调文字入口，替换原悬浮圆钮 */
  function injectEntryLinks() {
    if (document.getElementById('gcEntryStyle')) return;
    var st = document.createElement('style');
    st.id = 'gcEntryStyle';
    st.textContent = '.gc-entry{display:inline-flex;align-items:center;gap:5px;border:0;background:none;padding:4px 2px;'
      + 'font-size:12.5px;color:#5b7292;cursor:pointer}'
      + '.gc-entry:hover{color:#2f6fd0}'
      + '.gc-entry b{font-weight:600}';
    document.head.appendChild(st);

    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      var head = document.querySelector('#gcAcctProfile .gc-pf-head');
      if (head && !document.getElementById('gcEntryNotify')) {
        var b1 = document.createElement('button');
        b1.type = 'button';
        b1.id = 'gcEntryNotify';
        b1.className = 'gc-entry';
        b1.style.marginLeft = 'auto';
        b1.innerHTML = '<b>消息通知</b>';
        b1.onclick = function () { try { window.GCNotify.open(); } catch (e) {} };
        head.appendChild(b1);
      }
      var ai = document.getElementById('aiChatMessages');
      if (ai && ai.parentNode && !document.getElementById('gcEntryDock')) {
        var b2 = document.createElement('button');
        b2.type = 'button';
        b2.id = 'gcEntryDock';
        b2.className = 'gc-entry';
        b2.style.margin = '0 0 6px 2px';
        b2.innerHTML = '<b>AI 对话记录</b>';
        b2.onclick = function (e) { e.stopPropagation(); try { window.GCChatDock.open(); } catch (err) {} };
        ai.parentNode.insertBefore(b2, ai);
      }
      if ((document.getElementById('gcEntryNotify') && document.getElementById('gcEntryDock')) || tries > 40) clearInterval(timer);
    }, 800);
  }

  window.GCChatDock = { open: openDock, close: closeDock, refresh: loadList, save: autoSave };
  window.GCNotify = { open: function () { var b = document.getElementById('gcNotifyBell'); if (b) b.click(); }, reload: loadNotify };
  window.GCAd = { show: showOpenAd };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
