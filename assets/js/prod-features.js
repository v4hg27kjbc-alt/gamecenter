
/* ===== GCX-PROD-FEATURES · 生产版功能增强（零外网依赖） ===== */
(function () {
  'use strict';
  if (window.__gcxProdLoaded) return;
  window.__gcxProdLoaded = true;

  var LS_AUTH = 'gc_auth_session';
  var LS_DEV = 'gc_local_device';
  var LS_LAST = 'gc_last_login';          // 本设备最近一次登录记录（保留 30 天）
  var HIST_MS = 30 * 24 * 3600 * 1000;    // 30 天窗口

  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  function tk() { try { return localStorage.getItem('gc_acct_token') || ''; } catch (e) { return ''; } }
  function $(id) { return document.getElementById(id); }

  /* ================= 0. 开屏加载动画：接管站点既有 #gcLogoIntro，叠加真实进度 =================
     说明：站点原开屏层自带 3s 收场逻辑；本段只在其内部叠加 1px 细线 + 百分比，
     进度取自 performance 资源完成比例与 readyState，不伪造匀速动画。 */
  (function bootLoading() {
    var intro = $('gcLogoIntro') || document.querySelector('.gcLogoIntro');
    if (!intro) return;               // 无开屏层（含用户勾选「以后不再显示」）→ 不另造加载页，避免白屏/闪烁
    if (window.__gcxProdBoot) return;
    window.__gcxProdBoot = true;

    var hud = null, bar = null, pct = null, rafId = null, closed = false, shown = 0;
    var started = Date.now();

    function build() {
      hud = document.createElement('div');
      hud.className = 'gcx-boot-hud';
      hud.innerHTML = '<div class="gcx-boot-line"><i></i></div><div class="gcx-boot-pct">0%</div>';
      intro.appendChild(hud);
      bar = hud.querySelector('.gcx-boot-line i');
      pct = hud.querySelector('.gcx-boot-pct');
    }
    function paint(v) {
      shown = v;
      if (!bar) return;
      var val = closed ? v : Math.min(v, 96);   // 收尾前封顶 96%，避免数字来回跳
      bar.style.width = val.toFixed(1) + '%';
      if (pct) pct.textContent = Math.round(val) + '%';
    }
    function compute() {
      var res = (performance.getEntriesByType ? performance.getEntriesByType('resource') : []);
      var total = Math.max(res.length, 1), ok = 0;
      for (var i = 0; i < res.length; i++) { if (res[i].responseEnd > 0) ok++; }
      var p = (ok / total) * 84;
      if (document.readyState === 'interactive') p = Math.max(p, 62);
      if (document.readyState === 'complete') p = Math.max(p, 94);
      var byTime = Math.min(90, (Date.now() - started) / 24);
      return Math.min(99, Math.max(p, byTime));
    }
    function stop() {
      if (closed) return;
      closed = true;
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      paint(100);
      setTimeout(function () {
        if (hud) {
          hud.classList.add('is-done');
          setTimeout(function () { if (hud && hud.parentNode) hud.parentNode.removeChild(hud); }, 320);
        }
        var stage = document.querySelector('.app-container');
        if (stage) stage.classList.add('gcx-stage-in');
      }, 200);
    }
    function tick() {
      if (closed) return;
      var alive = document.body.contains(intro) &&
        getComputedStyle(intro).display !== 'none' &&
        Number(getComputedStyle(intro).opacity) > 0.02;
      if (!alive) {
        /* 开屏层被跳过或已收场：能看见就补满再淡出，看不见就静默结束 */
        if (hud && document.body.contains(hud)) { paint(100); stop(); } else { closed = true; }
        return;
      }
      var t = compute();
      if (t > shown) { paint(shown + Math.min((t - shown) * 0.22, 2.0)); }
      /* 站点开屏 3s 收场，这里在 2.6s 主动补满 100% 并淡出，确保 100% 真实可见 */
      if (Date.now() - started >= 2600) { paint(100); stop(); return; }
      rafId = requestAnimationFrame(tick);
    }
    build();
    paint(4);
    rafId = requestAnimationFrame(tick);
  })();

  /* ================= 1. 本机会话（一键登录） ================= */
  function deviceName() {
    var d = ls(LS_DEV);
    if (d) return d;
    var ua = navigator.userAgent || '';
    d = /iPhone|iPad|iPod/.test(ua) ? 'iPhone / iPad'
      : /Android/.test(ua) ? 'Android 设备'
      : /Mac OS X/.test(ua) ? 'Mac 电脑'
      : /Windows/.test(ua) ? 'Windows 电脑' : '本机浏览器';
    ls(LS_DEV, d);
    return d;
  }
  function getAuth() {
    var raw = ls(LS_AUTH);
    if (!raw) return null;
    try { var o = JSON.parse(raw); if (o && o.nick) return o; } catch (e) {}
    return null;
  }
  function setAuth(nick) {
    var o = { nick: nick, device: deviceName(), ts: Date.now() };
    ls(LS_AUTH, JSON.stringify(o));
    ls(LS_LAST, JSON.stringify({ nick: nick, device: o.device, ts: o.ts }));
    syncDock();
    return o;
  }
  function clearAuth() { try { localStorage.removeItem(LS_AUTH); } catch (e) {} syncDock(); }
  /* 本设备 30 天内是否留有登录记录（退出登录不擦除，仅过期失效） */
  function lastLogin() {
    var raw = ls(LS_LAST);
    if (!raw) return null;
    try { var o = JSON.parse(raw); if (o && o.ts) return o; } catch (e) {}
    return null;
  }
  function histValid() {
    var o = lastLogin();
    return !!(o && (Date.now() - o.ts) < HIST_MS);
  }
  function daysAgo(ts) { return Math.max(0, Math.floor((Date.now() - ts) / 86400000)); }
  function isLogged() { return !!(getAuth() || tk()); }

  /* 登录后按钮变账户入口：沿用站点既有 #gcAcctBtn（点击即开个人中心），只改文案 */
  function syncDock() {
    var btn = $('gcAcctBtn'), txt = $('gcAcctBtnText');
    if (!btn || !txt) return;
    var a = getAuth(), srv = tk();
    if (srv) { txt.textContent = '账户'; btn.setAttribute('title', '已登录 · 点击打开个人中心'); btn.removeAttribute('data-gcx-onetap'); return; }
    if (a) {
      txt.textContent = a.nick;
      btn.setAttribute('title', a.nick + ' · ' + a.device + ' · 点击打开个人中心');
      btn.removeAttribute('data-gcx-onetap');
      return;
    }
    if (histValid()) {
      var h = lastLogin();
      txt.textContent = '一键登录';
      btn.setAttribute('title', '本设备 ' + daysAgo(h.ts) + ' 天前登录过（' + h.nick + '），点击一键登录');
      btn.setAttribute('data-gcx-onetap', '1');
    } else {
      txt.textContent = '登录';
      btn.setAttribute('title', '登录 / 个人中心');
      btn.removeAttribute('data-gcx-onetap');
    }
  }
  setInterval(function () {
    var txt = $('gcAcctBtnText'), a = getAuth();
    if (txt && a && !tk() && txt.textContent !== a.nick) txt.textContent = a.nick;
  }, 2500);

  /* ================= 2. 面板页签：新增「一键登录」并接管互斥 ================= */
  function paneId(name) {
    return name === 'onetap' ? 'gcLpOneTap'
      : name === 'transfer' ? 'gcLpTransfer' : 'gcLpReceive';
  }
  function switchTab(name) {
    var tabs = document.querySelectorAll('.gc-lp-tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('on', tabs[i].getAttribute('data-lp') === name);
    ['onetap', 'transfer', 'receive'].forEach(function (k) {
      var el = $(paneId(k));
      if (el) el.classList.toggle('on', k === name);
    });
  }
  function msg(id, text, kind) {
    var el = $(id);
    if (!el) return;
    el.textContent = text || '';
    el.className = 'gc-lp-msg' + (kind ? ' ' + kind : '');
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function renderOneTap() {
    var pane = $('gcLpOneTap');
    if (!pane) return;
    var a = getAuth(), srv = tk(), h = histValid() ? lastLogin() : null;
    if (srv && !a) {
      pane.innerHTML = '<p class="gc-lp-note">当前已使用站点账号登录，可直接在「图片速传」与「接收」里收发。</p>' +
        '<div class="gcx-onetap-who"><div class="gcx-onetap-avatar">✓</div><div>' +
        '<div class="gcx-onetap-name">站点账号已登录</div>' +
        '<div class="gcx-onetap-sub">' + esc(deviceName()) + '</div></div></div>' +
        '<div class="gc-lp-msg" id="gcxOneTapMsg"></div>';
      return;
    }
    if (a) {
      pane.innerHTML = '<p class="gc-lp-note">本机会话已建立，可直接接收 #tf= 传输链接与速传码。</p>' +
        '<div class="gcx-onetap-who"><div class="gcx-onetap-avatar">' + esc(String(a.nick).slice(0, 1).toUpperCase()) + '</div>' +
        '<div><div class="gcx-onetap-name">' + esc(a.nick) + '</div>' +
        '<div class="gcx-onetap-sub">' + esc(a.device) + ' · 本机会话（不发短信、不设密码）</div></div></div>' +
        '<div class="gc-lp-row"><button class="gc-lp-btn ghost" id="gcxOneTapOut" type="button">退出本机会话</button></div>' +
        '<div class="gc-lp-msg" id="gcxOneTapMsg"></div>';
      return;
    }
    if (h) {
      /* 检测到本设备 30 天内有登录记录：先给出提示，再提供一键登录（身份取自本机记录） */
      pane.innerHTML = '<p class="gc-lp-note">已检测到本设备 ' + daysAgo(h.ts) + ' 天前的登录记录：' + esc(h.nick) + '，可直接一键登录（超过 30 天需重新登录）。</p>' +
        '<div class="gcx-onetap-who"><div class="gcx-onetap-avatar">' + esc(String(h.nick).slice(0, 1).toUpperCase()) + '</div>' +
        '<div><div class="gcx-onetap-name">' + esc(h.nick) + '</div>' +
        '<div class="gcx-onetap-sub">上次登录 ' + esc(fmtDate(h.ts)) + ' · ' + esc(h.device || deviceName()) + '</div></div></div>' +
        '<div class="gc-lp-row"><button class="gc-lp-btn" id="gcxOneTapGo" type="button">一键登录</button></div>' +
        '<div class="gc-lp-row"><input class="gc-lp-input" id="gcxOneTapNick" maxlength="16" placeholder="或换一个昵称登录"></div>' +
        '<div class="gc-lp-msg" id="gcxOneTapMsg"></div>';
      return;
    }
    /* 无 30 天登录记录：一键登录直接禁用，只提示先去账户入口登录 */
    pane.innerHTML = '<p class="gc-lp-note">未检测到本设备 30 天内的登录记录，一键登录已禁用。请先通过右上角账户入口登录，之后本设备 30 天内可一键登录。</p>' +
      '<div class="gc-lp-row" style="margin-top:0">' +
        '<button class="gc-lp-btn" id="gcxOneTapGo" type="button" disabled>一键登录（本设备无登录记录）</button>' +
      '</div>' +
      '<div class="gc-lp-msg" id="gcxOneTapMsg">仅当本设备 30 天内登录过时，一键登录才可用。</div>';
  }
  function fmtDate(ts) {
    var d = new Date(ts), p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }
  function initOneTap() {
    var tabs = document.querySelector('.gc-lp-tabs');
    var pane = $('gcLpOneTap');
    if (!tabs || !pane) return false;
    if (pane.getAttribute('data-bound') === '1') { renderOneTap(); return true; }
    pane.setAttribute('data-bound', '1');
    renderOneTap();

    pane.addEventListener('click', function (e) {
      var t = e.target;
      if (!t) return;
      if (t.id === 'gcxOneTapGo') {
        var h = histValid() ? lastLogin() : null;
        if (!h) { msg('gcxOneTapMsg', '未检测到本设备 30 天内的登录记录，一键登录已禁用，请先通过右上角账户入口登录', 'err'); return; }
        var inp = $('gcxOneTapNick');
        var typed = ((inp && inp.value) || '').trim();
        var nick = typed || h.nick || '';
        if (!nick) { msg('gcxOneTapMsg', '请输入昵称', 'err'); return; }
        if (nick.length > 16) { msg('gcxOneTapMsg', '昵称最多 16 个字符', 'err'); return; }
        setAuth(nick);
        renderOneTap();
        msg('gcxOneTapMsg', '已建立本机会话：' + nick, 'ok');
      } else if (t.id === 'gcxOneTapOut') {
        clearAuth();
        renderOneTap();
        msg('gcxOneTapMsg', '已退出本机会话（30 天内仍可用同一身份一键登录）', 'ok');
      }
    });

    tabs.addEventListener('click', function (e) {
      var t = e.target;
      var btn = t && t.closest ? t.closest('.gc-lp-tab') : null;
      if (!btn) return;
      switchTab(btn.getAttribute('data-lp'));
    });
    return true;
  }

  /* 打开多端互联面板并定位到「一键登录」 */
  function openOneTap() {
    var fab = $('gcLinkFab'), panel = $('gcLinkPanel');
    if (!panel) return;
    if (!panel.classList.contains('on') && fab) fab.click();
    switchTab('onetap');
  }

  /* ================= 3. 传输链接 #tf=CODE（仅登录后可用） ================= */
  function handleTf() {
    var m = String(location.hash || '').match(/#tf=([A-Za-z0-9]{4,8})/);
    if (!m) return;
    var code = m[1].toUpperCase();
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}

    var tries = 0;
    function go() {
      var fab = $('gcLinkFab'), panel = $('gcLinkPanel');
      if (!fab || !panel) return;
      if (!panel.classList.contains('on')) fab.click();
      switchTab('receive');
      var inp = $('gcLpRecvCode');
      if (inp) inp.value = code;
      msg('gcLpRecvMsg', '正在取回传输码 ' + code + ' …');
      var btn = $('gcLpRecvBtn');
      if (btn) btn.click();
    }
    var t = setInterval(function () {
      tries++;
      if ($('gcLpRecvBtn') || tries > 20) { clearInterval(t); go(); }
    }, 150);
  }

  /* 未登录但本设备 30 天内有登录记录：点右上角入口直接进「一键登录」，不再弹旧登录框 */
  function bindDockAcct() {
    var btn = $('gcAcctBtn');
    if (!btn || btn.getAttribute('data-gcx-bound') === '1') return;
    btn.setAttribute('data-gcx-bound', '1');
    btn.addEventListener('click', function (e) {
      if (isLogged() || !histValid()) return;      // 已登录 → 走站点原生个人中心
      e.preventDefault(); e.stopPropagation();
      openOneTap();
    }, true);
  }

  /* ================= 4. 启动 ================= */
  function init() {
    try { initOneTap(); } catch (e) {}
    try { bindDockAcct(); } catch (e) {}
    syncDock();
    try { handleTf(); } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  window.addEventListener('hashchange', function () { try { handleTf(); } catch (e) {} });
  setTimeout(function () { try { initOneTap(); bindDockAcct(); syncDock(); } catch (e) {} }, 900);
})();
