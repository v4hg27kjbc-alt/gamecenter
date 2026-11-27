/*!
 * gc-product.js — 商品上下架全站联动（主站同源 /api/products）
 * 1) /read/{p}.html、/pay/{p}.html 命中已下架商品 → 全屏提示「目前已下架，无法进行操作」并阻断操作
 * 2) 页面内任何指向已下架商品的链接/卡片 → 灰化禁用并就地标注「目前已下架，无法进行操作」
 * 3) 接口返回全量条目（含 enabled），本脚本只做展示与拦截，不写任何数据
 */
(function () {
  'use strict';
  if (window.GC_PRODUCT_LOADED) return;
  window.GC_PRODUCT_LOADED = true;

  var API = '/api/products';
  var FALLBACK = 'https://henry126923-admincenter.pages.dev/api/products';
  var OFFLINE_TEXT = '目前已下架，无法进行操作';
  var VER = '20261127';

  function rel(u) {
    if (!u) return '';
    var s = String(u).trim();
    try {
      var x = new URL(s, location.origin);
      return x.pathname.replace(/\/+$/, '') || '/';
    } catch (e) {
      return s.split('?')[0].split('#')[0].replace(/\/+$/, '');
    }
  }

  function normItems(items) {
    var map = {};
    var offline = [];
    (items || []).forEach(function (it) {
      if (!it || typeof it !== 'object') return;
      var off = it.enabled === false;
      if (off) offline.push(it);
      var paths = [it.readHref, it.payHref];
      if (it.id) {
        paths.push('/read/' + it.id + '.html');
        paths.push('/pay/' + it.id + '.html');
      }
      if (it.project) {
        paths.push('/read/' + it.project + '.html');
        paths.push('/pay/' + it.project + '.html');
      }
      paths.forEach(function (p) {
        var k = rel(p);
        if (k) map[k] = it;
      });
    });
    return { map: map, offline: offline };
  }

  function injectCss() {
    if (document.getElementById('gcProductCss')) return;
    var st = document.createElement('style');
    st.id = 'gcProductCss';
    st.textContent = [
      '.gc-offline-tag{display:inline-block;margin-left:8px;padding:2px 8px;border-radius:999px;',
      'background:#fee2e2;color:#b91c1c;font-size:12px;line-height:1.6;white-space:nowrap;font-weight:600;}',
      'a.gc-offline-link{pointer-events:none!important;opacity:.55;filter:grayscale(1);text-decoration:line-through!important;}',
      '#gcOfflineMask{position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.72);',
      'display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(2px);}',
      '#gcOfflineMask .gc-om-card{max-width:440px;width:100%;background:#fff;border-radius:14px;padding:22px 20px;',
      'box-shadow:0 20px 60px rgba(0,0,0,.35);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;}',
      '#gcOfflineMask .gc-om-t{font-size:17px;font-weight:700;color:#b91c1c;margin:0 0 8px;}',
      '#gcOfflineMask .gc-om-d{font-size:13.5px;color:#475569;line-height:1.7;margin:0 0 16px;}',
      '#gcOfflineMask .gc-om-a{display:inline-block;padding:9px 18px;border-radius:9px;background:#0f172a;color:#fff;',
      'text-decoration:none;font-size:13.5px;}'
    ].join('');
    (document.head || document.documentElement).appendChild(st);
  }

  function showMask(item) {
    if (document.getElementById('gcOfflineMask')) return;
    injectCss();
    var mask = document.createElement('div');
    mask.id = 'gcOfflineMask';
    mask.setAttribute('data-gc-product', item && item.id ? item.id : '');
    mask.innerHTML =
      '<div class="gc-om-card" role="alertdialog" aria-label="' + OFFLINE_TEXT + '">' +
      '<p class="gc-om-t">' + OFFLINE_TEXT + '</p>' +
      '<p class="gc-om-d">该商品已由管理员下架，相关的付款、阅读与券码兑换均已停止。' +
      '如需继续查看，请返回首页选择其他在售文档。</p>' +
      '<a class="gc-om-a" href="/">返回首页</a>' +
      '</div>';
    (document.body || document.documentElement).appendChild(mask);
    // 阻断页内可点击元素（遮罩本身除外）
    try {
      document.documentElement.style.overflow = 'hidden';
    } catch (e) {}
  }

  function markLink(a, item) {
    if (!a || a.getAttribute('data-gc-offline') === '1') return;
    a.setAttribute('data-gc-offline', '1');
    a.classList.add('gc-offline-link');
    a.setAttribute('aria-disabled', 'true');
    a.setAttribute('title', OFFLINE_TEXT);
    a.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      showMask(item);
    }, true);
    var host = a.closest('.pick-card, .gp-doc, .gc-pf-trial, .card, li');
    if (host && !host.querySelector('.gc-offline-tag')) {
      var tag = document.createElement('span');
      tag.className = 'gc-offline-tag';
      tag.textContent = OFFLINE_TEXT;
      (a.parentNode && a.parentNode !== host ? a.parentNode : host).appendChild(tag);
    }
  }

  function apply(items) {
    var res = normItems(items);
    var map = res.map;

    // 1) 当前页即下架商品页
    var cur = rel(location.pathname);
    var hit = map[cur];
    if (hit && hit.enabled === false) showMask(hit);

    // 2) 页内所有指向下架商品的链接
    var links = document.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var k = rel(a.getAttribute('href'));
      var it = map[k];
      if (it && it.enabled === false) markLink(a, it);
    }
    // 3) 供其它脚本查询
    window.GC_PRODUCTS = {
      version: VER,
      items: items || [],
      offline: res.offline,
      isOffline: function (p) {
        var it = map[rel(p)];
        return !!(it && it.enabled === false);
      },
      text: OFFLINE_TEXT
    };
    try {
      document.dispatchEvent(new CustomEvent('gc-products-ready', { detail: window.GC_PRODUCTS }));
    } catch (e) {}
  }

  function getJSON(url) {
    return fetch(url, { cache: 'no-store', credentials: 'omit' }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    });
  }

  function boot() {
    injectCss();
    getJSON(API).then(function (d) {
      if (!d || d.ok === false) throw new Error('bad payload');
      apply(d.items || []);
    }).catch(function () {
      getJSON(FALLBACK).then(function (d) {
        if (d && d.ok !== false) apply(d.items || []);
      }).catch(function () {});
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
