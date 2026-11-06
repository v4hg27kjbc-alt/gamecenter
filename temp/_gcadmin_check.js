
(function () {
  'use strict';
  if (window.__gcAdminLoaded) return;
  window.__gcAdminLoaded = true;

  var TOKEN_KEY = 'gcAdminToken';
  var SMS_KEY = 'gcSmsRecords';
  var DB_KEY = 'gcAdminLocal';
  var PANEL = document.getElementById('gcAdminPanel');
  if (!PANEL) return;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function nowStr() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function genId() { return 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function maskPhone(p) { p = String(p || ''); return p.length >= 7 ? p.slice(0, 3) + '****' + p.slice(-4) : (p || '—'); }
  function getToken() { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setToken(t) { try { sessionStorage.setItem(TOKEN_KEY, t); } catch (e) {} }
  function clearToken() { try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) {} }
  function loadDB() { try { return JSON.parse(localStorage.getItem(DB_KEY) || '{}'); } catch (e) { return {}; } }
  function saveDB(db) { try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (e) {} }
  function smsRecords() { try { return JSON.parse(localStorage.getItem(SMS_KEY) || '[]'); } catch (e) { return []; } }
  function saveSmsRecords(arr) { try { localStorage.setItem(SMS_KEY, JSON.stringify(arr)); } catch (e) {} }

  function recRequest(path, opts) {
    opts = opts || {};
    var headers = { 'Accept': 'application/json' };
    var tk = getToken();
    if (tk) headers['X-Admin-Token'] = tk;
    if (opts.body) headers['Content-Type'] = 'application/json';
    var init = { method: opts.method || 'GET', headers: headers, credentials: 'same-origin' };
    if (opts.body) init.body = JSON.stringify(opts.body);
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(15000);
    return fetch(path, init).then(function (res) {
      return res.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var em = (data && (data.error || data.message)) ? (data.error || data.message) : ('HTTP ' + res.status);
          var err = new Error(em);
          err.status = res.status;
          throw err;
        }
        if (data === null) throw new Error('返回数据格式异常');
        return data;
      });
    });
  }

  function status(id, msg, cls) {
    var el = $(id);
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'gca-status' + (cls ? ' ' + cls : '');
  }

  /* ---- 打开 / 关闭 / Tab ---- */
  function openPanel() {
    PANEL.classList.add('open');
    PANEL.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    var tk = getToken();
    var bar = $('gcAdminLoginBar');
    if (bar && tk) {
      var input = $('gcAdminTokenInput');
      var saveBtn = $('gcAdminTokenSave');
      var clearBtn = $('gcAdminTokenClear');
      if (input) input.value = tk;
      if (saveBtn) saveBtn.style.display = 'none';
      if (clearBtn) clearBtn.style.display = '';
    }
    loadTokenUsage();
    loadMaintConfig();
    loadUsers();
    renderSmsQuota();
    renderSmsRecords();
    renderSettingsPage();
  }
  function closePanel() {
    PANEL.classList.remove('open');
    PANEL.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    if (window.location.hash === '#admin' && history.replaceState) {
      try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) {}
    }
  }
  function switchPage(name) {
    var pages = ['sms', 'token', 'users', 'maint', 'settings'];
    pages.forEach(function (p) {
      var page = $('gcPage' + p.charAt(0).toUpperCase() + p.slice(1));
      if (page) page.classList.toggle('active', p === name);
    });
    var tabs = document.querySelectorAll('#gcAdminNav .gca-tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-page') === name);
    if (name === 'token') loadTokenUsage();
    if (name === 'users') loadUsers();
    if (name === 'maint') loadMaintConfig();
    if (name === 'settings') renderSettingsPage();
  }

  /* ---- 鉴权 ---- */
  function unlockAdmin() {
    var input = $('gcAdminTokenInput');
    var tk = (input ? input.value : '').trim();
    if (!tk) { status('gcSmsStatus', '请输入管理员令牌', 'err'); return; }
    setToken(tk);
    var saveBtn = $('gcAdminTokenSave');
    var clearBtn = $('gcAdminTokenClear');
    if (saveBtn) saveBtn.style.display = 'none';
    if (clearBtn) clearBtn.style.display = '';
    loadTokenUsage();
    loadMaintConfig();
    loadUsers();
    status('gcSmsStatus', '令牌已解锁，管理操作可用', 'good');
  }
  function clearAdmin() {
    clearToken();
    var saveBtn = $('gcAdminTokenSave');
    var clearBtn = $('gcAdminTokenClear');
    var input = $('gcAdminTokenInput');
    if (saveBtn) saveBtn.style.display = '';
    if (clearBtn) clearBtn.style.display = 'none';
    if (input) input.value = '';
    status('gcSmsStatus', '已清除令牌，管理操作锁定', '');
  }

  /* ---- 短信收发 ---- */
  function smsQuota() {
    var db = loadDB();
    if (db.smsQuota === undefined || db.smsQuota === null) db.smsQuota = 1000;
    return Number(db.smsQuota) || 0;
  }
  function renderSmsQuota() {
    var db = loadDB();
    var q = smsQuota();
    var el = $('gcSmsQuotaNum'); if (el) el.textContent = q;
    var cost = Number(db.smsLastCost || 0);
    var sent = Number(db.smsSent || 0);
    var el2 = $('gcSmsCostNum'); if (el2) el2.textContent = (cost * 0.045).toFixed(2);
    var el3 = $('gcSmsSentNum'); if (el3) el3.textContent = sent;
  }
  function renderSmsRecords() {
    var tbody = $('gcSmsTbody');
    if (!tbody) return;
    var arr = smsRecords();
    tbody.innerHTML = '';
    var empty = $('gcSmsEmpty'); if (empty) empty.style.display = arr.length ? 'none' : '';
    var cnt = $('gcSmsRecCount'); if (cnt) cnt.textContent = arr.length + ' 条';
    arr.slice().sort(function (a, b) { return String(b.time).localeCompare(String(a.time)); }).forEach(function (r) {
      var tr = document.createElement('tr');
      var c1 = document.createElement('td'); c1.textContent = r.time || '';
      var c2 = document.createElement('td'); c2.textContent = maskPhone(r.phone);
      var c3 = document.createElement('td'); c3.textContent = r.templateCode || '';
      var c4 = document.createElement('td'); c4.className = 'gca-mono'; c4.textContent = r.bizId || '—';
      var c5 = document.createElement('td');
      c5.textContent = r.status || '已发送';
      c5.style.color = (r.status === '成功' || r.status === '已发送') ? '#16a34a' : (r.status === '失败' ? '#dc2626' : '#d97706');
      var c6 = document.createElement('td');
      var tb = document.createElement('button');
      tb.className = 'gca-btn gca-ghost';
      tb.style.padding = '2px 10px'; tb.style.fontSize = '12px';
      tb.textContent = r.tracking === false ? '已归档 · 开启追踪' : '追踪中 · 关闭追踪';
      tb.setAttribute('data-sms-id', r.id);
      c6.appendChild(tb);
      tr.appendChild(c1); tr.appendChild(c2); tr.appendChild(c3); tr.appendChild(c4); tr.appendChild(c5); tr.appendChild(c6);
      tbody.appendChild(tr);
    });
  }
  function toggleSmsTracking(id) {
    var arr = smsRecords();
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].id === id) { arr[i].tracking = (arr[i].tracking === false) ? true : false; break; }
    }
    saveSmsRecords(arr);
    renderSmsRecords();
  }
  function smsSend() {
    var phone = ($('gcSmsPhone') ? $('gcSmsPhone').value : '').trim();
    var tpl = $('gcSmsTemplate') ? $('gcSmsTemplate').value : 'auto';
    var tplCode = tpl;
    if (tpl === 'manual') {
      tplCode = ($('gcSmsTemplateCustom') ? $('gcSmsTemplateCustom').value : '').trim();
      if (!/^[0-9]{5,8}$/.test(tplCode)) { status('gcSmsStatus', '请填写有效的短信模板 Code（5~8 位数字）', 'err'); return; }
    }
    if (!/^1[3-9]\d{9}$/.test(phone)) { status('gcSmsStatus', '请输入有效的 11 位手机号', 'err'); return; }
    var btn = $('gcSmsSend'); if (btn) btn.disabled = true;
    status('gcSmsStatus', '正在发送…', '');
    recRequest('/api/sms-verify', { method: 'POST', body: { phoneNumber: phone } }).then(function (data) {
      var bizId = (data && data.bizId) ? String(data.bizId) : '';
      var arr = smsRecords();
      arr.unshift({ id: genId(), phone: phone, time: nowStr(), templateCode: tplCode, bizId: bizId, status: bizId ? '已发送' : '待回执', tracking: true });
      saveSmsRecords(arr);
      var db = loadDB();
      var q = smsQuota();
      if (q > 0) db.smsQuota = q - 1;
      db.smsLastCost = Number(db.smsLastCost || 0) + 1;
      db.smsSent = Number(db.smsSent || 0) + 1;
      saveDB(db);
      renderSmsQuota(); renderSmsRecords();
      status('gcSmsStatus', '发送成功：' + ((data && data.message) ? data.message : '验证码已下发') + (bizId ? '，BizId=' + bizId : ''), 'good');
      if (btn) btn.disabled = false;
    }).catch(function (err) {
      var arr = smsRecords();
      arr.unshift({ id: genId(), phone: phone, time: nowStr(), templateCode: tplCode, bizId: '', status: '失败', tracking: true });
      saveSmsRecords(arr);
      renderSmsRecords();
      status('gcSmsStatus', '发送失败：' + ((err && err.message) ? err.message : '未知错误'), 'err');
      if (btn) btn.disabled = false;
    });
  }

  /* ---- Token 用量 ---- */
  var TOKEN_STATE = { loading: false };
  function loadTokenUsage() {
    if (TOKEN_STATE.loading) return;
    TOKEN_STATE.loading = true;
    status('gcTokenStatus', '正在拉取 Token 用量…', '');
    recRequest('/api/token-usage?days=7', { method: 'GET' }).then(function (data) {
      var dd = (data && data.data && typeof data.data === 'object') ? data.data : data;
      var usage = (dd && dd.usage) || {};
      var el;
      el = $('gcTokCalls'); if (el) el.textContent = (usage.calls != null) ? usage.calls : '—';
      el = $('gcTokTokens'); if (el) el.textContent = (usage.totalTokens != null) ? usage.totalTokens : '—';
      el = $('gcTokCost'); if (el) el.textContent = (usage.costYuan != null) ? Number(usage.costYuan).toFixed(2) : '—';
      var avg = (usage.calls && usage.totalTokens) ? Math.round(usage.totalTokens / usage.calls) : '—';
      el = $('gcTokAvg'); if (el) el.textContent = avg;
      var byDay = (dd && dd.byDay && Array.isArray(dd.byDay)) ? dd.byDay : [];
      var tbody = $('gcTokenTbody');
      var empty = $('gcTokenEmpty');
      if (tbody) {
        tbody.innerHTML = '';
        byDay.slice().sort(function (a, b) { return String(a.date || '').localeCompare(String(b.date || '')); }).forEach(function (r) {
          var tr = document.createElement('tr');
          var c1 = document.createElement('td'); c1.textContent = r.date || '';
          var c2 = document.createElement('td'); c2.textContent = (r.calls != null) ? r.calls : 0;
          var c3 = document.createElement('td'); c3.textContent = (r.totalTokens != null) ? r.totalTokens : 0;
          var c4 = document.createElement('td'); c4.textContent = (r.costYuan != null) ? Number(r.costYuan).toFixed(2) : '0.00';
          tr.appendChild(c1); tr.appendChild(c2); tr.appendChild(c3); tr.appendChild(c4);
          tbody.appendChild(tr);
        });
      }
      if (empty) empty.style.display = byDay.length ? 'none' : '';
      status('gcTokenStatus', '用量已更新', 'good');
    }).catch(function (err) {
      status('gcTokenStatus', 'Token 用量拉取失败：' + ((err && err.message) ? err.message : '未知错误'), 'err');
    }).finally(function () { TOKEN_STATE.loading = false; });
  }

  /* ---- 用户管理 ---- */
  function sha256Hex(str) {
    if (window.crypto && crypto.subtle && crypto.subtle.digest) {
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (buf) {
        var bytes = new Uint8Array(buf);
        var hex = '';
        for (var i = 0; i < bytes.length; i++) hex += ('0' + bytes[i].toString(16)).slice(-2);
        return hex;
      });
    }
    return Promise.resolve('');
  }
  var USERS_STATE = { loading: false, data: [] };
  function loadUsers() {
    if (USERS_STATE.loading) return;
    USERS_STATE.loading = true;
    status('gcUsersStatus', '正在加载用户列表…', '');
    recRequest('/api/users', { method: 'GET' }).then(function (data) {
      var dd = (data && data.data && typeof data.data === 'object') ? data.data : data;
      var arr = (dd && (dd.users || dd.list || dd.items)) ? (dd.users || dd.list || dd.items) : [];
      USERS_STATE.data = Array.isArray(arr) ? arr : [];
      status('gcUsersStatus', '用户列表已加载（' + USERS_STATE.data.length + ' 人）', 'good');
      renderUsersTable();
    }).catch(function (err) {
      USERS_STATE.data = [];
      status('gcUsersStatus', '用户列表加载失败：' + ((err && err.message) ? err.message : '未知错误'), 'err');
      renderUsersTable();
    }).finally(function () { USERS_STATE.loading = false; });
  }
  function renderUsersTable() {
    var tbody = $('gcUsersTbody');
    if (!tbody) return;
    var arr = USERS_STATE.data.slice().sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
    tbody.innerHTML = '';
    var empty = $('gcUsersEmpty'); if (empty) empty.style.display = arr.length ? 'none' : '';
    var cnt = $('gcUsersCount'); if (cnt) cnt.textContent = arr.length + ' 人';
    arr.forEach(function (u) {
      var st = u.status || 'active';
      var tr = document.createElement('tr');
      var c0 = document.createElement('td'); c0.className = 'gca-check-col';
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'gc-user-check'; cb.setAttribute('data-uid', u.id || u.username || u.phone || '');
      c0.appendChild(cb);
      var c1 = document.createElement('td'); c1.textContent = u.username || '—';
      var c2 = document.createElement('td'); c2.textContent = maskPhone(u.phone);
      var c3 = document.createElement('td');
      var ph = (u.passwordHash || u.password || '').toString();
      c3.className = 'gca-mono'; c3.textContent = ph ? ph.slice(0, 12) + '…' : '—'; c3.title = ph;
      var c4 = document.createElement('td'); c4.textContent = u.createdAt || '';
      var c5 = document.createElement('td');
      var flags = [];
      if (st === 'muted') flags.push('禁言');
      if (st === 'flagged') flags.push('违规');
      if (st === 'banned') flags.push('封锁');
      c5.textContent = flags.length ? flags.join(' / ') : '正常';
      c5.style.color = flags.length ? '#dc2626' : '#16a34a';
      var c6 = document.createElement('td');
      var acts = [
        { act: st === 'muted' ? 'unmute' : 'mute', label: st === 'muted' ? '解封' : '禁言' },
        { act: 'flag', label: st === 'flagged' ? '再标记违规' : '标记违规' },
        { act: (st === 'banned' || st === 'flagged') ? 'unban' : 'ban', label: (st === 'banned' || st === 'flagged') ? '解除封锁' : '封锁' }
      ];
      for (var k = 0; k < acts.length; k++) {
        var b = document.createElement('button');
        b.className = 'gca-btn gca-ghost'; b.style.padding = '2px 8px'; b.style.fontSize = '12px'; b.style.marginRight = '4px';
        b.textContent = acts[k].label;
        b.setAttribute('data-uid', u.id || u.username || u.phone || '');
        b.setAttribute('data-act', acts[k].act);
        c6.appendChild(b);
      }
      tr.appendChild(c0); tr.appendChild(c1); tr.appendChild(c2); tr.appendChild(c3); tr.appendChild(c4); tr.appendChild(c5); tr.appendChild(c6);
      tbody.appendChild(tr);
    });
  }
  function selectedUserIds() {
    var ids = [];
    var cbs = document.querySelectorAll('#gcUsersTbody .gc-user-check:checked');
    for (var i = 0; i < cbs.length; i++) ids.push(cbs[i].getAttribute('data-uid'));
    return ids;
  }
  function usersBatchAction(action) {
    var ids = selectedUserIds();
    if (!ids.length) { status('gcUsersStatus', '请先勾选要处理的用户', 'err'); return; }
    if (action === 'flag' && !window.confirm('确认对 ' + ids.length + ' 个用户标记违规？')) return;
    status('gcUsersStatus', '正在批量' + ({ mute: '禁言', unmute: '解封', flag: '标记违规' }[action] || action) + '…', '');
    recRequest('/api/users', { method: 'POST', body: { action: 'batch', op: action, ids: ids } }).then(function () {
      status('gcUsersStatus', '批量操作成功', 'good');
      loadUsers();
    }).catch(function (err) {
      status('gcUsersStatus', '批量操作失败：' + ((err && err.message) ? err.message : '未知错误'), 'err');
    });
  }
  function usersSingleAction(id, action) {
    if (action === 'flag' && !window.confirm('确认将用户「' + id + '」标记违规？')) return;
    status('gcUsersStatus', '正在操作…', '');
    recRequest('/api/users', { method: 'POST', body: { action: 'single', id: id, op: action } }).then(function () {
      status('gcUsersStatus', '操作成功：' + id, 'good');
      loadUsers();
    }).catch(function (err) {
      status('gcUsersStatus', '操作失败：' + ((err && err.message) ? err.message : '未知错误'), 'err');
    });
  }
  function createUser() {
    var name = ($('gcUserCreateName') ? $('gcUserCreateName').value : '').trim();
    var phone = ($('gcUserCreatePhone') ? $('gcUserCreatePhone').value : '').trim();
    var pass = $('gcUserCreatePass') ? $('gcUserCreatePass').value : '';
    if (!name) { status('gcUsersStatus', '请输入用户名', 'err'); return; }
    if (phone && !/^1[3-9]\d{9}$/.test(phone)) { status('gcUsersStatus', '手机号格式不正确', 'err'); return; }
    status('gcUsersStatus', '正在创建用户…', '');
    var payload = { username: name, phone: phone };
    if (pass) {
      sha256Hex(pass).then(function (hash) {
        payload.passwordHash = hash;
        return recRequest('/api/users', { method: 'POST', body: payload });
      }).then(function () {
        status('gcUsersStatus', '用户创建成功', 'good');
        if ($('gcUserCreateName')) $('gcUserCreateName').value = '';
        if ($('gcUserCreatePhone')) $('gcUserCreatePhone').value = '';
        if ($('gcUserCreatePass')) $('gcUserCreatePass').value = '';
        loadUsers();
      }).catch(function (err) {
        status('gcUsersStatus', '创建失败：' + ((err && err.message) ? err.message : '未知错误'), 'err');
      });
    } else {
      recRequest('/api/users', { method: 'POST', body: payload }).then(function () {
        status('gcUsersStatus', '用户创建成功', 'good');
        if ($('gcUserCreateName')) $('gcUserCreateName').value = '';
        if ($('gcUserCreatePhone')) $('gcUserCreatePhone').value = '';
        if ($('gcUserCreatePass')) $('gcUserCreatePass').value = '';
        loadUsers();
      }).catch(function (err) {
        status('gcUsersStatus', '创建失败：' + ((err && err.message) ? err.message : '未知错误'), 'err');
      });
    }
  }

  /* ---- 维护控制（适配主站 /api/maintenance 契约） ---- */
  var MAINT_STATE = { loading: false };
  var EMOJI_LIST = ['🔧', '🛠', '⏳', '🚧', '☁️', '✈️', '🛫', '🛬', '🧰', '💤'];
  function renderMaintEmojiPicker(active) {
    var wrap = $('gcMaintEmojiPicker');
    if (!wrap) return;
    wrap.innerHTML = '';
    EMOJI_LIST.forEach(function (e) {
      var b = document.createElement('div');
      b.className = 'gca-emoji-opt' + (e === active ? ' active' : '');
      b.textContent = e;
      b.setAttribute('data-emoji', e);
      wrap.appendChild(b);
    });
  }
  function maintSelectedEmoji() {
    var wrap = $('gcMaintEmojiPicker');
    if (!wrap) return '';
    var act = wrap.querySelector('.gca-emoji-opt.active');
    return act ? act.getAttribute('data-emoji') : '';
  }
  function loadMaintConfig() {
    if (MAINT_STATE.loading) return;
    MAINT_STATE.loading = true;
    status('gcMaintStatus', '正在读取主站维护状态…', '');
    recRequest('/api/maintenance', { method: 'GET' }).then(function (data) {
      var d = data || {};
      var maint = d.maintenance || {};
      var el;
      el = $('gcMaintEnabled'); if (el) el.checked = !!maint.enabled;
      el = $('gcMaintMessage'); if (el) el.value = maint.message || '';
      el = $('gcMaintAsset'); if (el) el.value = maint.assetUrl || '';
      var emoji = (maint.assetUrl && String(maint.assetUrl).length <= 4) ? String(maint.assetUrl) : '';
      renderMaintEmojiPicker(emoji);
      var bl = (d.blocklist && Array.isArray(d.blocklist)) ? d.blocklist : [];
      el = $('gcMaintBlocklistInput'); if (el) el.value = bl.join('\n');
      status('gcMaintStatus', '维护状态已同步（当前：' + (maint.enabled ? '维护中' : '正常') + '）', 'good');
    }).catch(function (err) {
      status('gcMaintStatus', '维护状态读取失败：' + ((err && err.message) ? err.message : '未知错误'), 'err');
    }).finally(function () { MAINT_STATE.loading = false; });
  }
  function maintBuildPayload() {
    var msg = $('gcMaintMessage');
    var asset = $('gcMaintAsset');
    var manualAsset = asset ? asset.value.trim() : '';
    var emoji = maintSelectedEmoji();
    var assetUrl = manualAsset || emoji || '🛠';
    return {
      enabled: !!($('gcMaintEnabled') && $('gcMaintEnabled').checked),
      aiGate: !!($('gcMaintEnabled') && $('gcMaintEnabled').checked),
      message: msg ? msg.value.trim() : '站点维护中，请稍后再来',
      assetUrl: assetUrl
    };
  }
  function saveMaintConfig() {
    var pass = $('gcMaintSuperPass') ? $('gcMaintSuperPass').value : '';
    status('gcMaintStatus', '正在保存维护配置…', '');
    recRequest('/api/maintenance', { method: 'POST', body: { action: 'save-config', superPassword: pass, config: maintBuildPayload() } }).then(function (data) {
      status('gcMaintStatus', (data && data.message) ? data.message : '维护配置已保存', 'good');
      if ($('gcMaintSuperPass')) $('gcMaintSuperPass').value = '';
      loadMaintConfig();
    }).catch(function (err) {
      var em = (err && err.message) ? err.message : '未知错误';
      if (pass === '' && /super_password_required|超管密码/i.test(em)) {
        em = '服务端需要超管密码，请在上方输入 SUPER_ADMIN_PASSWORD 后重试';
      }
      status('gcMaintStatus', '保存失败：' + em, 'err');
    });
  }
  function saveMaintBlocklist() {
    var pass = $('gcMaintSuperPassBlk') ? $('gcMaintSuperPassBlk').value : '';
    var ta = $('gcMaintBlocklistInput');
    var lines = ta ? ta.value.split('\n') : [];
    var blocklist = [];
    for (var i = 0; i < lines.length; i++) { var p = lines[i].trim(); if (p) blocklist.push(p); }
    status('gcMaintStatus', '正在推送黑名单…', '');
    recRequest('/api/maintenance', { method: 'POST', body: { action: 'save-blocklist', superPassword: pass, items: blocklist } }).then(function (data) {
      status('gcMaintStatus', (data && data.message) ? data.message : '黑名单已推送', 'good');
      if ($('gcMaintSuperPassBlk')) $('gcMaintSuperPassBlk').value = '';
      loadMaintConfig();
    }).catch(function (err) {
      var em = (err && err.message) ? err.message : '未知错误';
      if (pass === '' && /super_password_required|超管密码/i.test(em)) {
        em = '服务端需要超管密码，请在上方输入 SUPER_ADMIN_PASSWORD 后重试';
      }
      status('gcMaintStatus', '推送失败：' + em, 'err');
    });
  }

  /* ---- 设置分区 ---- */
  function renderSettingsPage() {
    var has = !!getToken();
    var st = $('gcSettingsTokenState');
    if (st) { st.textContent = has ? '已解锁' : '未解锁'; st.className = 'gca-badge' + (has ? ' ok' : ''); }
    var inp = $('gcSettingsTokenInput');
    if (inp && has) inp.value = getToken();
    var clearBtn = $('gcSettingsTokenClear');
    var saveBtn = $('gcSettingsTokenSave');
    if (saveBtn) saveBtn.style.display = has ? 'none' : '';
    if (clearBtn) clearBtn.style.display = has ? '' : 'none';
    var cnt = $('gcSettingsDataCount');
    if (cnt) cnt.textContent = smsRecords().length + ' 条短信记录';
  }
  function unlockSettingsToken() {
    var input = $('gcSettingsTokenInput');
    var tk = (input ? input.value : '').trim();
    if (!tk) { status('gcSettingsStatus', '请输入管理员令牌', 'err'); return; }
    setToken(tk);
    status('gcSettingsStatus', '令牌已解锁，管理操作可用', 'good');
    renderSettingsPage();
  }
  function clearSettingsToken() {
    clearToken();
    var input = $('gcSettingsTokenInput');
    if (input) input.value = '';
    status('gcSettingsStatus', '已清除令牌，管理操作锁定', '');
    renderSettingsPage();
  }
  function exportSmsRecords() {
    var arr = smsRecords();
    var blob = new Blob([JSON.stringify(arr, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'gc-sms-records-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    status('gcSettingsStatus', '已导出 ' + arr.length + ' 条短信记录', 'good');
  }
  function clearSmsRecords() {
    if (!window.confirm('确认清空全部短信发送记录？此操作仅影响本机记录，不影响服务端。')) return;
    saveSmsRecords([]);
    renderSmsRecords();
    renderSettingsPage();
    status('gcSettingsStatus', '短信记录已清空', 'good');
  }
  function resetSmsQuota() {
    var db = loadDB();
    db.smsQuota = 1000;
    saveDB(db);
    renderSmsQuota();
    renderSettingsPage();
    status('gcSettingsStatus', '本地余额已重置为 1000', 'good');
  }

  /* ---- 事件绑定 ---- */
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.id === 'gcAdminClose') { closePanel(); return; }
    if (t && t.id === 'gcAdminTokenSave') { unlockAdmin(); return; }
    if (t && t.id === 'gcAdminTokenClear') { clearAdmin(); return; }
    if (t && t.id === 'gcSmsSend') { smsSend(); return; }
    if (t && t.id === 'gcTokenReload') { loadTokenUsage(); return; }
    if (t && t.id === 'gcUsersReload') { loadUsers(); return; }
    if (t && t.id === 'gcUsersCheckAll') {
      var checked = t.checked;
      var cbs = document.querySelectorAll('#gcUsersTbody .gc-user-check');
      for (var i = 0; i < cbs.length; i++) cbs[i].checked = checked;
      return;
    }
    if (t && t.id === 'gcUserCreateBtn') { createUser(); return; }
    if (t && t.id === 'gcMaintSaveConfig') { saveMaintConfig(); return; }
    if (t && t.id === 'gcMaintSaveBlocklist') { saveMaintBlocklist(); return; }
    if (t && t.id === 'gcSettingsTokenSave') { unlockSettingsToken(); return; }
    if (t && t.id === 'gcSettingsTokenClear') { clearSettingsToken(); return; }
    if (t && t.id === 'gcSettingsExport') { exportSmsRecords(); return; }
    if (t && t.id === 'gcSettingsClearSms') { clearSmsRecords(); return; }
    if (t && t.id === 'gcSettingsResetQuota') { resetSmsQuota(); return; }
    if (t && t.getAttribute && t.getAttribute('data-batch')) { usersBatchAction(t.getAttribute('data-batch')); return; }
    if (t && t.getAttribute && t.getAttribute('data-act') && t.getAttribute('data-uid')) {
      usersSingleAction(t.getAttribute('data-uid'), t.getAttribute('data-act'));
      return;
    }
    if (t && t.getAttribute && t.getAttribute('data-sms-id')) { toggleSmsTracking(t.getAttribute('data-sms-id')); return; }
    if (t && t.classList && t.classList.contains('gca-emoji-opt')) {
      var wrap = $('gcMaintEmojiPicker');
      if (wrap) {
        var opts = wrap.querySelectorAll('.gca-emoji-opt');
        for (var i = 0; i < opts.length; i++) opts[i].classList.toggle('active', opts[i] === t);
      }
      var asset = $('gcMaintAsset');
      if (asset) asset.value = t.getAttribute('data-emoji');
      return;
    }
    if (t && t.classList && t.classList.contains('gca-tab') && t.getAttribute('data-page')) {
      switchPage(t.getAttribute('data-page'));
      return;
    }
    if (t && t.id === 'gcAdminTrigger') { openPanel(); return; }
    if (t && t.id === 'gcSmsTemplate') { return; }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t && t.id === 'gcSmsTemplate') {
      var wrap = $('gcSmsManualWrap');
      if (wrap) wrap.style.display = t.value === 'manual' ? '' : 'none';
    }
    if (t && t.id === 'gcMaintEnabled') {
      var asset = $('gcMaintAsset');
      if (asset && !asset.value) asset.value = '🛠';
    }
  });

  function checkHash() {
    if (window.location.hash === '#admin') openPanel();
  }
  window.addEventListener('hashchange', checkHash);
  checkHash();
})();
