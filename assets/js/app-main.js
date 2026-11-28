
// ===== 滚动进度条 =====
(function() {
  var bar = document.getElementById('scrollProgress');
  function updateProgress() {
    var scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    var docH = document.documentElement.scrollHeight - document.documentElement.clientHeight;
    var pct = docH > 0 ? Math.min(100, (scrollTop / docH) * 100) : 0;
    bar.style.width = pct + '%';
  }
  window.addEventListener('scroll', updateProgress, { passive: true });
  updateProgress();
})();

// ===== 导出收藏 =====
function getCollectionData() {
  var collected = [];
  aircrafts.forEach(function(a) {
    if (collection.has(a.id)) {
      collected.push({
        name: a.name,
        code: a.code,
        category: a.category,
        country: a.country,
        specs: p3NormSpecs(a.specs),
        desc: a.desc,
        image: a.image,
        id: a.id
      });
    }
  });
  return collected;
}



function exportCollectionImage() {
  var data = getCollectionData();
  if (data.length === 0) { alert(t('noCollectionData')); return; }

  var btn = document.getElementById('exportCollectionBtn');
  var originalHTML = btn.innerHTML;
  btn.innerHTML = '导出中...';
  btn.disabled = true;

  var dpr = Math.min(window.devicePixelRatio || 1, 3);
  var COLS = 2;
  var CARD_W = 560;
  var CARD_PADDING = 28;
  var CARD_GAP = 20;
  var PAGE_PADDING = 40;

  // Card height is dynamic: image area + text area
  var IMG_H = 260;
  var TEXT_H = 120;
  var CARD_H = IMG_H + TEXT_H;

  var cols = Math.min(COLS, data.length);
  var rows = Math.ceil(data.length / cols);
  var totalW = cols * CARD_W + (cols - 1) * CARD_GAP + PAGE_PADDING * 2;
  var totalBodyH = rows * (CARD_H + CARD_GAP) - CARD_GAP;

  var headerH = 100;
  var footerH = 50;
  var canvasW = totalW;
  var canvasH = headerH + totalBodyH + footerH + PAGE_PADDING * 2;

  var canvas = document.createElement('canvas');
  canvas.width = canvasW * dpr;
  canvas.height = canvasH * dpr;
  var ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // White background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasW, canvasH);

  // --- Header ---
  ctx.fillStyle = '#0d2137';
  ctx.fillRect(0, 0, canvasW, headerH);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 26px -apple-system, "PingFang SC", sans-serif';
  ctx.fillText('我的收藏 \u00b7 民航客机收藏馆', PAGE_PADDING, 42);
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '13px -apple-system, "PingFang SC", sans-serif';
  var todayStr = new Date().toISOString().slice(0, 10);
  ctx.fillText('共 ' + data.length + ' 架 | ' + todayStr, PAGE_PADDING, 68);

  // --- Card grid ---
  var catLabels = { civil: '民航客机', fighter: '战斗机', bomber: '轰炸机', transport: '运输机', helicopter: '直升机' };
  var specLabelMap = { cruise_speed: '巡航速度', max_speed: '最大速度', max_range: '最大航程', range: '航程', combat_radius: '作战半径', capacity: '载客量', load: '载重', wingspan: '翼展', ceiling: '升限', rotor_diameter: '旋翼直径', engine: '发动机', seats: '座位数', mtow: '最大起飞重量', length: '机身长度', height: '机身高度' };

  var loadedCount = 0;
  var totalImages = data.length;
  var downloadFired = false;
  var allImagesDone = false;

  function tryDownload() {
    if (downloadFired) return;
    if (loadedCount < totalImages) return;
    allImagesDone = true;
    downloadFired = true;

    var btn = document.getElementById('exportCollectionBtn');
    if (btn) {
      btn.innerHTML = originalHTML;
      btn.disabled = false;
    }

    // Border
    ctx.strokeStyle = '#0d2137';
    ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, canvasW, canvasH);

    // Footer
    ctx.fillStyle = '#90a4ae';
    ctx.font = '10px -apple-system, "PingFang SC", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('Generated: ' + todayStr, canvasW - PAGE_PADDING, canvasH - 14);
    ctx.textAlign = 'left';

    try {
      canvas.toBlob(function(blob) {
        var url = URL.createObjectURL(blob);
        var el = document.createElement('a');
        el.href = url;
        el.download = 'aviation-collection-' + todayStr + '.png';
        el.style.display = 'none';
        document.body.appendChild(el);
        el.click();
        setTimeout(function() {
          document.body.removeChild(el);
          URL.revokeObjectURL(url);
        }, 100);
      }, 'image/png');
    } catch(e) {
      alert('导出图片失败');
    }
  }

  // 8s safety timeout
  setTimeout(function() {
    if (!allImagesDone) { loadedCount = totalImages; tryDownload(); }
  }, 8000);

  data.forEach(function(item, i) {
    var row = Math.floor(i / cols);
    var col = i % cols;
    var cx = PAGE_PADDING + col * (CARD_W + CARD_GAP);
    var cy = headerH + PAGE_PADDING + row * (CARD_H + CARD_GAP);

    // Card background
    ctx.fillStyle = '#f8f9fa';
    roundRect(ctx, cx, cy, CARD_W, CARD_H, 12);
    ctx.fill();

    // Card border
    ctx.strokeStyle = '#e0e0e0';
    ctx.lineWidth = 1;
    roundRect(ctx, cx, cy, CARD_W, CARD_H, 12);
    ctx.stroke();

    // --- Image area ---
    var imgAreaH = IMG_H;
    // Placeholder gradient
    var grad = ctx.createLinearGradient(cx, cy, cx + CARD_W, cy + imgAreaH);
    var catColors = {
      civil: ['#1a3a5c', '#0d2137'],
      fighter: ['#3a1a1a', '#1a0d0d'],
      bomber: ['#2a2a3a', '#151525'],
      transport: ['#1a3a2a', '#0d1a15'],
      helicopter: ['#3a2a1a', '#1a150d']
    };
    var cc = catColors[item.category] || ['#1a2a3a', '#0d1520'];
    grad.addColorStop(0, cc[0]);
    grad.addColorStop(1, cc[1]);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(cx + 12, cy);
    ctx.lineTo(cx + CARD_W - 12, cy);
    ctx.quadraticCurveTo(cx + CARD_W, cy, cx + CARD_W, cy + 12);
    ctx.lineTo(cx + CARD_W, cy + imgAreaH);
    ctx.lineTo(cx, cy + imgAreaH);
    ctx.lineTo(cx, cy + 12);
    ctx.quadraticCurveTo(cx, cy, cx + 12, cy);
    ctx.fill();

    // Category label on image placeholder
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font = 'bold 14px -apple-system, "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(catLabels[item.category] || item.category, cx + CARD_W / 2, cy + imgAreaH / 2 + 6);
    ctx.textAlign = 'left';

    // --- Load real image ---
    var imgUrl = proxyUrl(item.image);
    if (imgUrl && imgUrl.indexOf('http') === 0 && /\.(jpg|jpeg|png|webp|gif|svg)/i.test(imgUrl)) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function() {
        // Draw image over the placeholder area
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(cx + 12, cy);
        ctx.lineTo(cx + CARD_W - 12, cy);
        ctx.quadraticCurveTo(cx + CARD_W, cy, cx + CARD_W, cy + 12);
        ctx.lineTo(cx + CARD_W, cy + imgAreaH);
        ctx.lineTo(cx, cy + imgAreaH);
        ctx.lineTo(cx, cy + 12);
        ctx.quadraticCurveTo(cx, cy, cx + 12, cy);
        ctx.closePath();
        ctx.clip();
        // Scale to cover
        var s = Math.max(CARD_W / img.width, imgAreaH / img.height);
        var dw = img.width * s;
        var dh = img.height * s;
        var dx = cx + (CARD_W - dw) / 2;
        var dy = cy + (imgAreaH - dh) / 2;
        ctx.drawImage(img, dx, dy, dw, dh);
        ctx.restore();
        loadedCount++;
        tryDownload();
      };
      img.onerror = function() {
        loadedCount++;
        tryDownload();
      };
      img.src = imgUrl;
    } else {
      loadedCount++;
    }

    // --- Text area ---
    var ty = cy + imgAreaH + 16;

    // Name
    ctx.fillStyle = '#1a1a2e';
    ctx.font = 'bold 16px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText(t(item.name) || item.code, cx + CARD_PADDING, ty);

    // Code + country
    ctx.fillStyle = '#607d8b';
    ctx.font = '12px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText(item.code + ' \u00b7 ' + (item.country || ''), cx + CARD_PADDING, ty + 22);

    // Description (truncated)
    ctx.fillStyle = '#78909c';
    ctx.font = '11px -apple-system, "PingFang SC", sans-serif';
    var descText = (t(item.desc) || '').replace(/<[^>]+>/g, '').substring(0, 50);
    if (descText.length >= 50) descText += '\u2026';
    ctx.fillText(descText, cx + CARD_PADDING, ty + 42);

    // Specs line
    if (item.specs) {
      ctx.fillStyle = '#90a4ae';
      ctx.font = '11px -apple-system, "PingFang SC", sans-serif';
      var _spItem = p3NormSpecs(item.specs);
      var keys = Object.keys(_spItem);
      var specsParts = [];
      keys.slice(0, 3).forEach(function(k) {
        specsParts.push((specLabelMap[k] || k) + ': ' + _spItem[k]);
      });
      ctx.fillText(specsParts.join('  |  '), cx + CARD_PADDING, ty + 62);
    }
  });

  // If all images were skipped (invalid URLs), trigger download immediately
  if (loadedCount >= totalImages) tryDownload();
}

// Round rectangle helper
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
function getManufacturerIcon(code) {
  var mfr = (code || '').split(' ')[0].toLowerCase();
  var color, text;
  if (mfr === 'airbus') { color = '#0288d1'; text = 'A'; }
  else if (mfr === 'boeing') { color = '#0d47a1'; text = 'B'; }
  else if (mfr === 'comac') { color = '#c62828'; text = 'C'; }
  else if (mfr === 'embraer') { color = '#2e7d32'; text = 'E'; }
  else if (mfr === 'lockheed') { color = '#607d8b'; text = 'LM'; }
  else if (mfr === 'northrop') { color = '#546e7a'; text = 'NG'; }
  else if (mfr === '成都飞机工业集团') { color = '#c62828'; text = '成'; }
  else if (mfr === '西安飞机工业集团') { color = '#1565c0'; text = '西'; }
  else { color = '#78909c'; text = (code || '?').charAt(0).toUpperCase(); }
  return '<svg width="32" height="32" viewBox="0 0 32 32" style="flex-shrink:0"><rect width="32" height="32" rx="6" fill="' + color + '"/><text x="16" y="22" text-anchor="middle" fill="white" font-size="' + (text.length > 1 ? '11' : '14') + '" font-weight="bold" font-family="sans-serif">' + text + '</text></svg>';
}

// ===== 导出单架飞机图片 =====
function exportSingleAircraft(id) {
  var a = aircrafts.find(function(x) { return x.id === id; });
  if (!a) return;

  var dpr = Math.min(window.devicePixelRatio || 1, 3);
  var W = 600;
  var padding = 40;
  var headerH = 120;
  var bodyH = 200;
  var canvasH = headerH + bodyH + padding;

  var canvas = document.createElement('canvas');
  canvas.width = W * dpr;
  canvas.height = canvasH * dpr;
  var ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // White bg
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, canvasH);

  // Header
  ctx.fillStyle = '#0d2137';
  ctx.fillRect(0, 0, W, headerH);

  // Name
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 24px -apple-system, "PingFang SC", sans-serif';
  ctx.fillText(t(a.name) || a.code, padding, headerH/2 - 10);

  // Code + country
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '13px -apple-system, "PingFang SC", sans-serif';
  ctx.fillText(a.code + ' · ' + a.country, padding, headerH/2 + 17);

  // Specs
  var specsY = headerH + 30;
  ctx.fillStyle = '#1a1a2e';
  ctx.font = 'bold 15px -apple-system, "PingFang SC", sans-serif';
  ctx.fillText('规格参数', padding, specsY);

  var specEntries = p3SpecEntries(a);
  var specLabels = { cruise_speed: '巡航速度', max_speed: '最大速度', max_range: '最大航程', range: '航程', combat_radius: '作战半径', capacity: '载客量', load: '载重', wingspan: '翼展', ceiling: '升限', rotor_diameter: '旋翼直径' };
  var sx = padding, sy = specsY + 30;
  ctx.fillStyle = '#333';
  ctx.font = '13px -apple-system, "PingFang SC", sans-serif';
  specEntries.forEach(function(entry, i) {
    var col = i % 2;
    var row = Math.floor(i / 2);
    var x = sx + col * 260;
    var y = sy + row * 26;
    ctx.fillStyle = '#607d8b';
    ctx.fillText((specLabels[entry[0]] || entry[0]) + ': ', x, y);
    ctx.fillStyle = '#1a1a2e';
    ctx.fillText(entry[1], x + 90, y);
  });

  // Border
  ctx.strokeStyle = '#0d2137';
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, W, canvasH);

  // Footer
  ctx.fillStyle = '#90a4ae';
  ctx.font = '10px -apple-system, "PingFang SC", sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('Generated: ' + new Date().toISOString().slice(0,10), W - padding, canvasH - 12);
  ctx.textAlign = 'left';

  try {
    canvas.toBlob(function(blob) {
      var url = URL.createObjectURL(blob);
      var el = document.createElement('a');
      el.href = url;
      el.download = (t(a.name) || a.code).replace(/[\/\\:]/g, '-') + '.png';
      el.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  } catch(e) {
    alert('导出图片失败');
  }
}


// ===== AI 知识图谱 =====

// 知识图谱下钻机型详情时的返回上下文（存在 = 关闭详情应回到图谱原位，而非跳回首页）
var _kgReturn = null;

function openKgPanel() {
  saveScrollState();
  var overlay = document.getElementById('kgOverlay');
  overlay.classList.add('active');
  buildKgCardGrid();
}

function closeKgPanel(opts) {
  document.getElementById('kgOverlay').classList.remove('active');
  // 下钻机型详情：仅收起图谱面板，保留图谱状态，且不重渲染首页网格/不复位页面滚动
  if (opts && opts.drill) return;
  if (typeof renderCards === 'function') renderCards();
  restoreScrollState();
}

function buildKgCardGrid() {
  var grid = document.getElementById('kgCardGrid');
  if (!grid) return;
  grid.innerHTML = '';

  // Group civil Boeing/Airbus aircraft by family
  var families = {};
  aircrafts.forEach(function(a) {
    if (a.category !== 'civil') return;
    var code = (a.code || '').toLowerCase();
    var famKey = '';
    var famLabel = '';
    var isBoeing = code.includes('boeing') || code.startsWith('b7');
    var isAirbus = code.includes('airbus') || code.startsWith('a3') || code.startsWith('a2');
    if (isBoeing) {
      var m = code.match(/boeing\s*(\d+)/i) || code.match(/b(\d+)/i);
      if (m) { famKey = 'boeing-' + m[1]; famLabel = '\u6ce2\u97f3 ' + m[1]; }
    } else if (isAirbus) {
      var am = code.match(/a(\d+)/i);
      if (am) { famKey = 'airbus-a' + am[1].substring(0,3); famLabel = '\u7a7a\u5ba2 A' + am[1].substring(0,3); }
    }
    if (!famKey) return;
    if (!families[famKey]) families[famKey] = { label: famLabel, isBoeing: isBoeing, list: [] };
    families[famKey].list.push(a);
  });

  // Sort families: Boeing first, then Airbus; within each by model number
  var famKeys = Object.keys(families).sort(function(a, b) {
    var aIsB = families[a].isBoeing, bIsB = families[b].isBoeing;
    if (aIsB && !bIsB) return -1;
    if (!aIsB && bIsB) return 1;
    return a.localeCompare(b);
  });

  famKeys.forEach(function(fk) {
    var group = families[fk];
    group.list.sort(function(a, b) {
      return (parseInt(prodYearLookup[a.id] || '9999')) - (parseInt(prodYearLookup[b.id] || '9999'));
    });

    var groupEl = document.createElement('div');
    groupEl.className = 'kg-family-group';

    var titleEl = document.createElement('div');
    titleEl.className = 'kg-family-title';
    titleEl.textContent = group.label;
    groupEl.appendChild(titleEl);

    var cardGrid = document.createElement('div');
    cardGrid.className = 'kg-card-grid';

    group.list.forEach(function(a) {
      var card = document.createElement('div');
      card.className = 'kg-card';
      card.onclick = function() {
        var _wrap = document.querySelector('#kgOverlay .kg-scroll-wrap');
        _kgReturn = { scrollTop: _wrap ? _wrap.scrollTop : 0 };
        closeKgPanel({ drill: true });
        openDetail(a.id);
      };

      var img = document.createElement('img');
      img.className = 'kg-card-img';
      img.src = proxyUrl(a.image);
      img.alt = a.code;
      img.loading = 'lazy';
      img.onerror = function() {
        this.src = 'data:image/svg+xml,' + encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 130">' +
          '<rect fill="#1a1f3a" width="200" height="130"/>' +
          '<text fill="#555" x="100" y="70" text-anchor="middle" font-size="14">' + (a.code || '?') + '</text></svg>'
        );
      };
      card.appendChild(img);

      var body = document.createElement('div');
      body.className = 'kg-card-body';
      body.innerHTML = '<div class="kg-card-code">' + a.code + '</div><div class="kg-card-year">' + (prodYearLookup[a.id] || '--') + '</div>';
      card.appendChild(body);

      cardGrid.appendChild(card);
    });

    groupEl.appendChild(cardGrid);
    grid.appendChild(groupEl);
  });

  if (famKeys.length === 0) {
    grid.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:40px 0;">暂无知谱数据</div>';
  }
}

// ===== 航空快讯全屏面板 =====
let newsPanelItems = [];

async function openNewsPanel() {
  saveScrollState();
  document.getElementById('newsPanelOverlay').classList.add('visible');
  document.body.style.overflow = 'hidden';
  if (newsPanelItems.length === 0) { await loadNewsPanel(); }
  var nc = document.getElementById('newsPanelContent');
  if (nc) nc.scrollTop = 0;
  if (window._newsRefreshInterval) clearInterval(window._newsRefreshInterval);
  window._newsRefreshInterval = setInterval(async function() {
    try {
      var results = await Promise.allSettled(NEWS_FEEDS.map(function(url) {
        return fetch(url, { signal: AbortSignal.timeout(12000) }).then(function(r) { return r.json(); });
      }));
      var allItems = [];
      results.forEach(function(r) {
        if (r.status === 'fulfilled' && r.value && r.value.items) {
          allItems = allItems.concat(r.value.items.map(function(item) {
            var rawText = (item.content || item.contentSnippet || '').replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ').trim();
            return { title: item.title || '', link: item.link || '', pubDate: item.pubDate || '', snippet: rawText.substring(0, 350) };
          }));
        }
      });
      if (allItems.length > 0) {
        allItems.sort(function(a, b) { return new Date(b.pubDate) - new Date(a.pubDate); });
        newsPanelItems = allItems.slice(0, 15);
      }
    } catch(e) {}
  }, 180000);
}

function closeNewsPanel() {
  document.getElementById('newsPanelOverlay').classList.remove('visible');
  document.body.style.overflow = '';
  if (window._newsRefreshInterval) { clearInterval(window._newsRefreshInterval); window._newsRefreshInterval = null; }
  if (typeof renderCards === 'function') renderCards();
  restoreScrollState();
}

/* ===== 机型Quiz ===== */
var QUIZ_YEARS = {
  'Airbus A380': 2005, 'Boeing 787-9': 2013, 'Airbus A350-900': 2013, 'Boeing 777-300ER': 2003,
  'COMAC C919': 2017, 'Airbus A320neo': 2014, 'Boeing 737 MAX 8': 2016, 'Airbus A330-300': 1992,
  'Embraer E195-E2': 2017, 'Airbus A220-300': 2015, 'F-22 Raptor': 1997, 'J-20': 2011,
  'B-2 Spirit': 1989, 'C-17': 1991, 'Y-20': 2013, 'AH-64 Apache': 1975,
  'Boeing 747-8': 2010, 'Boeing 707-120': 1957, 'Boeing 707-320': 1959, 'Boeing 727-100': 1963,
  'Boeing 727-200': 1967, 'Boeing 737-100': 1967, 'Boeing 737-200': 1967, 'Boeing 747-100': 1969,
  'Boeing 747-200': 1970, 'Boeing 747-SP': 1975, 'Boeing 747-300': 1982, 'Airbus A300B2': 1972,
  'Airbus A300B4': 1974
};
var quizQuestions = [];
var quizIndex = 0;
var quizScore = 0;
var quizAnswered = false;
var quizSoundEnabled = (function() { try { return localStorage.getItem('quizSound') !== 'off'; } catch(e) { return true; } })();
var quizAudioCtx = null;

function quizGetCtx() {
  if (!quizAudioCtx) {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (AC) quizAudioCtx = new AC();
  }
  if (quizAudioCtx && quizAudioCtx.state === 'suspended') quizAudioCtx.resume();
  return quizAudioCtx;
}
function quizTone(freq, start, dur, type, vol) {
  var ctx = quizGetCtx();
  if (!ctx) return;
  var osc = ctx.createOscillator();
  var gain = ctx.createGain();
  osc.type = type || 'sine';
  osc.frequency.value = freq;
  var t0 = ctx.currentTime + (start || 0);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol || 0.18, t0 + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + (dur || 0.3));
  osc.connect(gain); gain.connect(ctx.destination);
  osc.start(t0); osc.stop(t0 + (dur || 0.3) + 0.05);
}
function playQuizSound(type) {
  if (!quizSoundEnabled) return;
  try {
    if (type === 'correct') { quizTone(523, 0, 0.18, 'triangle', 0.2); quizTone(659, 0.1, 0.18, 'triangle', 0.2); quizTone(784, 0.2, 0.3, 'triangle', 0.22); }
    else if (type === 'wrong') { quizTone(220, 0, 0.25, 'sawtooth', 0.12); quizTone(150, 0.16, 0.35, 'sawtooth', 0.1); }
    else if (type === 'click') { quizTone(880, 0, 0.08, 'sine', 0.1); }
    else if (type === 'finish') { quizTone(523, 0, 0.16, 'triangle', 0.2); quizTone(659, 0.13, 0.16, 'triangle', 0.2); quizTone(784, 0.26, 0.16, 'triangle', 0.2); quizTone(1046, 0.39, 0.45, 'triangle', 0.24); }
  } catch(e) {}
}
function toggleQuizSound() {
  quizSoundEnabled = !quizSoundEnabled;
  try { localStorage.setItem('quizSound', quizSoundEnabled ? 'on' : 'off'); } catch(e) {}
  var btn = document.getElementById('quizSoundBtn');
  var onIcon = document.getElementById('quizSoundOnIcon');
  var offIcon = document.getElementById('quizSoundOffIcon');
  if (btn) btn.classList.toggle('off', !quizSoundEnabled);
  if (onIcon) onIcon.style.display = quizSoundEnabled ? '' : 'none';
  if (offIcon) offIcon.style.display = quizSoundEnabled ? 'none' : '';
  if (quizSoundEnabled) playQuizSound('click');
}
function quizShuffle(arr) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
function quizRandomPick(arr, n, exclude) {
  var pool = arr.filter(function(x) { return x !== exclude; });
  return quizShuffle(pool).slice(0, n);
}
function generateQuizQuestions() {
  var pool = aircrafts.filter(function(a) { return QUIZ_YEARS[a.code] !== undefined; });
  var picked = quizShuffle(pool).slice(0, 15);
  var qs = picked.map(function(a, i) {
    var isName = (i % 2 === 0) ? true : false;
    if (isName) {
      var wrong = quizRandomPick(pool.map(function(x) { return x.code; }), 3, a.code);
      return { aircraft: a, type: 'name', answer: a.code, options: quizShuffle([a.code].concat(wrong)) };
    } else {
      var years = Object.keys(QUIZ_YEARS).map(function(k) { return QUIZ_YEARS[k]; });
      var wrongY = [];
      var attempts = 0;
      while (wrongY.length < 3 && attempts < 60) {
        attempts++;
        var y = years[Math.floor(Math.random() * years.length)];
        if (y !== QUIZ_YEARS[a.code] && wrongY.indexOf(y) === -1) wrongY.push(y);
      }
      var seed = QUIZ_YEARS[a.code];
      [seed - 3, seed + 4, seed - 7, seed + 8].forEach(function(y) {
        if (wrongY.length < 3 && y !== seed && wrongY.indexOf(y) === -1 && y >= 1950) wrongY.push(y);
      });
      return { aircraft: a, type: 'year', answer: seed, options: quizShuffle([seed].concat(wrongY)) };
    }
  });
  return qs;
}
function openQuiz() {
  playQuizSound('click');
  saveScrollState();
  document.getElementById('quizOverlay').classList.add('visible');
  document.body.style.overflow = 'hidden';
  var btn = document.getElementById('quizSoundBtn');
  var onIcon = document.getElementById('quizSoundOnIcon');
  var offIcon = document.getElementById('quizSoundOffIcon');
  if (btn) btn.classList.toggle('off', !quizSoundEnabled);
  if (onIcon) onIcon.style.display = quizSoundEnabled ? '' : 'none';
  if (offIcon) offIcon.style.display = quizSoundEnabled ? 'none' : '';
  quizQuestions = generateQuizQuestions();
  quizIndex = 0;
  quizScore = 0;
  quizAnswered = false;
  document.getElementById('quizProgressFill').style.width = '0%';
  renderQuizQuestion();
}
function closeQuiz() {
  document.getElementById('quizOverlay').classList.remove('visible');
  document.body.style.overflow = '';
  if (typeof renderCards === 'function') renderCards();
  restoreScrollState();
}
function renderQuizQuestion() {
  var content = document.getElementById('quizContent');
  var q = quizQuestions[quizIndex];
  document.getElementById('quizProgressText').textContent = '第 ' + (quizIndex + 1) + ' / 15 题';
  document.getElementById('quizScoreText').textContent = '答对 ' + quizScore + ' 题';
  document.getElementById('quizProgressFill').style.width = ((quizIndex) / 15 * 100) + '%';
  var typeLabel = q.type === 'name'
    ? '<div class="quiz-question-type">猜机型</div>'
    : '<div class="quiz-question-type type-year">猜年份</div>';
  var questionText = q.type === 'name'
    ? '这张图是哪款机型？'
    : '猜猜它的首飞年份？';
  var optionHtml = q.options.map(function(opt, i) {
    var label = q.type === 'name' ? opt : opt + ' 年';
    return '<button class="quiz-option" id="quizOpt' + i + '" onclick="selectQuizAnswer(' + i + ')">' + label + '</button>';
  }).join('');
  content.innerHTML =
    typeLabel +
    '<img class="quiz-img" src="' + proxyUrl(q.aircraft.image) + '" alt="机型图片" onerror="this.style.display=\'none\'">' +
    '<div class="quiz-question-text">' + questionText + '</div>' +
    '<div class="quiz-options">' + optionHtml + '</div>' +
    '<div class="quiz-feedback" id="quizFeedback"></div>';
  quizAnswered = false;
}
function selectQuizAnswer(idx) {
  if (quizAnswered) return;
  quizAnswered = true;
  var q = quizQuestions[quizIndex];
  var correct = idx === q.options.indexOf(q.answer);
  if (correct) { quizScore++; playQuizSound('correct'); }
  else { playQuizSound('wrong'); }
  document.querySelectorAll('#quizContent .quiz-option').forEach(function(btn, i) {
    btn.disabled = true;
    if (i === q.options.indexOf(q.answer)) btn.classList.add('correct');
    else if (i === idx) btn.classList.add('wrong');
  });
  var fb = document.getElementById('quizFeedback');
  var correctLabel = q.type === 'name' ? q.answer : q.answer + ' 年';
  fb.innerHTML = correct
    ? '回答正确！这是 ' + q.aircraft.code + '，太棒了！'
    : '回答错误。正确答案是：' + correctLabel;
  document.getElementById('quizScoreText').textContent = '答对 ' + quizScore + ' 题';
  document.getElementById('quizProgressFill').style.width = ((quizIndex + 1) / 15 * 100) + '%';
  setTimeout(function() {
    if (quizIndex + 1 >= 15) { showQuizResult(); }
    else { quizIndex++; renderQuizQuestion(); }
  }, correct ? 1100 : 1700);
}
function showQuizResult() {
  var content = document.getElementById('quizContent');
  document.getElementById('quizProgressText').textContent = '完成';
  document.getElementById('quizProgressFill').style.width = '100%';
  playQuizSound('finish');
  try {
    var _best = parseInt(localStorage.getItem('aviation_quiz_best') || '0', 10) || 0;
    if (quizScore > _best) localStorage.setItem('aviation_quiz_best', String(quizScore));
    var _pf = parseInt(localStorage.getItem('aviation_quiz_perfect_streak') || '0', 10) || 0;
    _pf = (quizScore >= 15) ? _pf + 1 : 0;
    localStorage.setItem('aviation_quiz_perfect_streak', String(_pf));
  } catch (e) {}
  if (typeof badgeCheckAll === 'function') badgeCheckAll();
  var title, desc;
  if (quizScore >= 15) { unlockBadge('quiz-master'); title = '航空专家！'; desc = '对机型和首飞年份如数家珍，太强了！'; }
  else if (quizScore >= 11) { title = '资深航空迷'; desc = '眼光相当准，离专家就差一点点啦！'; }
  else if (quizScore >= 8) { title = '入门航迷'; desc = '有潜力！多逛逛收藏馆，下次就是满分！'; }
  else { title = '新手上路'; desc = '别灰心，多看几次机型卡片，很快就能认出它们！'; }
  content.innerHTML =
    '<div class="quiz-result">' +
      '<div class="quiz-result-label">本次得分</div>' +
      '<div class="quiz-result-score">' + quizScore + ' / 15</div>' +
      '<div class="quiz-result-title">' + title + '</div>' +
      '<div class="quiz-result-desc">' + desc + '</div>' +
      v56QuizFactHtml() +
      '<div class="quiz-result-btns">' +
        '<button class="quiz-primary-btn" onclick="openQuiz()">再来一局</button>' +
        '<button class="quiz-ghost-btn" onclick="closeQuiz()">返回首页</button>' +
      '</div>' +
    '</div>';
}

// ===== 打卡成就徽章系统 =====
var BADGES = [
  { id: 'first-flight', name: '首航纪念', nameEn: 'First Flight', icon: '✈️', color: 'linear-gradient(135deg,#f59e0b,#fbbf24)', desc: '首次打开收藏馆', descEn: 'Open the collection hall for the first time', intro: '第一次踏上收藏馆的跑道，属于你的航空之旅就此启航。', introEn: 'Your first step onto the museum runway — an aviation journey begins here.',
    check: function () { return badgeGetCheckin().days.length >= 1; } },
  { id: 'collector',    name: '收藏新秀', nameEn: 'Rising Collector', icon: '⭐', color: 'linear-gradient(135deg,#10b981,#34d399)', desc: '收藏 5 款机型', descEn: 'Collect 5 aircraft', intro: '机库渐丰，眼光独到。收藏 5 款心仪机型，你就是收藏新秀。', introEn: 'Five favourites in the hangar — your eye for aircraft is showing.',
    check: function () { return collection.size >= 5; } },
  { id: 'checkin-3',    name: '晨航打卡', nameEn: 'Morning Departure', icon: '📅', color: 'linear-gradient(135deg,#fb923c,#f97316)', desc: '连续 3 天打开打卡', descEn: 'Check in 3 days in a row', intro: '连续 3 天如约而至，像准时起飞的晨间航班一样可靠。', introEn: 'Three days in a row — as reliable as a morning departure.',
    check: function () { return badgeGetCheckin().streak >= 3; } },
  { id: 'quiz-master',  name: '满分飞行员', nameEn: 'Perfect Pilot', icon: '🏆', color: 'linear-gradient(135deg,#8b5cf6,#a78bfa)', desc: 'Quiz 15 题全对', descEn: 'Score 15/15 in a quiz', intro: '机型、年代、细节全掌握。满分飞行员，专业级航空通！', introEn: 'Types, eras and details all nailed — a professional-grade aviation buff.',
    check: function () { try { return (parseInt(localStorage.getItem('aviation_quiz_best') || '0', 10) || 0) >= 15; } catch (e) { return false; } } },
  { id: 'checkin-7',    name: '云端常客', nameEn: 'Above the Clouds', icon: '👑', color: 'linear-gradient(135deg,#ef4444,#f59e0b)', desc: '累计打卡满 7 天', descEn: 'Check in on 7 days in total', intro: '累计 7 天登机打卡，云层之上早已认得你的身影。', introEn: 'Seven check-ins logged — the sky already knows your silhouette.',
    check: function () { return badgeGetCheckin().total >= 7; } },
  { id: 'collector-20', name: '机库巨擘', nameEn: 'Hangar Titan', icon: '🛩️', color: 'linear-gradient(135deg,#f59e0b,#f97316)', desc: '收藏 20 款机型', descEn: 'Collect 20 aircraft', intro: '从窄体到巨无霸，二十款机型一字排开，你的机库已是小型航展。', introEn: 'From narrow-body to jumbo — twenty types lined up, your hangar is a small airshow.',
    check: function () { return collection.size >= 20; } },
  { id: 'livery-5',     name: '涂装收藏家', nameEn: 'Livery Curator', icon: '🎨', color: 'linear-gradient(135deg,#14b8a6,#10b981)', desc: '收藏 5 款涂装', descEn: 'Collect 5 liveries', intro: '机身之外的另一种浪漫。五款涂装入册，你就是涂装收藏家。', introEn: 'Five liveries archived — the romance that lives on the fuselage.',
    check: function () { try { return (typeof liveryGetCollected === 'function' ? liveryGetCollected().length : 0) >= 5; } catch (e) { return false; } } },
  { id: 'coldfacts-12', name: '冷知识猎人', nameEn: 'Trivia Hunter', icon: '🔍', color: 'linear-gradient(135deg,#f472b6,#ec4899)', desc: '累计查阅 12 条 AI 冷知识', descEn: 'Read 12 AI cold facts', intro: '一页页翻过去，冷知识攒成了谈资。你已经是民航冷知识猎人。', introEn: 'Batch after batch, trivia became talking points — a true civil-aviation trivia hunter.',
    check: function () { try { return (parseInt(localStorage.getItem('aviation_coldfacts_seen') || '0', 10) || 0) >= 12; } catch (e) { return false; } } },
  { id: 'quiz-streak-3', name: '三连满分', nameEn: 'Triple Ace', icon: '🎯', color: 'linear-gradient(135deg,#fbbf24,#f43f5e)', desc: 'Quiz 连续 3 局满分', descEn: 'Three perfect quizzes in a row', intro: '连着三局 15/15，稳定得像自动驾驶。', introEn: 'Three 15/15 finishes back to back — as steady as autopilot.',
    check: function () { try { return (parseInt(localStorage.getItem('aviation_quiz_perfect_streak') || '0', 10) || 0) >= 3; } catch (e) { return false; } } },
  { id: 'checkin-30',   name: '月度常客', nameEn: 'Monthly Regular', icon: '🗓️', color: 'linear-gradient(135deg,#e5e7eb,#9ca3af)', desc: '累计打卡满 30 天', descEn: 'Check in on 30 days in total', intro: '三十天登机打卡，收藏馆的灯什么时候亮你都清楚。', introEn: 'Thirty check-ins logged — you know exactly when the lights come on.',
    check: function () { return badgeGetCheckin().total >= 30; } }
];
var badgeNewThisSession = [];
function badgeDateStr(offset) {
  var d = new Date(); if (offset) d.setDate(d.getDate() + offset);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function badgeGetCheckin() {
  try { return JSON.parse(localStorage.getItem('aviation_checkin') || '{"days":[],"streak":0,"total":0}'); }
  catch (e) { return { days: [], streak: 0, total: 0 }; }
}
function badgeSaveCheckin(c) {
  try { localStorage.setItem('aviation_checkin', JSON.stringify(c)); } catch (e) {}
}
function badgeGetUnlocked() {
  try { return JSON.parse(localStorage.getItem('aviation_badges') || '[]'); } catch (e) { return []; }
}
function badgeSaveUnlocked(arr) {
  try { localStorage.setItem('aviation_badges', JSON.stringify(arr)); } catch (e) {}
}
function badgeGetTimes() {
  try { return JSON.parse(localStorage.getItem('aviation_badges_time') || '{}'); } catch (e) { return {}; }
}
function badgeSaveTime(id) {
  try {
    var times = badgeGetTimes();
    times[id] = badgeDateStr(0) + ' ' + String(new Date().getHours()).padStart(2, '0') + ':' + String(new Date().getMinutes()).padStart(2, '0');
    localStorage.setItem('aviation_badges_time', JSON.stringify(times));
  } catch (e) {}
}
function badgeIsEn() { return (typeof currentLang !== 'undefined' && currentLang === 'en'); }
function badgeLabel(zh, en) { return badgeIsEn() ? en : zh; }
function badgeField(b, key) {
  if (!b) return '';
  if (badgeIsEn()) { var en = b[key + 'En']; if (en) return en; }
  return b[key] || '';
}
// 统一扫描所有带判定函数的徽章，达成即解锁（收藏 / 打卡 / Quiz / 冷知识 / 涂装共用）
function badgeCheckAll() {
  var unlocked = badgeGetUnlocked();
  for (var i = 0; i < BADGES.length; i++) {
    var b = BADGES[i];
    if (typeof b.check !== 'function') continue;
    if (unlocked.indexOf(b.id) !== -1) continue;
    var ok = false;
    try { ok = !!b.check(); } catch (e) { ok = false; }
    if (ok) { unlockBadge(b.id); unlocked = badgeGetUnlocked(); }
  }
}
function unlockBadge(id) {
  var arr = badgeGetUnlocked();
  if (arr.indexOf(id) !== -1) return false;
  arr.push(id);
  badgeSaveUnlocked(arr);
  badgeSaveTime(id);
  badgeNewThisSession.push(id);
  showBadgeToast(id);
  return true;
}
function showBadgeToast(id) {
  var b = BADGES.filter(function(x) { return x.id === id; })[0];
  if (!b) return;
  var wrap = document.getElementById('badgeToastWrap');
  if (!wrap) return;
  var div = document.createElement('div');
  div.className = 'badge-toast';
  div.innerHTML = '<span>' + b.icon + '</span><span>' + badgeLabel('解锁徽章：', 'Badge unlocked: ') + '<strong>' + badgeField(b, 'name') + '</strong></span>';
  wrap.appendChild(div);
  setTimeout(function() {
    div.classList.add('hide');
    setTimeout(function() { div.remove(); }, 450);
  }, 3200);
}
function checkinOnLoad() {
  var c = badgeGetCheckin();
  var today = badgeDateStr(0);
  var last = c.days.length ? c.days[c.days.length - 1] : '';
  var isFirst = c.days.length === 0;
  if (last !== today) {
    var consecutive = last === badgeDateStr(-1);
    c.streak = consecutive ? c.streak + 1 : 1;
    c.days.push(today);
    c.total = c.days.length;
    badgeSaveCheckin(c);
  }
  var unlocked = badgeGetUnlocked();
  if (isFirst && unlocked.indexOf('first-flight') === -1) unlockBadge('first-flight');
  if (c.streak >= 3 && unlocked.indexOf('checkin-3') === -1) unlockBadge('checkin-3');
  if (c.total >= 7 && unlocked.indexOf('checkin-7') === -1) unlockBadge('checkin-7');
  if (collection.size >= 5 && unlocked.indexOf('collector') === -1) unlockBadge('collector');
  badgeCheckAll();
}
function openBadges() {
  saveScrollState();
  if (typeof badgeCheckAll === 'function') badgeCheckAll();
  document.getElementById('badgeOverlay').classList.add('visible');
  document.body.style.overflow = 'hidden';
  renderBadges();
}
function closeBadges() {
  document.getElementById('badgeOverlay').classList.remove('visible');
  document.body.style.overflow = '';
  if (typeof renderCards === 'function') renderCards();
  restoreScrollState();
}
function renderBadges() {
  var unlocked = badgeGetUnlocked();
  var grid = document.getElementById('badgeGrid');
  if (!grid) return;
  var statsEl = document.getElementById('badgeStats');
  if (statsEl) {
    statsEl.innerHTML = badgeLabel(
      '已解锁 <strong id="badgeUnlockedCount">' + unlocked.length + '</strong> / ' + BADGES.length + ' 枚徽章',
      'Unlocked <strong id="badgeUnlockedCount">' + unlocked.length + '</strong> / ' + BADGES.length + ' badges'
    );
  } else {
    var cntEl = document.getElementById('badgeUnlockedCount');
    if (cntEl) cntEl.textContent = unlocked.length;
  }
  grid.innerHTML = BADGES.map(function(b) {
    var has = unlocked.indexOf(b.id) !== -1;
    var isNew = badgeNewThisSession.indexOf(b.id) !== -1;
    return '<div class="badge-card ' + (has ? 'unlocked' : 'locked') + '" onclick="showBadgeDetail(\'' + b.id + '\')">' +
      (has ? (isNew ? '<div class="badge-new">NEW</div>' : '') : '<div class="badge-lock">🔒</div>') +
      '<div class="badge-medal" style="background:' + b.color + '">' + b.icon + '</div>' +
      '<div class="badge-name">' + badgeField(b, 'name') + '</div>' +
      '<div class="badge-desc">' + (has ? badgeField(b, 'desc') : badgeLabel('未解锁 · ', 'Locked · ') + badgeField(b, 'desc')) + '</div>' +
    '</div>';
  }).join('');
}
function showBadgeDetail(id) {
  var b = BADGES.filter(function(x) { return x.id === id; })[0];
  if (!b) return;
  var unlocked = badgeGetUnlocked();
  var has = unlocked.indexOf(b.id) !== -1;
  var times = badgeGetTimes();
  var el = document.getElementById('badgeDetailOverlay');
  if (!el) return;
  var dateLine = has
    ? (times[b.id] ? badgeLabel('获取日期：', 'Unlocked at: ') + times[b.id] : badgeLabel('获取日期：已解锁（较早版本记录）', 'Unlocked (recorded in an earlier version)'))
    : badgeLabel('未解锁', 'Locked');
  el.innerHTML =
    '<div class="badge-detail-card">' +
      '<button class="badge-detail-close" onclick="closeBadgeDetail()" title="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' +
      '<div class="badge-detail-medal" style="background:' + b.color + (has ? '' : ';filter:grayscale(1)') + '">' + b.icon + '</div>' +
      '<div class="badge-detail-name">' + badgeField(b, 'name') + '</div>' +
      '<div class="badge-detail-status ' + (has ? 'ok' : 'lock') + '">' + (has ? badgeLabel('已解锁', 'Unlocked') : badgeLabel('未解锁', 'Locked')) + '</div>' +
      '<div class="badge-detail-intro">' + badgeField(b, 'intro') + '</div>' +
      '<div class="badge-detail-date">' + dateLine + '</div>' +
      '<div class="badge-detail-desc">' + badgeLabel('解锁条件：', 'How to unlock: ') + badgeField(b, 'desc') + '</div>' +
    '</div>';
  el.classList.add('visible');
  document.body.style.overflow = 'hidden';
}
function closeBadgeDetail() {
  var el = document.getElementById('badgeDetailOverlay');
  if (el) el.classList.remove('visible');
  document.body.style.overflow = '';
}
function badgeDetailBackdrop(e) {
  if (e.target === e.currentTarget) closeBadgeDetail();
}
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeBadgeDetail();
});

// Esc 关闭收藏记录
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    var cr = document.getElementById('collectRecordOverlay');
    if (cr && cr.classList.contains('visible')) closeCollectRecord();
  }
});

// ===== 机型涂装画廊 =====
var LIVERY_KEY = 'aviation_liveries';
function liveryGetCollected() {
  try { return JSON.parse(localStorage.getItem(LIVERY_KEY) || '[]'); } catch (e) { return []; }
}
function liverySaveCollected(list) {
  try { localStorage.setItem(LIVERY_KEY, JSON.stringify(list)); } catch (e) {}
}
function liveryKeyOf(id, idx) { return id + '-' + idx; }
function liveryFindAircraft(id) {
  var arr = aircrafts.filter(function(x) { return x.id === id; });
  return arr.length ? arr[0] : null;
}
function liveryLogoOf(al) {
  var air = airlines[al];
  return (air && air.logo) ? air.logo : '';
}
function liveryUpdateBadge() {
  var dot = document.getElementById('liveryBadgeDot');
  if (dot) dot.textContent = liveryGetCollected().length;
  updateCollectRecordDot();
}
function updateCollectRecordDot() {
  var dot = document.getElementById('collectRecordDot');
  if (dot) dot.textContent = collection.size + liveryGetCollected().length;
}
var collectRecordTab = 'all';
function openCollectRecord() {
  var el = document.getElementById('collectRecordOverlay');
  if (!el) return;
  document.getElementById('collectRecordTitle').textContent = t('collectRecord');
  document.getElementById('collectRecordSub').textContent = t('collectRecordSub');
  document.getElementById('collectRecordTabAll').textContent = t('collectRecordTabAll');
  document.getElementById('collectRecordTabAircraft').textContent = t('collectRecordTabAircraft');
  document.getElementById('collectRecordTabLivery').textContent = t('collectRecordTabLivery');
  switchCollectRecordTab('all');
  el.classList.add('visible');
  document.body.style.overflow = 'hidden';
}
function closeCollectRecord(e) {
  if (e && e.target !== e.currentTarget && !(e.target.classList && e.target.classList.contains('quiz-close'))) return;
  var el = document.getElementById('collectRecordOverlay');
  if (el) el.classList.remove('visible');
  syncBodyScrollLock();
}
function switchCollectRecordTab(tab) {
  collectRecordTab = tab;
  var tabs = document.querySelectorAll('.collect-record-tab');
  tabs.forEach(function(btn) { btn.classList.toggle('active', btn.dataset.tab === tab); });
  renderCollectRecord();
}
function collectRecordThumbForAircraft(a) {
  return '<div class="cr-thumb"><img src="' + proxyUrl(a.image) + '" alt="' + t(a.name) + '" loading="lazy" onerror="this.parentNode.style.background=\'linear-gradient(135deg,#1e3a8a,#7c3aed)\';this.remove()"><span class="cr-type-badge">' + t('collectRecordType') + '</span></div>';
}
function liveryImgFallback(el, id, idx) {
  var lv = (LIVERIES[id] || [])[idx];
  var a = liveryFindAircraft(id);
  var code = a ? a.code : '';
  if (!lv || !el || !el.parentNode) return;
  el.parentNode.classList.add('img-fallback');
  el.parentNode.innerHTML = liveryPosterHtml(lv, code);
}
function collectRecordThumbForLivery(id, idx, lv) {
  var a = liveryFindAircraft(id);
  var code = a ? a.code : '';
  return '<div class="cr-thumb"><img src="' + proxyUrl(lv.img) + '" alt="' + lv.cn + '" onerror="liveryImgFallback(this,' + id + ',' + idx + ')"><span class="cr-type-badge" style="background:linear-gradient(135deg,' + lv.color + ',#1e3a8a)">' + t('collectRecordLiveryType') + '</span></div>';
}
function renderCollectRecord() {
  var content = document.getElementById('collectRecordContent');
  if (!content) return;
  var aircraftItems = [];
  collection.forEach(function(id) {
    var a = aircrafts.filter(function(x) { return x.id === id; })[0];
    if (!a) return;
    aircraftItems.push(
      '<div class="collect-record-card">' + collectRecordThumbForAircraft(a) +
      '<div class="cr-body">' +
        '<div class="cr-name">' + t(a.name) + ' · ' + (a.code || '') + '</div>' +
        '<div class="cr-sub">' + a.country + '</div>' +
        '<div class="cr-actions">' +
          '<button class="livery-act-btn" onclick="openDetail(' + a.id + ');closeCollectRecord()">' + t('collectRecordTabAircraft') + '</button>' +
          '<button class="livery-act-btn" onclick="toggleCollect(' + a.id + ')">' + t('collectRecordRemove') + '</button>' +
        '</div>' +
      '</div></div>'
    );
  });
  var liveryItems = [];
  liveryGetCollected().forEach(function(key) {
    var sp = key.split('-');
    var id = parseInt(sp[0], 10), idx = parseInt(sp[1], 10);
    var a = liveryFindAircraft(id);
    var lv = (LIVERIES[id] || [])[idx];
    if (!a || !lv || !lv.img) return;
    liveryItems.push(
      '<div class="collect-record-card">' + collectRecordThumbForLivery(id, idx, lv) +
      '<div class="cr-body">' +
        '<div class="cr-name">' + t(a.name) + ' · ' + lv.cn + '</div>' +
        '<div class="cr-sub">' + lv.en + ' · ' + lv.cc + '</div>' +
        '<div class="cr-actions">' +
          '<button class="livery-act-btn" onclick="openLivery(' + id + ');closeCollectRecord()">' + t('liveryGallery') + '</button>' +
          '<button class="livery-act-btn" onclick="toggleCollectLivery(' + id + ',' + idx + ')">' + t('collectRecordRemove') + '</button>' +
        '</div>' +
      '</div></div>'
    );
  });
  var html;
  if (collectRecordTab === 'aircraft') {
    html = aircraftItems.length ? aircraftItems.join('') : '<div class="collect-record-empty">' + t('collectRecordEmptyAircraft') + '</div>';
  } else if (collectRecordTab === 'livery') {
    html = liveryItems.length ? liveryItems.join('') : '<div class="collect-record-empty">' + t('collectRecordEmptyLivery') + '</div>';
  } else {
    var merged = aircraftItems.concat(liveryItems);
    html = merged.length ? merged.join('') : '<div class="collect-record-empty">' + t('collectRecordEmpty') + '</div>';
  }
  content.innerHTML = html;
}
function liveryPosterHtml(lv, code) {
  var logo = liveryLogoOf(lv.al);
  var logoHtml = logo
    ? '<img class="livery-poster-logo" src="' + logo + '" alt="' + lv.cn + '">'
    : '<div class="livery-poster-logo livery-poster-logo-txt" style="background:' + lv.color + '">' + lv.cn + '</div>';
  return '<div class="livery-poster" style="background:linear-gradient(135deg,' + lv.color + ' 0%,#0b1220 130%)">' +
    logoHtml +
    '<div class="livery-plane">✈</div>' +
    '<div class="livery-poster-code">' + (code || '') + '</div>' +
    '<div class="livery-poster-cc">' + lv.cc + '</div>' +
  '</div>';
}
function liveryCardHtml(id, idx, lv) {
  var a = liveryFindAircraft(id);
  var code = a ? a.code : '';
  var collected = liveryGetCollected().indexOf(liveryKeyOf(id, idx)) !== -1;
  var imgHtml = lv.img
    ? '<img class="livery-card-img" src="' + proxyUrl(lv.img) + '" alt="' + lv.cn + '" onerror="liveryImgFallback(this,' + id + ',' + idx + ')">'
    : liveryPosterHtml(lv, code);
  return '<div class="livery-card">' +
    '<div class="livery-card-img-wrap">' + imgHtml +
      '<div class="livery-card-logo">' + (liveryLogoOf(lv.al) ? '<img src="' + liveryLogoOf(lv.al) + '" alt="' + lv.cn + '">' : '<span class="livery-card-logo-txt">' + lv.cn + '</span>') + '</div>' +
    '</div>' +
    '<div class="livery-card-info">' +
      '<div class="livery-card-name">' + lv.cn + '</div>' +
      '<div class="livery-card-en">' + lv.en + ' · ' + lv.cc + '</div>' +
      '<button class="livery-act-btn livery-coll-btn' + (collected ? ' collected' : '') + '" id="livery-btn-' + liveryKeyOf(id, idx) + '" onclick="toggleCollectLivery(' + id + ',' + idx + ')">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>' +
        (collected ? t('liveryCollected') : t('liveryCollect')) +
      '</button>' +
      '<button class="livery-fold-toggle" onclick="toggleLiveryFold(this)">' + t('liveryFold') + ' ▾</button>' +
      '<div class="livery-fold-body"><div class="livery-note">' + lv.note + '</div></div>' +
    '</div>' +
  '</div>';
}
function cabinImgFallback(img) {
  if (!img || !img.parentNode) return;
  var d = document.createElement('div');
  d.className = 'cabin-img-fallback';
  d.textContent = '图片加载失败';
  img.parentNode.replaceChild(d, img);
}
/* 统一弹窗滚动守护：关闭上层弹窗后，若下层仍有全屏层，则继续保持滚动锁定 */
function anyTopOverlayOpen() {
  var ids = ['aiChatOverlay','aiReviewOverlay','photoAiOverlay','collectAnalysisOverlay',
    'newsPanelOverlay','aiExpoOverlay','flyBoardOverlay','quizOverlay','badgeOverlay','badgeDetailOverlay','letterOverlay',
    'liveryOverlay','cabinOverlay','collectRecordOverlay'];
  for (var i = 0; i < ids.length; i++) {
    var el = document.getElementById(ids[i]);
    if (el && (el.classList.contains('visible') || el.classList.contains('show'))) return true;
  }
  if (document.querySelector('.kg-overlay.visible, .kg-overlay.show, .livery-overlay.visible, .livery-overlay.show')) return true;
  return document.getElementById('overlayContainer').children.length > 0;
}
function syncBodyScrollLock() {
  document.body.style.overflow = anyTopOverlayOpen() ? 'hidden' : '';
}
function openCabin(id) {
  var a = liveryFindAircraft(id);
  var c = CABIN_SHOTS[id];
  if (!c) return;
  var el = document.getElementById('cabinOverlay');
  if (!el) return;
  document.getElementById('cabinTitle').textContent = a ? t(a.name) : ('#' + id);
  document.getElementById('cabinSub').textContent = (c.display || ('#' + id)) + ' · 客舱实拍';
  var content = document.getElementById('cabinContent');
  var groups = [
    { key: 'biz', tag: '商务舱' },
    { key: 'eco', tag: '经济舱' }
  ];
  var html = '<div class="cabin-grid">';
  groups.forEach(function(g) {
    var d = c[g.key];
    if (!d || !d.img) return;
    html += '<div class="cabin-card">' +
      '<div class="cabin-photo">' +
        '<img src="' + d.img + '" alt="' + (c.display || '') + ' ' + g.tag + '" onclick="openImageLightbox(' + d.img + ')" onerror="cabinImgFallback(this)">' +
        '<div class="cabin-tag' + (g.key === 'eco' ? ' eco' : '') + '">' + g.tag + '</div>' +
      '</div>' +
      '<div class="cabin-desc"><strong>' + d.airline + '</strong> ' + d.desc + '</div>' +
      '<div class="cabin-src"><a href="' + d.src + '" target="_blank" rel="noopener">图片来源 · Wikimedia Commons</a></div>' +
    '</div>';
  });
  html += '</div>';
  content.innerHTML = html;
  el.classList.add('visible');
  document.body.style.overflow = 'hidden';
}
function closeCabin() {
  var el = document.getElementById('cabinOverlay');
  if (el) el.classList.remove('visible');
  syncBodyScrollLock();
}
function cabinBackdrop(e) {
  if (e.target === e.currentTarget) closeCabin();
}
function openLivery(id) {
  var a = liveryFindAircraft(id);
  var all = LIVERIES[id] || [];
  var list = [];
  all.forEach(function(lv, i) { if (lv.img) list.push({ lv: lv, i: i }); });
  var el = document.getElementById('liveryOverlay');
  if (!el) return;
  document.getElementById('liveryTitle').textContent = a ? t(a.name) : ('#' + id);
  document.getElementById('liveryTitleSub').textContent = t('liveryGallerySub');
  var content = document.getElementById('liveryContent');
  if (!list.length) {
    content.innerHTML = '<div class="livery-empty">' + t('liveryNoImage') + '</div>';
  } else {
    content.innerHTML = list.map(function(x) { return liveryCardHtml(id, x.i, x.lv); }).join('');
  }
  var bar = document.getElementById('liveryExportBar');
  if (bar) bar.style.display = 'none';
  liveryUpdateBadge();
  el.classList.add('visible');
  document.body.style.overflow = 'hidden';
}
function closeLivery() {
  var el = document.getElementById('liveryOverlay');
  if (el) el.classList.remove('visible');
  syncBodyScrollLock();
}
function liveryBackdrop(e) {
  if (e.target === e.currentTarget) closeLivery();
}
function toggleLiveryFold(btn) {
  var body = btn.parentNode.querySelector('.livery-fold-body');
  if (!body) return;
  var open = body.classList.toggle('open');
  btn.innerHTML = open ? t('liveryFoldHide') + ' ▴' : t('liveryFold') + ' ▾';
}
function toggleCollectLivery(id, idx) {
  var list = liveryGetCollected();
  var key = liveryKeyOf(id, idx);
  var i = list.indexOf(key);
  if (i !== -1) { list.splice(i, 1); liveryToast(t('liveryUncollectSuccess')); }
  else { list.push(key); liveryToast(t('liveryCollectSuccess')); }
  liverySaveCollected(list);
  if (typeof badgeCheckAll === 'function') badgeCheckAll();
  var btn = document.getElementById('livery-btn-' + key);
  if (btn) {
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>' + ((i !== -1) ? t('liveryCollect') : t('liveryCollected'));
    btn.classList.toggle('collected', i === -1);
  }
  liveryUpdateBadge();
  if (document.getElementById('collectRecordOverlay') && document.getElementById('collectRecordOverlay').classList.contains('visible')) renderCollectRecord();
}
function drawLiveryPlane(ctx, cx, cy, w, h, color) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = color;
  // 后掠翼（上）
  ctx.beginPath();
  ctx.moveTo(-w * 0.15, -h * 0.1);
  ctx.lineTo(-w * 0.75, -h * 1.35);
  ctx.lineTo(-w * 0.5, -h * 0.35);
  ctx.lineTo(-w * 0.2, -h * 0.05);
  ctx.closePath(); ctx.fill();
  // 后掠翼（下）
  ctx.beginPath();
  ctx.moveTo(-w * 0.15, h * 0.1);
  ctx.lineTo(-w * 0.75, h * 1.35);
  ctx.lineTo(-w * 0.5, h * 0.35);
  ctx.lineTo(-w * 0.2, h * 0.05);
  ctx.closePath(); ctx.fill();
  // 尾翼
  ctx.beginPath();
  ctx.moveTo(w * 0.5, -h * 0.18);
  ctx.lineTo(w * 0.92, -h * 1.05);
  ctx.lineTo(w * 0.98, -h * 0.15);
  ctx.closePath(); ctx.fill();
  // 机身
  ctx.beginPath();
  ctx.ellipse(0, 0, w, h, 0, 0, Math.PI * 2);
  ctx.fill();
  // 机头舷窗点缀
  ctx.fillStyle = 'rgba(0,0,0,0.08)';
  ctx.beginPath();
  ctx.ellipse(w * 0.55, 0, w * 0.22, h * 0.75, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
function drawLiveryPoster(ctx, x, y, w, h, lv, a) {
  // 背景
  var grad = ctx.createLinearGradient(x, y, x + w, y + h);
  grad.addColorStop(0, lv.color);
  grad.addColorStop(1, '#0b1220');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 18);
  ctx.fill();
  // 飞机
  drawLiveryPlane(ctx, x + w * 0.52, y + h * 0.5, w * 0.30, h * 0.16, 'rgba(255,255,255,0.92)');
  // 航司logo
  var logo = liveryLogoOf(lv.al);
  if (logo) {
    var img = new Image();
    img.src = logo;
    try { ctx.drawImage(img, x + 20, y + 18, 64, 64); } catch (e) {}
  }
  // 文字
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 30px sans-serif';
  ctx.fillText(a ? a.name : '', x + 20, y + h - 46);
  ctx.font = '20px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText(lv.cn + ' · ' + lv.en, x + 20, y + h - 16);
  ctx.font = 'bold 26px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillText(a ? a.code : '', x + w - 110, y + 48);
}
function downloadLivery(id, idx) {
  var lv = (LIVERIES[id] || [])[idx];
  if (!lv) return;
  var a = liveryFindAircraft(id);
  var canvas = document.createElement('canvas');
  canvas.width = 800; canvas.height = 560;
  var ctx = canvas.getContext('2d');
  drawLiveryPoster(ctx, 20, 20, 760, 520, lv, a);
  var link = document.createElement('a');
  link.download = 'livery_' + (a ? a.code : id) + '_' + lv.al + '.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
  liveryToast(t('liveryDownloadSuccess'));
}
function openLiveryCollection() {
  var el = document.getElementById('liveryOverlay');
  if (!el) return;
  var list = liveryGetCollected();
  var content = document.getElementById('liveryContent');
  document.getElementById('liveryTitle').textContent = t('liveryMy');
  document.getElementById('liveryTitleSub').textContent = '';
  if (!list.length) {
    content.innerHTML = '<div class="livery-empty">' + t('liveryEmpty') + '</div>';
  } else {
    content.innerHTML = list.map(function(key) {
      var sp = key.split('-');
      var id = parseInt(sp[0], 10), idx = parseInt(sp[1], 10);
      var a = liveryFindAircraft(id);
      var lv = (LIVERIES[id] || [])[idx];
      if (!a || !lv || !lv.img) return '';
      var collected = liveryGetCollected().indexOf(liveryKeyOf(id, idx)) !== -1;
      return '<div class="livery-coll-card">' +
        '<span class="livery-coll-badge" style="background:' + lv.color + '">' + (a.code || '?') + '</span>' +
        '<div class="livery-coll-info"><div class="livery-coll-name">' + a.name + ' · ' + lv.cn + '</div><div class="livery-coll-sub">' + lv.en + ' · ' + lv.cc + '</div></div>' +
        '<button class="livery-act-btn livery-coll-btn' + (collected ? ' collected' : '') + '" id="livery-btn-' + liveryKeyOf(id, idx) + '" onclick="toggleCollectLivery(' + id + ',' + idx + ')">' + (collected ? t('liveryCollected') : t('liveryCollect')) + '</button>' +
        '<button class="livery-act-btn" onclick="openLivery(' + id + ')">' + t('liveryGallery') + '</button>' +
      '</div>';
    }).join('');
  }
  var bar = document.getElementById('liveryExportBar');
  if (bar) bar.style.display = list.length ? '' : 'none';
  liveryUpdateBadge();
  el.classList.add('visible');
  document.body.style.overflow = 'hidden';
}
function exportLiveryCollection() {
  var list = liveryGetCollected();
  var items = [];
  list.forEach(function(key) {
    var sp = key.split('-');
    var id = parseInt(sp[0], 10), idx = parseInt(sp[1], 10);
    var a = liveryFindAircraft(id);
    var lv = (LIVERIES[id] || [])[idx];
    if (a && lv) items.push({ a: a, lv: lv });
  });
  if (!items.length) { liveryToast(t('liveryEmpty')); return; }
  var canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 100 + items.length * 280;
  var ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 34px sans-serif';
  ctx.fillText(t('liveryMy') + ' · ' + items.length, 40, 62);
  ctx.font = '18px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillText('Aviation Collection', 40, 92);
  items.forEach(function(it, i) {
    drawLiveryPoster(ctx, 40, 120 + i * 280, 720, 250, it.lv, it.a);
  });
  var link = document.createElement('a');
  link.download = 'my_liveries.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
  liveryToast(t('liveryExportSuccess'));
}

function liveryToast(msg) {
  var old = document.getElementById('liveryToast');
  if (old) old.remove();
  var div = document.createElement('div');
  div.id = 'liveryToast';
  div.className = 'livery-toast';
  div.textContent = msg;
  document.body.appendChild(div);
  requestAnimationFrame(function() { div.classList.add('show'); });
  setTimeout(function() {
    div.classList.remove('show');
    setTimeout(function() { if (div.parentNode) div.parentNode.removeChild(div); }, 400);
  }, 2200);
}


// 页面加载完成后打卡（函数定义块末尾调用，确保 BADGES 等已就绪）
checkinOnLoad();

function newsSourceLabel(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch(e) { return ''; }
}

function renderNewsContent(content, items) {
  if (items.length === 0) {
    content.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:40px 0;">暂无快讯，下拉刷新试试</div>';
    return;
  }
  if (!document.getElementById('newsFadeStyle')) {
    var st = document.createElement('style');
    st.id = 'newsFadeStyle';
    st.textContent = '.news-fade{animation:newsFadeIn .32s ease}@keyframes newsFadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}'
      + '.news-rank{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 5px;margin-right:8px;border-radius:7px;background:rgba(148,163,184,.22);color:#64748b;font-size:.78rem;font-weight:800;line-height:1;vertical-align:1px}'
      + '.news-rank-top{background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;box-shadow:0 2px 8px rgba(102,126,234,.35)}'
      + '.news-boom{display:inline-block;margin-right:8px;padding:1px 6px;border-radius:6px;background:#e11d48;color:#fff;font-size:.7rem;font-weight:800;line-height:1.5;vertical-align:1px;letter-spacing:.5px}'
      + '.news-title-hot{color:#e11d48 !important}'
      + '.news-heatbar{display:inline-block;margin-left:8px;padding:1px 7px;border-radius:9px;background:rgba(225,29,72,.1);color:#e11d48;font-size:.68rem;font-weight:700;vertical-align:1px}';
    document.head.appendChild(st);
  }
  var paragraph = items.map(function(item, i) {
    var dateStr = item.pubDate ? new Date(item.pubDate).toLocaleDateString('zh-CN') : '';
    var src = (item.link && item.link !== '#') ? newsSourceLabel(item.link) : '';
    var srcHtml = src ? ' <a href="' + escapeHtml(item.link) + '" target="_blank" rel="noopener" style="color:var(--accent);font-size:0.72rem;text-decoration:none;opacity:.85;">来源：' + escapeHtml(src) + '</a>' : '';
    var rank = (typeof item.rank === 'number' && item.rank > 0) ? item.rank : (i + 1);
    var isHot = !!item.hot;
    var rankHtml = '<span class="news-rank' + (rank <= 3 ? ' news-rank-top' : '') + '">' + rank + '</span>';
    var boomHtml = isHot ? '<span class="news-boom">爆</span>' : '';
    var heatHtml = (typeof item.heat === 'number' && item.heat > 0) ? '<span class="news-heatbar">热度 ' + item.heat + '</span>' : '';
    return '<div style="margin-bottom:22px;padding-bottom:16px;border-bottom:1px solid var(--glass-border);"><p style="margin:0 0 8px 0;">' + rankHtml + boomHtml + '<strong class="' + (isHot ? 'news-title-hot' : '') + '" style="font-size:1.05rem;' + (isHot ? '' : 'color:var(--accent);') + '">' + escapeHtml(item.title) + '</strong>' + heatHtml + (dateStr ? ' <span style="color:var(--text-dim);font-size:0.75rem;">' + dateStr + '</span>' : '') + srcHtml + '</p><p style="margin:0;color:var(--text-dim);font-size:0.9rem;line-height:1.8;">' + escapeHtml(item.snippet || '暂无摘要') + '</p></div>';
  }).join('');
  content.innerHTML = '<div style="line-height:1.8;padding:10px 0;">' + paragraph + '</div>';
  content.classList.remove('news-fade');
  void content.offsetWidth;
  content.classList.add('news-fade');
}

async function tryFetchRSSAndUpdate(content, today, shownTitles, shownUrls) {
  try {
    var results = await Promise.allSettled(NEWS_FEEDS.map(function(url) {
      return fetch(url, { signal: AbortSignal.timeout(12000) }).then(function(r) { return r.json(); });
    }));
    var allItems = [];
    results.forEach(function(r) {
      if (r.status === 'fulfilled' && r.value && r.value.items) {
        allItems = allItems.concat(r.value.items.map(function(item) {
          var rawText = (item.content || item.contentSnippet || '').replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ').trim();
          return { title: item.title || '', link: item.link || '', pubDate: item.pubDate || '', snippet: rawText.substring(0, 350) };
        }));
      }
    });
    if (allItems.length === 0) return; // RSS全失败，保留静态内容

    allItems.sort(function(a, b) { return new Date(b.pubDate) - new Date(a.pubDate); });
    var pool = allItems.slice(0, Math.min(15, allItems.length));

    // RSS按link去重
    var freshPool = pool.filter(function(item) { return shownUrls.indexOf(item.link) === -1; });
    var rssSelected = [];
    var fpCopy = freshPool.slice();
    while (rssSelected.length < 15 && fpCopy.length > 0) {
      var idx = Math.floor(Math.random() * fpCopy.length);
      rssSelected.push(fpCopy.splice(idx, 1)[0]);
    }
    if (rssSelected.length < 15) {
      var remaining = pool.filter(function(item) {
        return !rssSelected.some(function(s) { return s.link === item.link; });
      });
      var rCopy = remaining.slice();
      while (rssSelected.length < 15 && rCopy.length > 0) {
        var ri = Math.floor(Math.random() * rCopy.length);
        rssSelected.push(rCopy.splice(ri, 1)[0]);
      }
    }
    if (rssSelected.length === 0) return;

    // AI翻译
    var translated = null;
    for (var tAttempt = 0; tAttempt < 1 && !translated; tAttempt++) {
      try {
        var translatePrompt = '你是专业航空新闻翻译。将以下' + rssSelected.length + '条英文航空新闻的标题和摘要翻译成简体中文，返回严格JSON数组：[{"title":"中文标题","snippet":"中文摘要"}]。要求：1.只输出JSON数组，不要markdown代码块、不要任何解释；2.title保持简洁准确；3.snippet完整通顺；4.专有名词保留英文缩写（如C919、A380、EASA）；5.严禁输出英文原文。\n' + JSON.stringify(rssSelected.map(function(item) { return { title: item.title, snippet: item.snippet }; }));
        var tCtrl = new AbortController();
        var tTimeout = setTimeout(function() { tCtrl.abort(); }, 20000);
        var tData = await AIBridge.chat({
          tier: 'flagship',
          feature: 'news_translate',
          messages: [{ role: 'user', content: translatePrompt }],
          max_tokens: 3600,
          temperature: 0.3,
          signal: tCtrl.signal
        });
        clearTimeout(tTimeout);
        var tReply = tData.choices && tData.choices[0] && tData.choices[0].message && tData.choices[0].message.content;
        if (tReply) {
          var parsed = extractTranslatedJson(tReply);
          if (parsed) translated = parsed;
        }
      } catch(e) { /* 单次翻译失败，稍后重试 */ }
      if (!translated && tAttempt < 2) await new Promise(function(r) { setTimeout(r, 500); });
    }
    // 翻译失败或结果仍为英文时，保留静态中文新闻，不替换展示
    if (!translated) return;
    var latinTitleCount = translated.filter(function(t) {
      var title = (t && t.title) || '';
      var latin = (title.match(/[A-Za-z]/g) || []).length;
      return title.length > 0 && latin / title.length > 0.4;
    }).length;
    if (latinTitleCount > 0) return;
    for (var ti = 0; ti < Math.min(translated.length, rssSelected.length); ti++) {
      if (translated[ti].title) rssSelected[ti].title = translated[ti].title;
      if (translated[ti].snippet) rssSelected[ti].snippet = translated[ti].snippet;
    }

    // 更新 RSS 去重记录
    rssSelected.forEach(function(item) { shownUrls.push(item.link); });
    shownUrls = shownUrls.slice(-100);
    try {
      // 合并 shownUrls 和 shownTitles，保留两个维度的去重
      var mergedHistory = {};
      var stored = localStorage.getItem('aviationNewsHistory');
      if (stored) { mergedHistory = JSON.parse(stored); }
      localStorage.setItem('aviationNewsHistory', JSON.stringify({
        date: today,
        shownTitles: mergedHistory.shownTitles || shownTitles,
        shownUrls: shownUrls
      }));
    } catch(e) {}

    newsPanelItems = rssSelected;
    renderNewsContent(content, rssSelected);
  } catch(e) { /* RSS全失败，保留静态内容不变 */ }
}

function extractTranslatedJson(raw) {
  if (!raw) return null;
  var text = raw.trim();
  // 去掉可能的 markdown 代码块围栏
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  // 若整体不是数组，尝试截取第一个 [ ... ] 片段
  if (text.charAt(0) !== '[') {
    var si = text.indexOf('[');
    var ei = text.lastIndexOf(']');
    if (si === -1 || ei === -1 || ei <= si) return null;
    text = text.substring(si, ei + 1);
  }
  try {
    var arr = JSON.parse(text);
    return Array.isArray(arr) ? arr : null;
  } catch(e) {
    // 尝试逐行清洗非法字符后重试
    try {
      var cleaned = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
      var arr2 = JSON.parse(cleaned);
      return Array.isArray(arr2) ? arr2 : null;
    } catch(e2) { return null; }
  }
}

async function loadNewsPanel() {
  var content = document.getElementById('newsPanelContent');
  var today = new Date().toISOString().slice(0, 10);

  // 读取去重历史
  var history = { date: today, shownTitles: [], shownUrls: [] };
  try {
    var stored = localStorage.getItem('aviationNewsHistory');
    if (stored) {
      var parsed = JSON.parse(stored);
      if (parsed.date === today) {
        history.shownTitles = parsed.shownTitles || [];
        history.shownUrls = parsed.shownUrls || [];
      }
    }
  } catch(e) {}

  // ===== 阶段一：立即展示静态中文新闻兜底 =====
  var shownTitles = history.shownTitles;
  var staticPool = NEWS_STATIC.slice();
  var available = staticPool.filter(function(item) { return shownTitles.indexOf(item.title) === -1; });
  var selected = [];
  var availCopy = available.slice();
  while (selected.length < 15 && availCopy.length > 0) {
    var idx = Math.floor(Math.random() * availCopy.length);
    selected.push(availCopy.splice(idx, 1)[0]);
  }
  // 不够时从全池补
  if (selected.length < 15) {
    var remaining = staticPool.filter(function(item) {
      return !selected.some(function(s) { return s.title === item.title; });
    });
    var remCopy = remaining.slice();
    while (selected.length < 15 && remCopy.length > 0) {
      var ri = Math.floor(Math.random() * remCopy.length);
      selected.push(remCopy.splice(ri, 1)[0]);
    }
  }

  // 更新静态去重记录
  selected.forEach(function(item) { shownTitles.push(item.title); });
  shownTitles = shownTitles.slice(-200);
  try { localStorage.setItem('aviationNewsHistory', JSON.stringify({ date: today, shownTitles: shownTitles, shownUrls: history.shownUrls })); } catch(e) {}

  newsPanelItems = selected;
  renderNewsContent(content, selected);

  // ===== 阶段二：后台异步尝试RSS获取，成功后替换 =====
  p3TryBackendNews(content, today, shownTitles, history.shownUrls);
}

async function refreshNewsPanel() {
  await loadNewsPanel();
}

let newsPanelWordCount = 400;

function selectWordCount(wc) {
  newsPanelWordCount = wc;
  document.querySelectorAll('#newsPanelOverlay .wordcount-btn').forEach(function(b) { b.classList.remove('active'); });
  var btn = document.getElementById('wc' + wc);
  if (btn) btn.classList.add('active');
}

async function generateNewsSummaryInPanel() {
  var wordCount = newsPanelWordCount;
  var content = document.getElementById('newsPanelContent');
  if (newsPanelItems.length === 0) {
    content.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:40px 0;">暂无快讯，无法生成总结</div>';
    return;
  }
  content.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:40px 0;"><div class="ai-loading" style="display:inline-flex"><span></span><span></span><span></span></div></div>';
  var titles = newsPanelItems.map(function(item) { return item.title; }).join('\n');
  var prompt = '以下是今日民航航空新闻标题，请写一篇约' + wordCount + '字的航空新闻综合摘要，按主题归类，直接陈述事实不要开场白和结束语，不要称呼观众，单纯输出内容，自然段落不要列点序号。\n\n' + titles;
  var systemPrompt = '你是资深航空编辑。用中文输出约' + wordCount + '字的航空新闻综合摘要，直接讲内容，不要任何寒暄或情感表达，段落形式流畅自然，不列点。';
  var controller = new AbortController();
  var timeoutId = setTimeout(function() { controller.abort(); }, (AI_CONFIG && AI_CONFIG.timeout) || 90000);
  try {
    var data = await AIBridge.chat({ tier: 'light', feature: 'news_summary', messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }], max_tokens: Math.max(wordCount * 3, 800), temperature: 0.6, signal: controller.signal });
    clearTimeout(timeoutId);
    var reply = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    content.innerHTML = reply ? '<div class="news-summary-result">' + escapeHtml(reply) + '</div>' : '<div style="text-align:center;color:var(--text-dim);padding:40px 0;">生成失败，请重试</div>';
  } catch (err) {
    clearTimeout(timeoutId);
    content.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:40px 0;">' + (err.name === 'AbortError' ? '请求超时' : '生成失败') + '，请重试</div>';
  }
}

/* ===== v-fix1016b：AI 策划展（aiExpo 单步生成 · 按日缓存） ===== */
var AE = { running: false, ctrl: null, data: null, dateKey: '' };

function aeEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function aeToastHint(msg) {
  var t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:20002;background:rgba(0,0,0,0.78);color:#fff;padding:10px 18px;border-radius:999px;font-size:13px;pointer-events:none;transition:opacity .3s ease;';
  document.body.appendChild(t);
  setTimeout(function () { t.style.opacity = '0'; }, 1800);
  setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2200);
}

function aeAbortRunning() {
  if (AE.ctrl) { try { AE.ctrl.abort(); } catch (e) {} AE.ctrl = null; }
}

function aeShowLoading(c, hint) {
  c.innerHTML = '<div style="white-space:normal;text-align:center;color:var(--text-dim);padding:var(--space-40) 0;">' + aeEsc(hint || '') + '</div><div class="ai-loading" style="margin:0 auto;"><span></span><span></span><span></span></div>';
}

function aeTodayKey() {
  var d = new Date();
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}

function aeParseJson(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  var a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {}
  try { return JSON.parse(s); } catch (e2) { return null; }
}

function aeNormalizePlan(obj) {
  if (!obj || typeof obj !== 'object') return null;
  var title = obj.title || obj.name || '';
  var brief = obj.brief || obj.desc || obj.intro || '';
  var items = Array.isArray(obj.items) ? obj.items.slice(0, 8) : [];
  var guide = Array.isArray(obj.guide) ? obj.guide : (Array.isArray(obj.tips) ? obj.tips : []);
  var tags = Array.isArray(obj.tags) ? obj.tags : [];
  if (!title || !items.length) return null;
  return { title: title, brief: brief, items: items, guide: guide, tags: tags };
}

var AE_FALLBACK_AIRCRAFT = [
  'Airbus A380', 'Boeing 787-9', 'Airbus A350-900', 'Boeing 777-300ER', 'COMAC C919',
  'Airbus A320neo', 'Boeing 737 MAX 8', 'Airbus A330-300', 'Embraer E195-E2', 'Airbus A220-300',
  'Boeing 747-8', 'Boeing 707-120', 'Boeing 707-320', 'Boeing 727-100', 'Boeing 727-200',
  'Boeing 737-100', 'Boeing 737-200', 'Boeing 747-100', 'Boeing 747-200', 'Boeing 747-SP', 'Boeing 747-300',
  'Airbus A300B2', 'Airbus A300B4'
];

function aeCollectAircraftNames() {
  var names = [];
  try {
    if (typeof aircrafts !== 'undefined' && aircrafts && aircrafts.length) {
      aircrafts.forEach(function (it) {
        var n = (it && (it.nameZh || it.name || it.code)) || '';
        if (n && names.indexOf(n) === -1) names.push(n);
      });
    }
  } catch (e) {}
  return names;
}

async function aeFetchAircraftNames() {
  var names = aeCollectAircraftNames();
  if (names && names.length) return names;
  var base = (typeof P3_API_BASE !== 'undefined' && P3_API_BASE) ? P3_API_BASE : '';
  try {
    var resp = await fetch(base + '/api/aircraft', {
      method: 'GET', cache: 'no-store', headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000)
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    var res = await resp.json();
    var list = (typeof p3PickList === 'function') ? p3PickList(res) : (res.items || res.data || res.list || (Array.isArray(res) ? res : []));
    names = [];
    (list || []).forEach(function (it) {
      var n = (it && (it.nameZh || it.name || it.code)) || '';
      if (n && names.indexOf(n) === -1) names.push(n);
    });
    if (names.length) return names;
  } catch (e) {}
  return AE_FALLBACK_AIRCRAFT.slice();
}

async function aeCall(promptText, maxTok) {
  var controller = new AbortController();
  AE.ctrl = controller;
  var timeoutId = setTimeout(function () { controller.abort(); }, (AI_CONFIG && AI_CONFIG.timeout) || 90000);
  try {
    var data = await AIBridge.chat({
      tier: 'light',
      feature: 'topic_ideas',
      messages: [
        { role: 'system', content: '你是民航主题策展人。只输出严格 JSON，不要输出任何多余文字、解释或代码块标记。' },
        { role: 'user', content: promptText }
      ],
      max_tokens: maxTok || 2048,
      temperature: 0.8,
      timeout: (AI_CONFIG && AI_CONFIG.timeout) || 90000,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    AE.ctrl = null;
    var raw = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return { parsed: aeParseJson(raw), raw: raw || '', degraded: !!(data && data._degraded), degradeKind: (data && data._degradeKind) || '' };
  } catch (err) {
    clearTimeout(timeoutId);
    AE.ctrl = null;
    throw err;
  }
}

function aeRenderError(c, r, msg) {
  var html = '<div class="expo-empty">' + aeEsc(msg) + '</div>';
  if (r && r.degraded) html += '<div class="expo-note">AI 繁忙，已切换兜底模型，返回内容可能不是预期格式</div>';
  c.innerHTML = html;
}

function aeBuildPrompt(dateKey, aircraftNames) {
  var pool = (aircraftNames && aircraftNames.length) ? aircraftNames.join('、') : AE_FALLBACK_AIRCRAFT.join('、');
  return '今天是 ' + dateKey + '。请为本站民航客机收藏馆策划一份「今日展览」：从下方真实机型库中挑选 5~8 件展品，设计一个与今日日期相关的差异化展览主题（每天主题应不同，可结合日期含义/节气/民航纪念日等）。直接输出严格 JSON：{"title":"展览标题","brief":"150字左右策展说明","items":[{"name":"机型名（必须取自机型库）","highlight":"一句展品看点"}],"guide":["观展攻略/推荐路线 2~3 条"],"tags":["标签3~5个"]}。title 不超过 30 字，items 5~8 件，name 必须严格取自机型库名单，不要输出 JSON 以外的任何内容。\n机型库名单：' + pool;
}

function aeRenderExpo(c, plan, meta) {
  var html = '';
  if (meta && meta.dateBadge) html += '<div class="expo-meta"><span class="expo-date-badge">' + aeEsc(meta.dateBadge) + '</span></div>';
  html += '<div class="expo-title">' + aeEsc(plan.title) + '</div>';
  if (plan.brief) html += '<div class="expo-brief">' + aeEsc(plan.brief) + '</div>';
  if (plan.items && plan.items.length) {
    html += '<div class="expo-section-title">展品推荐</div><div class="expo-items">';
    plan.items.forEach(function (it) {
      var nm = (it && it.name) || '';
      var hl = (it && it.highlight) || (it && it.hook) || '';
      html += '<div class="expo-item"><div class="expo-item-name">' + aeEsc(nm) + '</div><div class="expo-item-highlight">' + aeEsc(hl) + '</div></div>';
    });
    html += '</div>';
  }
  if (plan.guide && plan.guide.length) {
    html += '<div class="expo-section-title">观展攻略</div><ol class="expo-guide">' + plan.guide.map(function (g) { return '<li>' + aeEsc(g) + '</li>'; }).join('') + '</ol>';
  }
  if (plan.tags && plan.tags.length) {
    html += '<div class="expo-section-title">标签</div><div class="expo-tags">' + plan.tags.map(function (t) { return '<span class="expo-tag">#' + aeEsc(t) + '</span>'; }).join('') + '</div>';
  }
  c.innerHTML = html;
}

function aeLoadCached(dateKey) {
  try {
    var raw = localStorage.getItem('aiExpo_' + dateKey);
    if (!raw) return null;
    var obj = JSON.parse(raw);
    return (obj && obj._v === 1 && aeNormalizePlan(obj.plan)) ? obj.plan : null;
  } catch (e) { return null; }
}

function aeSaveCached(dateKey, plan) {
  try {
    localStorage.setItem('aiExpo_' + dateKey, JSON.stringify({ _v: 1, date: dateKey, plan: plan }));
  } catch (e) {}
}

async function aeGenerate(force) {
  if (AE.running) return;
  AE.running = true;
  var c = document.getElementById('aiExpoContent');
  var dateKey = aeTodayKey();
  if (!force) {
    var cached = aeLoadCached(dateKey);
    if (cached) {
      AE.data = cached; AE.dateKey = dateKey;
      aeRenderExpo(c, cached, { dateBadge: '今日展览 · ' + dateKey });
      AE.running = false;
      return;
    }
  }
  aeShowLoading(c, '正在策展今日展览…');
  var names = [];
  try { names = await aeFetchAircraftNames(); } catch (e) { names = aeCollectAircraftNames(); }
  try {
    var r = await aeCall(aeBuildPrompt(dateKey, names), 2048);
    var plan = aeNormalizePlan(r.parsed);
    if (!plan) {
      aeRenderError(c, r, 'AI 返回内容无法解析，请点击「换今日主题」重试');
      AE.running = false;
      return;
    }
    aeSaveCached(dateKey, plan);
    AE.data = plan; AE.dateKey = dateKey;
    aeRenderExpo(c, plan, { dateBadge: '今日展览 · ' + dateKey });
    if (r.degraded) {
      var note = document.createElement('div');
      note.className = 'expo-note';
      note.textContent = 'AI 繁忙，已切换兜底模型生成';
      c.appendChild(note);
    }
  } catch (err) {
    aeRenderError(c, null, (err && err.name === 'AbortError') ? '请求超时，请点击「换今日主题」重试' : '生成失败，请点击「换今日主题」重试');
  }
  AE.running = false;
}

function openAiExpo() {
  saveScrollState();
  document.getElementById('aiExpoOverlay').classList.add('visible');
  document.body.style.overflow = 'hidden';
  aeGenerate(false);
}

function closeAiExpo() {
  aeAbortRunning();
  document.getElementById('aiExpoOverlay').classList.remove('visible');
  document.body.style.overflow = '';
  restoreScrollState();
}

function expoRegen() {
  if (AE.running) return;
  aeGenerate(true);
}

function expoCopy() {
  var p = AE.data;
  if (!p) { aeToastHint('暂无策展文案可复制'); return; }
  var lines = [];
  lines.push('【AI 策划展 · ' + (AE.dateKey || aeTodayKey()) + '】');
  lines.push('主题：' + (p.title || ''));
  if (p.brief) lines.push('简介：' + p.brief);
  if (p.items && p.items.length) {
    lines.push('展品：');
    p.items.forEach(function (it) { lines.push('· ' + (it.name || '') + '：' + (it.highlight || '')); });
  }
  if (p.guide && p.guide.length) {
    lines.push('观展攻略：');
    p.guide.forEach(function (g) { lines.push('· ' + g); });
  }
  if (p.tags && p.tags.length) lines.push('标签：#' + p.tags.join(' #'));
  var text = lines.join('\n');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () { aeToastHint('已复制策展文案'); }, function () { aeLegacyCopy(text); });
  } else {
    aeLegacyCopy(text);
  }
}

function aeLegacyCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); aeToastHint('已复制策展文案'); } catch (e) { aeToastHint('复制失败，请手动复制'); }
  document.body.removeChild(ta);
}
