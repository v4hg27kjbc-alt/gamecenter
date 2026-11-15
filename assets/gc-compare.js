/* ==========================================================================
 * 民航客机收藏馆 · 交互新功能 v3.5「机型速配对比台」
 * --------------------------------------------------------------------------
 * 1) 右下角独立入口（与多端互联 FAB 垂直错开，不遮挡阅读）
 * 2) 双槽对比：左右各选一架机型，实时对比 6 项核心参数
 * 3) 差值高亮 + 归一化条形动画（差异 >15% 标色）
 * 4) 「随机开箱」一键随机配对；Esc / 点击遮罩关闭
 * 5) 尊重 prefers-reduced-motion，关闭时不留残影
 * 依赖：页面全局机型数组 aircrafts（同源 <script> 全局词法环境）
 * ========================================================================== */
(function () {
  'use strict';
  if (window.__gcCompare) return;
  window.__gcCompare = true;

  var FIELDS = [
    { key: 'seats', label: '典型座位', hint: '载客量' },
    { key: 'max_range', label: '最大航程', hint: 'km' },
    { key: 'length', label: '机身长度', hint: 'm' },
    { key: 'wingspan', label: '翼展', hint: 'm' },
    { key: 'mtow', label: '最大起飞重量', hint: '吨' },
    { key: 'cruise_speed', label: '巡航速度', hint: '马赫' }
  ];

  var reduce = false;
  try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

  function planes() {
    try {
      if (typeof aircrafts !== 'undefined' && Array.isArray(aircrafts) && aircrafts.length) return aircrafts;
    } catch (e) {}
    try {
      if (window.aircrafts && Array.isArray(window.aircrafts)) return window.aircrafts;
    } catch (e2) {}
    return [];
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function specOf(p, key) {
    var sp = (p && p.specs) || {};
    if (sp[key] != null) return String(sp[key]);
    var alts = {
      seats: ['seat', 'capacity', 'pax'], max_range: ['range', 'maxRange'],
      length: ['len', 'fuselage'], wingspan: ['span', 'wing'],
      mtow: ['weight', 'mtow_t'], cruise_speed: ['speed', 'cruise']
    }[key] || [];
    for (var i = 0; i < alts.length; i++) { if (sp[alts[i]] != null) return String(sp[alts[i]]); }
    return '--';
  }

  function numOf(txt) {
    var m = String(txt || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : NaN;
  }

  function css() {
    if (document.getElementById('gcCmpStyle')) return;
    var st = document.createElement('style');
    st.id = 'gcCmpStyle';
    st.textContent = [
      '#gcCmpBtn{position:fixed;right:22px;bottom:104px;z-index:9993;display:flex;align-items:center;gap:7px;',
      'height:42px;padding:0 15px 0 12px;border:1px solid rgba(255,255,255,.18);border-radius:999px;cursor:pointer;',
      'background:linear-gradient(135deg,#0b2340,#164a8a);color:#fff;font-size:13px;font-weight:600;letter-spacing:.2px;',
      'box-shadow:0 10px 26px rgba(11,35,64,.28);transition:transform .2s,box-shadow .2s}',
      '#gcCmpBtn:hover{transform:translateY(-2px);box-shadow:0 14px 32px rgba(11,35,64,.36)}',
      '#gcCmpBtn svg{width:16px;height:16px;fill:none;stroke:#f5c96a;stroke-width:1.8}',
      '#gcCmpMask{position:fixed;inset:0;z-index:99990;display:none;background:rgba(8,20,36,.42);backdrop-filter:blur(3px)}',
      '#gcCmpMask.open{display:block}',
      '#gcCmpPanel{position:absolute;left:50%;top:50%;transform:translate(-50%,-46%) scale(.97);width:min(760px,calc(100vw - 28px));',
      'max-height:min(86vh,720px);overflow:auto;background:#fff;border-radius:18px;box-shadow:0 26px 70px rgba(8,20,36,.34);',
      'border:1px solid #e4ecf5;opacity:0;transition:opacity .22s,transform .22s;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}',
      '#gcCmpMask.open #gcCmpPanel{opacity:1;transform:translate(-50%,-50%) scale(1)}',
      '#gcCmpPanel .cp-hd{display:flex;align-items:center;gap:10px;padding:15px 18px 12px;border-bottom:1px solid #eef3f9}',
      '#gcCmpPanel .cp-hd b{font-size:15px;color:#12243a}',
      '#gcCmpPanel .cp-hd .cp-sub{font-size:11.5px;color:#8593a6}',
      '#gcCmpPanel .cp-x{margin-left:auto;border:0;background:#f1f5fa;color:#5a6a80;width:28px;height:28px;border-radius:9px;cursor:pointer;font-size:15px;line-height:1}',
      '#gcCmpPanel .cp-bd{padding:14px 18px 18px}',
      '#gcCmpPanel .cp-picks{display:grid;grid-template-columns:1fr 26px 1fr;gap:10px;align-items:center}',
      '#gcCmpPanel select{width:100%;padding:9px 10px;border-radius:10px;border:1px solid #d7e3f0;background:#fbfdff;color:#12243a;font-size:13px;outline:none}',
      '#gcCmpPanel .cp-vs{text-align:center;font-size:11px;font-weight:700;color:#8593a6}',
      '#gcCmpPanel .cp-img{display:grid;grid-template-columns:1fr 26px 1fr;gap:10px;margin-top:12px;align-items:center}',
      '#gcCmpPanel .cp-img img{width:100%;height:96px;object-fit:cover;border-radius:12px;background:#eef3f9;border:1px solid #e4ecf5}',
      '#gcCmpPanel .cp-code{font-size:12.5px;font-weight:700;color:#164a8a;margin-top:6px;text-align:center}',
      '#gcCmpPanel .cp-row{margin-top:13px}',
      '#gcCmpPanel .cp-lab{display:flex;align-items:center;gap:6px;font-size:12px;color:#5a6a80;margin-bottom:5px}',
      '#gcCmpPanel .cp-lab em{font-style:normal;color:#b0bccb;font-size:11px}',
      '#gcCmpPanel .cp-bars{display:grid;grid-template-columns:1fr 26px 1fr;gap:10px;align-items:center}',
      '#gcCmpPanel .cp-bar{height:9px;border-radius:999px;background:#eef3f9;overflow:hidden;position:relative}',
      '#gcCmpPanel .cp-bar i{display:block;height:100%;width:0;border-radius:999px;transition:width .5s cubic-bezier(.22,.7,.3,1)}',
      '#gcCmpPanel .cp-val{font-size:12.5px;font-weight:700;color:#12243a;margin-top:4px}',
      '#gcCmpPanel .cp-val.win{color:#047857}',
      '#gcCmpPanel .cp-val.lose{color:#94a3b8}',
      '#gcCmpPanel .cp-ft{display:flex;gap:10px;align-items:center;padding:12px 18px 16px;border-top:1px solid #eef3f9}',
      '#gcCmpPanel .cp-ft button{border:1px solid #d7e3f0;background:#fff;color:#164a8a;border-radius:10px;padding:8px 14px;font-size:12.5px;cursor:pointer;font-weight:600}',
      '#gcCmpPanel .cp-ft button.primary{background:linear-gradient(135deg,#0b2340,#164a8a);color:#fff;border-color:transparent}',
      '#gcCmpPanel .cp-ft .cp-tip{margin-left:auto;font-size:11.5px;color:#8593a6}',
      '@media (max-width:520px){#gcCmpBtn{right:14px;bottom:92px;height:38px;padding:0 12px;font-size:12px}',
      '#gcCmpPanel .cp-img img{height:72px}}'
    ].join('');
    document.head.appendChild(st);
  }

  var state = { a: null, b: null };

  function optList(sel, cur) {
    var arr = planes();
    return '<option value="">选择机型…</option>' + arr.map(function (p) {
      return '<option value="' + p.id + '"' + (String(p.id) === String(cur) ? ' selected' : '') + '>'
        + esc(p.code || p.name) + (p.country ? '（' + esc(p.country) + '）' : '') + '</option>';
    }).join('');
  }

  function find(id) {
    var arr = planes();
    for (var i = 0; i < arr.length; i++) { if (String(arr[i].id) === String(id)) return arr[i]; }
    return null;
  }

  function imgOf(p) {
    if (!p) return '';
    var src = p.image || '';
    return src ? '<img src="' + esc(src) + '" alt="' + esc(p.code || '') + '" loading="lazy" onerror="this.style.visibility=\'hidden\'">' : '<img alt="">';
  }

  function render() {
    var panel = document.getElementById('gcCmpPanel');
    if (!panel) return;
    var A = state.a, B = state.b;
    var rows = FIELDS.map(function (f) {
      var va = A ? specOf(A, f.key) : '--';
      var vb = B ? specOf(B, f.key) : '--';
      var na = numOf(va), nb = numOf(vb);
      var max = Math.max(isNaN(na) ? 0 : na, isNaN(nb) ? 0 : nb) || 1;
      var pa = isNaN(na) ? 0 : Math.max(4, na / max * 100);
      var pb = isNaN(nb) ? 0 : Math.max(4, nb / max * 100);
      var d = (!isNaN(na) && !isNaN(nb) && max > 0) ? Math.abs(na - nb) / max : 0;
      var ca = !isNaN(na) && !isNaN(nb) ? (na > nb ? 'win' : (na < nb ? 'lose' : '')) : '';
      var cb = !isNaN(na) && !isNaN(nb) ? (nb > na ? 'win' : (nb < na ? 'lose' : '')) : '';
      var gA = d > 0.15 ? 'linear-gradient(90deg,#164a8a,#2f6fd0)' : 'linear-gradient(90deg,#8fb4e0,#b9cfe8)';
      var gB = d > 0.15 ? 'linear-gradient(90deg,#b8860b,#f5c96a)' : 'linear-gradient(90deg,#e0cf9a,#efe2bf)';
      return '<div class="cp-row">'
        + '<div class="cp-lab">' + esc(f.label) + '<em>' + esc(f.hint) + '</em></div>'
        + '<div class="cp-bars">'
        + '<div><div class="cp-bar"><i data-w="' + pa + '" style="background:' + gA + '"></i></div>'
        + '<div class="cp-val ' + ca + '">' + esc(va) + '</div></div>'
        + '<div class="cp-vs">·</div>'
        + '<div><div class="cp-bar"><i data-w="' + pb + '" style="background:' + gB + '"></i></div>'
        + '<div class="cp-val ' + cb + '">' + esc(vb) + '</div></div>'
        + '</div></div>';
    }).join('');

    panel.innerHTML =
      '<div class="cp-hd"><b>机型速配对比台</b><span class="cp-sub">左右各选一架，实时比参数</span>'
      + '<button class="cp-x" id="gcCmpX" aria-label="关闭">&times;</button></div>'
      + '<div class="cp-bd">'
      + '<div class="cp-picks">'
      + '<select id="gcCmpA">' + optList(0, A && A.id) + '</select>'
      + '<div class="cp-vs">VS</div>'
      + '<select id="gcCmpB">' + optList(0, B && B.id) + '</select></div>'
      + '<div class="cp-img">'
      + '<div>' + imgOf(A) + '<div class="cp-code">' + esc(A ? (A.code || '') : '待选择') + '</div></div>'
      + '<div class="cp-vs">·</div>'
      + '<div>' + imgOf(B) + '<div class="cp-code">' + esc(B ? (B.code || '') : '待选择') + '</div></div></div>'
      + rows + '</div>'
      + '<div class="cp-ft">'
      + '<button class="primary" id="gcCmpRandom" type="button">随机开箱</button>'
      + '<button id="gcCmpSwap" type="button">左右对调</button>'
      + '<span class="cp-tip">数据取自机型库参数表</span></div>';

    panel.querySelector('#gcCmpX').onclick = close;
    panel.querySelector('#gcCmpRandom').onclick = randomPick;
    panel.querySelector('#gcCmpSwap').onclick = function () {
      var t = state.a; state.a = state.b; state.b = t; render();
    };
    panel.querySelector('#gcCmpA').onchange = function () { state.a = find(this.value); render(); };
    panel.querySelector('#gcCmpB').onchange = function () { state.b = find(this.value); render(); };

    // 条形动画：下一帧写入宽度
    var bars = panel.querySelectorAll('.cp-bar i[data-w]');
    var t = reduce ? 0 : 40;
    setTimeout(function () {
      Array.prototype.forEach.call(bars, function (el) { el.style.width = el.getAttribute('data-w') + '%'; });
    }, t);
  }

  function randomPick() {
    var arr = planes().slice();
    if (arr.length < 2) return;
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    state.a = arr[0]; state.b = arr[1];
    render();
  }

  function open() {
    css();
    var mask = document.getElementById('gcCmpMask');
    if (!mask) {
      mask = document.createElement('div');
      mask.id = 'gcCmpMask';
      mask.innerHTML = '<div id="gcCmpPanel" role="dialog" aria-label="机型速配对比台"></div>';
      document.body.appendChild(mask);
      mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && mask.classList.contains('open')) close();
      });
    }
    if (!state.a || !state.b) {
      var arr = planes();
      state.a = state.a || arr[0] || null;
      state.b = state.b || arr[4] || arr[1] || null;
    }
    render();
    mask.classList.add('open');
  }

  function close() {
    var mask = document.getElementById('gcCmpMask');
    if (mask) mask.classList.remove('open');
  }

  function boot() {
    if (!planes().length) { setTimeout(boot, 900); return; }
    css();
    if (document.getElementById('gcCmpBtn')) return;
    var btn = document.createElement('button');
    btn.id = 'gcCmpBtn';
    btn.type = 'button';
    btn.title = '机型速配对比台';
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h7M4 15h7M13 9h7M13 15h7"/>'
      + '<circle cx="9" cy="9" r="1.4"/><circle cx="15" cy="15" r="1.4"/></svg><span>速配对比</span>';
    btn.addEventListener('click', open);
    document.body.appendChild(btn);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  setTimeout(boot, 1500);

  window.GCCompare = { open: open, close: close, random: randomPick };
})();
