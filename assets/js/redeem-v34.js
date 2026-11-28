
(function () {
  if (window.__gcRedeemV34) return;
  window.__gcRedeemV34 = true;
  var PENDING = 'gc_coupon_pending';

  function norm(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function fmt(v) {
    var c = norm(v);
    if (c.length > 10) return c;
    var a = c.slice(0, 2), b = c.slice(2, 6), d = c.slice(6, 10);
    return [a, b, d].filter(Boolean).join('-');
  }
  function tk() { try { return localStorage.getItem('gc_acct_token') || ''; } catch (e) { return ''; } }
  function tip(msg, isErr) {
    var t = document.getElementById('gcCouponTip');
    if (t) { t.textContent = msg; t.style.color = isErr ? '#b91c1c' : '#16a34a'; }
    if (typeof window.gcToast === 'function') { try { window.gcToast(msg); } catch (e) {} }
    else { try { toast(msg); } catch (e) {} }
  }
  function api(action, extra) {
    var body = Object.assign({ action: action }, extra || {});
    var t = tk(); if (t && !body.token) body.token = t;
    return fetch('/api/coupon', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad_response' }; }); });
  }
  function pulse(node) {
    if (!node || !node.animate) return;
    try {
      var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduce) return;
      node.animate([
        { transform: 'scale(1)', boxShadow: '0 0 0 0 rgba(22,163,74,.55)' },
        { transform: 'scale(1.045)', boxShadow: '0 0 0 12px rgba(22,163,74,0)' },
        { transform: 'scale(1)', boxShadow: '0 0 0 0 rgba(22,163,74,0)' }
      ], { duration: 620, easing: 'cubic-bezier(.22,1,.36,1)' });
    } catch (e) {}
  }
  var MSG = {
    unauthorized: '请先登录后再兑换券码', coupon_not_found: '券码不存在，请核对后重试',
    coupon_used: '该券码已被使用，如有疑问请联系站长', coupon_revoked: '该券码已被作废',
    coupon_expired: '该券码已过期', coupon_invalid: '请输入完整的券码',
    list_full: '券码数量已达上限', KV_UNAVAILABLE: '服务端存储未就绪，稍后再试'
  };
  function msgOf(k) { return MSG[k] || ('兑换失败：' + (k || '未知错误')); }

  /* 全站唯一兑换实现：任何入口（个人中心 / 扫码落地 / 链接携带 / 外部调用）都走这里 */
  window.gcRedeemCode = function (raw, opts) {
    opts = opts || {};
    var btn = opts.button || document.getElementById('gcCouponRedeem');
    var code = norm(raw);
    if (!code || code.length < 6) { tip('请输入完整的券码', true); return Promise.resolve({ ok: false, error: 'coupon_invalid' }); }
    if (!tk()) {
      try { localStorage.setItem(PENDING, code); } catch (e) {}
      tip('请先登录，登录后会自动为你兑换', true);
      try { if (window.GC && window.GC.openMask) window.GC.openMask('auth', '券码兑换'); } catch (e) {}
      var maskBtn = document.querySelector('[data-mask="auth"], #gcAuthOpen, #gcLoginBtn');
      if (!maskBtn) { try { var el = document.getElementById('gcProfileBtn'); if (el) el.click(); } catch (e) {} }
      return Promise.resolve({ ok: false, error: 'login_required', pending: true });
    }
    if (btn) { btn.disabled = true; btn.dataset.old = btn.textContent; btn.textContent = '兑换中…'; }
    return api('redeem', { code: code }).then(function (res) {
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.old || '立即兑换'; }
      if (res && res.ok) {
        try { localStorage.removeItem(PENDING); } catch (e) {}
        var inp = document.getElementById('gcCouponInput'); if (inp) inp.value = '';
        if (res.coupons && window.__gcApplyCoupons) { try { window.__gcApplyCoupons(res.coupons); } catch (e) {} }
        var c = res.coupon || {};
        tip(res.already ? '这张券码已经兑换过了，可在下方查看'
          : ('兑换成功：' + (c.type || '券码') + '（该券码已核销）'), !!res.already);
        pulse(btn);
        try { document.dispatchEvent(new CustomEvent('gc:coupon-redeemed', { detail: res })); } catch (e) {}
        return res;
      }
      if (res && res.error === 'unauthorized') {
        try { localStorage.setItem(PENDING, code); } catch (e) {}
      }
      tip(msgOf(res && res.error), true);
      return res || { ok: false };
    }).catch(function () {
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.old || '立即兑换'; }
      tip('网络异常，请稍后重试', true);
      return { ok: false, error: 'network' };
    });
  };

  /* 登录成功后自动补兑换（未登录时落地的券码） */
  function flushPending() {
    var code = '';
    try { code = localStorage.getItem(PENDING) || ''; } catch (e) {}
    if (!code || !tk()) return;
    setTimeout(function () { try { window.gcRedeemCode(code); } catch (e) {} }, 800);
  }
  try {
    var of = window.fetch;
    window.fetch = function (input, init) {
      var url = (typeof input === 'string') ? input : (input && input.url) || '';
      var pr = of.apply(this, arguments);
      if (/\/api\/account/.test(url) && init && typeof init.body === 'string' && /"action"\s*:\s*"login"/.test(init.body)) {
        return pr.then(function (r) {
          try {
            r.clone().json().then(function (d) { if (d && d.token) flushPending(); }).catch(function () {});
          } catch (e) {}
          return r;
        });
      }
      return pr;
    };
  } catch (e) {}

  /* 接管个人中心按钮与回车，统一走 gcRedeemCode */
  function bind() {
    var btn = document.getElementById('gcCouponRedeem');
    if (btn && !btn.__gcUni) {
      btn.__gcUni = true;
      btn.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopImmediatePropagation();
        var inp = document.getElementById('gcCouponInput');
        window.gcRedeemCode(inp && inp.value, { button: btn });
      }, true);
    }
    var inp = document.getElementById('gcCouponInput');
    if (inp && !inp.__gcUni) {
      inp.__gcUni = true;
      inp.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault(); ev.stopImmediatePropagation();
          window.gcRedeemCode(inp.value, { button: document.getElementById('gcCouponRedeem') });
        }
      }, true);
      inp.addEventListener('blur', function () { if (inp.value) inp.value = fmt(inp.value); });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  setTimeout(bind, 1200);
  setTimeout(flushPending, 2600);
})();
