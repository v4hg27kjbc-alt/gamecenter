
(function () {
  'use strict';
  var API = '/api/account';
  var TK = 'gc_acct_token';
  var st = { token: null, profile: null, mode: 'onetap', way: 'password' };

  function $(id) { return document.getElementById(id); }
  function ls(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; }
  }
  function jget(k) { try { return JSON.parse(localStorage.getItem(k) || '[]') || []; } catch (e) { return []; } }
  function jset(k, v) { try { localStorage.setItem(k, JSON.stringify(v || [])); } catch (e) {} }

  function label(a) {
    if (!a) return '';
    try { if (typeof window.t === 'function') return window.t(a.name); } catch (e) {}
    return typeof a.name === 'string' ? a.name : ((a.name && (a.name.zh || a.name.en)) || a.id);
  }
  function findAircraft(id) {
    try { if (window.aircrafts && window.aircrafts.length) return window.aircrafts.find(function (x) { return x.id === id; }); } catch (e) {}
    return null;
  }

  function presetAvatars() {
    var out = [];
    var themes = [
      ['#3b82f6', '#1d4ed8', 'M2 12h20M12 2l7 10-7 10-7-10z'],
      ['#667eea', '#764ba2', 'M12 3l2.6 5.9 6.4.6-4.8 4.3 1.4 6.3L12 16.9 6.4 20.1l1.4-6.3L3 9.5l6.4-.6z'],
      ['#0ea5e9', '#0369a1', 'M4 15c3-4 5-6 8-6s5 2 8 6M7 19c2-2.5 3.3-3.8 5-3.8s3 1.3 5 3.8'],
      ['#f59e0b', '#b45309', 'M12 3a9 9 0 100 18 9 9 0 000-18zm0 4.5l4.5 8h-9z'],
      ['#10b981', '#047857', 'M3 12l9-8 9 8v8a2 2 0 01-2 2H5a2 2 0 01-2-2z'],
      ['#ec4899', '#9d174d', 'M12 21s-7-4.6-7-9.6A3.9 3.9 0 0112 8a3.9 3.9 0 017 3.4C19 16.4 12 21 12 21z']
    ];
    themes.forEach(function (tt) {
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="96" height="96">' +
        '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="' + tt[0] + '"/><stop offset="1" stop-color="' + tt[1] + '"/></linearGradient></defs>' +
        '<rect width="24" height="24" fill="url(#g)"/>' +
        '<path d="' + tt[2] + '" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.92"/>' +
        '</svg>';
      out.push('data:image/svg+xml,' + encodeURIComponent(svg));
    });
    return out;
  }
  var PRESETS = presetAvatars();

  function api(action, extra) {
    var payload = Object.assign({ action: action }, extra || {});
    if (st.token && !payload.token) payload.token = st.token;
    return fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad_response' }; }); });
  }

  var MSG = {
    username_taken: '这个用户名已被占用，换一个试试',
    user_not_found: '账号不存在，请先注册',
    bad_password: '密码不正确',
    username_invalid: '用户名需 2-16 位，中文/字母/数字/下划线',
    password_too_short: '密码至少 6 位',
    display_name_invalid: '昵称 1-16 个字符',
    avatar_too_large: '头像文件太大，换一张小一点的',
    KV_UNAVAILABLE: '服务端存储未就绪，稍后再试',
    unauthorized: '登录状态已失效，请重新登录',
    account_banned: '该账号已被限制登录，请联系管理员',
    phone_not_registered: '该手机号还没有注册，请先注册',
    phone_invalid: '请输入正确的 11 位手机号',
    phone_taken: '该手机号已绑定其他账号，请更换或先在原账号解绑',
    code_invalid: '请输入短信验证码',
    code_expired: '验证码已过期，请重新获取',
    code_wrong: '验证码不正确',
    list_full: '列表已满（上限 300 条）'
  };
  function msgOf(code) { return MSG[code] || ('操作失败：' + (code || '未知错误')); }

  function setMsg(text, ok) {
    var el = $('gcAcctMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'gc-acct-msg' + (ok ? ' ok' : '');
  }

  /* v3.6 AI 模型可用性：每次访问都提示（带时间）+ 后台记录 */
  (function initModelHealth() {
    var AVAIL = ['kimi-k2.6'];
    var UNAVAIL = ['kimi-k3', 'kimi-k3.1-pro'];
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    function nowText() {
      var d = new Date();
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
        + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }
    function renderBar(notice, atText) {
      if (document.getElementById('gcMhBar')) return;
      var bar = document.createElement('div');
      bar.id = 'gcMhBar';
      bar.style.cssText = 'position:relative;z-index:9998;display:flex;align-items:center;gap:8px;flex-wrap:wrap;'
        + 'padding:9px 14px;background:#fffbeb;border-bottom:1px solid #fde68a;color:#92400e;'
        + 'font-size:12.5px;line-height:1.6;font-family:inherit;text-align:left';
      bar.innerHTML = '<b style="flex:0 0 auto;color:#b45309">AI 模型提示</b>'
        + '<span style="flex:1 1 220px">' + (notice || '当前仅 kimi-k2.6 可用，其余模型暂不可用') + '</span>'
        + '<span style="flex:0 0 auto;color:#a16207">时间：' + (atText || nowText()) + '</span>'
        + '<button type="button" aria-label="收起提示" style="flex:0 0 auto;border:0;background:none;color:#a16207;'
        + 'font-size:15px;cursor:pointer;line-height:1;padding:0 2px">×</button>';
      bar.querySelector('button').addEventListener('click', function () { bar.remove(); });
      var body = document.body;
      body.insertBefore(bar, body.firstChild);
    }
    function report() {
      try {
        fetch('/api/model-health', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'report', available: AVAIL, unavailable: UNAVAIL, ua: navigator.userAgent || '' })
        }).catch(function () { });
      } catch (e) { }
    }
    setTimeout(function () {
      fetch('/api/model-health', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.ok) renderBar(d.notice, d.atText || nowText());
          else renderBar('', nowText());
          report();
        })
        .catch(function () { renderBar('', nowText()); report(); });
    }, 600);
  })();

  /* v3.6 手机端「我的」入口：直接打开账号面板（未登录先进登录页） */
  function gcMyOpen(tab) {
    try {
      if (typeof st !== 'undefined' && st && st.profile) { openMask('profile'); }
      else { openMask('auth', '我的'); }
    } catch (e) { try { openMask('profile'); } catch (e2) {} }
    setTimeout(function () {
      var sec = document.getElementById('gcMySec');
      if (sec && sec.scrollIntoView) { try { sec.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {} }
      var inp = document.getElementById('gcOrderContact');
      if (tab !== 'no-focus' && inp) { try { inp.focus({ preventScroll: true }); } catch (e) {} }
    }, 320);
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.id) return;
    if (t.id === 'gcMyEntry' || t.id === 'gcMyOrderEntry') { e.preventDefault(); gcMyOpen(); }
  }, true);

  function openMask(view, reason) {
    var mask = $('gcAcctMask');
    if (!mask) return;
    mask.classList.add('on');
    mask.setAttribute('aria-hidden', 'false');
    var g = $('gcAcctGate');
    if (g) { g.style.display = 'none'; g.textContent = ''; }
    if (view === 'profile' && st.profile) {
      $('gcAcctAuth').style.display = 'none';
      $('gcAcctProfile').style.display = 'block';
      renderProfile();
    } else {
      $('gcAcctAuth').style.display = 'block';
      $('gcAcctProfile').style.display = 'none';
      setMode(st.mode);
      setMsg(sessionStorage.getItem('gc_acct_bad') || '');
      sessionStorage.removeItem('gc_acct_bad');
      if (reason && g) {
        g.style.display = 'block';
        g.textContent = '「' + reason + '」需登录后使用：登录或注册即可解锁收藏同步、笔记保存与深度研读';
      }
    }
  }
  function closeMask() {
    var mask = $('gcAcctMask');
    if (!mask) return;
    mask.classList.remove('on');
    mask.setAttribute('aria-hidden', 'true');
    setMsg('');
    var g = $('gcAcctGate');
    if (g) { g.style.display = 'none'; g.textContent = ''; }
  }

  function setMode(mode) {
    st.mode = mode === 'register' ? 'register' : 'login';
    if (st.mode === 'register' && !st.way) st.way = 'code';
    var isReg = st.mode === 'register';
    var isCode = st.way === 'code';
    if ($('gcTabLogin')) $('gcTabLogin').classList.toggle('on', !isReg);
    if ($('gcTabRegister')) $('gcTabRegister').classList.toggle('on', isReg);
    if ($('gcWayWrap')) $('gcWayWrap').style.display = isReg ? 'none' : 'flex';
    if ($('gcWayPwd')) $('gcWayPwd').classList.toggle('on', st.way === 'password');
    if ($('gcWayCode')) $('gcWayCode').classList.toggle('on', isCode);
    if ($('gcPhoneWrap')) $('gcPhoneWrap').style.display = (isReg || isCode) ? 'block' : 'none';
    if ($('gcCodeWrap')) $('gcCodeWrap').style.display = (isReg || isCode) ? 'block' : 'none';
    if ($('gcNameWrap')) $('gcNameWrap').style.display = (isReg || !isCode) ? 'block' : 'none';
    if ($('gcPassWrap')) $('gcPassWrap').style.display = (isReg || !isCode) ? 'block' : 'none';
    if ($('gcAcctPass2Wrap')) $('gcAcctPass2Wrap').style.display = isReg ? 'block' : 'none';
    if ($('gcAcctSubmit')) $('gcAcctSubmit').textContent = isReg ? '注册并登录' : (isCode ? '验证码登录' : '密码登录');
    if ($('gcNameLabel')) $('gcNameLabel').textContent = isReg ? '用户名（可中文，2-16 位）' : '用户名 / UID / 手机号';
    if ($('gcAcctName')) $('gcAcctName').placeholder = isReg ? '给自己起个名字' : '例如 henry 或 13800000000';
    if ($('gcPassLabel')) $('gcPassLabel').textContent = isReg ? '密码（默认 12345678）' : '密码';
    if ($('gcAcctPass')) {
      $('gcAcctPass').setAttribute('autocomplete', isReg ? 'new-password' : 'current-password');
      if (isReg && !$('gcAcctPass').value) $('gcAcctPass').value = '12345678';
    }
    if ($('gcAcctPass2') && isReg && !$('gcAcctPass2').value) $('gcAcctPass2').value = '12345678';
    setMsg('');
  }

  function submitAuth() {
    var isReg = st.mode === 'register';
    var isCode = st.way === 'code';
    var phone = (($('gcAcctPhone') || {}).value || '').replace(/\s/g, '');
    var code = (($('gcAcctCode') || {}).value || '').replace(/\s/g, '');
    var name = (($('gcAcctName') || {}).value || '').trim();
    var pass = (($('gcAcctPass') || {}).value) || '';
    var btn = $('gcAcctSubmit');
    if (!btn) return;

    if (isReg) {
      if (!/^1[3-9]\d{9}$/.test(phone)) { setMsg('请输入正确的 11 位手机号'); return; }
      if (!/^\d{4,8}$/.test(code)) { setMsg('请输入收到的短信验证码'); return; }
      if (!name) { setMsg('请填写用户名（2-16 位，可中文）'); return; }
      var p2 = $('gcAcctPass2').value || '';
      if (!pass) pass = '12345678';
      if (pass.length < 6) { setMsg('密码至少 6 位'); return; }
      if (pass !== p2) { setMsg('两次输入的密码不一致'); return; }
    } else if (isCode) {
      if (!/^1[3-9]\d{9}$/.test(phone)) { setMsg('请输入正确的 11 位手机号'); return; }
      if (!/^\d{4,8}$/.test(code)) { setMsg('请输入收到的短信验证码'); return; }
    } else if (!name || !pass) {
      setMsg('请填写账号和密码');
      return;
    }

    btn.disabled = true;
    btn.textContent = isReg ? '注册中…' : '登录中…';
    var req;
    if (isReg) req = api('register', { username: name, password: pass, phone: phone, code: code });
    else if (isCode) req = api('onetap', { mode: 'code', phone: phone, code: code });
    else req = api('onetap', { mode: 'password', username: name, password: pass });

    req.then(function (res) {
      btn.disabled = false;
      setMode(st.mode);
      if (!res || !res.ok) {
        var em = (res && (res.hint || res.message)) || '';
        setMsg(em || msgOf(res && res.error));
        /* 黑名单账号：所有模式（含登录）统一弹站内通知 */
        if (res && (res.error === 'account_banned' || res.error === 'banned' || res.blocked === true)) {
          if (typeof window.__siteBlockCard === 'function') {
            window.__siteBlockCard(res.blocked || res.block || { reason: em || msgOf(res.error) });
          }
        }
        return;
      }
      st.token = res.token;
      st.profile = res.profile;
      ls(TK, res.token);
      unlockAiOnLogin();
      applyProfile();
      openMask('profile');
      renderProfile();
      autoMigrateTemp();
      var needBind = !!(res.needBindPhone || (res.profile && res.profile.needBindPhone));
      if (needBind) setTimeout(function () { maybeBindPrompt(res.profile); }, 420);
      var nick = (res.profile && (res.profile.displayName || res.profile.username)) || '';
      toast((isReg ? '注册成功，已自动登录：' : '登录成功，欢迎回来 ') + nick);
      /* v3.5：注册成功 → 直接给出文档链接自动下载 → 感谢页 → 可返回主站 */
      if (isReg) {
        setTimeout(function () {
          try {
            var a = document.createElement('a');
            a.href = '/api/project-doc?project=c919&download=1&welcome=1&t=' + Date.now();
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            setTimeout(function () {
              if (a.parentNode) a.parentNode.removeChild(a);
              window.location.href = '/thanks.html?project=c919&welcome=1';
            }, 1200);
          } catch (e) { }
        }, 650);
      }
      setTimeout(function () {
        var pending = jget('gc_temp_favs').length + jget('gc_temp_saved').length;
        if (pending > 0) toast('检测到 ' + pending + ' 条临时收藏，正在同步到账号');
      }, 600);
    }).catch(function () {
      btn.disabled = false;
      setMode(st.mode);
      setMsg('网络异常，请稍后重试');
    });
  }

  var codeTimer = null;
  function sendCode() {
    var el = $('gcAcctPhone');
    var phone = ((el && el.value) || '').replace(/\s/g, '');
    if (!/^1[3-9]\d{9}$/.test(phone)) { setMsg('请先填写正确的 11 位手机号'); if (el) el.focus(); return; }
    var b = $('gcSendCode');
    if (!b || b.disabled) return;
    b.disabled = true;
    b.textContent = '发送中…';
    fetch('/api/sms-verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phoneNumber: phone }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad_response' }; }); })
      .then(function (res) {
        if (!res || !res.ok) {
          b.disabled = false;
          b.textContent = '重新获取';
          setMsg('验证码发送失败：' + ((res && (res.message || res.hint || res.error)) || '请稍后再试'));
          return;
        }
        setMsg('验证码已发送至 ' + ((res && res.phone) || phone) + '，5 分钟内有效', true);
        var left = 60;
        b.textContent = left + 's';
        if (codeTimer) clearInterval(codeTimer);
        codeTimer = setInterval(function () {
          left--;
          if (left <= 0) { clearInterval(codeTimer); codeTimer = null; b.disabled = false; b.textContent = '重新获取'; }
          else b.textContent = left + 's';
        }, 1000);
      })
      .catch(function () { b.disabled = false; b.textContent = '重新获取'; setMsg('网络异常，验证码发送失败'); });
  }

  /* ===== 手机号绑定：后台用户首次登录提示 + 短信验证码绑定 ===== */
  var bindTimer = null;
  function bindMsg(text, ok) {
    var el = $('gcBindMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'gc-acct-msg' + (ok ? ' ok' : '');
  }
  function openBind(reason) {
    var mask = $('gcBindMask');
    if (!mask) return;
    var p = st.profile || {};
    var sub = $('gcBindSub');
    var tip = '没有绑定手机号：绑定后可用验证码登录、找回账号，收藏与笔记也能跨设备同步。';
    if (reason === 'phone_unverified' || (p.phone && !p.phoneVerified)) {
      tip = '后台登记的手机号（' + (p.phone || '') + '）还没完成验证，请用短信验证码确认绑定。';
    }
    if (sub) sub.textContent = tip;
    var ph = $('gcBindPhone');
    if (ph && !ph.value && /^1[3-9]\d{9}$/.test(p.phone || '')) ph.value = p.phone;
    bindMsg('');
    mask.classList.add('on');
    mask.setAttribute('aria-hidden', 'false');
    setTimeout(function () { if (ph) ph.focus(); }, 120);
  }
  function closeBind() {
    var mask = $('gcBindMask');
    if (!mask) return;
    mask.classList.remove('on');
    mask.setAttribute('aria-hidden', 'true');
    bindMsg('');
  }
  function maybeBindPrompt(profile) {
    var p = profile || st.profile;
    if (!p || !p.needBindPhone) return;
    if (sessionStorage.getItem('gc_bind_skip') === '1') return;
    openBind(p.bindReason || 'no_phone');
  }
  function sendBindCode() {
    var el = $('gcBindPhone');
    var phone = ((el && el.value) || '').replace(/\s/g, '');
    if (!/^1[3-9]\d{9}$/.test(phone)) { bindMsg('请先填写正确的 11 位手机号'); if (el) el.focus(); return; }
    var b = $('gcBindSend');
    if (!b || b.disabled) return;
    b.disabled = true;
    b.textContent = '发送中…';
    fetch('/api/sms-verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phoneNumber: phone }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad_response' }; }); })
      .then(function (res) {
        if (!res || !res.ok) {
          b.disabled = false;
          b.textContent = '重新获取';
          bindMsg('验证码发送失败：' + ((res && (res.message || res.hint || res.error)) || '请稍后再试'));
          return;
        }
        bindMsg('验证码已发送至 ' + ((res && res.phone) || phone) + '，5 分钟内有效', true);
        var left = 60;
        b.textContent = left + 's';
        if (bindTimer) clearInterval(bindTimer);
        bindTimer = setInterval(function () {
          left--;
          if (left <= 0) { clearInterval(bindTimer); bindTimer = null; b.disabled = false; b.textContent = '重新获取'; }
          else b.textContent = left + 's';
        }, 1000);
      })
      .catch(function () { b.disabled = false; b.textContent = '重新获取'; bindMsg('网络异常，验证码发送失败'); });
  }
  function submitBind() {
    var phone = (($('gcBindPhone') || {}).value || '').replace(/\s/g, '');
    var code = (($('gcBindCode') || {}).value || '').replace(/\s/g, '');
    if (!/^1[3-9]\d{9}$/.test(phone)) { bindMsg('请输入正确的 11 位手机号'); return; }
    if (!/^\d{4,8}$/.test(code)) { bindMsg('请输入收到的短信验证码'); return; }
    var btn = $('gcBindSubmit');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '绑定中…';
    api('bindphone', { phone: phone, code: code }).then(function (res) {
      btn.disabled = false;
      btn.textContent = '绑定手机号';
      if (!res || !res.ok) {
        bindMsg((res && (res.hint || res.message)) || msgOf(res && res.error));
        /* 更换次数用尽：直接告知上限，不再让用户反复尝试 */
        if (res && res.error === 'phone_change_limit') renderProfile();
        return;
      }
      st.profile = res.profile || st.profile;
      if ($('gcBindCode')) $('gcBindCode').value = '';
      if ($('gcBindPhone')) $('gcBindPhone').value = '';
      sessionStorage.removeItem('gc_bind_skip');
      closeBind();
      renderProfile();
      var left = (res && res.remaining !== undefined) ? Number(res.remaining) : null;
      if (res && res.changed) {
        toast('手机号已更换' + (left !== null ? '，还可更换 ' + left + ' 次' : ''));
      } else {
        toast('手机号绑定成功，之后不再提示绑定');
      }
    }).catch(function () {
      btn.disabled = false;
      btn.textContent = '绑定手机号';
      bindMsg('网络异常，请稍后重试');
    });
  }

  function gcGate(reason) {
    st.mode = 'login';
    openMask('auth', reason);
  }

  function applyProfile() {
    var p = st.profile;
    var btn = $('gcAcctBtn'), txt = $('gcAcctBtnText');
    if (!btn) return;
    if (p) {
      txt.textContent = p.displayName || p.username;
      var old = btn.querySelector('.gc-acct-avatar');
      if (old) old.remove();
      var img = document.createElement('img');
      img.className = 'gc-acct-avatar';
      img.alt = '';
      img.src = p.avatar || PRESETS[0];
      var svg = btn.querySelector('svg');
      if (svg) svg.style.display = 'none';
      btn.insertBefore(img, btn.firstChild);
    } else {
      txt.textContent = '登录';
      var av = btn.querySelector('.gc-acct-avatar');
      if (av) av.remove();
      var sv2 = btn.querySelector('svg');
      if (sv2) sv2.style.display = '';
    }
  }

  function renderProfile() {
    var p = st.profile;
    if (!p) return;
    /* 登录后自动合并未登录期间的本地临时收藏，避免跨设备/跨会话不同步 */
    try { autoMigrateTemp(); } catch (e) {}
    /* 扫码/链接带入的券码：自动填入输入框，等待用户点击兑换 */
    try {
      var pc = takePendingCoupon();
      var ci = $('gcCouponInput');
      if (pc && ci && !ci.value) {
        ci.value = pc;
        var ctip = $('gcCouponTip');
        if (ctip) { ctip.textContent = '已带入券码 ' + pc + '，点击「立即兑换」完成核销'; ctip.style.color = '#0e7490'; }
      }
    } catch (e) {}
    $('gcPfAvatar').src = p.avatar || PRESETS[0];
    $('gcPfName').textContent = p.displayName || p.username;
    $('gcPfUid').textContent = 'UID ' + p.uid;
    $('gcPfBadge').textContent = p.migrated ? '已迁移 · 试运营免费' : '试运营 · 免费解锁';

    var grid = $('gcAvatarGrid');
    if (grid && !grid.dataset.built) {
      PRESETS.forEach(function (src, i) {
        var im = document.createElement('img');
        im.className = 'gc-avatar-opt';
        im.src = src;
        im.alt = '预设头像' + (i + 1);
        im.addEventListener('click', function () { saveAvatar(src); });
        grid.appendChild(im);
      });
      grid.dataset.built = '1';
    }
    if (grid) {
      Array.prototype.forEach.call(grid.children, function (el) { el.classList.toggle('on', el.src === (p.avatar || PRESETS[0])); });
    }

    renderCoupons(p.coupons);
    gcOrderBoot(p);

    var phText = $('gcPfPhoneText');
    if (phText) {
      var phv = p.phone || '';
      if (phv) {
        phText.textContent = phv + (p.phoneVerified ? ' · 已验证' : ' · 待验证');
        phText.style.color = p.phoneVerified ? '#16a34a' : '#b45309';
      } else {
        phText.textContent = '未绑定手机号';
        phText.style.color = '#b45309';
      }
    }
    var bindBtn = $('gcPfBind');
    if (bindBtn) {
      bindBtn.style.display = '';
      var leftCh = Math.max(0, Number(p.phoneChangeRemaining === undefined ? 2 : p.phoneChangeRemaining));
      if (!p.phone) {
        bindBtn.textContent = '绑定手机号';
        bindBtn.disabled = false;
      } else if (!p.phoneVerified) {
        bindBtn.textContent = '验证手机号';
        bindBtn.disabled = false;
      } else if (leftCh > 0) {
        bindBtn.textContent = '更换手机号（剩 ' + leftCh + ' 次）';
        bindBtn.disabled = false;
      } else {
        bindBtn.textContent = '更换次数已用尽';
        bindBtn.disabled = true;
      }
    }
    var phTip = $('gcPfPhoneTip');
    if (phTip) {
      var chLeft = Math.max(0, Number(p.phoneChangeRemaining === undefined ? 2 : p.phoneChangeRemaining));
      var chNote = p.phone ? ('手机号可更换 ' + chLeft + ' 次（每账号最多 2 次，每次需短信验证码）。') : '';
      phTip.textContent = p.needBindPhone
        ? '绑定后可用验证码登录、找回账号，并停止绑定提醒。' + (p.phone ? ' ' + chNote : '')
        : '手机号已验证，可用验证码登录与找回账号。' + (chNote ? ' ' + chNote : '');
    }

    var mig = $('gcPfMigrate');
    var pending = jget('gc_temp_favs').length + jget('gc_temp_saved').length;
    if (mig) mig.style.display = (p.migrated && pending === 0) ? 'none' : '';
  }

  /* ===== 券码兑换 ===== */
  function couponNorm(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function couponApi(action, extra) {
    var payload = Object.assign({ action: action }, extra || {});
    if (st.token && !payload.token) payload.token = st.token;
    return fetch('/api/coupon', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad_response' }; }); });
  }
  var COUPON_MSG = {
    unauthorized: '请先登录后再兑换券码',
    coupon_not_found: '券码不存在，请核对后重试',
    coupon_used: '该券码已被使用，如有疑问请联系站长',
    coupon_revoked: '该券码已被作废，如有疑问请联系站长',
    coupon_expired: '该券码已过期',
    coupon_invalid: '请输入完整的券码',
    list_full: '券码数量已达上限',
    KV_UNAVAILABLE: '服务端存储未就绪，稍后再试'
  };
  function couponMsg(code) { return COUPON_MSG[code] || ('兑换失败：' + (code || '未知错误')); }
  function couponEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function maskCouponCode(v) {
    var s = String(v || '');
    var parts = s.split('-');
    if (parts.length >= 3) return parts[0] + '-' + parts[1] + '-••••';
    return s ? s.slice(0, 4) + '••••' : '';
  }
  function renderCoupons(list) {
    try { window.__gcRenderCoupons = renderCoupons; } catch (e) {}
    var box = $('gcCouponList');
    var cnt = $('gcCouponCount');
    list = list || [];
    if (cnt) cnt.textContent = list.length;
    if (!box) return;
    if (!list.length) { box.innerHTML = '<span class="gc-pf-empty">还没有兑换记录</span>'; return; }
    box.innerHTML = list.map(function (c) {
      c = c || {};
      var meta = [];
      if (c.type) meta.push(couponEsc(c.type));
      if (c.value) meta.push(couponEsc(c.value));
      var at = c.at ? String(c.at).slice(0, 10) : '';
      if (at) meta.push(at);
      var m = /ORD-\d{8}-[A-Z0-9]{6}/.exec(String(c.note || ''));
      var btn = m ? '<button class="gc-pf-btn primary" data-coread="' + m[0] + '" type="button" style="padding:5px 11px;font-size:12px">阅读</button>' : '';
      return '<div class="gc-pf-item" style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">' +
        '<span style="font-weight:700;letter-spacing:.6px;color:#0e7490">' + couponEsc(maskCouponCode(c.code)) + '</span>' +
        '<span style="font-size:12px;color:#64748b;flex:1">' + meta.join(' · ') + '</span>' + btn + '</div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-coread]'), function (b) {
      b.addEventListener('click', function () {
        window.open('/read/737.html?order=' + encodeURIComponent(b.getAttribute('data-coread')), '_blank');
      });
    });
  }

  /* ===== 我购买的商品 ===== */
  function orderEsc(s) { return couponEsc(s); }
  function orderTime(v) { return v ? String(v).replace('T', ' ').slice(0, 16) : '—'; }

  function renderOrders(list) {
    var box = $('gcOrderList');
    var cnt = $('gcOrderCount');
    list = list || [];
    if (cnt) cnt.textContent = list.length;
    if (!box) return;
    if (!list.length) { box.innerHTML = '<span class="gc-pf-empty">该联系方式下没有购买记录</span>'; return; }
    box.innerHTML = list.map(function (o) {
      var oid = o.orderNo || o.id;
      var phase = o.phase || o.status;
      var map = {
        active: ['#b45309', '待完成支付'],
        pending: ['#b45309', '待完成支付'],
        confirmed: ['#047857', '已完成'],
        rejected: ['#b91c1c', '未通过'],
        refunded: ['#7c3aed', '已退款'],
        cancelled: ['#64748b', '已取消']
      };
      var m = map[phase] || map[o.status] || ['#b45309', '待核对'];
      var color = m[0], st = o.phaseText || m[1];
      var canRead = o.status === 'confirmed';
      var docUrl = o.docUrl || ('/api/project-doc?project=' + encodeURIComponent(o.project || 'b737') + '&download=1&order=' + encodeURIComponent(oid));
      var readUrl = o.readUrl || ('/read/' + (o.project === 'c919' ? 'c919' : '737') + '.html?order=' + encodeURIComponent(oid));
      var leftTxt = '';
      if (phase === 'active' && o.expireAt) {
        var left = Math.max(0, Math.round((new Date(o.expireAt).getTime() - Date.now()) / 60000));
        leftTxt = '<br><span style="color:#b45309;font-weight:600">请在 ' + left + ' 分钟内完成支付，超时订单将自动回滚</span>';
      }
      var notice = '';
      if (phase === 'refunded') {
        notice = '<div style="margin-top:8px;padding:9px 11px;border-radius:9px;background:#f5f3ff;border:1px solid #ddd6fe;color:#5b21b6;font-size:12.5px;line-height:1.7">' +
          (o.refundNotice || '工作人员已为你安排退款，退款将在一个月内到账。') +
          (o.refundAt ? '<br>退款时间 ' + orderTime(o.refundAt) : '') + '</div>';
      } else if (phase === 'cancelled') {
        notice = '<div style="margin-top:8px;padding:9px 11px;border-radius:9px;background:#f1f5f9;border:1px solid #e2e8f0;color:#475569;font-size:12.5px;line-height:1.7">该订单超过 24 小时未完成支付，系统已自动取消。如仍需购买，可在收费页重新下单。</div>';
      }
      return '<div class="gc-pf-item" style="display:block">' +
        '<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap">' +
        '<b style="font-family:ui-monospace,Menlo,monospace;font-size:12.5px;color:#334155">' + orderEsc(oid) + '</b>' +
        '<span style="font-size:12px;color:' + color + ';font-weight:700">' + orderEsc(st) + '</span></div>' +
        '<div style="font-size:13px;font-weight:600;margin-top:6px">' + orderEsc(o.product || o.projectTitle || '付费研究报告') + '</div>' +
        '<div style="font-size:12px;color:#64748b;margin-top:4px;line-height:1.7">金额 ¥' + orderEsc(o.price || 5) +
        ' · 下单 ' + orderTime(o.createdAt) +
        (o.paidAt ? '<br>支付时间 ' + orderTime(o.paidAt) : '') +
        (o.statusAt ? '<br>状态更新 ' + orderTime(o.statusAt) : '') +
        (o.couponCode
          ? '<div style="margin-top:8px;padding:9px 11px;border:1.5px dashed #c7d2fe;border-radius:10px;background:#f8fafc;font-size:12.5px;color:#334155;line-height:1.8">券码 <b style="font-family:ui-monospace,Menlo,monospace;font-size:14.5px;color:#4338ca;letter-spacing:.5px">' + orderEsc(o.couponCode) + '</b><br>与爱发电「配置码 / 私信码」为同一串，可对照校准；限用 ' + (o.couponUseLimit || 2) + ' 次，用完自动失效</div>'
          : (o.couponMasked ? '<br>兑换码 ' + orderEsc(o.couponMasked) + '（支付确认后显示完整码）' : '')) +
        (o.contact ? '<br>下单联系方式 ' + orderEsc(o.contact) : '') + leftTxt + '</div>' +
        notice +
        '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">' +
        (canRead ? '<button class="gc-pf-btn primary" data-read="' + orderEsc(oid) + '" type="button" style="padding:6px 12px;font-size:12.5px">进入阅读</button>' : '') +
        (canRead ? '<a class="gc-pf-btn" href="' + orderEsc(docUrl) + '" style="padding:6px 12px;font-size:12.5px;text-decoration:none;display:inline-block">下载文档</a>' : '') +
        (canRead ? '<a class="gc-pf-btn" href="/thanks.html?project=' + encodeURIComponent(o.project || 'b737') + '&order=' + encodeURIComponent(oid) + '" style="padding:6px 12px;font-size:12.5px;text-decoration:none;display:inline-block">凭单号重新下载</a>' : '') +
        (phase === 'active' || phase === 'pending' ? '<a class="gc-pf-btn" href="/pay/' + encodeURIComponent(o.project === 'c919' ? '737' : (o.project || '737')) + '.html" style="padding:6px 12px;font-size:12.5px;text-decoration:none;display:inline-block">继续支付</a>' : '') +
        (o.couponCode ? '<button class="gc-pf-btn" data-copy="' + orderEsc(o.couponCode) + '" type="button" style="padding:6px 12px;font-size:12.5px">复制券码</button>' : '') +
        (o.couponCode ? '<button class="gc-pf-btn" data-pass="' + orderEsc(oid) + '" type="button" style="padding:6px 12px;font-size:12.5px">保存券码凭证</button>' : '') +
        '<button class="gc-pf-btn" data-ovouch="' + orderEsc(oid) + '" type="button" style="padding:6px 12px;font-size:12.5px">保存订单凭证</button>' +
        '<button class="gc-pf-btn" data-trace="' + orderEsc(oid) + '" data-code="' + orderEsc(o.couponCode || '') + '" type="button" style="padding:6px 12px;font-size:12.5px">追踪码查询</button>' +
        '<button class="gc-pf-btn" data-fb="' + orderEsc(oid) + '" type="button" style="padding:6px 12px;font-size:12.5px">联系站内工作人员</button>' +
        '</div></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-read]'), function (b) {
      b.addEventListener('click', function () {
        window.open('/read/737.html?order=' + encodeURIComponent(b.getAttribute('data-read')), '_blank');
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-fb]'), function (b) {
      b.addEventListener('click', function () { submitFeedback(b.getAttribute('data-fb')); });
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-copy]'), function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-copy') || '';
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v);
          else { var ta = document.createElement('textarea'); ta.value = v; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
          try { toast('券码已复制：' + v); } catch (e) {}
        } catch (e) { window.prompt('请手动复制券码', v); }
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-pass]'), function (b) {
      b.addEventListener('click', function () { saveCouponPass(b.getAttribute('data-pass')); });
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-ovouch]'), function (b) {
      b.addEventListener('click', function () { saveOrderPass(b.getAttribute('data-ovouch')); });
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-trace]'), function (b) {
      b.addEventListener('click', function () {
        var code = b.getAttribute('data-code') || '';
        if (!code) { var q = window.prompt('请输入要追踪的券码（如 GC-7F2K-9QMD）', ''); code = (q || '').trim(); }
        if (code) traceCoupon(code);
      });
    });
  }

  function queryOrders(contact) {
    var tip = $('gcOrderTip');
    var box = $('gcOrderList');
    contact = String(contact || '').trim();
    if (!contact || contact.length < 3) {
      if (tip) { tip.textContent = '请输入下单时填写的手机号或邮箱，或直接粘贴券码'; tip.style.color = '#b91c1c'; }
      return;
    }
    /* 单一入口：输入券码自动切到「追踪码查询」，输入手机号/邮箱则查订单 */
    var looksCode = /^GC[-\s]?/i.test(contact) || (/^[A-Za-z0-9-]{6,40}$/.test(contact) && /[A-Za-z]/.test(contact));
    if (looksCode && contact.indexOf('@') < 0) { traceCoupon(contact); return; }
    if (box) box.innerHTML = '<span class="gc-pf-empty">查询中…</span>';
    fetch('/api/order?action=myorders&contact=' + encodeURIComponent(contact), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) {
          if (box) box.innerHTML = '<span class="gc-pf-empty">' + orderEsc((d && d.message) || '查询失败') + '</span>';
          return;
        }
        renderOrders(d.orders || []);
        if (tip) {
          tip.style.color = '#64748b';
          tip.textContent = (d.orders && d.orders.length)
            ? ('共 ' + d.orders.length + ' 笔购买记录；兑换码仅显示一遍，此处为脱敏记录，可点「进入阅读」凭订单号阅读。')
            : '该联系方式下暂无购买记录。';
        }
      }).catch(function () {
        if (box) box.innerHTML = '<span class="gc-pf-empty">网络异常，请稍后重试</span>';
      });
  }

  /* ===== v3.6 订单/券码：凭证保存 + 追踪查询 ===== */
  function gcDownloadText(name, text) {
    try {
      var blob = new Blob(['\ufeff' + text], { type: 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
      try { toast('已保存：' + name); } catch (e) {}
    } catch (e) { window.prompt('请手动复制保存内容', text); }
  }
  function gcOrderApi(q) {
    return fetch('/api/order?' + q, { cache: 'no-store' }).then(function (r) { return r.json(); });
  }
  function saveOrderPass(oid) {
    gcOrderApi('action=status&id=' + encodeURIComponent(oid)).then(function (d) {
      var o = (d && (d.order || d)) || {};
      var lines = [
        '民航客机收藏馆 · 订单凭证',
        '--------------------------------',
        '订单号：' + (o.orderNo || o.id || oid),
        '商品：' + (o.product || o.projectTitle || '付费研究报告'),
        '金额：¥' + (o.price || 5),
        '订单状态：' + (o.phaseText || o.statusText || o.status || ''),
        '下单时间：' + (o.createdAt || ''),
        (o.paidAt ? '支付时间：' + o.paidAt : ''),
        (o.afdianOrder ? '爱发电订单号：' + o.afdianOrder : ''),
        '联系方式：' + (o.contact || ''),
        (o.couponCode ? '券码：' + o.couponCode : ''),
        '--------------------------------',
        '查询入口：' + location.origin + '/#my',
        '导出时间：' + new Date().toLocaleString()
      ];
      gcDownloadText('订单凭证_' + (o.orderNo || oid) + '.txt', lines.filter(Boolean).join('\n'));
    }).catch(function () { alert('网络异常，请稍后重试'); });
  }
  function saveCouponPass(oid) {
    gcOrderApi('action=status&id=' + encodeURIComponent(oid)).then(function (d) {
      var o = (d && (d.order || d)) || {};
      var code = o.couponCode || '';
      if (!code) { alert('该订单暂未生成券码'); return; }
      var c = o.coupon || {};
      var lines = [
        '民航客机收藏馆 · 券码凭证',
        '--------------------------------',
        '券码：' + code,
        '（与爱发电「配置码 / 私信码」是同一串，可对照校准）',
        '订单号：' + (o.orderNo || o.id || oid),
        '商品：' + (o.product || o.projectTitle || '付费研究报告'),
        '可用次数：' + (c.useLimit || o.couponUseLimit || 2) + ' 次',
        '已用次数：' + (c.usedCount || 0) + ' 次',
        '剩余次数：' + (c.remaining === undefined ? (c.useLimit || 2) : c.remaining) + ' 次',
        '状态：' + (c.status === 'used' ? '已用尽/已失效' : '可用'),
        (c.expireAt ? '有效期至：' + c.expireAt : ''),
        '--------------------------------',
        '兑换入口：' + location.origin + '/#my',
        '导出时间：' + new Date().toLocaleString()
      ];
      gcDownloadText('券码凭证_' + code + '.txt', lines.join('\n'));
    }).catch(function () { alert('网络异常，请稍后重试'); });
  }
  function traceCoupon(code) {
    var box = $('gcOrderList');
    code = String(code || '').trim().toUpperCase();
    if (code.length < 6) { alert('请输入完整券码'); return; }
    if (box) box.innerHTML = '<span class="gc-pf-empty">追踪中…</span>';
    var tip = $('gcOrderTip');
    gcOrderApi('action=trace&code=' + encodeURIComponent(code)).then(function (d) {
      if (!box) return;
      if (!d || !d.ok || !d.found) {
        box.innerHTML = '<span class="gc-pf-empty">' + orderEsc((d && (d.hint || d.message)) || '未找到该券码') + '</span>';
        if (tip) { tip.textContent = '没有查到这张券码，请核对（也可在爱发电「我的」→ 订单详情里对照配置码 / 私信码）'; tip.style.color = '#b91c1c'; }
        return;
      }
      if (tip) { tip.style.color = '#16a34a'; tip.textContent = '已找到券码，以下为使用情况。'; }
      var logs = (d.usedLog || []).map(function (x) {
        return '<div style="font-size:12px;color:#64748b">· ' + orderTime(x.at) + (x.project ? '　项目 ' + orderEsc(x.project) : '') + '</div>';
      }).join('') || '<div style="font-size:12px;color:#94a3b8">暂无核销记录</div>';
      box.innerHTML = '<div class="gc-pf-item" style="display:block">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">' +
        '<b style="font-family:ui-monospace,Menlo,monospace;font-size:13px;color:#4338ca">' + orderEsc(d.code || code) + '</b>' +
        '<span style="font-size:12px;font-weight:700;color:' + (d.remaining > 0 ? '#047857' : '#b91c1c') + '">' +
        (d.remaining > 0 ? '可用' : '已失效') + '</span></div>' +
        '<div style="font-size:12.5px;color:#475569;margin-top:6px;line-height:1.9">' +
        '可用 ' + (d.useLimit || 0) + ' 次 · 已用 ' + (d.usedCount || 0) + ' 次 · 剩余 ' + (d.remaining || 0) + ' 次<br>' +
        '关联项目：' + (orderEsc((d.projectTitles || []).join('、')) || '未关联（不可用于具体项目）') + '<br>' +
        '订单号：' + (orderEsc(d.orderId) || '—') + '<br>' +
        '订单状态：' + (orderEsc(d.orderStatus) || '—') + '</div>' +
        '<div style="margin-top:8px;padding:9px 11px;border-radius:9px;background:#f8fafc;border:1px solid #e2e8f0">' +
        '<div style="font-size:12px;font-weight:700;color:#334155;margin-bottom:4px">核销记录（最近 5 条）</div>' + logs + '</div>' +
        '</div>';
    }).catch(function () {
      if (box) box.innerHTML = '<span class="gc-pf-empty">网络异常，请稍后重试</span>';
    });
  }

  function submitFeedback(orderNo) {
    var text = window.prompt('请描述您的问题（提交至站长后台，500 字以内）', '');
    if (text === null) return;
    text = String(text || '').trim();
    if (text.length < 4) { alert('请至少填写 4 个字，便于站长定位问题'); return; }
    var contact = ($('gcOrderContact') && $('gcOrderContact').value || '').trim();
    fetch('/api/order', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'feedback', id: orderNo, text: text, contact: contact })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.ok) alert('反馈已提交，站长会尽快处理。');
      else alert((d && d.message) || '提交失败，请稍后重试');
    }).catch(function () { alert('网络异常，请稍后重试'); });
  }

  var gcOrderBooted = false;
  function gcOrderBoot(p) {
    var inp = $('gcOrderContact');
    var btn = $('gcOrderQuery');
    if (inp && p && p.phone && !inp.value) inp.value = p.phone;
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', function () { queryOrders((($('gcOrderContact') || {}).value || '').trim()); });
      if (inp) inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') queryOrders((inp.value || '').trim()); });
    }
    if (inp && inp.value && !gcOrderBooted) {
      gcOrderBooted = true;
      queryOrders(inp.value.trim());
    }
  }
  function takePendingCoupon() {
    var v = '';
    try {
      var m = /[?&]coupon=([^&]+)/.exec(location.search || '');
      if (m) v = decodeURIComponent(m[1]);
    } catch (e) {}
    if (!v) { try { v = localStorage.getItem('gc_coupon_pending') || ''; } catch (e) {} }
    if (v) { try { localStorage.removeItem('gc_coupon_pending'); } catch (e) {} }
    return couponNorm(v);
  }
  function redeemCoupon() {
    var input = $('gcCouponInput');
    var tip = $('gcCouponTip');
    function say(t, isErr) {
      if (!tip) return;
      tip.textContent = t;
      tip.style.color = isErr ? '#b91c1c' : '#16a34a';
    }
    var code = couponNorm(input && input.value);
    if (!code || code.length < 6) { say('请输入完整的券码', true); return; }
    if (!st.token) { say('请先登录后再兑换券码', true); openMask('auth', '券码兑换'); return; }
    var btn = $('gcCouponRedeem');
    if (btn) { btn.disabled = true; btn.textContent = '兑换中…'; }
    couponApi('redeem', { code: code }).then(function (res) {
      if (btn) { btn.disabled = false; btn.textContent = '立即兑换'; }
      if (res && res.ok) {
        if (res.coupons) {
          if (!st.profile) st.profile = {};
          st.profile.coupons = res.coupons;
          renderCoupons(res.coupons);
        }
        if (input) input.value = '';
        if (res.already) { say('这张券码已经兑换过了，可在下方查看', true); return; }
        var c = res.coupon || {};
        say('兑换成功：' + (c.type || '券码') + (c.value ? ' ' + c.value : '') + '（该券码已核销）', false);
        try { toast('兑换成功：' + (c.code || code)); } catch (e) {}
      } else {
        say(couponMsg(res && res.error), true);
      }
    }).catch(function () {
      if (btn) { btn.disabled = false; btn.textContent = '立即兑换'; }
      say('网络异常，请稍后重试', true);
    });
  }

  function renderList(listId, countId, ids, kind) {
    var box = $(listId);
    if (!box) return;
    ids = ids || [];
    var c = $(countId);
    if (c) c.textContent = ids.length;
    if (!ids.length) {
      box.innerHTML = '<span class="gc-pf-empty">' + (kind === 'favorites' ? '还没有收藏，打开任意机型点右上角 ♥ 收藏' : '还没有保存，打开任意机型点 ☆ 保存') + '</span>';
      return;
    }
    box.innerHTML = '';
    if (!(window.aircrafts && window.aircrafts.length)) {
      clearTimeout(box._retry);
      box._retry = setTimeout(function () { renderList(listId, countId, ids, kind); }, 400);
    }
    ids.forEach(function (id) {
      var a = findAircraft(id);
      var chip = document.createElement('span');
      chip.className = 'gc-pf-chip';
      chip.innerHTML = '<span>' + (label(a) || id) + '</span>';
      var del = document.createElement('button');
      del.type = 'button';
      del.textContent = '✕';
      del.title = '移除';
      del.addEventListener('click', function () { toggleFav(id, kind === 'favorites' ? 'fav' : 'save', true); });
      chip.appendChild(del);
      chip.style.cursor = 'pointer';
      chip.addEventListener('click', function (e) {
        if (e.target === del) return;
        closeMask();
        if (typeof window.openDetail === 'function') { window.openDetail(id); return; }
        var a2 = findAircraft(id);
        location.hash = (a2 && (a2.slug || a2.id)) || id;
      });
      box.appendChild(chip);
    });
  }

  /* 登录即默认解锁全部 AI 功能：写解锁标记 + 移除按钮灰置 + 恢复按钮文案 */
  function unlockAiOnLogin() {
    try { if (window.__accessControlUnlock) window.__accessControlUnlock(); } catch (e) {}
    try { localStorage.setItem('aviation_ai_unlocked', '1'); } catch (e) {}
    var btn = document.getElementById('aiChatBtn');
    if (btn) btn.classList.remove('ai-gated');
    var span = document.getElementById('aiChatBtnText');
    if (span) span.textContent = String(span.textContent || '').replace('AI 未解锁', '问 AI').replace('AI locked', 'Ask AI');
  }
  try { window.__unlockAiOnLogin = unlockAiOnLogin; } catch (e) {}
  /* 退出登录：撤销解锁，AI 入口重新灰置（未登录不可用任何 AI 功能） */
  function lockAiOnLogout() {
    try { localStorage.removeItem('aviation_ai_unlocked'); } catch (e) {}
    var btn = document.getElementById('aiChatBtn');
    if (btn) btn.classList.add('ai-gated');
    var span = document.getElementById('aiChatBtnText');
    if (span) span.textContent = String(span.textContent || '').replace('问 AI', 'AI 未解锁').replace('Ask AI', 'AI locked');
  }
  /* 登录后自动把未登录期间暂存的收藏/保存并入账号，避免出现“收藏没同步” */
  function autoMigrateTemp() {
    if (!st.token) return;
    var ef = jget('gc_temp_favs') || [], es = jget('gc_temp_saved') || [];
    if (!ef.length && !es.length) return;
    api('migrate', { favorites: ef, saved: es }).then(function (res) {
      if (!res || !res.ok) return;
      st.profile = res.profile;
      jset('gc_temp_favs', []); jset('gc_temp_saved', []);
      renderProfile();
      var d = res.migrated || {};
      var n = (d.favorites || 0) + (d.saved || 0);
      if (n > 0) toast('已把 ' + n + ' 条本地收藏同步到账号');
    }).catch(function () {});
  }
  try {
    window.__autoMigrateTemp = autoMigrateTemp;
    window.__renderProfile = renderProfile;
    window.__gcRenderCoupons = renderCoupons;
    /* 统一兑换成功后的列表刷新：把 coupons 灌回本地 profile 并重渲染 */
    window.__gcApplyCoupons = function (list) {
      try {
        if (!st.profile) st.profile = {};
        st.profile.coupons = list || [];
        renderCoupons(st.profile.coupons);
        if (typeof window.__renderProfile === 'function' && renderProfile !== window.__renderProfile) window.__renderProfile();
      } catch (e) {}
    };
    window.GC = window.GC || {};
    window.GC.redeemCode = function (code) { return (window.gcRedeemCode || function () {})(code); };
  } catch (e) {}

  function saveAvatar(src) {
    api('update', { avatar: src }).then(function (res) {
      if (res && res.ok) { st.profile = res.profile; applyProfile(); renderProfile(); setMsg('头像已更新', true); }
      else setMsg(msgOf(res && res.error));
    });
  }

  function compressImage(file, cb) {
    var fr = new FileReader();
    fr.onload = function () {
      var img = new Image();
      img.onload = function () {
        var size = 96;
        var cv = document.createElement('canvas');
        cv.width = size; cv.height = size;
        var ctx = cv.getContext('2d');
        var s = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        cb(cv.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = function () { cb(null); };
      img.src = fr.result;
    };
    fr.onerror = function () { cb(null); };
    fr.readAsDataURL(file);
  }

  function toggleFav(id, kind, forceRemove) {
    if (!id) return;
    var key = kind === 'save' ? 'saved' : 'favorites';
    if (!st.token) {
      var lk = kind === 'save' ? 'gc_temp_saved' : 'gc_temp_favs';
      var arr = jget(lk);
      var i = arr.indexOf(id);
      if (i >= 0) arr.splice(i, 1); else arr.push(id);
      jset(lk, arr);
      toast(i >= 0 ? '已从临时保存移除（登录后可迁移）' : '已暂存本地，登录后可一键迁移');
      gcGate(kind === 'save' ? '保存笔记' : '收藏机型');
      return;
    }
    var op = forceRemove ? 'remove' : 'toggle';
    api('favorite', { aircraftId: id, kind: kind === 'save' ? 'save' : 'fav', op: op }).then(function (res) {
      if (res && res.ok) {
        st.profile = res.profile;
        var has = (res.profile[key] || []).indexOf(id) >= 0;
        toast(has ? (kind === 'save' ? '已保存' : '已收藏') : '已移除');
        renderProfile();
        syncFavButtons(id);
      } else toast(msgOf(res && res.error));
    });
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
    el._t = setTimeout(function () { el.style.opacity = '0'; el.style.transform = 'translateX(-50%) translateY(12px)'; }, 1900);
  }

  function currentDetailId() {
    try {
      var h = (location.hash || '').replace('#', '');
      if (h && window.aircrafts) {
        var a = window.aircrafts.find(function (x) { return x.slug === h || x.id === h; });
        if (a) return a.id;
      }
    } catch (e) {}
    return null;
  }

  function injectFavBar(modal, id) {
    /* 收藏 / 保存功能已下线（2026-11 改版）：不再注入收藏栏 */
    return;
  }

  function syncFavButtons(id) {
    var modals = document.querySelectorAll('.detail-modal');
    if (!modals.length) return;
    var p = st.profile;
    var favs = p ? (p.favorites || []) : jget('gc_temp_favs');
    var saves = p ? (p.saved || []) : jget('gc_temp_saved');
    var idv = id || currentDetailId();
    Array.prototype.forEach.call(modals, function (m) {
      var f = m.querySelector('.gc-fav-btn'), sv = m.querySelector('.gc-fav-btn.save');
      if (f) f.classList.toggle('on', favs.indexOf(idv) >= 0);
      if (sv) sv.classList.toggle('on', saves.indexOf(idv) >= 0);
    });
  }

  var mo = new MutationObserver(function () {
    var modals = document.querySelectorAll('.detail-modal');
    if (!modals.length) return;
    var id = currentDetailId();
    Array.prototype.forEach.call(modals, function (m) { if (id) injectFavBar(m, id); });
  });
  mo.observe(document.body, { childList: true, subtree: true });

  // 绑定事件
  document.addEventListener('DOMContentLoaded', function () {
    var btn = $('gcAcctBtn');
    if (btn) btn.addEventListener('click', function () { openMask(st.profile ? 'profile' : 'auth'); });
    if ($('gcWayPwd')) $('gcWayPwd').addEventListener('click', function () { st.way = 'password'; setMode('login'); });
    if ($('gcWayCode')) $('gcWayCode').addEventListener('click', function () { st.way = 'code'; setMode('login'); });
    if ($('gcSendCode')) $('gcSendCode').addEventListener('click', sendCode);
    if ($('gcBindSend')) $('gcBindSend').addEventListener('click', sendBindCode);
    if ($('gcBindSubmit')) $('gcBindSubmit').addEventListener('click', submitBind);
    if ($('gcBindClose')) $('gcBindClose').addEventListener('click', function () {
      sessionStorage.setItem('gc_bind_skip', '1');
      closeBind();
    });
    if ($('gcBindMask')) $('gcBindMask').addEventListener('click', function (e) {
      if (e.target.id === 'gcBindMask') { sessionStorage.setItem('gc_bind_skip', '1'); closeBind(); }
    });
    if ($('gcBindCode')) $('gcBindCode').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitBind(); });
    if ($('gcPfBind')) $('gcPfBind').addEventListener('click', function () { openBind((st.profile && st.profile.bindReason) || 'no_phone'); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeBind(); });
    if ($('gcPfPwdSave')) $('gcPfPwdSave').addEventListener('click', function () {
      var np = (($('gcPwdNew') || {}).value || '').trim();
      if (np.length < 6) { toast('新密码至少 6 位'); return; }
      var b = $('gcPfPwdSave');
      b.disabled = true;
      api('update', { password: np }).then(function (res) {
        b.disabled = false;
        if (res && res.ok) { if ($('gcPwdNew')) $('gcPwdNew').value = ''; toast('密码已更新，下次可用新密码登录'); }
        else toast((res && (res.hint || res.message)) || '密码修改失败');
      }).catch(function () { b.disabled = false; toast('网络异常，请稍后重试'); });
    });
    if ($('gcAcctCode')) $('gcAcctCode').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitAuth(); });
    if ($('gcAcctPhone')) $('gcAcctPhone').addEventListener('keydown', function (e) { if (e.key === 'Enter') { if ($('gcAcctCode')) $('gcAcctCode').focus(); } });
    if ($('gcAcctClose')) $('gcAcctClose').addEventListener('click', closeMask);
    if ($('gcAcctMask')) $('gcAcctMask').addEventListener('click', function (e) { if (e.target.id === 'gcAcctMask') closeMask(); });
    if ($('gcTabLogin')) $('gcTabLogin').addEventListener('click', function () { setMode('login'); });
    if ($('gcTabRegister')) $('gcTabRegister').addEventListener('click', function () { setMode('register'); });
    if ($('gcAcctSubmit')) $('gcAcctSubmit').addEventListener('click', submitAuth);
    if ($('gcAcctPass2')) $('gcAcctPass2').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitAuth(); });
    if ($('gcAcctPass')) $('gcAcctPass').addEventListener('keydown', function (e) { if (e.key === 'Enter') { if (st.mode === 'register') $('gcAcctPass2').focus(); else submitAuth(); } });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMask(); });

    if ($('gcPfUpload')) $('gcPfUpload').addEventListener('click', function () { $('gcAvatarFile').click(); });
    if ($('gcAvatarFile')) $('gcAvatarFile').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      compressImage(f, function (data) {
        if (!data) { setMsg('图片读取失败，换一张试试'); return; }
        saveAvatar(data);
      });
      e.target.value = '';
    });
    if ($('gcPfRename')) $('gcPfRename').addEventListener('click', function () {
      var cur = st.profile ? (st.profile.displayName || st.profile.username) : '';
      var nv = window.prompt('新的用户名（2-16 位，中文/字母/数字/下划线）', cur);
      if (nv === null) return;
      nv = nv.trim();
      if (!nv) return;
      api('update', { username: nv, displayName: nv }).then(function (res) {
        if (res && res.ok) { st.profile = res.profile; applyProfile(); renderProfile(); setMsg('用户名已更新', true); }
        else setMsg(msgOf(res && res.error));
      });
    });
    if ($('gcPfLogout')) $('gcPfLogout').addEventListener('click', function () {
      api('logout', {}).finally(function () {
        st.token = null; st.profile = null;
        try { localStorage.removeItem(TK); } catch (e) {}
        lockAiOnLogout();
        applyProfile(); closeMask(); toast('已退出登录');
      });
    });
    if ($('gcPfMigrate')) $('gcPfMigrate').addEventListener('click', function () {
      var ef = jget('gc_temp_favs'), es = jget('gc_temp_saved');
      if (!ef.length && !es.length && st.profile && st.profile.migrated) { toast('没有需要迁移的数据'); return; }
      api('migrate', { favorites: ef, saved: es }).then(function (res) {
        if (res && res.ok) {
          st.profile = res.profile;
          jset('gc_temp_favs', []); jset('gc_temp_saved', []);
          renderProfile();
          var d = res.migrated || {};
          setMsg('迁移完成：新增收藏 ' + (d.favorites || 0) + ' 条、保存 ' + (d.saved || 0) + ' 条', true);
          toast('临时账户数据已并入本账号');
          var mig = $('gcPfMigrate');
          if (mig) mig.style.display = 'none';
        } else setMsg(msgOf(res && res.error));
      });
    });

    // ---- 券码兑换 ----
    if ($('gcCouponRedeem')) $('gcCouponRedeem').addEventListener('click', redeemCoupon);
    if ($('gcCouponInput')) $('gcCouponInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); redeemCoupon(); }
    });
    // 扫码/链接携带 ?coupon=XXXX：先落地到本地，登录后再自动带入
    try {
      var cm0 = /[?&]coupon=([^&]+)/.exec(location.search || '');
      if (cm0) {
        var cv0 = couponNorm(decodeURIComponent(cm0[1]));
        if (cv0) localStorage.setItem('gc_coupon_pending', cv0);
      }
    } catch (e) {}

    // 恢复登录态
    var tk = ls(TK);
    if (tk) {
      st.token = tk;
      api('profile', { token: tk }).then(function (res) {
        if (res && res.ok) {
          st.profile = res.profile;
          if (typeof window.__unlockAiOnLogin === 'function') window.__unlockAiOnLogin();
          applyProfile();
          if (typeof window.__renderProfile === 'function') window.__renderProfile();
          if (typeof window.__autoMigrateTemp === 'function') window.__autoMigrateTemp();
          if (res.profile && res.profile.needBindPhone) sessionStorage.removeItem('gc_bind_skip');
        }
        else {
          st.token = null; try { localStorage.removeItem(TK); } catch (e) {} applyProfile();
          /* 打开页面即检测黑名单，避免静默封禁 */
          if (res && (res.error === 'account_banned' || res.error === 'banned' || res.blocked === true)) {
            if (typeof window.__siteBlockCard === 'function') {
              window.__siteBlockCard(res.blocked || res.block || { reason: (res && (res.hint || res.message)) || '账号已被限制' });
            }
          }
        }
      }).catch(function () {});
    } else applyProfile();
  });

  window.gcAccount = { open: openMask, state: st };
})();
