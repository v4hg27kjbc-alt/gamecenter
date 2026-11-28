
// ===== v56：Quiz 冷知识 / AI 冷知识面板 / 动态天空窗 =====
(function () {
  'use strict';

  // ---------- 真实航空冷知识数据池（中英双语，来源：公开民航工程与运营资料） ----------
  var V56_FACTS = [
    { ic: '\u{1F6EC}', t: { zh: '千度刹车', en: '900\u00b0C Brakes' }, x: { zh: '空客 A380 着陆时碳刹车盘温度可达 900\u00b0C，需充分冷却后起落架舱门才会收起。', en: 'The Airbus A380\u2019s carbon brakes can reach 900\u00b0C on landing; its gear doors only close after they cool down.' } },
    { ic: '\u{1F4FA}', t: { zh: '橙色黑匣子', en: 'Orange Recorder' }, x: { zh: '飞行数据记录仪俗称\u201c黑匣子\u201d，其实是醒目的橙色，便于事故后快速搜寻。', en: 'Flight recorders \u2014 the \u201cblack boxes\u201d \u2014 are painted bright orange for easy recovery after an accident.' } },
    { ic: '\u{1F4CF}', t: { zh: '六层楼高的尾翼', en: 'Tail Like a Tower' }, x: { zh: '波音 747 的垂直尾翼高约 19.4 米，接近六层楼房的高度。', en: 'The Boeing 747\u2019s vertical stabiliser stands about 19.4 metres tall \u2014 nearly six storeys.' } },
    { ic: '\u{1F3BE}', t: { zh: '三个网球场', en: 'Three Tennis Courts' }, x: { zh: 'A380 的机翼面积约 845 平方米，大约相当于三个网球场。', en: 'The A380\u2019s wing area is about 845 m\u00b2 \u2014 roughly three tennis courts.' } },
    { ic: '\u{1FA9F}', t: { zh: '舷窗的小孔', en: 'The Tiny Window Hole' }, x: { zh: '客舱舷窗底部的小孔用于平衡内外气压差，防止窗户结构受压破裂。', en: 'The tiny hole at the base of cabin windows balances air pressure to protect the pane.' } },
    { ic: '\u{1F6DE}', t: { zh: '氮气轮胎', en: 'Nitrogen Tyres' }, x: { zh: '民航客机轮胎充的是氮气而非空气，以降低高温起火风险。', en: 'Aircraft tyres are filled with nitrogen instead of air to reduce fire risk at high temperature.' } },
    { ic: '\u{1F4A8}', t: { zh: '三分钟换气', en: 'Fresh Air in 3 Minutes' }, x: { zh: '客舱空气每 2\u20133 分钟就会经 HEPA 滤网完成一次全量更换。', en: 'Cabin air is completely replaced every 2\u20133 minutes through HEPA filters.' } },
    { ic: '\u{1F32C}', t: { zh: '逆风着陆', en: 'Landing Into Wind' }, x: { zh: '客机大多选择逆风着陆：逆风能带来额外升力，显著缩短滑跑距离。', en: 'Airliners mostly land into the wind: headwind adds lift and shortens the landing roll.' } },
    { ic: '\u{1F426}', t: { zh: '鸟击高发时段', en: 'When Birds Strike' }, x: { zh: '约九成鸟击发生在飞机的起飞与降落阶段，此时高度低、鸟类活动密集。', en: 'About 90% of bird strikes occur during take-off and landing, when aircraft are low and birds are active.' } },
    { ic: '\u{1F4AA}', t: { zh: '推力之王', en: 'The Power King' }, x: { zh: '波音 777 搭载的 GE90-115B 单台最大推力约 12.79 万磅，是现役推力最大的商用涡扇发动机之一。', en: 'The GE90-115B on the Boeing 777 produces up to 127,900 lbf \u2014 one of the most powerful commercial turbofans in service.' } },
    { ic: '\u{1F914}', t: { zh: '十五分钟氧气', en: '15 Minutes of Oxygen' }, x: { zh: '客舱氧气面罩的供氧时间约 15 分钟，足以让机组将飞机下降到可呼吸高度。', en: 'Passenger oxygen masks supply about 15 minutes of oxygen \u2014 enough for pilots to descend to a breathable altitude.' } },
    { ic: '\u{1F7E5}', t: { zh: '红绿跑道灯', en: 'Green and Red Lights' }, x: { zh: '跑道入口灯为绿色、跑道末端的警示灯为红色，帮助飞行员判断进近方向。', en: 'Runway threshold lights are green and runway-end lights are red, guiding the approach direction.' } },
    { ic: '\u{1F9CA}', t: { zh: '碳纤维之躯', en: 'Carbon Body' }, x: { zh: 'A350 的机身约 53% 为碳纤维复合材料，比同级金属机身轻约 20%。', en: 'About 53% of the A350 airframe is carbon-fibre composite \u2014 roughly 20% lighter than a metal airframe of the same class.' } },
    { ic: '\u{1F525}', t: { zh: '热胀三十厘米', en: '30 cm of Stretch' }, x: { zh: '协和号超音速飞行时因气动加热，机身会热胀拉长约 30 厘米。', en: 'Concorde stretched about 30 cm during supersonic flight due to aerodynamic heating.' } },
    { ic: '\u{1F37D}', t: { zh: '分开的机长餐', en: 'Different Meals' }, x: { zh: '许多航司会让正副驾驶吃不同餐食，防止两人因同一份食物同时不适。', en: 'Many airlines serve captains and first officers different meals so food illness cannot hit both at once.' } }
  ];
  window.__V56_FACTS = V56_FACTS;
  var v56Lang = function () { return (typeof currentLang !== 'undefined' && currentLang === 'en') ? 'en' : 'zh'; };
  var v56Txt = function (o) { var l = v56Lang(); return o && o[l] ? o[l] : o.zh; };

  // ---------- Quiz 结果冷知识 ----------
  var v56QuizLast = -1;
  window.v56QuizFactHtml = function () {
    var n = V56_FACTS.length;
    var idx;
    do { idx = Math.floor(Math.random() * n); } while (n > 1 && idx === v56QuizLast);
    v56QuizLast = idx;
    var f = V56_FACTS[idx];
    return '<div class="quiz-result-fact"><span class="qr-icon">' + f.ic + '</span><span><strong>' +
      v56Txt(f.t) + '</strong>' + v56Txt(f.x) + '</span></div>';
  };

  // ---------- AI 冷知识面板 ----------
  window.openColdFacts = function () {
    var ov = document.getElementById('coldfactOverlay');
    if (!ov) return;
    v56RefreshPanel();
    ov.classList.add('visible');
    document.body.style.overflow = 'hidden';
  };
  window.closeColdFacts = function () {
    var ov = document.getElementById('coldfactOverlay');
    if (ov) ov.classList.remove('visible');
    document.body.style.overflow = '';
  };
  window.coldfactBackdrop = function (e) { if (e.target === e.currentTarget) closeColdFacts(); };
  // 每屏展示的冷知识条数；「换一批」从数据池中随机换一组（不与上一组重复）
  var V56_PANEL_SIZE = 6;
  var v56PanelIdx = [];
  function v56ShuffleIdx(a) {
    var r = a.slice();
    for (var i = r.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = r[i]; r[i] = r[j]; r[j] = t; }
    return r;
  }
  function v56ColdfactsSeenAdd(n) {
    try {
      var cur = parseInt(localStorage.getItem('aviation_coldfacts_seen') || '0', 10) || 0;
      localStorage.setItem('aviation_coldfacts_seen', String(cur + n));
    } catch (e) {}
  }
  function v56PickPanel(forceNew) {
    var n = V56_FACTS.length;
    var size = Math.min(V56_PANEL_SIZE, n);
    if (!forceNew && v56PanelIdx.length) return v56PanelIdx;
    var prev = {};
    for (var i = 0; i < v56PanelIdx.length; i++) prev[v56PanelIdx[i]] = 1;
    var rest = [];
    for (var j = 0; j < n; j++) if (!prev[j]) rest.push(j);
    var pick = v56ShuffleIdx(rest).slice(0, size);
    var guard = 0;
    while (pick.length < size && guard < 300) {
      guard++;
      var c = Math.floor(Math.random() * n);
      if (pick.indexOf(c) === -1) pick.push(c);
    }
    v56PanelIdx = v56ShuffleIdx(pick);
    return v56PanelIdx;
  }
  window.v56RefreshPanel = function (forceNew, noCount) {
    var grid = document.getElementById('cfGrid');
    if (!grid) return;
    var wasEmpty = !v56PanelIdx.length;
    var idxs = v56PickPanel(!!forceNew);
    var h = [];
    for (var i = 0; i < idxs.length; i++) {
      var f = V56_FACTS[idxs[i]];
      h.push('<div class="cf-card" data-fi="' + idxs[i] + '"><div class="cf-card-icon">' + f.ic + '</div><div class="cf-card-title">' +
        v56Txt(f.t) + '</div><div class="cf-card-text">' + v56Txt(f.x) + '</div></div>');
    }
    grid.innerHTML = h.join('');
    // 仅在首次生成新一组或点击「换一批」时累计查阅条数，避免切语言重复计数
    if (!noCount && (forceNew || wasEmpty)) {
      v56ColdfactsSeenAdd(idxs.length);
      if (typeof badgeCheckAll === 'function') badgeCheckAll();
    }
  };
  window.v56PanelRing = function () { return v56PanelIdx.slice(); };
  window.v56ShuffleFacts = function () {
    var btn = document.getElementById('coldfactShuffleBtn');
    if (btn) {
      btn.classList.add('spin');
      setTimeout(function () { btn.classList.remove('spin'); }, 460);
    }
    window.v56RefreshPanel(true);
  };
  var cfOv = document.getElementById('coldfactOverlay');
  if (cfOv) cfOv.addEventListener('click', coldfactBackdrop);

  // ---------- 动态天空窗 ----------
  window.v56RefreshSkyLabel = function () {
    var w = document.getElementById('skyWindow');
    if (!w) return;
    var p = w.getAttribute('data-sky') || 'night';
    var map = {
      dawn: { zh: '日出时分 · 天光渐亮', en: 'Dawn Glow' },
      day: { zh: '日间巡航 · 万里晴空', en: 'Daylight' },
      dusk: { zh: '日落黄昏 · 归航时刻', en: 'Golden Dusk' },
      night: { zh: '夜空繁星 · 夜航模式', en: 'Starry Night' }
    };
    var el = document.getElementById('skyLabelText');
    if (el) el.textContent = map[p] ? v56Txt(map[p]) : map.night.zh;
  };
  window.v56RefreshSky = function () {
    var w = document.getElementById('skyWindow');
    if (!w) return;
    var h = new Date().getHours();
    var p;
    if (h >= 6 && h < 10) p = 'dawn';
    else if (h >= 10 && h < 17) p = 'day';
    else if (h >= 17 && h < 20) p = 'dusk';
    else p = 'night';
    if (w.getAttribute('data-sky') !== p) w.setAttribute('data-sky', p);
    v56RefreshSkyLabel();
  };
  window.v56RefreshSky();
  setInterval(v56RefreshSky, 30000);
})();
