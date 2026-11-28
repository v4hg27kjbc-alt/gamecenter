/**
 * gc-ctrl.js —— 首开横幅 / 广告 / 通知 统一控制层（v5.5）
 *
 * 目标：
 *   1) 首开 8 个元素全部由后台 /api/banners、/api/ads、/api/notices 的 enabled 决定显隐；
 *   2) 投放位置(slot)、优先级(order)、显示次数(freq) 真实生效；
 *   3) 文案 / 图片 / 按钮由后台字段驱动，未配置图片时回落到 defaultImage；
 *   4) 后台改动轮询 + 回到前台即刷新，秒级同步到前端。
 *
 * 设计约束：
 *   - 不删除、不改写站点既有脚本函数；本层自行渲染并"守护"目标节点，
 *     外部脚本若晚一步覆盖 DOM，会被观察者还原；
 *   - 接口拿不到数据（网络失败）时按内置默认放行，避免误杀首屏；
 *     接口成功但列表中不含该 key，视为已停用 → 隐藏。
 */
(function () {
  'use strict';

  var VERSION = 'v5.5.0';
  var API = { banners: '/api/banners', ads: '/api/ads', notices: '/api/notices' };
  var POLL_MS = 30000;

  /** 8 个首开元素的登记表（默认值用于接口不可用时的兜底） */
  var SPEC = [
    { key: 'gcMhBar', kind: 'banners', type: 'bar', slot: 'page-top', freq: 'once-open', order: 10,
      title: 'AI 模型提示', sub: '', closable: true },
    { key: 'gcLaunchBanner', kind: 'banners', type: 'launch', slot: 'top-second-row', freq: 'once-open', order: 20,
      title: '新上架 · 空客 A320 系列综合研究报告', sub: '约 3.5 万字，¥5 一次购买长期可读', href: '/pay/a320.html', closable: true },
    { key: 'updateBanner', kind: 'banners', type: 'update', slot: 'below-hero', freq: 'once-open', order: 30,
      title: '一封信 & AI 机型故事上线', sub: '点顶栏信封读作者告别信（2026.8.27）', closable: true },
    { key: 'heroBanner', kind: 'banners', type: 'hero', slot: 'hero-center', freq: 'always', order: 40,
      title: '主视觉轮播横幅', sub: '', closable: false },
    { key: 'gcV35Ad', kind: 'ads', type: 'modal', slot: 'fullscreen-modal', freq: 'once-open', order: 50,
      title: 'C919 综合研究报告', sub: '免费开放，登录后即可完整阅读', href: '/read/c919.html', closable: true },
    { key: 'gcPromo5', kind: 'ads', type: 'promo', slot: 'float-bottom-right', freq: 'once-session', order: 60,
      title: '深度研读', sub: '737 / A320 综合研究报告，¥5 一次购买长期可读', href: '/pay/a320.html', closable: true },
    { key: 'announceToast', kind: 'notices', type: 'toast-top', slot: 'top-slide-toast', freq: 'once-session', order: 70,
      title: '体验全面升级', sub: '', closable: true },
    { key: 'badgeToast', kind: 'notices', type: 'toast-center', slot: 'center-toast', freq: 'once-session', order: 80,
      title: '解锁徽章：首航纪念', sub: '', closable: false }
  ];

  var state = { loaded: false, data: {}, error: null };
  var shownThisLoad = {};
  var nodes = {};
  var heroLock = '';  // 后台为 heroBanner 配置的图片，需压制站点轮播覆盖
  var timers = [];
  var observed = false;

  /* ---------------- 工具 ---------------- */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function safeHref(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return '';
    if (/^(https?:)?\/\//i.test(s) || s.charAt(0) === '/') return s;
    return '';
  }

  function safeImg(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return '';
    if (/^data:image\//i.test(s)) return s;
    if (/^(https?:)?\/\//i.test(s) || s.charAt(0) === '/') return s;
    return '';
  }

  function storage(key, val, session) {
    var st = null;
    try { st = session ? window.sessionStorage : window.localStorage; } catch (e) { return null; }
    try {
      if (val === undefined) return st.getItem(key);
      st.setItem(key, String(val));
    } catch (e) { return null; }
    return null;
  }

  function dayKey() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
  }

  /* ---------------- 数据 ---------------- */

  function matchKey(item, key) {
    if (!item) return false;
    var cand = [item.key, item.id, item.name];
    for (var i = 0; i < cand.length; i++) {
      var v = String(cand[i] == null ? '' : cand[i]).trim();
      if (!v) continue;
      if (v === key) return true;
      if (v.toLowerCase() === key.toLowerCase()) return true;
    }
    return false;
  }

  function fetchKind(kind) {
    return fetch(API[kind], { cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var items = d && Array.isArray(d.items) ? d.items : null;
        if (!items) return { kind: kind, ok: false, items: [] };
        return { kind: kind, ok: true, items: items };
      })
      .catch(function () { return { kind: kind, ok: false, items: [] }; });
  }

  function load(silent) {
    return Promise.all([fetchKind('banners'), fetchKind('ads'), fetchKind('notices')])
      .then(function (res) {
        var map = {};
        var anyOk = false;
        res.forEach(function (r) {
          map[r.kind] = r.items;
          if (r.ok) anyOk = true;
        });
        state.data = map;
        state.loaded = anyOk;
        state.error = anyOk ? null : 'network';
        renderAll(!!silent);
        return state;
      });
  }

  function resolve(spec) {
    var list = state.data[spec.kind] || [];
    for (var i = 0; i < list.length; i++) {
      if (matchKey(list[i], spec.key)) return list[i];
    }
    return null;
  }

  function conf(spec) {
    var item = resolve(spec);
    if (!state.loaded) {
      // 接口不可用：按内置默认放行，保证首屏完整
      return Object.assign({ enabled: true, slot: spec.slot, freq: spec.freq, order: spec.order,
        title: spec.title, sub: spec.sub, href: spec.href, closable: spec.closable, image: '', defaultImage: '',
        _fallback: true }, spec);
    }
    if (!item) return { enabled: false, _missing: true, key: spec.key, slot: spec.slot, freq: spec.freq, order: spec.order };
    return {
      enabled: item.enabled !== false,
      slot: item.slot || spec.slot,
      freq: item.freq || spec.freq,
      order: typeof item.order === 'number' ? item.order : spec.order,
      title: item.title || spec.title,
      sub: item.sub || '',
      href: safeHref(item.href) || spec.href || '',
      image: safeImg(item.image),
      defaultImage: safeImg(item.defaultImage),
      useDefaultImage: item.useDefaultImage !== false,
      closable: item.closable === false ? false : true,
      form: item.form || '',
      note: item.note || ''
    };
  }

  function sessionId() {
    var sid = storage('gc-session-id', undefined, true);
    if (!sid) {
      sid = String(Date.now()) + Math.random().toString(36).slice(2, 8);
      storage('gc-session-id', sid, true);
    }
    return sid;
  }

  /** 显示次数判定 */
  function freqAllows(spec, c) {
    if (shownThisLoad[spec.key]) return true; // 本次页面加载内已通过校验，重绘不再重复判定
    var k = 'gc-freq:' + spec.key;
    if (c.freq === 'always' || c.freq === 'once-open') {
      // once-open：每次打开页面各一次（本站无前端路由，等价于总是）
      return true;
    }
    if (c.freq === 'once-session') {
      return storage(k + ':' + sessionId(), undefined, true) !== '1';
    }
    if (c.freq === 'once-day') {
      return storage(k) !== dayKey();
    }
    return true;
  }

  function markFreq(spec, c) {
    shownThisLoad[spec.key] = true;
    var k = 'gc-freq:' + spec.key;
    if (c.freq === 'once-session') {
      storage(k + ':' + sessionId(), '1', true);
    } else if (c.freq === 'once-day') {
      storage(k, dayKey());
    }
  }

  /* ---------------- 样式 ---------------- */

  function injectCss() {
    if (document.getElementById('gcCtrlCss')) return;
    var css = [
      '#gcMhBar[data-gc-off="1"],#gcLaunchBanner[data-gc-off="1"],#updateBanner[data-gc-off="1"],',
      '#heroBanner[data-gc-off="1"],#gcV35Ad[data-gc-off="1"],#gcPromo5[data-gc-off="1"],',
      '#announceToast[data-gc-off="1"],#badgeToastWrap[data-gc-off="1"]{display:none!important;opacity:0!important;visibility:hidden!important;pointer-events:none!important}',
      '.gc-ov{font-family:inherit;box-sizing:border-box}',
      /* 顶部提示条 */
      '#gcMhBar.gc-ov-bar{position:relative;z-index:9998;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 16px;background:#fffbeb;border-bottom:1px solid #fde68a;color:#92400e;font-size:12.5px;line-height:1.6;text-align:left}',
      '#gcMhBar .gc-ov-tag{font-weight:700}',
      '#gcMhBar .gc-ov-close{margin-left:auto;border:0;background:transparent;color:#92400e;cursor:pointer;font-size:15px;line-height:1;padding:2px 6px;border-radius:6px}',
      /* 推广条 */
      '#gcLaunchBanner.gc-ov-launch{position:relative;z-index:9997;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 18px;margin:0 auto;max-width:1240px;background:linear-gradient(90deg,#0f172a,#1e3a5f);color:#fff;border-radius:12px;font-size:13.5px}',
      '#gcLaunchBanner .gc-ov-new{background:#22c55e;color:#052e16;font-weight:800;font-size:11px;padding:2px 8px;border-radius:999px;letter-spacing:.5px}',
      '#gcLaunchBanner .gc-ov-go{margin-left:auto;display:inline-flex;align-items:center;gap:6px;background:#38bdf8;color:#082f49;font-weight:700;padding:6px 14px;border-radius:999px;text-decoration:none;font-size:12.5px;white-space:nowrap}',
      '#gcLaunchBanner .gc-ov-x{border:0;background:rgba(255,255,255,.16);color:#fff;width:24px;height:24px;border-radius:50%;cursor:pointer;font-size:13px;line-height:1}',
      /* 更新条 */
      '#updateBanner.gc-ov-update{position:relative;z-index:9996;display:flex;align-items:center;gap:10px;max-width:1240px;margin:10px auto;padding:10px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;color:#334155;font-size:13px}',
      '#updateBanner .gc-ov-dot{width:8px;height:8px;border-radius:50%;background:#0ea5e9;flex:none}',
      '#updateBanner .gc-ov-close{margin-left:auto;border:0;background:transparent;color:#64748b;cursor:pointer;font-size:16px;line-height:1}',
      /* 全屏广告 */
      '#gcV35Ad.gc-ov-modal{position:fixed;inset:0;z-index:10050;display:flex;align-items:center;justify-content:center;background:rgba(8,15,30,.66);backdrop-filter:blur(4px);padding:20px}',
      '#gcV35Ad .gc-ov-card{position:relative;width:min(520px,92vw);background:#fff;border-radius:16px;padding:26px 24px;box-shadow:0 24px 60px rgba(0,0,0,.3);text-align:center;color:#0f172a}',
      '#gcV35Ad .gc-ov-card h3{margin:0 0 10px;font-size:19px;font-weight:800}',
      '#gcV35Ad .gc-ov-card p{margin:0 0 18px;color:#475569;font-size:13.5px;line-height:1.7}',
      '#gcV35Ad .gc-ov-cta{display:inline-block;background:#0ea5e9;color:#fff;font-weight:700;padding:10px 22px;border-radius:999px;text-decoration:none;font-size:14px}',
      '#gcV35Ad .gc-ov-x{position:absolute;top:10px;right:12px;border:0;background:transparent;font-size:20px;color:#94a3b8;cursor:pointer}',
      /* 浮动推广卡 */
      '#gcPromo5.gc-ov-promo{position:fixed;right:18px;bottom:18px;z-index:10040;width:min(320px,86vw);background:#0f172a;color:#e2e8f0;border-radius:14px;padding:16px 16px 14px;box-shadow:0 18px 42px rgba(2,6,23,.45);font-size:13px}',
      '#gcPromo5 .gc-ov-promo-t{font-weight:800;font-size:14.5px;margin:0 0 6px;color:#fff}',
      '#gcPromo5 .gc-ov-promo-s{margin:0 0 12px;line-height:1.65;color:#cbd5e1;font-size:12.5px}',
      '#gcPromo5 .gc-ov-cta{display:inline-block;background:#38bdf8;color:#082f49;font-weight:700;padding:8px 16px;border-radius:999px;text-decoration:none;font-size:12.5px}',
      '#gcPromo5 .gc-ov-x{position:absolute;top:8px;right:10px;border:0;background:transparent;color:#94a3b8;font-size:16px;cursor:pointer}',
      '#gcPromo5 img.gc-ov-img{width:100%;height:110px;object-fit:cover;border-radius:10px;margin-bottom:10px;display:block}',
      /* 顶部滑入通知 */
      '#announceToast.gc-ov-toast{position:fixed;top:16px;left:50%;transform:translate(-50%,-140%);z-index:10060;background:#0ea5e9;color:#fff;padding:11px 18px;border-radius:999px;font-size:13px;font-weight:700;box-shadow:0 12px 30px rgba(14,165,233,.42);display:flex;align-items:center;gap:10px;transition:transform .38s cubic-bezier(.22,1,.36,1),opacity .3s;opacity:0}',
      '#announceToast.gc-ov-show{transform:translate(-50%,0);opacity:1}',
      '#announceToast .gc-ov-x{border:0;background:rgba(255,255,255,.2);color:#fff;width:20px;height:20px;border-radius:50%;cursor:pointer;font-size:12px;line-height:1}',
      /* 居中 toast */
      '#badgeToastWrap.gc-ov-badge{position:fixed;top:64px;left:50%;transform:translate(-50%,-20px);z-index:10055;background:#1e293b;color:#f8fafc;padding:10px 18px;border-radius:10px;font-size:12.5px;box-shadow:0 14px 30px rgba(2,6,23,.4);opacity:0;transition:opacity .3s,transform .3s}',
      '#badgeToastWrap.gc-ov-show{opacity:1;transform:translate(-50%,0)}'
    ].join('');
    var st = document.createElement('style');
    st.id = 'gcCtrlCss';
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  /* ---------------- 位置投放 ---------------- */

  function anchorFor(slot, node) {
    var q = function (sel) { return document.querySelector(sel); };
    var hero = document.getElementById('heroBanner');
    switch (slot) {
      case 'page-top': return { parent: document.body, before: document.body.firstChild };
      case 'top-second-row': {
        var nav = q('header') || q('.site-header') || q('nav');
        if (nav && nav.parentNode) return { parent: nav.parentNode, before: nav.nextSibling };
        return { parent: document.body, before: hero ? hero : document.body.firstChild };
      }
      case 'below-hero': return hero && hero.parentNode ? { parent: hero.parentNode, before: hero.nextSibling } : { parent: document.body, before: document.body.firstChild };
      case 'hero-center': return { parent: document.body, before: null, skip: true };
      case 'top-bar': return { parent: document.body, before: document.body.firstChild };
      case 'side-bar': return { parent: document.body, before: null, skip: true };
      case 'footer-top': {
        var ft = q('footer');
        return ft && ft.parentNode ? { parent: ft.parentNode, before: ft } : { parent: document.body, before: null };
      }
      case 'fullscreen-modal':
      case 'float-bottom-right':
      case 'float-bottom-left':
      case 'top-slide-toast':
      case 'center-toast':
        return { parent: document.body, before: null, skip: true };
      default: return { parent: document.body, before: null };
    }
  }

  function place(spec, node, c) {
    var a = anchorFor(c.slot, node);
    node.setAttribute('data-gc-slot', c.slot);
    node.setAttribute('data-gc-order', String(c.order));
    if (a.skip || !a.parent) return;
    if (node.parentNode === a.parent && node === (a.before ? a.before.previousSibling : null)) return;
    try {
      if (a.before && a.before.parentNode === a.parent) a.parent.insertBefore(node, a.before);
      else a.parent.appendChild(node);
    } catch (e) { /* 忽略定位失败，保持原位 */ }
  }

  /** 同锚点内按 order 重新排列（优先级真实生效） */
  function sortByOrder() {
    var groups = {};
    SPEC.forEach(function (spec) {
      var n = nodes[spec.key];
      if (!n || !n.parentNode) return;
      var c = n.__gcConf || {};
      var pid = n.parentNode.__gcPid || (n.parentNode.__gcPid = 'p' + Math.random().toString(36).slice(2, 7));
      var pos = n.getAttribute('data-gc-slot') || '';
      (groups[pid + '|' + pos] = groups[pid + '|' + pos] || []).push(n);
    });
    Object.keys(groups).forEach(function (g) {
      var arr = groups[g];
      if (arr.length < 2) return;
      arr.sort(function (a, b) { return (a.__gcOrder || 0) - (b.__gcOrder || 0); });
      var parent = arr[0].parentNode;
      arr.forEach(function (n) { parent.appendChild(n); });
    });
  }

  /* ---------------- 渲染 ---------------- */

  function ensure(key, tag, cls) {
    var n = document.getElementById(key);
    if (!n) {
      n = document.createElement(tag || 'div');
      n.id = key;
      document.body.appendChild(n);
    }
    if (cls) n.className = cls;
    n.classList.add('gc-ov');
    return n;
  }

  function setVisible(node, on) {
    if (!node) return;
    if (on) {
      node.removeAttribute('data-gc-off');
      node.removeAttribute('hidden');
      node.style.removeProperty('display');
    } else {
      node.setAttribute('data-gc-off', '1');
      node.setAttribute('hidden', '1');
      node.style.setProperty('display', 'none', 'important');
    }
  }

  function dismissKey(spec) { return 'gc-ctrl-dismiss:' + spec.key; }

  function isDismissed(spec) {
    try { return window.localStorage.getItem(dismissKey(spec)) === '1'; } catch (e) { return false; }
  }

  function setDismissed(spec) {
    try { window.localStorage.setItem(dismissKey(spec), '1'); } catch (e) {}
  }

  function renderBar(spec, c) {
    var n = ensure('gcMhBar', 'div', 'gc-ov gc-ov-bar');
    n.innerHTML = '<span class="gc-ov-tag">' + esc(c.title || spec.title) + '</span>' +
      (c.sub ? '<span>' + esc(c.sub) + '</span>' : '') +
      (c.closable ? '<button type="button" class="gc-ov-close" aria-label="收起提示">&times;</button>' : '');
    if (c.closable) {
      n.querySelector('.gc-ov-close').addEventListener('click', function () {
        setVisible(n, false);
        setDismissed(spec);
      });
    }
    nodes[spec.key] = n;
    return n;
  }

  function renderLaunch(spec, c) {
    var n = ensure('gcLaunchBanner', 'div', 'gc-ov gc-ov-launch');
    var href = c.href || spec.href || '';
    n.innerHTML = '<span class="gc-ov-new">NEW</span>' +
      '<span><strong>' + esc(c.title) + '</strong>' + (c.sub ? ' · ' + esc(c.sub) : '') + '</span>' +
      (href ? '<a class="gc-ov-go" href="' + esc(href) + '">去解锁 →</a>' : '') +
      (c.closable ? '<button type="button" class="gc-ov-x" aria-label="关闭">&times;</button>' : '');
    if (c.closable) {
      n.querySelector('.gc-ov-x').addEventListener('click', function () {
        setVisible(n, false);
        setDismissed(spec);
      });
    }
    nodes[spec.key] = n;
    return n;
  }

  function renderUpdate(spec, c) {
    var n = ensure('updateBanner', 'div', 'gc-ov gc-ov-update');
    n.innerHTML = '<span class="gc-ov-dot"></span>' +
      '<span><strong>' + esc(c.title) + '</strong>' + (c.sub ? ' · ' + esc(c.sub) : '') + '</span>' +
      (c.closable ? '<button type="button" class="gc-ov-close" aria-label="关闭">&times;</button>' : '');
    if (c.closable) {
      n.querySelector('.gc-ov-close').addEventListener('click', function () {
        setVisible(n, false);
        setDismissed(spec);
      });
    }
    nodes[spec.key] = n;
    return n;
  }

  function renderHero(spec, c) {
    var n = document.getElementById('heroBanner');
    if (!n) { nodes[spec.key] = null; return null; }
    nodes[spec.key] = n;
    // 未配置图片时保留站点默认 4 帧轮播；配置了则替换首帧（无图回落 defaultImage）
    var img = c.image || (c.defaultImage && c.useDefaultImage !== false ? c.defaultImage : '');
    heroLock = img || '';
    if (img) {
      var first = n.querySelector('img');
      if (first && first.getAttribute('src') !== img) first.setAttribute('src', img);
    }
    if (c.title) {
      // 主视觉无可见文字位：后台文案同步到 aria-label 与图片 alt，保证改文案可被读到
      n.setAttribute('aria-label', c.title);
      var altImg = n.querySelector('img');
      if (altImg && altImg.getAttribute('alt') !== c.title) altImg.setAttribute('alt', c.title);
    }
    return n;
  }

  function renderModal(spec, c) {
    var n = ensure('gcV35Ad', 'div', 'gc-ov gc-ov-modal');
    var href = c.href || spec.href || '';
    var img = c.image || (c.defaultImage || '');
    n.innerHTML = '<div class="gc-ov-card">' +
      (c.closable ? '<button type="button" class="gc-ov-x" aria-label="关闭">&times;</button>' : '') +
      (img ? '<img class="gc-ov-img" src="' + esc(img) + '" alt="" style="width:100%;border-radius:12px;margin-bottom:14px;display:block">' : '') +
      '<h3>' + esc(c.title) + '</h3>' +
      (c.sub ? '<p>' + esc(c.sub) + '</p>' : '') +
      (href ? '<a class="gc-ov-cta" href="' + esc(href) + '">立即查看</a>' : '') +
      '</div>';
    if (c.closable) {
      n.querySelector('.gc-ov-x').addEventListener('click', function () {
        setVisible(n, false);
        setDismissed(spec);
      });
    }
    nodes[spec.key] = n;
    return n;
  }

  function renderPromo(spec, c) {
    var n = ensure('gcPromo5', 'div', 'gc-ov gc-ov-promo');
    // 站点自带的「深度研读」卡：内含 .gp-doc 文档列表（数据来自 /api/products），
    // 此时只更新标题/副标题与关闭行为，绝不清空既有文档列表。
    var docs = n.querySelectorAll('.gp-doc');
    if (docs.length) {
      var t = n.querySelector('.gp-ttl b');
      if (t && c.title) t.textContent = c.title;
      var subEl = n.querySelector('.gp-ttl span');
      if (subEl && c.sub) subEl.textContent = c.sub;
      var oldImg = n.querySelector('.gc-ov-img');
      if (c.image) {
        if (!oldImg) {
          oldImg = document.createElement('img');
          oldImg.className = 'gc-ov-img';
          n.insertBefore(oldImg, n.firstChild);
        }
        oldImg.setAttribute('src', c.image);
        oldImg.setAttribute('alt', '');
      } else if (oldImg && oldImg.parentNode) {
        oldImg.parentNode.removeChild(oldImg);
      }
      var clsBtn = n.querySelector('#gcPromo5Close') || n.querySelector('.gp-x');
      if (clsBtn) {
        clsBtn.style.display = c.closable === false ? 'none' : '';
        if (c.closable !== false && !clsBtn.__gcBound) {
          clsBtn.__gcBound = true;
          clsBtn.addEventListener('click', function (ev) {
            if (ev) ev.preventDefault();
            setVisible(n, false);
            setDismissed(spec);
          });
        }
      }
      nodes[spec.key] = n;
      return n;
    }
    var href = c.href || spec.href || '';
    var img = c.image || (c.defaultImage || '');
    n.innerHTML = (img ? '<img class="gc-ov-img" src="' + esc(img) + '" alt="">' : '') +
      (c.closable ? '<button type="button" class="gc-ov-x" aria-label="关闭">&times;</button>' : '') +
      '<p class="gc-ov-promo-t">' + esc(c.title) + '</p>' +
      (c.sub ? '<p class="gc-ov-promo-s">' + esc(c.sub) + '</p>' : '') +
      (href ? '<a class="gc-ov-cta" href="' + esc(href) + '">点开看介绍与付款</a>' : '');
    if (c.closable) {
      n.querySelector('.gc-ov-x').addEventListener('click', function () {
        setVisible(n, false);
        setDismissed(spec);
      });
    }
    nodes[spec.key] = n;
    return n;
  }

  function renderToastTop(spec, c) {
    var repeat = !!shownThisLoad[spec.key];
    var n = ensure('announceToast', 'div', 'gc-ov gc-ov-toast');
    n.innerHTML = '<span>✈ ' + esc(c.title) + (c.sub ? ' · ' + esc(c.sub) : '') + '</span>' +
      (c.closable ? '<button type="button" class="gc-ov-x" aria-label="关闭">&times;</button>' : '');
    nodes[spec.key] = n;
    if (c.closable) {
      n.querySelector('.gc-ov-x').addEventListener('click', function () {
        n.classList.remove('gc-ov-show');
        setTimeout(function () { setVisible(n, false); }, 320);
      });
    }
    if (!repeat) {
      requestAnimationFrame(function () { n.classList.add('gc-ov-show'); });
      timers.push(setTimeout(function () { n.classList.remove('gc-ov-show'); }, 6000));
    }
    return n;
  }

  function renderToastCenter(spec, c) {
    var repeat = !!shownThisLoad[spec.key];
    var wrap = document.getElementById('badgeToastWrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'badgeToastWrap';
      document.body.appendChild(wrap);
    }
    wrap.className = 'gc-ov gc-ov-badge';
    wrap.innerHTML = '<span>✈️ ' + esc(c.title) + (c.sub ? ' · ' + esc(c.sub) : '') + '</span>';
    nodes[spec.key] = wrap;
    if (!repeat) {
      requestAnimationFrame(function () { wrap.classList.add('gc-ov-show'); });
      timers.push(setTimeout(function () { wrap.classList.remove('gc-ov-show'); }, 4200));
    }
    return wrap;
  }

  var RENDERERS = {
    bar: renderBar, launch: renderLaunch, update: renderUpdate, hero: renderHero,
    modal: renderModal, promo: renderPromo, 'toast-top': renderToastTop, 'toast-center': renderToastCenter
  };

  function renderOne(spec) {
    var c = conf(spec);
    var node = nodes[spec.key] || null;
    var show = c.enabled && freqAllows(spec, c) && !isDismissed(spec);
    if (!show) {
      if (!node) node = document.getElementById(spec.key) || document.getElementById(spec.key === 'badgeToast' ? 'badgeToastWrap' : spec.key);
      nodes[spec.key] = node;
      setVisible(node, false);
      if (node) { node.__gcOrder = c.order; node.__gcConf = c; node.setAttribute('data-gc-enabled', '0'); }
      return;
    }
    var fn = RENDERERS[spec.type] || renderBar;
    node = fn(spec, c);
    if (!node) return;
    node.__gcOrder = c.order;
    node.__gcConf = c;
    node.setAttribute('data-gc-enabled', '1');
    node.setAttribute('data-gc-key', spec.key);
    setVisible(node, true);
    place(spec, node, c);
    if (!c._fallback) markFreq(spec, c); // 兜底渲染不写频次，避免影响真实配置的显示次数
  }

  var rendering = false, pendingRender = false;
  function renderAll(silent) {
    if (!document.body) return;
    // 数据未到位且无失败结论时不渲染，避免先用默认值渲染再被真实配置覆盖（频次判定会被污染）
    if (!state.loaded && !state.error) return;
    if (rendering) { pendingRender = true; return; }
    rendering = true;
    try { renderPass(silent); } catch (e) { /* 单次渲染异常不影响后续 */ }
    rendering = false;
    if (pendingRender) { pendingRender = false; window.setTimeout(function () { renderAll(true); }, 0); }
  }

  function renderPass(silent) {
    injectCss();
    SPEC.forEach(function (spec) {
      try { renderOne(spec); } catch (e) { /* 单个失败不影响其余 */ }
    });
    try { sortByOrder(); } catch (e) {}
    try { stampSentinel(); } catch (e) {}
    if (!silent) document.documentElement.setAttribute('data-gc-ctrl', VERSION);
  }

  /** 在受控节点内写入哨兵，用于判断内容是否被外部脚本覆盖 */
  function stampSentinel() {
    SPEC.forEach(function (spec) {
      var n = nodes[spec.key];
      if (!n || n.getAttribute('data-gc-off') === '1') return;
      var old = n.querySelector('[data-gc-sentinel]');
      if (old) old.parentNode.removeChild(old);
      var s = document.createElement('i');
      s.setAttribute('data-gc-sentinel', spec.key);
      s.style.cssText = 'display:none!important';
      n.appendChild(s);
    });
  }

  /** 完整性检查：重复 id 清理 + 受控节点被外部覆盖则重绘 */
  function checkIntegrity() {
    var dirty = false;
    Object.keys(guardMap).forEach(function (id) {
      var list = document.querySelectorAll('[id="' + id + '"]');
      if (list.length > 1) {
        for (var k = 1; k < list.length; k++) {
          if (list[k].parentNode) list[k].parentNode.removeChild(list[k]);
        }
        dirty = true;
      }
    });
    SPEC.forEach(function (spec) {
      var n = nodes[spec.key];
      if (!n || !n.parentNode) { dirty = true; return; }
      if (n.getAttribute('data-gc-off') === '1') {
        if (n.style.display !== 'none') dirty = true;
        return;
      }
      if (!n.querySelector('[data-gc-sentinel]')) dirty = true;
    });
    // 站点自带轮播会改写 heroBanner 首帧；后台已配置图片时强制保持
    if (heroLock) {
      var hb = document.getElementById('heroBanner');
      if (hb && hb.getAttribute('data-gc-off') !== '1') {
        var fi = hb.querySelector('img');
        if (fi && fi.getAttribute('src') !== heroLock) { fi.setAttribute('src', heroLock); dirty = true; }
      }
    }
    if (dirty) renderAll(true);
    return dirty;
  }

  /* ---------------- 守护：外部脚本覆盖/重复注入撤销 ---------------- */

  var guardMap = {
    gcMhBar: 'div', gcLaunchBanner: 'div', updateBanner: 'div', heroBanner: 'div',
    gcV35Ad: 'div', gcPromo5: 'div', announceToast: 'div', badgeToastWrap: 'div'
  };

  var GUARD_SEL = '[id="gcMhBar"],[id="gcLaunchBanner"],[id="updateBanner"],[id="heroBanner"],[id="gcV35Ad"],[id="gcPromo5"],[id="announceToast"],[id="badgeToastWrap"]';

  var guardTimer = null;
  function guard() {
    if (observed || !window.MutationObserver) return;
    observed = true;
    var mo = new MutationObserver(function (muts) {
      if (rendering) return;
      var dirty = false;
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type !== 'childList') continue;
        var t = m.target;
        if (t && t.id && guardMap[t.id]) { dirty = true; break; }
        // 外部脚本新插入的节点（可能嵌套在容器内）
        for (var j = 0; j < m.addedNodes.length; j++) {
          var an = m.addedNodes[j];
          if (!an || an.nodeType !== 1) continue;
          if (an.id && guardMap[an.id]) { dirty = true; break; }
          if (an.querySelector && an.querySelector(GUARD_SEL)) { dirty = true; break; }
        }
        if (dirty) break;
      }
      if (!dirty) return;
      if (guardTimer) clearTimeout(guardTimer);
      guardTimer = window.setTimeout(function () {
        guardTimer = null;
        if (rendering) return;
        checkIntegrity();
      }, 260);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ---------------- 启动 ---------------- */

  function boot() {
    injectCss();
    // 早占位：阻止站点既有脚本再次注入同 id 节点（其内部多有 getElementById 短路）
    guard();
    load(false);
    timers.push(setInterval(function () { if (!document.hidden) load(true); }, POLL_MS));
    timers.push(setInterval(function () { if (!document.hidden && !rendering) checkIntegrity(); }, 6000));
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) load(true);
    });
    window.addEventListener('gc-admin-updated', function () { load(true); });
  }

  window.GC_CTRL = {
    version: VERSION,
    spec: SPEC,
    reload: function () { return load(true); },
    state: function () { return state; },
    render: function () { renderAll(true); },
    check: function () { return checkIntegrity(); },
    get: function (key) { return nodes[key] || null; },
    debug: function () {
      return SPEC.map(function (s) {
        var c = conf(s);
        var n = nodes[s.key];
        return {
          key: s.key, kind: s.kind, enabled: !!c.enabled, slot: c.slot, order: c.order, freq: c.freq,
          rendered: !!n, visible: !!(n && !n.hasAttribute('data-gc-off'))
        };
      });
    }
  };

  if (document.readyState === 'loading') {
    boot();
    document.addEventListener('DOMContentLoaded', function () { renderAll(true); });
  } else {
    boot();
    renderAll(true);
  }
})();
