
/* ===== 账户/主题坞显隐：只在浏览主页时出现，打开任何窗口、小窗、弹层或子视图时隐藏 ===== */
(function () {
  var dock = document.getElementById('gcAcctDock');
  if (!dock) return;
  /* GCX-PROD-FEATURES: 排除活动公告遮罩(gcV35Ad/gcv-*)，否则开屏广告期间账户坞被误判"界面开窗"而隐藏 */
  var EXCL = /gcAcctDock|gcV35Ad|gcv-|scroll-progress|badge-toast|badgeToast|stars-layer|starsLayer|airline-guide-tip|toast|marvis|cursor|dropdown/i;
  var SEL = '[id*="Overlay"],[id*="overlay"],[id*="Mask"],[id*="mask"],[id*="Panel"],[id*="panel"],' +
            '[id*="Modal"],[id*="modal"],[id*="Sheet"],[id*="sheet"],[id*="Layer"],[id*="layer"],' +
            '[class*="overlay"],[class*="modal"],[class*="mask"],[class*="sheet"],[class*="drawer"],[class*="dialog"]';

  function layerOpen() {
    var list = document.querySelectorAll(SEL);
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el === dock || dock.contains(el) || el.contains(dock)) continue;
      if (EXCL.test((el.id || '') + ' ' + (el.className || ''))) continue;
      var cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
      var r = el.getBoundingClientRect();
      // 全屏遮罩或任意小窗（宽>=240 且 高>=160）都算"打开了窗口"
      if ((r.width >= 240 && r.height >= 160) || (r.width >= window.innerWidth * 0.9 && r.height >= window.innerHeight * 0.9)) return true;
    }
    return false;
  }

  function urlSubView() {
    var h = (location.hash || '').replace('#', '');
    if (!h) return false;
    return /^(admin|detail|aircraft|plane|fav|favorites|stats|search|quiz|news)/i.test(h);
  }

  var timer = null;
  function sync() {
    var off = layerOpen() || urlSubView();
    if (off === dock.classList.contains('gc-dock-off')) return;
    dock.classList.toggle('gc-dock-off', off);
    dock.setAttribute('aria-hidden', off ? 'true' : 'false');
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(sync, 60); }

  window.addEventListener('resize', schedule);
  window.addEventListener('hashchange', schedule);
  window.addEventListener('popstate', schedule);
  document.addEventListener('click', schedule, true);
  document.addEventListener('keyup', schedule, true);
  document.addEventListener('transitionend', schedule, true);
  if (window.MutationObserver) {
    try {
      new MutationObserver(schedule).observe(document.body, {
        attributes: true, attributeFilter: ['class', 'style', 'aria-hidden'], subtree: true, childList: true
      });
    } catch (e) {}
  }
  setInterval(sync, 700);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync);
  sync();
})();
