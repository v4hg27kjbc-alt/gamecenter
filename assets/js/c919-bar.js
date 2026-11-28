
/* C919 免费上线 · 顶部轻量入口条（滚动后自动隐去，不打扰阅读） */
(function () {
  if (window.__gcC919Bar) return;
  window.__gcC919Bar = true;
  var KEY = 'gc_c919_bar_off_v35';
  function boot() {
    try { if (localStorage.getItem(KEY) === '1') return; } catch (e) {}
    if (document.getElementById('gcC919Bar')) return;
    var bar = document.createElement('div');
    bar.id = 'gcC919Bar';
    bar.style.cssText = 'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:99990;display:flex;align-items:center;gap:10px;' +
      'background:linear-gradient(135deg,rgba(11,35,64,.96),rgba(22,74,138,.96));color:#fff;border-radius:999px;padding:7px 8px 7px 15px;' +
      'font-size:12.6px;line-height:1.4;box-shadow:0 12px 30px rgba(11,35,64,.3);backdrop-filter:blur(8px);' +
      'transition:opacity .3s,transform .3s;max-width:calc(100vw - 28px)';
    bar.innerHTML = '<span style="flex:0 0 auto;background:rgba(255,255,255,.2);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:700">NEW</span>'
      + '<a href="/read/c919.html" style="color:#fff;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">C919 综合研究报告已免费开放 · 免费阅读 / 免费下载</a>'
      + '<button id="gcC919BarX" aria-label="关闭" style="flex:0 0 auto;border:0;background:rgba(255,255,255,.16);color:#fff;width:20px;height:20px;border-radius:50%;cursor:pointer;font-size:12px;line-height:1">&times;</button>';
    document.body.appendChild(bar);
    document.getElementById('gcC919BarX').onclick = function (e) {
      e.preventDefault();
      bar.style.opacity = '0';
      bar.style.transform = 'translateX(-50%) translateY(-14px)';
      setTimeout(function () { bar.parentNode && bar.parentNode.removeChild(bar); }, 300);
      try { localStorage.setItem(KEY, '1'); } catch (e2) {}
    };
    var lastY = 0;
    window.addEventListener('scroll', function () {
      var y = window.scrollY || document.documentElement.scrollTop || 0;
      if (y > 260) { bar.style.opacity = '0'; bar.style.pointerEvents = 'none'; }
      else { bar.style.opacity = '1'; bar.style.pointerEvents = 'auto'; }
      lastY = y;
    }, { passive: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
