
/* ===========================================================================
   v70 特性① runtime · SoftGlass（v2 柔光玻璃按钮层）
   —— 只给按钮类元素挂玻璃：button / .btn / [role=button] / input 按钮 /
      可点操作按钮（.fab-add、.back-to-top、chips 等）。
   —— 已移除：SVG feDisplacementMap 真折射宿主(#lg-svg-root)、指针跟随
      (pointermove + --lg-mx/--lg-my + 动态折射中心)、卡片/面板/模态/列表
      等大面积元素的批量挂类。整页恢复干净观感。
   —— 新增：中性按钮自动补柔光面(lg-btn-frost)；按下/拖拽松手后的 QQ 弹性
      回弹(sg-bounce)。
   —— 不触碰任何既有函数/变量：本段只新增 window.SoftGlass
      （并保留 window.AppleGlass 别名以兼容既有探针）。
   =========================================================================== */
(function () {
  'use strict';

  if (window.SoftGlass && window.SoftGlass.__v) { return; }

  var MARK = 'lg-btn';
  var BTN_SEL = 'button, .btn, [role="button"], input[type="button"], input[type="submit"]';
  /* 底栏胶囊自身有独立材质，不给其条目挂按钮玻璃；.mat-skip 为显式豁免位 */
  var SKIP_SEL = '#mtbBar, .mat-skip';
  var SPRING_MS = 560;

  var perfLight = false;
  var mountedCount = 0;
  var observed = 0;

  /* ---------- 中性按钮判定：自身无渐变底、且底色接近透明 ---------- */
  function isNeutralBg(el) {
    try {
      var cs = getComputedStyle(el);
      var bi = cs.backgroundImage || '';
      if (bi && bi !== 'none') { return false; }
      var m = (cs.backgroundColor || '').match(/rgba?\(([^)]+)\)/);
      if (!m) { return false; }
      var a = m[1].split(',')[3];
      a = (a === undefined) ? 1 : parseFloat(a);
      return !(a >= 0.12);
    } catch (e) { return false; }
  }

  function skipped(el) {
    if (!el || !el.classList) { return true; }
    if (el.classList.contains('mat-skip')) { return true; }
    if (el.closest && el.closest(SKIP_SEL)) { return true; }
    return false;
  }

  function mount(el) {
    if (skipped(el)) { return false; }
    var fresh = false;
    if (!el.classList.contains(MARK)) {
      el.classList.add('glass-material', MARK);
      mountedCount++;
      fresh = true;
    }
    /* 柔光面：仅对中性按钮补（带自身渐变的按钮不动其底色） */
    var hasFrost = el.classList.contains('lg-btn-frost');
    if (!hasFrost && isNeutralBg(el)) { el.classList.add('lg-btn-frost'); }
    return fresh;
  }

  function mountAll() {
    var list;
    try { list = document.querySelectorAll(BTN_SEL); } catch (e) { return; }
    for (var i = 0; i < list.length; i++) { mount(list[i]); }
  }

  /* ---------- QQ 弹性回弹：按下→松手（含拖拽后松手）触发 ---------- */
  function spring(el) {
    if (!el || !el.classList) { return false; }
    el.classList.remove('sg-bounce');
    void el.offsetWidth;                 /* 强制重排，保证重复触发都能播 */
    el.classList.add('sg-bounce');
    clearTimeout(el.__sgTimer);
    el.__sgTimer = setTimeout(function () { el.classList.remove('sg-bounce'); }, SPRING_MS);
    return true;
  }

  function pressTarget(node) {
    if (!node || !node.closest) { return null; }
    var el = node.closest(BTN_SEL);
    if (!el) {
      el = node.closest('.mtb-item');
      if (el && el.closest('#mtbBar')) { return el; }
      return null;
    }
    if (el.closest('#mtbBar')) {                 /* 底栏条目：只回弹，不挂按钮玻璃 */
      var item = node.closest('.mtb-item');
      return item || el;
    }
    return el.classList.contains(MARK) ? el : null;
  }

  var pressEl = null;
  document.addEventListener('pointerdown', function (ev) {
    pressEl = pressTarget(ev.target);
  }, true);
  function release(ev) {
    var el = pressEl || pressTarget(ev.target);
    pressEl = null;
    if (el) { spring(el); }
  }
  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', release, true);

  var pending = null;
  function scheduleScan() {
    if (pending) { return; }
    pending = setTimeout(function () { pending = null; mountAll(); }, 240);
  }

  function boot() {
    if (!document.body) { return; }
    var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    perfLight = reduced
      || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4)
      || (navigator.deviceMemory && navigator.deviceMemory <= 4)
      || (navigator.connection && navigator.connection.saveData === true);
    if (perfLight) { document.body.classList.add('lg-perf-light'); }

    /* v2 无折射：保留 lg-norefract 标记，供底栏等组件走"纯模糊"降级分支 */
    document.documentElement.classList.add('lg-norefract');
    document.documentElement.classList.remove('lg-refract-on');

    mountAll();
    setTimeout(mountAll, 900);      /* 弹窗/AI 面板等晚初始化内容补挂 */
    setTimeout(mountAll, 2600);
    try { mountAll(); } catch (e0) { /* 忽略 */ }

    try {
      var mo = new MutationObserver(scheduleScan);
      mo.observe(document.body, { childList: true, subtree: true });
      observed = 1;
    } catch (e1) { /* 老浏览器忽略 */ }

    window.SoftGlass = {
      __v: '2.0',
      role: 'soft-glass-buttons',
      refract: false,          /* 已移除 SVG 折射 */
      pointerFollow: false,    /* 已移除鼠标追光 */
      perfLight: perfLight,
      refresh: mountAll,
      mount: mountAll,
      spring: spring,
      state: function () {
        return {
          refract: false, perfLight: perfLight, pointerFollow: false,
          buttons: document.querySelectorAll('.' + MARK).length,
          frost: document.querySelectorAll('.' + MARK + '.lg-btn-frost').length,
          accent: document.querySelectorAll('.' + MARK + '.lg-accent').length,
          mountedStatic: document.querySelectorAll('[data-lg="static"].' + MARK).length,
          mountedRuntime: 0,                       /* v2 不再对卡片/弹窗做运行时挂类 */
          chrome: 0, panel: 0, soft: 0,            /* 大面积角色类已全部退休 */
          refractFilters: document.querySelectorAll('filter[id^="lg-fx-"]').length,
          observers: observed,
          total: document.querySelectorAll('.glass-material').length
        };
      }
    };
    /* 兼容旧探针名 */
    window.AppleGlass = window.SoftGlass;

    var st = window.SoftGlass.state();
    console.log('[SoftGlass] v2 柔光玻璃按钮层已启用 | 折射: off(已移除) | 鼠标追光: off'
      + ' | 按钮玻璃: ' + st.buttons + ' (柔光面 ' + st.frost + ' / 强调 ' + st.accent + ')'
      + ' | 低配降级: ' + (perfLight ? 'on' : 'off'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

/* ===========================================================================
   今日执飞 · 航线执飞卡（fly-board）—— 纯增量模块
   复用既有 overlay/glass/滚动锁契约；不覆盖任何既有函数。
   音效：Web Audio 合成（风声/盖章/点击）；导出：html2canvas CDN。
   =========================================================================== */
(function () {
  var FLY_SOUND_KEY = 'flySound';
  var flySoundEnabled = (function () { try { return localStorage.getItem(FLY_SOUND_KEY) !== 'off'; } catch (e) { return true; } })();
  var flyCtx = null;
  var flyAnimId = 0;
  var flyRunning = false;
  var flyWindNodes = null;
  var FLY_POOL = null;
  var FLY_ITEM_W = 128;
  var FLY_ITEM_STEP = 138;

  /* —— 候选池：从既有 aircrafts 提取民航机型（附中文名） —— */
  function flyPool() {
    if (FLY_POOL) return FLY_POOL;
    var arr = (typeof aircrafts !== 'undefined' && Array.isArray(aircrafts)) ? aircrafts : [];
    var src = arr.filter(function (a) { return a && a.category === 'civil'; });
    if (!src.length) {
      src = [
        { id: 1, code: 'Airbus A380', image: '', specs: { seats: '525 人', cruise_speed: '0.85 马赫', max_range: '15,200 km', capacity: '525–853 人' } },
        { id: 2, code: 'Boeing 787-9', image: '', specs: { seats: '290 人', cruise_speed: '0.85 马赫', max_range: '14,140 km', capacity: '242–330 人' } },
        { id: 5, code: 'COMAC C919', image: '', specs: { seats: '168 人', cruise_speed: '0.785 马赫', max_range: '5,555 km', capacity: '158–192 人' } },
        { id: 6, code: 'Airbus A320neo', image: '', specs: { seats: '165 人', cruise_speed: '0.78 马赫', max_range: '6,300 km', capacity: '150–194 人' } }
      ];
    }
    FLY_POOL = src.map(function (a) {
      var nm = (typeof t === 'function') ? t(a.name) : (a.code || '');
      if (!nm || nm === a.name) nm = a.code || '';
      return { id: a.id, name: nm, code: a.code || '', img: a.image || '', specs: a.specs || {}, tags: a.tags || [] };
    });
    return FLY_POOL;
  }

  function flyAirportList() {
    var src = (typeof airports !== 'undefined') ? airports : {};
    var list = Object.keys(src).map(function (k) {
      return { code: k, name: (src[k] && src[k].name) || k, lat: src[k] && src[k].lat || 0, lng: src[k] && src[k].lng || 0 };
    });
    if (!list.length) {
      list = [
        { code: 'PEK', name: '北京', lat: 40.08, lng: 116.58 },
        { code: 'PVG', name: '上海', lat: 31.14, lng: 121.81 },
        { code: 'CAN', name: '广州', lat: 23.39, lng: 113.30 },
        { code: 'HKG', name: '香港', lat: 22.31, lng: 113.91 },
        { code: 'SIN', name: '新加坡', lat: 1.36, lng: 103.99 },
        { code: 'DXB', name: '迪拜', lat: 25.25, lng: 55.36 },
        { code: 'LHR', name: '伦敦', lat: 51.47, lng: -0.46 },
        { code: 'JFK', name: '纽约', lat: 40.64, lng: -73.78 }
      ];
    }
    return list;
  }

  /* —— 大圆距离（km），用于航程匹配 —— */
  function flyDistKm(a, b) {
    if (!a || !b) return 0;
    if ((!a.lat && !a.lng) || (!b.lat && !b.lng)) return 0;
    var R = 6371;
    var dLat = (b.lat - a.lat) * Math.PI / 180;
    var dLng = (b.lng - a.lng) * Math.PI / 180;
    var la = a.lat * Math.PI / 180;
    var lb = b.lat * Math.PI / 180;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function flyParseRange(s) {
    if (!s) return 0;
    var m = String(s).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
  }

  /* —— 为航线挑 1~2 架：优先航程可覆盖，否则取最接近的 —— */
  function flyPickForRoute(dep, arr, airportsMap) {
    var pool = flyPool();
    var d = flyDistKm(airportsMap[dep] || null, airportsMap[arr] || null);
    var need = d > 0 ? d : 2200;
    var fits = pool.filter(function (a) {
      var r = flyParseRange(a.specs.max_range);
      return r > 0 && r >= need * 1.12;
    });
    if (!fits.length) {
      var sorted = pool.slice().sort(function (a, b) { return flyParseRange(b.specs.max_range) - flyParseRange(a.specs.max_range); });
      fits = sorted.slice(0, Math.min(4, sorted.length));
    }
    function one() { return fits[Math.floor(Math.random() * fits.length)]; }
    var main = one();
    var alt = null;
    if (fits.length > 1 && Math.random() < 0.45) {
      var b = one();
      if (b.id !== main.id) alt = b;
    }
    return { main: main, alt: alt, dist: d };
  }

  /* —— 音效：Web Audio 合成 —— */
  function flyGetCtx() {
    if (!flyCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) flyCtx = new AC();
    }
    if (flyCtx && flyCtx.state === 'suspended' && flyCtx.resume) flyCtx.resume();
    return flyCtx;
  }
  function flyTone(freq, start, dur, type, vol, freqEnd) {
    var ctx = flyGetCtx();
    if (!ctx) return;
    try {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = type || 'sine';
      var t0 = ctx.currentTime + (start || 0);
      osc.frequency.setValueAtTime(freq, t0);
      if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, t0 + (dur || 0.3));
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(vol || 0.16, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + (dur || 0.3));
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + (dur || 0.3) + 0.05);
    } catch (e) {}
  }
  function flyNoiseBuf(ctx, dur) {
    var len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }
  function flyStartWind() {
    if (!flySoundEnabled) return;
    var ctx = flyGetCtx();
    if (!ctx) return;
    try {
      var src = ctx.createBufferSource();
      src.buffer = flyNoiseBuf(ctx, 5);
      src.loop = true;
      var filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 320;
      filter.Q.value = 0.8;
      var gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.18);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      src.start();
      flyWindNodes = { src: src, filter: filter, gain: gain };
    } catch (e) {}
  }
  function flyStopWind() {
    if (!flyWindNodes) return;
    var nodes = flyWindNodes;
    flyWindNodes = null;
    try {
      if (nodes.gain && flyCtx) {
        nodes.gain.gain.setValueAtTime(nodes.gain.gain.value, flyCtx.currentTime);
        nodes.gain.gain.exponentialRampToValueAtTime(0.0001, flyCtx.currentTime + 0.25);
      }
      setTimeout(function () { try { nodes.src.stop(); } catch (e2) {} }, 350);
    } catch (e) {}
  }
  function flyStamp() {
    if (!flySoundEnabled) return;
    flyTone(170, 0, 0.28, 'sine', 0.28, 46);
    flyTone(60, 0.02, 0.3, 'triangle', 0.24, 40);
    var ctx = flyGetCtx();
    if (!ctx) return;
    try {
      var src = ctx.createBufferSource();
      src.buffer = flyNoiseBuf(ctx, 0.09);
      var bp = ctx.createBiquadFilter();
      bp.type = 'highpass';
      bp.frequency.value = 1800;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.15, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.09);
      src.connect(bp); bp.connect(g); g.connect(ctx.destination);
      src.start();
    } catch (e) {}
  }
  function flyClick() { if (flySoundEnabled) flyTone(720, 0, 0.08, 'sine', 0.07); }

  function toggleFlySound() {
    flySoundEnabled = !flySoundEnabled;
    try { localStorage.setItem(FLY_SOUND_KEY, flySoundEnabled ? 'on' : 'off'); } catch (e) {}
    var btn = document.getElementById('flySoundBtn');
    if (btn) btn.textContent = '音效：' + (flySoundEnabled ? '开' : '关');
    if (flySoundEnabled) flyClick();
  }

  /* —— 下拉初始化 —— */
  function flyFillSelects() {
    var dep = document.getElementById('flyDepSel');
    var arr = document.getElementById('flyArrSel');
    if (!dep || !arr) return;
    if (dep.options.length > 1) return;
    var list = flyAirportList();
    var html = '';
    for (var i = 0; i < list.length; i++) html += '<option value="' + list[i].code + '">' + list[i].name + ' ' + list[i].code + '</option>';
    dep.innerHTML = html;
    arr.innerHTML = html;
    var i1 = Math.floor(Math.random() * list.length);
    var i2 = Math.floor(Math.random() * (list.length - 1));
    if (i2 >= i1) i2++;
    dep.selectedIndex = i1;
    arr.selectedIndex = i2;
  }

  /* —— 滚动舞台 —— */
  function flyEaseOutQuart(t) { return 1 - Math.pow(1 - t, 4); }
  function flyBuildReel(pool, targetPoolIdx) {
    var reel = document.getElementById('flyReel');
    if (!reel) return null;
    var seq = [];
    var i, j;
    for (i = 0; i < 2; i++) for (j = 0; j < pool.length; j++) seq.push(pool[j]);
    for (i = 0; i < Math.min(4, pool.length); i++) seq.push(pool[i]);
    var html = '';
    for (i = 0; i < seq.length; i++) {
      var letter = (seq[i].name || seq[i].code || '?').slice(0, 1);
      html += '<div class="fly-reel-item"><div class="fly-reel-ic">' + letter + '</div><div class="fly-reel-acname">' + seq[i].name + '</div></div>';
    }
    reel.innerHTML = html;
    var pickedGlobalIdx = pool.length + targetPoolIdx;
    var targetX = pickedGlobalIdx * FLY_ITEM_STEP + FLY_ITEM_STEP / 2;
    var stage = document.getElementById('flyStage');
    var viewW = stage && stage.clientWidth > 200 ? stage.clientWidth : 420;
    var dest = -(targetX - viewW / 2);
    return { dest: dest, pickedGlobalIdx: pickedGlobalIdx };
  }
  function flyRunReel(pool, targetPoolIdx, done) {
    var reel = document.getElementById('flyReel');
    var stage = document.getElementById('flyStage');
    if (!reel || !stage) { done(); return; }
    var plan = flyBuildReel(pool, targetPoolIdx);
    if (!plan) { done(); return; }
    var duration = 4200;
    var startTs = null;
    var token = ++flyAnimId;
    flyStartWind();
    function frame(ts) {
      if (flyAnimId !== token) return;
      if (!startTs) startTs = ts;
      var t = Math.min(1, (ts - startTs) / duration);
      var eased = flyEaseOutQuart(t);
      var x = plan.dest * eased;
      reel.style.transform = 'translateX(' + x + 'px)';
      var speed = 1 - eased;
      if (flyWindNodes && flyWindNodes.filter) {
        try { flyWindNodes.filter.frequency.value = 300 + 1500 * (0.25 + 0.75 * speed); } catch (e) {}
      }
      if (t < 1) {
        window.requestAnimationFrame(frame);
      } else {
        reel.style.transform = 'translateX(' + plan.dest + 'px)';
        flyStopWind();
        var items = reel.children;
        for (var i = 0; i < items.length; i++) items[i].classList.remove('landed');
        if (items[plan.pickedGlobalIdx]) items[plan.pickedGlobalIdx].classList.add('landed');
        flyStamp();
        setTimeout(done, 460);
      }
    }
    window.requestAnimationFrame(frame);
  }

  /* —— 机长口吻点评 —— */
  var FLY_LINES = {
    1: '双层大块头，起飞时整条跑道都得让三分。今天这条线它来压阵，稳。',
    2: '复合材料机身，最擅长钻长途夜航。乘客睡一觉，它还在云端溜达，省油是看家本事。',
    3: '罗尔斯·罗伊斯引擎的动静，听着跟吟诗似的。长途交给它，机长我放心。',
    4: '推力大得离谱，爬升的时候连咖啡都得端稳。老将出马，一条顶俩。',
    5: '国产新秀上阵，仪表盘摸起来都是新鲜味。今天带它跑一趟，给航线涨涨士气。',
    6: '单通道里的劳模，起降利索、不挑跑道，一天四段来回不在话下。',
    7: '换了新发动机，噪音小了一圈，翼尖小翼一翘，省油省到财务部都笑。',
    8: '中远程万金油，宽体里的大众款，哪条线缺飞机找它准没错。',
    9: '支线小钢炮，跑道短也不怵，小机场的宠儿，今天替你去探探路。',
    10: '客舱宽敞是它的骄傲，飞短途也跟坐头等舱似的，乘客的腰最懂。',
    26: '四发巨无霸的收尾之作，登机门一开廊桥都排队。今天这班，排面给足。',
    27: '喷气时代的老祖宗，驾驶舱全是机械手感。今天拉出来遛遛，全凭老司机。',
    28: '707 加长版，越洋航线的开拓者。飞得慢，但每一步都算数。',
    29: '后三发小尾巴，短跑道起降是绝活。当年机场常客，今天依然利索。',
    30: '727 加长款，1970 年代卖得最好的一台。今天这班，怀旧值拉满。',
    31: '第一代 737，小巧可靠。别看年纪大，短途通勤还是把好手。',
    32: '737 的加长版，服役半个世纪的老伙计。机长闭着眼都知道每个开关在哪。',
    33: '747 开山之作，双层机头一出场就惊艳世界。今天来，照样压得住场。',
    34: '747 经典款，跨太平洋的熟面孔。四发轰鸣，是那个年代的底气。',
    35: '缩短机身换超远航程，当年的跨洋传说。今天拉出来，还是那个范儿。',
    36: '747 家族承上启下的一代，货舱客舱两开花。老规矩，慢热但可靠。',
    37: '空客开局之作，宽体客机的老祖宗。慢悠悠地飞，像位老绅士。',
    38: 'A300 加长版，中短途宽体的老前辈。声音低沉，落地温柔。'
  };
  var FLY_DEFAULT_LINES = [
    '今天这班交给它，机长先把巡航速度调到顺手，剩下交给老天。',
    '机型有点年头，但保养得比我头发还精神，飞这条线绰绰有余。',
    '驾驶舱手感熟得很，航线长短都难不倒它，放心登机。',
    '这架我飞过不少回，起飞滑跑稳，落地也利索，乘客好评率高。'
  ];
  function flyLineFor(ac) {
    if (FLY_LINES[ac.id]) return FLY_LINES[ac.id];
    return FLY_DEFAULT_LINES[Math.floor(Math.random() * FLY_DEFAULT_LINES.length)];
  }

  /* —— 渲染执飞卡 —— */
  function flyRenderTicket(main, alt, dep, arr, airportsMap, dist) {
    var dateEl = document.getElementById('flyTicketDate');
    var depEl = document.getElementById('flyTicketDep');
    var arrEl = document.getElementById('flyTicketArr');
    var imgEl = document.getElementById('flyTicketImg');
    var nameEl = document.getElementById('flyTicketAcName');
    var specEl = document.getElementById('flyTicketSpecs');
    var noteEl = document.getElementById('flyTicketNote');
    var depInfo = airportsMap[dep] || { name: dep, code: dep };
    var arrInfo = airportsMap[arr] || { name: arr, code: arr };
    var now = new Date();
    var dateStr = now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日';
    if (dateEl) dateEl.textContent = dateStr;
    if (depEl) depEl.innerHTML = depInfo.name + '<small>' + dep + '</small>';
    if (arrEl) arrEl.innerHTML = arrInfo.name + '<small>' + arr + '</small>';
    if (nameEl) nameEl.textContent = main.name;
    var s = main.specs || {};
    var speed = s.cruise_speed || '—';
    var seats = s.seats || s.capacity || '—';
    var range = s.max_range || '—';
    var distLine = dist > 0 ? Math.round(dist) + ' km' : '—';
    if (specEl) {
      specEl.innerHTML = '巡航速度 <b>' + speed + '</b>　载客量 <b>' + seats + '</b>　航程 <b>' + range + '</b>　航线 <b>' + distLine + '</b>' + (alt ? '<br>备机：' + alt.name : '');
    }
    if (noteEl) noteEl.innerHTML = '<span class="fly-note-caption">机长</span>' + flyLineFor(main);
    if (imgEl) {
      var fb = document.createElement('span');
      fb.className = 'fly-ticket-img-fb';
      fb.textContent = (main.name || main.code || '?').slice(0, 1);
      imgEl.innerHTML = '';
      imgEl.appendChild(fb);
      if (main.img) {
        var im = document.createElement('img');
        im.src = main.img;
        im.alt = main.name;
        im.onload = function () { imgEl.innerHTML = ''; imgEl.appendChild(im); };
      }
    }
  }

  /* —— 派机主流程 —— */
  function flyDispatch() {
    if (flyRunning) return;
    var btn = document.getElementById('flyDispatchBtn');
    var btnText = document.getElementById('flyDispatchBtnText');
    var depSel = document.getElementById('flyDepSel');
    var arrSel = document.getElementById('flyArrSel');
    if (!depSel || !arrSel) return;
    var dep = depSel.value;
    var arr = arrSel.value;
    if (dep === arr) {
      var ai = arrSel.selectedIndex + 1;
      if (ai >= arrSel.options.length) ai = 0;
      arrSel.selectedIndex = ai;
      arr = arrSel.value;
    }
    var airportsMap = {};
    var list = flyAirportList();
    for (var i = 0; i < list.length; i++) airportsMap[list[i].code] = list[i];
    var choice = flyPickForRoute(dep, arr, airportsMap);
    var wrap = document.getElementById('flyTicketWrap');
    var stage = document.getElementById('flyStage');
    var content = document.getElementById('flyBoardContent');
    flyRunning = true;
    if (btn) btn.disabled = true;
    if (btnText) btnText.textContent = '派机中…';
    if (wrap) wrap.classList.remove('visible');
    if (stage) { stage.classList.add('visible'); stage.style.display = 'block'; }
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function finish() {
      flyRunning = false;
      if (btn) btn.disabled = false;
      if (btnText) btnText.textContent = '派机';
      flyRenderTicket(choice.main, choice.alt, dep, arr, airportsMap, choice.dist);
      if (wrap) wrap.classList.add('visible');
      if (content) {
        try { content.scrollTo({ top: content.scrollHeight, behavior: 'smooth' }); } catch (e) { content.scrollTop = content.scrollHeight; }
      }
      if (btn && !btn.classList.contains('fly-pulsing')) btn.classList.add('fly-pulsing');
      setTimeout(function () { if (btn) btn.classList.remove('fly-pulsing'); }, 900);
    }
    if (reduced) {
      setTimeout(finish, 350);
    } else {
      flyRunReel(flyPool(), choice.main ? flyPool().indexOf(choice.main) : 0, finish);
    }
  }

  /* —— 长图导出 —— */
  function flySaveTicket() {
    var ticket = document.getElementById('flyTicket');
    var btn = document.getElementById('flySaveBtn');
    if (!ticket) return;
    if (typeof html2canvas === 'undefined') {
      alert('长图库尚未加载，请检查网络后重试');
      return;
    }
    var wrap = document.getElementById('flyTicketWrap');
    if (!wrap || !wrap.classList.contains('visible')) {
      alert('先派机出票，再保存长图');
      return;
    }
    var old = btn ? btn.textContent : '';
    if (btn) { btn.textContent = '导出中…'; btn.disabled = true; }
    html2canvas(ticket, { backgroundColor: '#0b1522', scale: 2, useCORS: true }).then(function (canvas) {
      var a = document.createElement('a');
      a.download = '今日执飞-航线执飞卡.png';
      a.href = canvas.toDataURL('image/png');
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      if (btn) { btn.textContent = old; btn.disabled = false; }
    }).catch(function () {
      if (btn) { btn.textContent = old; btn.disabled = false; }
      alert('导出失败，请重试');
    });
  }

  /* —— 面板开关（复用既有滚动锁/玻璃动效契约） —— */
  function openFlyBoard() {
    if (typeof saveScrollState === 'function') saveScrollState();
    var overlay = document.getElementById('flyBoardOverlay');
    if (!overlay) return;
    overlay.classList.add('visible');
    document.body.style.overflow = 'hidden';
    flyFillSelects();
    var sb = document.getElementById('flySoundBtn');
    if (sb) sb.textContent = '音效：' + (flySoundEnabled ? '开' : '关');
    flyClick();
  }
  function closeFlyBoard() {
    flyAnimId++;
    flyRunning = false;
    flyStopWind();
    var overlay = document.getElementById('flyBoardOverlay');
    if (overlay) overlay.classList.remove('visible');
    document.body.style.overflow = '';
    if (typeof restoreScrollState === 'function') restoreScrollState();
  }

  window.openFlyBoard = openFlyBoard;
  window.closeFlyBoard = closeFlyBoard;
  window.flyDispatch = flyDispatch;
  window.toggleFlySound = toggleFlySound;
  window.flySaveTicket = flySaveTicket;
})();

