
/* v3.5 我的收藏（回归版）：每位用户仅允许 1 个收藏，收藏新的会自动替换旧的 */
(function () {
  var KEY = 'gc_fav_single_v35';
  var LEGACY = ['gc_temp_favs', 'gc_temp_saved'];

  function read() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (v && typeof v === 'object' && v.id) return v;
    } catch (e) {}
    return null;
  }
  function write(v) {
    try {
      if (v) localStorage.setItem(KEY, JSON.stringify(v));
      else localStorage.removeItem(KEY);
    } catch (e) {}
  }
  function cleanLegacy() {
    try {
      LEGACY.forEach(function (k) {
        var arr = JSON.parse(localStorage.getItem(k) || '[]');
        if (Array.isArray(arr) && arr.length) {
          /* 只保留第一个，迁移到单收藏 */
          if (!read()) write({ id: arr[0], title: '', at: new Date().toISOString() });
        }
        localStorage.removeItem(k);
      });
    } catch (e) {}
  }

  function titleOf(modal) {
    try {
      var h = modal.querySelector('.modal-body h2');
      if (h) return h.textContent.trim();
      var t = modal.querySelector('.cf-detail-title');
      if (t) return t.textContent.trim();
    } catch (e) {}
    return '';
  }
  function currentId(modal) {
    try {
      var h = (location.hash || '').replace('#', '');
      if (h) return h;
      var m = modal && modal.querySelector('[data-aircraft-id]');
      if (m) return m.getAttribute('data-aircraft-id');
    } catch (e) {}
    return '';
  }

  function toast(text) {
    var el = document.getElementById('gcToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'gcToast';
      el.style.cssText = 'position:fixed;left:50%;bottom:42px;transform:translateX(-50%) translateY(12px);background:rgba(15,23,42,.92);color:#fff;font-size:13px;padding:10px 18px;border-radius:999px;z-index:2147483600;opacity:0;transition:.26s;pointer-events:none;font-family:-apple-system,"PingFang SC",sans-serif;';
      document.body.appendChild(el);
    }
    el.textContent = text;
    requestAnimationFrame(function () { el.style.opacity = '1'; el.style.transform = 'translateX(-50%) translateY(0)'; });
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.style.opacity = '0'; el.style.transform = 'translateX(-50%) translateY(12px)'; }, 2200);
  }

  function renderStat() {
    var sc = document.getElementById('statCollection');
    if (!sc) return;
    var cur = read();
    sc.textContent = cur ? '1' : '0';
    sc.setAttribute('data-target', cur ? '1' : '0');
    var host = sc.parentElement;
    if (host) {
      host.style.cursor = 'pointer';
      host.title = cur ? ('当前收藏：' + (cur.title || cur.id) + '（点击查看）') : '还没有收藏';
      host.onclick = function () {
        var c = read();
        if (!c) { toast('还没有收藏，打开任意机型详情点「收藏」即可'); return; }
        if (c.id) { location.hash = '#' + c.id; }
      };
    }
    var box = document.getElementById('gcFavOneBox');
    if (box) {
      var c2 = read();
      box.innerHTML = c2
        ? '<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid #e4ecf7;border-radius:12px;background:#f8fbff">'
          + '<div style="flex:1;min-width:0"><b style="display:block;font-size:13.5px;color:#12243a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'
          + (c2.title || c2.id) + '</b><span style="font-size:11.5px;color:#7f8da2">收藏于 ' + String(c2.at || '').slice(0, 10) + ' · 每位用户限 1 个</span></div>'
          + '<button type="button" id="gcFavGo" style="padding:6px 12px;border-radius:9px;border:1px solid #cfe0f7;background:#fff;color:#2f6fd0;font-size:12px;cursor:pointer">查看</button>'
          + '<button type="button" id="gcFavClear" style="padding:6px 10px;border-radius:9px;border:1px solid #f0d7d7;background:#fff;color:#c0504d;font-size:12px;cursor:pointer">取消</button>'
          + '</div>'
        : '<div style="font-size:12.5px;color:#7f8da2;padding:8px 2px">暂无收藏。打开任意机型详情页点击「收藏」即可（每位用户只能收藏 1 个）。</div>';
      var go = document.getElementById('gcFavGo');
      if (go) go.onclick = function () { var c = read(); if (c && c.id) { location.hash = '#' + c.id; } };
      var cl = document.getElementById('gcFavClear');
      if (cl) cl.onclick = function () { write(null); renderStat(); syncButtons(); toast('已取消收藏'); };
    }
  }

  function syncButtons() {
    var cur = read();
    var btns = document.querySelectorAll('.gc-fav-one-btn');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var on = cur && b.getAttribute('data-fav-id') === cur.id;
      b.classList.toggle('on', !!on);
      b.textContent = on ? '★ 已收藏' : '☆ 收藏';
      b.style.color = on ? '#b8860b' : '#2f6fd0';
      b.style.borderColor = on ? '#f0d9a8' : '#cfe0f7';
      b.style.background = on ? '#fffaf0' : '#fff';
    }
  }

  function inject(modal) {
    if (!modal || modal.querySelector('.gc-fav-one-btn')) return;
    var id = currentId(modal);
    var host = modal.querySelector('.modal-body') || modal.querySelector('.cf-detail-panel') || modal;
    var bar = document.createElement('div');
    bar.className = 'gc-fav-bar';
    bar.style.cssText = 'display:flex;justify-content:flex-end;margin:6px 0 10px';
    bar.innerHTML = '<button type="button" class="gc-fav-one-btn" data-fav-id="' + (id || '') + '" '
      + 'style="padding:7px 14px;border-radius:10px;border:1px solid #cfe0f7;background:#fff;font-size:12.5px;font-weight:600;cursor:pointer;color:#2f6fd0">☆ 收藏</button>';
    var ref = host.querySelector('h2') || host.querySelector('.cf-detail-title');
    if (ref && ref.parentNode) ref.parentNode.insertBefore(bar, ref.nextSibling);
    else host.insertBefore(bar, host.firstChild);

    bar.querySelector('.gc-fav-one-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      var cur = read();
      var tid = currentId(modal) || id;
      var ttl = titleOf(modal);
      if (cur && cur.id === tid) {
        write(null);
        toast('已取消收藏');
      } else {
        write({ id: tid, title: ttl, at: new Date().toISOString() });
        toast(cur ? '每位用户只能收藏 1 个，已替换为「' + (ttl || tid) + '」' : '已收藏「' + (ttl || tid) + '」');
      }
      renderStat();
      syncButtons();
    });
    syncButtons();
  }

  function scan() {
    var modals = document.querySelectorAll('.detail-modal, .cf-detail-panel');
    for (var i = 0; i < modals.length; i++) inject(modals[i]);
  }

  function boot() {
    cleanLegacy();
    renderStat();
    scan();
    var mo = new MutationObserver(function () { scan(); });
    mo.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('hashchange', function () { setTimeout(scan, 120); });
    /* 在「我的」面板插入收藏区块 */
    setTimeout(function () {
      var sec = document.getElementById('gcCouponSec');
      if (sec && sec.parentNode && !document.getElementById('gcFavOneBox')) {
        var wrap = document.createElement('div');
        wrap.className = 'gc-pf-sec';
        wrap.id = 'gcFavSec';
        wrap.style.cssText = 'border:0;padding:0 0 12px';
        wrap.innerHTML = '<div style="font-size:13px;font-weight:700;color:#12243a;margin:0 0 8px">我的收藏</div><div id="gcFavOneBox"></div>';
        sec.parentNode.insertBefore(wrap, sec.nextSibling);
        renderStat();
      }
    }, 1500);
    setInterval(function () { renderStat(); syncButtons(); }, 4000);
  }

  window.GCFav = { get: read, set: write, clear: function () { write(null); renderStat(); }, render: renderStat };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
