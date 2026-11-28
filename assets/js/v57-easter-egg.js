
// ===== v57: 长按天空彩蛋 + 冷知识卡片详情 =====
(function () {
  'use strict';

  // ---------- 每条冷知识的真实延伸（中英双语，来源：公开民航工程与运营资料） ----------
  var V57_EXT = [
    { tag: { zh: 'A380 · 起落架与刹车', en: 'A380 Landing Gear and Brakes' }, d: { zh: 'A380 的主起落架共有 20 个机轮，配备碳复合刹车盘。着陆滑跑阶段刹车与发动机反推协同减速；若刹车盘过热，驾驶舱会收到提示，机务须待其充分冷却并复查后方可放行。相比钢刹车，整套碳刹车更轻，也有利于降低空机重量。', en: 'The A380 has 20 main-gear wheels with carbon brakes. During the landing roll, wheel brakes and thrust reversers work together to slow the aircraft; overheated brake discs trigger cockpit warnings, and ground crews must wait for them to cool before dispatch. Carbon brakes are also much lighter than steel units, which helps cut empty weight.' } },
    { tag: { zh: '飞行记录系统 · 搜寻', en: 'Flight Recorders and Recovery' }, d: { zh: '黑匣子通常成对安装：驾驶舱话音记录器（CVR）负责保存舱内语音，飞行数据记录器（FDR）持续记录高度、速度、舵面和发动机等数百项参数。新一代适航标准已要求话音记录至少保存 25 小时。记录器上还装有水下定位信标，便于失事后被搜索打捞。', en: 'Recorders normally come in a pair: the cockpit voice recorder (CVR) and the flight data recorder (FDR). The FDR continuously logs hundreds of parameters such as altitude, speed, control surfaces and engine readings; new airworthiness standards now require at least 25 hours of cockpit voice. An underwater locator beacon (ULB) helps search teams find the recorders after an accident.' } },
    { tag: { zh: '波音 747 · 垂尾结构', en: 'Boeing 747 Vertical Fin' }, d: { zh: '波音 747-400 的垂尾高约 19.4 米，约占整机长度 70.7 米的四分之一。高大的垂尾为这类巨型客机提供充足的方向稳定性，即使起飞时一侧发动机失效，也能帮助飞机保持直线飞行。', en: 'The Boeing 747-400 vertical fin is about 19.4 metres high, roughly one quarter of the 70.7-metre fuselage length. The tall fin gives the big airliner strong directional stability, helping it track straight even if one engine fails on take-off.' } },
    { tag: { zh: 'A380 · 机翼与机场等级', en: 'A380 Wing and Airport Class' }, d: { zh: 'A380 的翼展达 79.75 米，因此只能在 4F 级大型机场起降。巨大的机翼内部还承担了大部分燃油的储存。空客曾表示，按每位乘客计算，A380 的油耗低于多数老一代宽体客机。', en: 'With a wingspan of 79.75 metres, the A380 can only operate at 4F-class large airports. The huge wing also acts as the main fuel tank, holding most of the aircraft fuel inside its structure. Airbus points out that per passenger, the A380 burns less fuel than many older wide-body jets.' } },
    { tag: { zh: '舷窗结构 · 气压管理', en: 'Cabin Window Pressure' }, d: { zh: '客机舷窗分外层结构窗与内层保护窗两层。底部的小孔让夹层气压与客舱平衡，真正承受座舱压差的是外层窗；这一设计也降低了内层的受力与应力风险。即使外层出现裂纹，内层仍能提供一道临时保护。', en: 'Aircraft windows have an outer structural pane and an inner protective pane. The tiny bleed hole lets pressure between the panes equalise with the cabin, so the outer pane carries the real pressure load; it also reduces stress on the inner pane and gives the cabin crew a layer of protection if the outer pane cracks.' } },
    { tag: { zh: '机轮 · 轮胎与氮气', en: 'Tyres and Nitrogen' }, d: { zh: '飞机轮胎需承受每秒数十米的触地速度和整机重量，常见胎压约 200 psi（约 13.8 巴）。氮气受热膨胀更小、不易助燃，可在高温刹车和高速滑跑中保持胎压更稳定，也降低起火隐患。', en: 'Airliner tyres touch down at high speed and support huge loads, often at around 200 psi. Nitrogen expands less with heat and does not feed combustion, keeping tyre pressure more stable during hot braking and fast rolling while lowering the risk of fire.' } },
    { tag: { zh: '客舱空气 · HEPA', en: 'Cabin Air and HEPA' }, d: { zh: '客舱中的再循环空气经 HEPA 高效滤芯过滤，通常可拦下 99.97% 的 0.3 微米级颗粒；同时发动机引气不断补充新鲜空气，混合后全舱空气约每 2-3 分钟更新一次。滤芯按维护计划定期更换。', en: 'Cabin recirculated air passes through HEPA filters that capture 99.97% of particles at 0.3 micron; engine bleed air continuously adds fresh air, and the mixed air renews the whole cabin about every 2-3 minutes. Filters are replaced on a fixed maintenance schedule.' } },
    { tag: { zh: '着陆性能 · 风的影响', en: 'Landing Performance and Wind' }, d: { zh: '起飞与着陆性能计算都会考虑风分量：逆风让相同空速下的地速更低，从而缩短着陆滑跑距离、减轻轮胎与刹车负担。侧风过强时，机组须按机型侧风限制决定是否等待或备降；顺风着陆则需要更长的跑道裕度。', en: 'Take-off and landing performance calculations include wind: with a headwind, ground speed is lower at the same airspeed, which shortens the landing roll and eases brakes and tyres. Strong crosswinds are limited by aircraft type, while a tailwind landing needs much more runway margin.' } },
    { tag: { zh: '鸟击 · 机场与发动机', en: 'Bird Strikes and Engines' }, d: { zh: '绝大多数鸟击发生在机场附近低空，即起飞爬升、进近与着陆阶段。机场普遍采用声波驱鸟、猎鹰驱赶、生态治理等综合手段。发动机取证前还要通过“吞鸟”试验，吸入鸟后仍能保持安全状态。', en: 'Most bird strikes happen near airports at low altitude, during climb-out, approach and landing. Airports use sound deterrents, falconry and habitat management to reduce risk. Jet engines must also pass bird-ingestion tests before certification, so they stay controllable after striking birds.' } },
    { tag: { zh: 'GE90-115B · 777', en: 'GE90-115B on the 777' }, d: { zh: 'GE90-115B 是波音 777-300ER 的配套发动机，风扇直径约 3.25 米，比不少客机机身还粗。它属于 11.5 万磅级推力，2002 年试车曾短暂达到 12.79 万磅，是民航史上推力最强的发动机之一。', en: 'The GE90-115B powers the Boeing 777-300ER and has a fan about 3.25 metres across, wider than many fuselages. Its thrust class reaches 115,000 lbf, and a 2002 test recorded 127,900 lbf, making it one of the most powerful commercial engines ever certified.' } },
    { tag: { zh: '应急供氧 · 紧急下降', en: 'Oxygen and Emergency Descent' }, d: { zh: '面罩弹出后，化学产氧器或中央储氧系统会供氧约 15 分钟，这段时间足够机组执行紧急下降，把飞机从巡航高度降到约 1 万英尺以下的可呼吸高度。这正是先戴好自己的面罩再帮助他人的原因。', en: 'When the masks drop, chemical oxygen generators or central oxygen systems feed about 15 minutes of oxygen. That is enough for pilots to perform an emergency descent to below roughly 10,000 feet, where air is breathable. This is why you should put on your own mask first before helping others.' } },
    { tag: { zh: '跑道灯光 · PAPI', en: 'Runway Lights and PAPI' }, d: { zh: '进近方向的跑道入口灯为绿色，起飞方向的跑道末端灯为红色，用来标定着陆区的起止。进近末段还可参考 PAPI 灯：红灯多代表下滑道偏低，白灯多代表偏高。', en: 'Threshold lights are green when seen from the approach side, while runway-end lights show red from the take-off direction, marking where the landing area ends. During final approach, PAPI lights use white and red bars to tell pilots whether their glide path is high or low.' } },
    { tag: { zh: 'A350 · 复合材料', en: 'A350 Composite Airframe' }, d: { zh: 'A350 的机身筒段采用自动铺丝工艺整体成型，接头更少、表面更平滑。复合材料机翼与机身降低了结构重量，也让客舱气压与湿度可以更高，乘坐更舒适，同时减少机体疲劳检查的工作量。', en: 'The A350 fuselage barrels are laid up by automated fibre placement, which means fewer joints and smoother surfaces. The composite airframe lowers weight and permits higher cabin pressure and humidity, improving passenger comfort and reducing fatigue-inspection work over the aircraft life.' } },
    { tag: { zh: '协和号 · 超音速热胀', en: 'Concorde Thermal Expansion' }, d: { zh: '协和号以约 2 马赫巡航时，机身表面温度超过 100°C，整机热胀约 30 厘米，结构设计为此预留了伸缩余量。它是历史上唯一投入商用的超音速客机，2003 年退役后民航至今尚未再有超音速客机投入运营。', en: 'Concorde cruised at about Mach 2, heating the skin to well over 100 degrees Celsius and stretching the fuselage by about 30 cm, which the design had to accommodate. It remained the only supersonic airliner in commercial service until retirement in 2003.' } },
    { tag: { zh: '机组餐食 · 运行风险', en: 'Crew Meal Policy' }, d: { zh: '不少航司会让机长与副驾驶错峰用餐，或提供不同餐食，避免同一份被污染的食物同时影响两名飞行员。这种“机组餐食隔离”是航空公司普遍采取的风险管理习惯，并非所有国家都强制规定。', en: 'Many airlines stagger the crews meals or serve different menus to the captain and first officer, so that a single contaminated dish cannot incapacitate both pilots at once. The practice is a common risk-management habit in airline operations, not a legal requirement everywhere.' } }
  ];
  window.__V57_EXT = V57_EXT;

  function v57Lang() { return (typeof currentLang !== 'undefined' && currentLang === 'en') ? 'en' : 'zh'; }

  // ---------- 功能2：点击冷知识卡片 → 详情视图 ----------
  window.v57OpenFactDetail = function (idx) {
    var ov = document.getElementById('cfDetailOverlay');
    var facts = window.__V56_FACTS;
    if (!ov || !facts || !facts[idx] || !V57_EXT[idx]) return;
    var f = facts[idx], e = V57_EXT[idx], l = v57Lang();
    var byId = function (id) { return document.getElementById(id); };
    window.__v57DetailIdx = idx;
    var posEl = byId('cfDetailPos');
    if (posEl) posEl.textContent = (idx + 1) + ' / ' + facts.length;
    byId('cfDetailIcon').textContent = f.ic;
    byId('cfDetailTitleText').textContent = f.t[l];
    byId('cfDetailSubText').textContent = e.tag[l];
    byId('cfDetailQuoteLabel').textContent = l === 'en' ? 'Card Snapshot' : '原卡片速览';
    byId('cfDetailExtLabel').textContent = l === 'en' ? 'Go Deeper' : '延伸阅读';
    byId('cfDetailQuote').textContent = f.x[l];
    byId('cfDetailExt').textContent = e.d[l];
    byId('cfDetailMeta').textContent = l === 'en'
      ? 'Press ESC or tap the background to close'
      : '按 ESC 或点击背景空白处可关闭';
    ov.classList.add('visible');
    ov.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  };
  window.v57StepFact = function (delta) {
    var facts = window.__V56_FACTS || [];
    if (!facts.length) return;
    var cur = (typeof window.__v57DetailIdx === 'number') ? window.__v57DetailIdx : 0;
    var ring = (typeof window.v56PanelRing === 'function') ? window.v56PanelRing() : [];
    var next;
    if (ring && ring.length) {
      var pos = ring.indexOf(cur);
      if (pos === -1) pos = 0;
      next = ring[(pos + delta + ring.length) % ring.length];
    } else {
      next = (cur + delta + facts.length) % facts.length;
    }
    v57OpenFactDetail(next);
    var panel = document.querySelector('.cf-detail-panel');
    if (panel) panel.scrollTop = 0;
  };
  window.v57CloseFactDetail = function () {
    var ov = document.getElementById('cfDetailOverlay');
    if (!ov) return;
    ov.classList.remove('visible');
    ov.setAttribute('aria-hidden', 'true');
    var co = document.getElementById('coldfactOverlay');
    document.body.style.overflow = (co && co.classList.contains('visible')) ? 'hidden' : '';
  };
  var detailOv = document.getElementById('cfDetailOverlay');
  if (detailOv) {
    detailOv.addEventListener('click', function (e) {
      if (e.target === e.currentTarget) v57CloseFactDetail();
    });
    var closeBtn = document.getElementById('cfDetailCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', v57CloseFactDetail);
    var prevBtn = document.getElementById('cfDetailPrevBtn');
    var nextBtn = document.getElementById('cfDetailNextBtn');
    if (prevBtn) prevBtn.addEventListener('click', function (ev) { ev.stopPropagation(); v57StepFact(-1); });
    if (nextBtn) nextBtn.addEventListener('click', function (ev) { ev.stopPropagation(); v57StepFact(1); });
    document.addEventListener('keydown', function (ev) {
      var ov2 = document.getElementById('cfDetailOverlay');
      if (!ov2 || !ov2.classList.contains('visible')) return;
      if (ev.key === 'ArrowLeft') v57StepFact(-1);
      else if (ev.key === 'ArrowRight') v57StepFact(1);
    });
  }
  var grid = document.getElementById('cfGrid');
  if (grid) {
    grid.addEventListener('click', function (e) {
      var card = e.target && e.target.closest ? e.target.closest('.cf-card') : null;
      if (!card) return;
      var fi = card.getAttribute('data-fi');
      var idx = (fi !== null && fi !== '') ? parseInt(fi, 10) : Array.prototype.indexOf.call(grid.children, card);
      if (idx >= 0) v57OpenFactDetail(idx);
    });
  }

  // ---------- 功能1：长按天空窗约 0.85s 触发趣味彩蛋 ----------
  var sky = document.getElementById('skyWindow');
  if (sky) {
    var holdTimer = null, startX = 0, startY = 0;
    var curLayer = null, clearTimer = null;

    function clearFx() {
      if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
      if (curLayer) { var p = curLayer.parentNode; if (p) p.removeChild(curLayer); }
      curLayer = null;
    }
    function spawn() {
      clearFx();
      var period = sky.getAttribute('data-sky') || 'night';
      var sources = [];
      var sels = ['.plane-a380 svg', '.plane-b787 svg', '.plane-b737 svg'];
      for (var k = 0; k < sels.length; k++) { var n = sky.querySelector(sels[k]); if (n) sources.push(n); }
      if (!sources.length) return;
      var fx = document.createElement('div');
      fx.className = 'v57-fx';
      sky.appendChild(fx);
      curLayer = fx;
      var color = period === 'day' ? '#3c4662' : (period === 'dawn' ? '#c9d6ec' : '#ffffff');
      var planes = 2 + Math.floor(Math.random() * 2); // 2~3 架
      var probMap = { night: 0.85, dusk: 0.42, dawn: 0.12, day: 0.06 };
      var prob = probMap[period];
      if (prob === undefined) prob = 0.12;
      var meteors = (Math.random() < prob) ? (Math.random() < 0.35 ? 2 : 1) : 0; // 最多 2 颗
      var i, w, m;
      for (i = 0; i < planes; i++) {
        var src = sources[Math.floor(Math.random() * sources.length)];
        w = document.createElement('div');
        w.className = 'v57-fx-plane';
        w.style.top = (6 + Math.random() * 40) + '%';
        w.style.setProperty('--fs', (0.45 + Math.random() * 0.65).toFixed(2));
        w.style.color = color;
        w.style.animationDuration = (2.6 + Math.random() * 1.3) + 's';
        w.style.animationDelay = (Math.random() * 0.5) + 's';
        if (period === 'day') w.style.filter = 'none';
        w.appendChild(src.cloneNode(true));
        fx.appendChild(w);
      }
      for (i = 0; i < meteors; i++) {
        m = document.createElement('div');
        m.className = 'v57-fx-meteor';
        m.style.top = (2 + Math.random() * 34) + '%';
        m.style.animationDuration = (0.7 + Math.random() * 0.8) + 's';
        m.style.animationDelay = (0.1 + Math.random() * 0.8) + 's';
        fx.appendChild(m);
      }
      fx.addEventListener('animationend', function (ev) {
        var t = ev.target;
        if (t && t !== fx && t.parentNode) t.parentNode.removeChild(t);
      });
      clearTimer = setTimeout(clearFx, 9500);
    }
    function cancelHold() { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } }
    sky.addEventListener('pointerdown', function (e) {
      cancelHold();
      startX = e.clientX; startY = e.clientY;
      holdTimer = setTimeout(spawn, 850); // 0.8~1s 档位：0.85s
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
      sky.addEventListener(ev, cancelHold);
    });
    sky.addEventListener('pointermove', function (e) {
      if (!holdTimer) return;
      if (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10) cancelHold();
    });
    window.v57TriggerEasterEgg = spawn;
  }
})();
