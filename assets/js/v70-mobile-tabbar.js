
/* ===========================================================================
   v70 特性② runtime · MobileTabbar
   —— 只在移动端（<=640px）显示底部菜单栏；桌面端 CSS 直接 display:none。
   —— 复用站内既有全局函数（scrollToTop / openPhotoAi / openCollectRecord），
      并优先调用 window.openAiChat（存在时），不新增业务逻辑。
   =========================================================================== */
(function () {
  'use strict';
  if (window.MobileTabbar && window.MobileTabbar.__v) { return; }

  var ICONS = {
    home: '<path d="M3 10.6 12 3.4l9 7.2"/><path d="M5.6 9.6V20.6h12.8V9.6"/>',
    grid: '<rect x="3.6" y="3.6" width="7" height="7" rx="2"/><rect x="13.4" y="3.6" width="7" height="7" rx="2"/><rect x="3.6" y="13.4" width="7" height="7" rx="2"/><rect x="13.4" y="13.4" width="7" height="7" rx="2"/>',
    ai: '<circle cx="12" cy="12" r="8.2"/><path d="M8.6 13.4c1 1.5 2.2 2.2 3.4 2.2s2.4-.7 3.4-2.2"/><path d="M9.6 9.6h.01M14.4 9.6h.01"/>',
    camera: '<path d="M3.8 8.6h3.1l1.6-2.1h7l1.6 2.1h3.1v11H3.8z"/><circle cx="12" cy="13.8" r="3.4"/>',
    star: '<path d="M6.2 3.6h11.6v16.8L12 16.2 6.2 20.4z"/>'
  };
  var LABELS = {
    zh: { home: '首页', grid: '图鉴', ai: '问AI', camera: '识机', star: '收藏' },
    en: { home: 'Home', grid: 'Index', ai: 'Ask AI', camera: 'Scan', star: 'Saved' }
  };

  function svg(path) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
  }

  function lang() {
    try {
      if (typeof currentLang !== 'undefined' && currentLang === 'en') { return 'en'; }
    } catch (e) { /* 忽略 */ }
    var l = document.documentElement.getAttribute('lang') || '';
    return /^en/i.test(l) ? 'en' : 'zh';
  }

  function q(sel) { try { return document.querySelector(sel); } catch (e) { return null; } }

  function scrollToFilterBar() {
    var fb = q('.filter-bar') || q('#filterBar');
    if (!fb) { window.scrollTo({ top: Math.round(document.body.scrollHeight * 0.28), behavior: 'smooth' }); return; }
    var y = fb.getBoundingClientRect().top + window.pageYOffset - 74;
    window.scrollTo({ top: Math.max(0, Math.round(y)), behavior: 'smooth' });
  }

  function call(name) {
    try {
      if (typeof window[name] === 'function') { window[name](); return true; }
    } catch (e) { /* 忽略 */ }
    return false;
  }

  var ITEMS = [
    { key: 'home', icon: ICONS.home, act: function () { if (!call('scrollToTop')) { window.scrollTo({ top: 0, behavior: 'smooth' }); } } },
    { key: 'grid', icon: ICONS.grid, act: scrollToFilterBar },
    { key: 'ai', icon: ICONS.ai, act: function () { call('openAiChat'); } },
    { key: 'camera', icon: ICONS.camera, act: function () { call('openPhotoAi'); } },
    { key: 'star', icon: ICONS.star, act: function () { call('openCollectRecord'); } }
  ];

  var bar = null, btns = {}, activeKey = null;

  function setActive(key) {
    activeKey = key;
    for (var k in btns) {
      if (Object.prototype.hasOwnProperty.call(btns, k)) {
        btns[k].classList.toggle('on', k === key);
      }
    }
  }

  function refreshLabels() {
    if (!bar) { return; }
    var L = LABELS[lang()] || LABELS.zh;
    for (var k in btns) {
      if (!Object.prototype.hasOwnProperty.call(btns, k)) { continue; }
      var span = btns[k].querySelector('span');
      if (span) { span.textContent = L[k] || k; }
      btns[k].setAttribute('aria-label', L[k] || k);
    }
  }

  function spy() {
    if (!bar || window.innerWidth > 640) { return; }
    var y = window.pageYOffset || document.documentElement.scrollTop || 0;
    var fb = q('.filter-bar') || q('#filterBar');
    var fbTop = fb ? fb.getBoundingClientRect().top + y : document.body.scrollHeight * 0.28;
    if (activeKey === 'ai' || activeKey === 'camera' || activeKey === 'star') { return; }
    setActive(y < fbTop - 90 ? 'home' : 'grid');
  }

  function build() {
    if (document.getElementById('mtbBar')) { return; }
    if (!document.body) { return; }
    bar = document.createElement('nav');
    bar.id = 'mtbBar';
    bar.className = 'mtb-bar glass-material gm-l4 lg-chrome';
    bar.setAttribute('data-lg', 'runtime');
    bar.setAttribute('role', 'navigation');
    bar.setAttribute('aria-label', '底部导航');
    for (var i = 0; i < ITEMS.length; i++) {
      (function (it) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'mtb-item';
        b.setAttribute('data-mtb', it.key);
        b.innerHTML = svg(it.icon) + '<span>' + it.key + '</span>';
        b.addEventListener('click', function () {
          setActive(it.key);
          it.act();
        });
        bar.appendChild(b);
        btns[it.key] = b;
      })(ITEMS[i]);
    }
    document.body.appendChild(bar);
    refreshLabels();
    setActive('home');
  }

  function boot() {
    build();
    var t = null;
    window.addEventListener('scroll', function () {
      if (t) { return; }
      t = setTimeout(function () { t = null; spy(); }, 120);
    }, { passive: true });
    window.addEventListener('resize', function () { spy(); });
    setInterval(function () { if (!document.hidden) { spy(); } }, 900);
    try {
      new MutationObserver(refreshLabels).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    } catch (e) { /* 忽略 */ }
    window.MobileTabbar = {
      __v: '1.0',
      el: bar,
      refresh: refreshLabels,
      setActive: setActive
    };
    console.log('[MobileTabbar] 移动端底部菜单栏已注入（桌面端 >640px 自动隐藏）');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

