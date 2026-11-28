
(function() {
  var currentVersion = document.body.getAttribute('data-version');
  if (!currentVersion) return;

  var CHECK_INTERVAL = 15000;  // 15s 基础间隔
  var RELOAD_DELAY = 1500;     // 1.5s 倒计时
  var RETRY_BACKOFF = 60000;   // 失败后退避 60s
  var timerId = null;
  var failCount = 0;
  var checking = false;

  function showToast(msg) {
    var existing = document.getElementById('versionToast');
    if (existing) existing.remove();
    var toast = document.createElement('div');
    toast.id = 'versionToast';
    toast.textContent = msg;
    toast.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:99999;'
      + 'background:rgba(10,25,47,0.95);color:#64ffda;padding:16px 32px;border-radius:8px;'
      + 'font-size:16px;font-weight:600;box-shadow:0 8px 32px rgba(0,0,0,0.5);'
      + 'border:1px solid rgba(100,255,218,0.3);pointer-events:none;';
    document.body.appendChild(toast);
  }

  function scheduleNext(delay) {
    if (timerId) clearTimeout(timerId);
    timerId = setTimeout(checkVersion, delay);
  }

  function checkVersion() {
    if (checking) return;
    checking = true;
    fetch(location.pathname + '?v=' + Date.now() + '&' + Math.random().toString(36).slice(2), {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
    })
      .then(function(res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function(html) {
        failCount = 0;
        var match = html.match(/data-version="([^"]*)"/);
        if (match && match[1] !== currentVersion) {
          showToast('\u53d1\u73b0\u65b0\u7248\u672c\uff0c\u5373\u5c06\u5237\u65b0...');
          setTimeout(function() { location.reload(true); }, RELOAD_DELAY);
          return;
        }
        scheduleNext(CHECK_INTERVAL);
      })
      .catch(function() {
        failCount++;
        var delay = failCount >= 3 ? RETRY_BACKOFF : CHECK_INTERVAL * failCount;
        scheduleNext(delay);
      })
      .finally(function() { checking = false; });
  }

  // 页面从后台切回前台时立即检测
  document.addEventListener('visibilitychange', function() {
    if (!document.hidden && !checking) {
      if (timerId) { clearTimeout(timerId); timerId = null; }
      checkVersion();
    }
  });

  checkVersion();
})();

// 隐私政策弹窗
function openPrivacyPolicy() {
  var o = document.getElementById('privacyOverlay');
  if (o) o.classList.add('show');
}
function closePrivacyPolicy() {
  var o = document.getElementById('privacyOverlay');
  if (o) o.classList.remove('show');
}
function privacyBackdrop(e) {
  if (e && e.target && e.target.id === 'privacyOverlay') closePrivacyPolicy();
}
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closePrivacyPolicy();
  if (e.key === 'Escape') closeFeedback();
  if (e.key === 'Escape') closeLetter();
});

/* ===== 一封信 ===== */
var letterMusicCtx = null;
var letterMasterGain = null;
var letterMusicTimer = null;
var letterMusicStep = 0;
var letterMusicPlaying = false;
/* 抒情琶音：C - G - Am - F 分解和弦循环 */
var letterChordProg = [
  [261.63, 329.63, 392.00, 523.25],
  [196.00, 246.94, 293.66, 392.00],
  [220.00, 261.63, 329.63, 440.00],
  [174.61, 220.00, 261.63, 349.23]
];
function letterGetCtx() {
  if (!letterMusicCtx) {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    letterMusicCtx = new AC();
    letterMasterGain = letterMusicCtx.createGain();
    letterMasterGain.gain.value = 0.0001;
    letterMasterGain.connect(letterMusicCtx.destination);
  }
  return letterMusicCtx;
}
function letterNote(freq, t0, dur, vol) {
  var ctx = letterMusicCtx;
  if (!ctx) return;
  var osc = ctx.createOscillator();
  var gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.5);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain); gain.connect(letterMasterGain);
  osc.start(t0); osc.stop(t0 + dur + 0.1);
}
function letterSchedule() {
  var ctx = letterGetCtx();
  if (!ctx || !letterMusicPlaying) return;
  var chord = letterChordProg[Math.floor(letterMusicStep / 4) % letterChordProg.length];
  var note = chord[letterMusicStep % 4];
  var t = ctx.currentTime + 0.08;
  letterNote(note, t, 1.9, 0.07);
  letterNote(note * 0.5, t, 2.4, 0.035);
  letterMusicStep++;
  letterMusicTimer = setTimeout(letterSchedule, 720);
}
function startLetterMusic() {
  var ctx = letterGetCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  var t = ctx.currentTime;
  var g = letterMasterGain.gain;
  g.cancelScheduledValues(t);
  g.setValueAtTime(Math.max(g.value, 0.0001), t);
  g.exponentialRampToValueAtTime(1, t + 0.7);
  letterMusicPlaying = true;
  if (!letterMusicTimer) letterSchedule();
}
function stopLetterMusic() {
  letterMusicPlaying = false;
  if (letterMusicTimer) { clearTimeout(letterMusicTimer); letterMusicTimer = null; }
  var ctx = letterMusicCtx;
  if (!ctx || ctx.state !== 'running') return;
  var t = ctx.currentTime;
  var g = letterMasterGain.gain;
  g.cancelScheduledValues(t);
  g.setValueAtTime(Math.max(g.value, 0.0001), t);
  g.exponentialRampToValueAtTime(0.0001, t + 1.1);
  setTimeout(function() {
    if (ctx.state === 'running') ctx.suspend();
  }, 1250);
}
function openLetter() {
  var o = document.getElementById('letterOverlay');
  if (o) o.classList.add('visible');
  if (!letterMusicPlaying) startLetterMusic();
  var btn = document.getElementById('letterMusicBtn');
  if (btn) btn.classList.add('active');
  var onI = document.getElementById('letterMusicIconOn');
  var offI = document.getElementById('letterMusicIconOff');
  if (onI) onI.style.display = '';
  if (offI) offI.style.display = 'none';
}
function closeLetter() {
  var o = document.getElementById('letterOverlay');
  if (o) o.classList.remove('visible');
  stopLetterMusic();
  var btn = document.getElementById('letterMusicBtn');
  if (btn) btn.classList.remove('active');
}
function letterBackdrop(e) {
  if (e && e.target && e.target.id === 'letterOverlay') closeLetter();
}
function toggleLetterMusic(e) {
  if (e) e.stopPropagation();
  if (letterMusicPlaying) {
    stopLetterMusic();
    var btn = document.getElementById('letterMusicBtn');
    if (btn) btn.classList.remove('active');
    var onI = document.getElementById('letterMusicIconOn');
    var offI = document.getElementById('letterMusicIconOff');
    if (onI) onI.style.display = 'none';
    if (offI) offI.style.display = '';
  } else {
    startLetterMusic();
    var btn2 = document.getElementById('letterMusicBtn');
    if (btn2) btn2.classList.add('active');
    var onI2 = document.getElementById('letterMusicIconOn');
    var offI2 = document.getElementById('letterMusicIconOff');
    if (onI2) onI2.style.display = '';
    if (offI2) offI2.style.display = 'none';
  }
}
document.addEventListener('DOMContentLoaded', function() {
  var lb = document.getElementById('letterBtn');
  if (lb) lb.addEventListener('click', openLetter);
});

/* ============================================================
   三期模块：照片拖拽上传 / AI 智能填写 / 重复校验 / 推荐 / 已采纳机型 / 快讯接口
   说明：全部函数为全局函数，供 buildAddForm / submitCustomAircraft / loadNewsPanel 调用
   ============================================================ */
var P3_API_BASE = 'https://henry126923-admincenter.pages.dev';
var P3_ANON_UID_KEY = 'aviation_anon_uid_v1';
var P3_APPROVED_ID_BASE = 900000;
var P3_IMAGE_MAX_BYTES = 300 * 1024;
var P3_REC_LOCAL_KEY = 'aviation_my_rec_v1';

/* ---------- 基础工具 ---------- */
function p3GetAnonUid() {
  try {
    var uid = localStorage.getItem(P3_ANON_UID_KEY);
    if (!uid) {
      uid = 'anon-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(P3_ANON_UID_KEY, uid);
    }
    return uid;
  } catch (e) {
    return 'anon-temp-' + Math.random().toString(36).slice(2, 10);
  }
}

function p3NormCode(s) {
  return String(s || '').toLowerCase().replace(/[\s\-_·]/g, '');
}

function p3Get(path) {
  return fetch(P3_API_BASE + path, {
    method: 'GET',
    cache: 'no-store',
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(8000)
  }).then(function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}

function p3Post(path, data) {
  return fetch(P3_API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(12000)
  }).then(function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}

function p3PickList(res) {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  return res.items || res.data || res.list || res.recommendations || res.aircrafts || res.news || [];
}

/* ============================================================
   一、照片拖拽上传区（复用 paCompressImage 站内压缩能力）
   ============================================================ */
var afImageState = { dataUrl: '', size: 0, name: '' };

function afBuildImageBlock() {
  return '<div class="af-drop-zone" id="afDropZone">' +
      '<svg viewBox="0 0 24 24" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
        '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>' +
      '<div>拖入照片 / 点击选择 / 粘贴截图</div>' +
      '<div class="af-hint" id="afHint">自动压缩至最长边 1024px · JPEG 0.85</div>' +
    '</div>' +
    '<input type="file" id="af_file" accept="image/*" style="display:none">' +
    '<div class="af-thumb-wrap" id="afThumbWrap">' +
      '<img id="af_thumb" alt="预览">' +
      '<button type="button" class="af-thumb-del" onclick="afClearImage()" title="移除图片">&#215;</button>' +
    '</div>' +
    '<input id="af_image" placeholder="或粘贴图片 URL https://...">' +
    '<button type="button" class="ai-fill-btn" id="af_nameAiBtn" onclick="afAiFillByName()">' +
      '<svg viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M12 3l1.9 4.6 4.6 1.9-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/></svg>AI 自动填写</button>' +
    '<div class="af-hint" id="afAiHint"></div>';
}

function afSetHint(msg, warn) {
  var h = document.getElementById('afHint');
  if (!h) return;
  h.textContent = msg || '';
  if (warn) h.classList.add('warn'); else h.classList.remove('warn');
}

function afSetAiHint(msg, warn) {
  var h = document.getElementById('afAiHint');
  if (!h) return;
  h.textContent = msg || '';
  if (warn) h.classList.add('warn'); else h.classList.remove('warn');
}

function afApplyImage(file) {
  if (!file) return;
  if (!/^image\//.test(file.type || '')) { afSetAiHint('请选择图片文件（JPG / PNG / WebP）', true); return; }
  afSetAiHint('正在压缩处理…');
  paCompressImage(file, function(dataUrl) {
    if (!dataUrl) { afSetAiHint('图片处理失败，请换一张重试', true); return; }
    afImageState.dataUrl = dataUrl;
    afImageState.name = file.name || '';
    var b64 = dataUrl.split(',')[1] || '';
    afImageState.size = Math.round(b64.length * 3 / 4);
    var thumb = document.getElementById('af_thumb');
    var wrap = document.getElementById('afThumbWrap');
    if (thumb && wrap) { thumb.src = dataUrl; wrap.classList.add('show'); }
    if (afImageState.size > P3_IMAGE_MAX_BYTES) {
      afSetHint('压缩后约 ' + Math.round(afImageState.size / 1024) + ' KB，已超过 300 KB 上限，可能无法保存到本机，建议换一张更小的图片', true);
    } else {
      afSetHint('已就绪：' + Math.round(afImageState.size / 1024) + ' KB · 最长边 1024px / JPEG 0.85');
    }
    afSetAiHint('照片已就绪，提交时会随推荐一起上传');
  });
}

function afBindImageDrop() {
  var zone = document.getElementById('afDropZone');
  var fileInput = document.getElementById('af_file');
  var urlInput = document.getElementById('af_image');
  if (!zone || !fileInput) return;

  zone.addEventListener('click', function(e) {
    if (e.target && e.target.closest && e.target.closest('.af-thumb-wrap')) return;
    fileInput.click();
  });
  fileInput.addEventListener('change', function() {
    if (fileInput.files && fileInput.files[0]) afApplyImage(fileInput.files[0]);
    fileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach(function(ev) {
    zone.addEventListener(ev, function(e) {
      e.preventDefault(); e.stopPropagation();
      zone.classList.add('dragover');
    });
  });
  zone.addEventListener('dragleave', function(e) {
    e.preventDefault(); e.stopPropagation();
    if (e.relatedTarget && zone.contains(e.relatedTarget)) return;
    zone.classList.remove('dragover');
  });
  zone.addEventListener('drop', function(e) {
    e.preventDefault(); e.stopPropagation();
    zone.classList.remove('dragover');
    var dt = e.dataTransfer;
    if (!dt) return;
    if (dt.files && dt.files.length) { afApplyImage(dt.files[0]); return; }
    var txt = dt.getData('text/uri-list') || dt.getData('text/plain');
    if (txt && /^https?:\/\//i.test(txt.trim())) {
      if (urlInput) urlInput.value = txt.trim();
      afSetHint('已读取图片链接，可直接提交或点击「AI 智能填写」补全信息');
    }
  });
  if (urlInput) {
    urlInput.addEventListener('input', function() {
      if (urlInput.value.trim()) afSetHint('使用图片链接，保存后按原链接加载');
    });
  }
  if (!window.__p3PasteBound) {
    window.__p3PasteBound = true;
    document.addEventListener('paste', function(e) {
      var ov = document.getElementById('addModalOverlay');
      if (!ov || !ov.classList.contains('show')) return;
      if (!e.clipboardData) return;
      var items = e.clipboardData.items || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image') === 0) {
          var f = items[i].getAsFile();
          if (f) { afApplyImage(f); e.preventDefault(); return; }
        }
      }
    });
  }
}

function afResetImageState() {
  afImageState.dataUrl = '';
  afImageState.size = 0;
  afImageState.name = '';
}

function afClearImage() {
  afImageState.dataUrl = '';
  afImageState.size = 0;
  afImageState.name = '';
  var thumb = document.getElementById('af_thumb');
  if (thumb) thumb.removeAttribute('src');
  var wrap = document.getElementById('afThumbWrap');
  if (wrap) wrap.classList.remove('show');
  afAskReset();
  afSetAiHint('');
  afSetHint('已移除图片，可重新拖入 / 选择 / 粘贴');
}

function afGetImageValue() {
  if (afImageState.dataUrl) return afImageState.dataUrl;
  var el = document.getElementById('af_image');
  return el ? (el.value || '').trim() : '';
}

/* ============================================================
   二、AI 智能填写（照片识机 + 字段补全 + 简介生成）
   ============================================================ */
function afSetField(id, val) {
  var el = document.getElementById(id);
  if (el && val) el.value = val;
}

function afFillFromAircraft(a, json) {
  afSetField('af_nameZh', String(t(a.name)).replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, ''));
  afSetField('af_code', a.code || '');
  afSetField('af_country', a.country || '');
  var catEl = document.getElementById('af_category');
  if (catEl && a.category) catEl.value = a.category;
  var sp = p3NormSpecs(a.specs);
  afSetField('af_speed', sp['cruise_speed'] || sp['max_speed'] || '');
  afSetField('af_range', sp['range'] || '');
  afSetField('af_capacity', sp['capacity'] || '');
  afSetField('af_wingspan', sp['wingspan'] || sp['rotor_diameter'] || '');
  var urlEl = document.getElementById('af_image');
  if (urlEl && !afImageState.dataUrl && !urlEl.value && a.image) urlEl.value = a.image;
}

function afGenDesc(a, reason, maker, cat) {
  var p = '请用中文写一段 60-90 字的航空机型简介。机型：' + t(a.name) + '（' + (a.code || '') + '，' + (a.country || '') + '）；关键规格：' + JSON.stringify(p3NormSpecs(a.specs)) +
    (reason ? '；外观识别依据：' + reason : '') +
    ((maker || cat) ? '；用户已确认线索：制造商 ' + (maker || '未确认') + '、类别 ' + (cat || '未确认') : '') +
    '。要求：只输出简介正文，不要标题、不要分点、不要换行、不要引号。';
  return AIBridge.chat({
    tier: 'light',
    feature: 'aircraft_desc',
    messages: [{ role: 'user', content: p }],
    temperature: 0.6,
    max_tokens: 240,
    timeout: (AI_CONFIG.timeout || 45000) + 10000
  }).then(function(d) {
    var txt = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
    txt = String(txt).replace(/\s+/g, ' ').trim().replace(/^["「']|["」']$/g, '');
    var el = document.getElementById('af_descZh');
    if (el && txt) el.value = txt.slice(0, 200);
  }).catch(function() {
    var el = document.getElementById('af_descZh');
    if (el && !el.value) el.value = paShortDesc(t(a.desc), 70);
  });
}

/* ---- 引导问答：上传照片后先问 2 题，答案与照片一起送大模型 ---- */
var afAskState = { step: 0, value: '', maker: '', cat: '', answered: false, running: false };
var AF_ASK_MAKERS = ['波音', '空客', '中国商飞', '其他'];
var AF_ASK_CATS = ['窄体', '宽体', '支线', '货机', '公务机', '其他'];

function afAskReset() {
  afAskState.step = 0;
  afAskState.value = '';
  afAskState.maker = '';
  afAskState.cat = '';
  afAskState.answered = false;
  var el = document.getElementById('afAsk');
  if (el) el.classList.remove('show');
}

function afAskOpen() {
  if (!document.getElementById('afAsk')) return;
  afAskReset();
  afAskRender(1);
  var el = document.getElementById('afAsk');
  if (el) el.classList.add('show');
}

function afAskRender(step) {
  var stepEl = document.getElementById('afAskStep');
  var titleEl = document.getElementById('afAskTitle');
  var optsEl = document.getElementById('afAskOpts');
  var inputEl = document.getElementById('afAskInput');
  var nextBtn = document.getElementById('afAskNext');
  if (!optsEl) return;
  afAskState.step = step;
  afAskState.value = '';
  var opts = step === 1 ? AF_ASK_MAKERS : AF_ASK_CATS;
  if (stepEl) stepEl.textContent = '第 ' + step + ' 题 / 共 2 题';
  if (titleEl) titleEl.textContent = step === 1
    ? '这架飞机的制造商是？（帮 AI 缩小检索范围）'
    : '这架飞机属于哪一类？（可再手动补充系列名）';
  optsEl.innerHTML = opts.map(function(v) {
    return '<button type="button" class="af-chip" data-v="' + v + '" onclick="afAskPick(this)">' + v + '</button>';
  }).join('');
  if (inputEl) {
    inputEl.value = '';
    inputEl.classList.toggle('show', step === 2);
    inputEl.placeholder = step === 1
      ? '手动输入制造商，如 巴西航空工业 / 图波列夫'
      : '可补充系列名 / 具体型号，如 737 MAX（选填）';
  }
  if (nextBtn) nextBtn.textContent = step === 1 ? '下一步' : '开始识别';
}

function afAskPick(btn) {
  var optsEl = document.getElementById('afAskOpts');
  if (optsEl) {
    var chips = optsEl.querySelectorAll('.af-chip');
    for (var i = 0; i < chips.length; i++) chips[i].classList.remove('selected');
  }
  btn.classList.add('selected');
  afAskState.value = btn.getAttribute('data-v') || '';
  var inputEl = document.getElementById('afAskInput');
  if (inputEl && afAskState.step === 1) {
    if (afAskState.value === '其他') { inputEl.classList.add('show'); inputEl.focus(); }
    else { inputEl.classList.remove('show'); inputEl.value = ''; }
  }
}

function afAskNext() {
  var inputEl = document.getElementById('afAskInput');
  var typed = inputEl ? (inputEl.value || '').trim() : '';
  var v = afAskState.value || '';
  if (afAskState.step === 1) {
    if (v === '其他' || !v) v = typed || (v === '其他' ? '' : v);
    if (!v) { afSetAiHint('请选择制造商，或选「其他」后手动输入名称', true); return; }
    afAskState.maker = v;
    afSetAiHint('');
    afAskRender(2);
    return;
  }
  if (!v && !typed) { afSetAiHint('请选择机型类别，或手动输入系列名', true); return; }
  if (v && v !== '其他' && typed) afAskState.cat = v + ' · 系列：' + typed;
  else afAskState.cat = (v && v !== '其他') ? v : (typed || '其他');
  afAskState.answered = true;
  var el = document.getElementById('afAsk');
  if (el) el.classList.remove('show');
  afRunPhotoAi();
}

function afSkipAsk() {
  afAskState.maker = '';
  afAskState.cat = '';
  afAskState.answered = false;
  var el = document.getElementById('afAsk');
  if (el) el.classList.remove('show');
  afRunPhotoAi();
}

function afRunPhotoAi() {
  var btn = document.getElementById('af_aiBtn');
  if (afAskState.running) return;
  if (!afImageState.dataUrl) {
    afSetAiHint('请先拖入或粘贴一张飞机照片，再使用 AI 智能填写', true);
    return;
  }
  afAskState.running = true;
  if (btn) btn.disabled = true;
  var hintList = [afAskState.maker, afAskState.cat].filter(function(x) { return !!x; }).join(' / ');
  afSetAiHint(hintList ? ('AI 正在结合照片与你的选择（' + hintList + '）识别机型…') : 'AI 正在识别机型…');
  paCallAI(afImageState.dataUrl, PA_SERIES, afAskState.maker, afAskState.cat).then(function(json) {
    var series = null;
    if (json && json.series) {
      var idx = parseInt(json.series, 10);
      if (idx > 0 && idx <= PA_SERIES.length) series = PA_SERIES[idx - 1];
    }
    if (!series) throw new Error('nodetect');
    var targetId = series.members[0];
    if (json && json.sub) {
      var subId = parseInt(json.sub, 10);
      if (series.members.indexOf(subId) >= 0) targetId = subId;
    }
    var a = aircrafts.find(function(x) { return x.id === targetId; });
    if (!a) throw new Error('nodetect');
    afFillFromAircraft(a, json);
    afSetAiHint('已识别：' + t(a.name) + (json && json.confidence ? '（置信度 ' + json.confidence + '%）' : '') + '，正在生成中文简介…');
    return afGenDesc(a, (json && json.reason) || '', afAskState.maker, afAskState.cat).then(function() {
      var dup = recFindDuplicate(document.getElementById('af_code') ? document.getElementById('af_code').value : '', document.getElementById('af_nameZh') ? document.getElementById('af_nameZh').value : '');
      afSetAiHint(dup
        ? '已自动填写完成。注意：站内已有该机型（' + t(dup.name) + ' · ' + dup.code + '），无需重复添加'
        : '已自动填写完成，请核对后提交', !!dup);
      afAskState.running = false;
      if (btn) btn.disabled = false;
    });
  }).catch(function() {
    afAskState.running = false;
    if (btn) btn.disabled = false;
    afSetAiHint('AI 识别失败或无法确定机型，请手动填写，或换一张更清晰的照片', true);
  });
}

function afAiFill() {
  var btn = document.getElementById('af_aiBtn');
  if (btn && btn.disabled) return;
  afSetAiHint('');
  if (!afImageState.dataUrl) {
    afSetAiHint('请先拖入或粘贴一张飞机照片，再使用 AI 智能填写', true);
    return;
  }
  if (!afAskState.answered) {
    var el = document.getElementById('afAsk');
    if (!afAskState.step) afAskRender(1);
    if (el) el.classList.add('show');
    afSetAiHint('请先回答下面 2 个问题：AI 会结合答案与照片一起识别，准确率更高', false);
    return;
  }
  afRunPhotoAi();
}

/* ---- 自定义机型名称：AI 查询资料并回填 ---- */
var AF_CAT_MAP = { '窄体': 'civil', '宽体': 'civil', '支线': 'civil', '公务机': 'civil', '货机': 'transport', '运输机': 'transport' };

function afSetNameAiHint(msg, warn) {
  var h = document.getElementById('af_nameAiHint');
  if (!h) return;
  h.textContent = msg || '';
  if (warn) h.classList.add('warn'); else h.classList.remove('warn');
}

function afAiFillByName() {
  var input = document.getElementById('af_customName');
  var btn = document.getElementById('af_nameAiBtn');
  if (btn && btn.disabled) return;
  var name = input ? (input.value || '').trim() : '';
  if (!name) { afSetNameAiHint('请先输入机型名称（如 波音 777-300ER、A350-900、C919），再点击 AI 自动填写', true); return; }
  if (btn) btn.disabled = true;
  afSetNameAiHint('AI 正在查询「' + name + '」的机型资料…');
  var prompt = '你是民航机型资料助手。请根据用户给出的机型名称，输出该机型的标准资料。用户输入的机型名称是：「' + name + '」。\n' +
    '严格只输出一个 JSON 对象（不要输出任何解释、不要 Markdown 代码块），字段如下：\n' +
    '{"nameZh":"中文名称，含制造商，如 波音 777-300ER","nameEn":"英文名称，如 Boeing 777-300ER","maker":"制造商，如 波音 / 空客 / 中国商飞 / 巴西航空工业","category":"类别，只能是 窄体、宽体、支线、货机、公务机 之一","country":"研制国家或地区，如 美国","firstFlight":"首飞年份，4 位数字，如 1994","capacity":"典型座位数，如 300-368 人","range":"航程，如 15,200 km","desc":"中文简介 60-90 字，只写正文"}\n' +
    '要求：1) 名称指向具体子型号时，给出该子型号的资料；2) 无法确认或机型不存在时，只输出 {"error":"unknown"}；3) 数字与单位要专业准确。';
  AIBridge.chat({
    tier: 'light',
    feature: 'aircraft_fill',
    messages: [
      { role: 'system', content: '你是民航机型资料专家，只输出严格合法的 JSON。' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.2,
    max_tokens: 600,
    timeout: (AI_CONFIG.timeout || 45000) + 10000
  }).then(function(d) {
    var text = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
    var m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('bad response');
    var json = JSON.parse(m[0]);
    if (json.error || (!json.nameZh && !json.nameEn)) throw new Error('unknown');
    if (btn) btn.disabled = false;
    afApplyNameAi(json, name);
  }).catch(function() {
    if (btn) btn.disabled = false;
    afSetNameAiHint('AI 未能获取「' + name + '」的资料（名称不准确或网络异常），请手动填写，或换成更完整的名称（如 波音 777-300ER）重试', true);
  });
}

function afApplyNameAi(json, queryName) {
  afSetField('af_nameZh', json.nameZh || json.nameEn || '');
  afSetField('af_code', json.nameEn || json.nameZh || '');
  afSetField('af_maker', json.maker || '');
  afSetField('af_country', json.country || '');
  afSetField('af_catText', json.category || '');
  var catEl = document.getElementById('af_category');
  if (catEl) {
    var catVal = AF_CAT_MAP[String(json.category || '').trim()];
    if (catVal) catEl.value = catVal;
  }
  var year = String(json.firstFlight || '').replace(/[^0-9]/g, '');
  if (year) afSetField('af_prodDate', year.slice(0, 4));
  afSetField('af_capacity', json.capacity || '');
  afSetField('af_range', json.range || '');
  afSetField('af_descZh', json.desc || '');
  var dup = recFindDuplicate(json.nameEn || '', json.nameZh || '');
  if (dup) {
    afSetNameAiHint('已自动填写完成。注意：站内已有该机型（' + t(dup.name) + ' · ' + dup.code + '），无需重复添加', true);
  } else {
    afSetNameAiHint('已自动填写完成（查询词：' + queryName + '），请核对后提交', false);
  }
}

/* ============================================================
   三、站内机型库查重
   ============================================================ */
function recFindDuplicate(code, nameZh) {
  var nc = p3NormCode(code);
  var nn = p3NormCode(nameZh);
  if (!nc && !nn) return null;
  for (var i = 0; i < aircrafts.length; i++) {
    var a = aircrafts[i];
    var ac = p3NormCode(a.code);
    var an = p3NormCode(t(a.name));
    if (nc && ac) {
      if (ac === nc) return a;
      if (ac.indexOf(nc) >= 0 || nc.indexOf(ac) >= 0) return a;
    }
    if (nn && an && an === nn) return a;
  }
  return null;
}

/* ============================================================
   四、推荐确认弹窗 / 我的推荐
   ============================================================ */
var recState = { aircraft: null, submitting: false };

function recSetStatus(msg, type) {
  var el = document.getElementById('recAskStatus');
  if (!el) return;
  el.className = 'rec-ask-status' + (msg ? ' show ' + (type || 'info') : '');
  el.textContent = msg || '';
}

function recSetButtons(mode) {
  var yes = document.getElementById('recAskYesBtn');
  var no = document.getElementById('recAskNoBtn');
  if (yes) {
    if (mode === 'done' || mode === 'declined') { yes.style.display = 'none'; }
    else { yes.style.display = ''; yes.disabled = false; yes.textContent = '是'; }
  }
  if (no) {
    no.textContent = (mode === 'done' || mode === 'declined') ? '关闭' : '否';
    no.setAttribute('onclick', (mode === 'done' || mode === 'declined') ? 'closeRecommendAsk()' : 'recAskDecline()');
  }
}

function recOpenAsk(aircraft, opts) {
  opts = opts || {};
  var el = document.getElementById('recommendOverlay');
  if (!el || !aircraft) return;
  recState.aircraft = aircraft;
  recState.submitting = false;
  var info = document.getElementById('recAskAircraft');
  if (info) {
    var img = aircraft.image ? ('<img src="' + (aircraft.image.indexOf('data:') === 0 ? aircraft.image : proxyUrl(aircraft.image)) + '" alt="" onerror="this.style.display=\'none\'">') : '';
    info.innerHTML = '<div><strong>' + t(aircraft.name) + '</strong></div>' +
      '<div>' + (aircraft.code || '') + ' · ' + (aircraft.country || '--') + '</div>' + img;
  }
  var tip = opts.localSaveFailed ? '注意：本机浏览器存储空间不足，该机型未能写入本机缓存，但仍可直接推荐给站长审核。' : '';
  recSetStatus(tip, tip ? 'err' : 'info');
  var yes = document.getElementById('recAskYesBtn');
  var no = document.getElementById('recAskNoBtn');
  if (yes) { yes.style.display = ''; yes.disabled = false; yes.textContent = '是'; yes.setAttribute('onclick', 'recAskAccept()'); }
  if (no) { no.textContent = '否'; no.setAttribute('onclick', 'recAskDecline()'); }
  el.classList.add('visible');
  document.body.style.overflow = 'hidden';
}

function closeRecommendAsk() {
  var el = document.getElementById('recommendOverlay');
  if (el) el.classList.remove('visible');
  syncBodyScrollLock();
}

function recBackdrop(e) {
  if (e && e.target === e.currentTarget) closeRecommendAsk();
}

function p3BuildPayload(a) {
  return {
    uid: p3GetAnonUid(),
    submittedAt: new Date().toISOString(),
    nameZh: t(a.name),
    code: a.code || '',
    category: a.category || '',
    country: a.country || '--',
    image: a.image || '',
    descZh: i18n.zh[a.desc] || '',
    specs: p3NormSpecs(a.specs),
    prodDate: a.prodDate || '',
    airlineIds: a.airlineIds || []
  };
}

function recAskAccept() {
  if (recState.submitting || !recState.aircraft) return;
  var a = recState.aircraft;
  recState.submitting = true;
  var yes = document.getElementById('recAskYesBtn');
  if (yes) { yes.disabled = true; yes.textContent = '是'; }
  recSetStatus('正在把推荐提交给站长，请稍候…', 'info');
  var payload = p3BuildPayload(a);
  p3Post('/api/recommend', payload).then(function(res) {
    recState.submitting = false;
    var rid = (res && (res.id || res.recId || res.recordId)) || '';
    var rec = { id: String(rid || ''), nameZh: payload.nameZh, code: payload.code, category: payload.category,
      country: payload.country, image: payload.image, ts: Date.now(), status: 'pending', reply: '', remote: true };
    p3SaveLocalRec(rec);
    recSetStatus('推荐已提交成功。站长审核通过后，这架机型有机会展示在公开首页，并标注「该机型为用户添加」。可点击页面底部「我的推荐」查看审核进度。', 'ok');
    recSetButtons('done');
  }).catch(function() {
    recState.submitting = false;
    var rec = { id: '', nameZh: payload.nameZh, code: payload.code, category: payload.category,
      country: payload.country, image: payload.image, ts: Date.now(), status: 'pending', reply: '', remote: false };
    p3SaveLocalRec(rec);
    if (yes) { yes.disabled = false; yes.textContent = '是'; }
    recSetStatus('推荐提交失败（网络或后台暂时不可用）。这架机型已经保存在本机，稍后可点击页面底部「我的推荐」重新提交。', 'err');
  });
}

function recAskDecline() {
  recSetStatus('好的，这架机型已保存在本机，不会提交到公开网页。以后随时可以点击页面底部「我的推荐」再次推荐。', 'info');
  recSetButtons('declined');
}

/* ---------- 本地推荐记录 ---------- */
function p3LoadLocalRecs() {
  try {
    var arr = JSON.parse(localStorage.getItem(P3_REC_LOCAL_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function p3SaveLocalRec(rec) {
  try {
    var arr = p3LoadLocalRecs();
    arr.unshift(rec);
    localStorage.setItem(P3_REC_LOCAL_KEY, JSON.stringify(arr.slice(0, 100)));
  } catch (e) {}
}

function p3StatusText(s) {
  if (s === 'approved') return '已采纳';
  if (s === 'rejected') return '未通过';
  return '待审核';
}

function p3StatusClass(s) {
  if (s === 'approved') return 'approved';
  if (s === 'rejected') return 'rejected';
  return 'pending';
}

function p3RenderRecList(remote, local) {
  var box = document.getElementById('myRecList');
  if (!box) return;
  var map = {};
  var order = [];
  (remote || []).forEach(function(r) {
    var key = String(r.id || r.recId || r.code || '').toLowerCase();
    if (!key) return;
    if (!map[key]) { map[key] = Object.assign({}, r); order.push(key); }
  });
  (local || []).slice().reverse().forEach(function(l) {
    var key = String(l.id || '').toLowerCase();
    if (!key) key = 'local-' + String(l.code || '').toLowerCase() + '-' + (l.ts || 0);
    if (!map[key]) { map[key] = Object.assign({}, l); order.push(key); }
    else {
      if (!map[key].status || map[key].status === 'pending') map[key].status = l.status || map[key].status;
      if (!map[key].reply) map[key].reply = l.reply || '';
    }
  });

  var items = order.map(function(k) { return map[k]; }).sort(function(a, b) { return (b.ts || 0) - (a.ts || 0); });
  if (!items.length) {
    box.innerHTML = '<div class="rec-empty">你还没有推荐过机型。<br>在「添加机型」提交后选择「好的，推荐」，即可在这里查看进度。</div>';
    return;
  }
  box.innerHTML = items.map(function(it) {
    var st = String(it.status || 'pending').toLowerCase();
    var title = it.nameZh || it.name || '(未命名机型)';
    var meta = [it.code || '', it.country || '', it.ts ? new Date(it.ts).toLocaleString('zh-CN', { hour12: false }) : ''].filter(function(x) { return !!x && x !== '--'; }).join(' · ');
    var reply = it.reply || it.adminReply || '';
    var img = it.image ? ('<img src="' + (String(it.image).indexOf('data:') === 0 ? it.image : proxyUrl(it.image)) + '" alt="" style="max-width:100%;max-height:120px;border-radius:10px;margin-top:8px;display:block" onerror="this.style.display=\'none\'">') : '';
    return '<div class="rec-item">' +
      '<div class="rec-item-title">' + title + '<span class="rec-status ' + p3StatusClass(st) + '">' + p3StatusText(st) + '</span></div>' +
      (meta ? '<div class="rec-item-meta">' + meta + '</div>' : '') +
      img +
      (reply ? '<div class="rec-item-reply">站长反馈：' + reply + '</div>' : '') +
      '</div>';
  }).join('');
}

function openMyRecommendations() {
  var el = document.getElementById('myRecOverlay');
  if (!el) return;
  var box = document.getElementById('myRecList');
  if (box) box.innerHTML = '<div class="rec-loading">正在读取推荐记录…</div>';
  el.classList.add('visible');
  document.body.style.overflow = 'hidden';
  var local = p3LoadLocalRecs();
  p3Get('/api/my-recommendations?uid=' + encodeURIComponent(p3GetAnonUid())).then(function(res) {
    p3RenderRecList(p3PickList(res), local);
  }).catch(function() {
    p3RenderRecList([], local);
  });
}

function closeMyRecommendations() {
  var el = document.getElementById('myRecOverlay');
  if (el) el.classList.remove('visible');
  syncBodyScrollLock();
}

function myRecBackdrop(e) {
  if (e && e.target === e.currentTarget) closeMyRecommendations();
}

/* ============================================================
   五、已采纳机型合并（卡片 / 详情显示灰字）
   ============================================================ */
function p3MergeApproved(list) {
  var added = 0;
  list.forEach(function(item, i) {
    if (!item) return;
    var id = P3_APPROVED_ID_BASE + i;
    if (aircrafts.some(function(x) { return x.id === id; })) return;
    var nameKey = 'p3n_' + id;
    var descKey = 'p3d_' + id;
    var nameZh = item.nameZh || item.name || ('用户添加机型 ' + (i + 1));
    i18n.zh[nameKey] = nameZh;
    i18n.zh[descKey] = item.descZh || item.desc || '';
    aircrafts.push({
      id: id,
      name: nameKey,
      code: item.code || '--',
      category: item.category || 'civil',
      country: item.country || '--',
      image: item.image || '',
      desc: descKey,
      specs: p3NormSpecs(item.specs),
      airlineIds: item.airlineIds || [],
      slug: '',
      prodDate: item.prodDate || '',
      _userAdded: true
    });
    added++;
  });
  return added;
}

function p3LoadApprovedAircrafts() {
  if (window.__p3ApprovedLoaded) return true;
  var store = null;
  try { store = aircrafts; } catch (e) { return false; }
  if (!store || !store.length) return false;
  window.__p3ApprovedLoaded = true;
  p3Get('/api/aircrafts/approved').then(function(res) {
    var list = p3PickList(res);
    if (!list.length) return;
    if (p3MergeApproved(list) > 0) {
      try { renderCards(); } catch (e) {}
    }
  }).catch(function() {
    window.__p3ApprovedLoaded = false;
  });
  return true;
}

(function p3Boot() {
  function tick(tries) {
    if (!p3LoadApprovedAircrafts() && tries < 8) setTimeout(function() { tick(tries + 1); }, 1000);
  }
  function start() { setTimeout(function() { tick(0); }, 900); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

/* ============================================================
   六、航空快讯后端接口（先接接口，失败回退既有 RSS / 静态兜底）
   ============================================================ */
function p3TryBackendNews(content, today, shownTitles, shownUrls) {
  return p3Get('/api/news').then(function(res) {
    var raw = p3PickList(res);
    var list = raw.map(function(it) {
      return {
        title: it.title || '',
        snippet: it.snippet || it.summary || it.desc || it.content || '',
        pubDate: it.pubDate || it.date || today,
        link: it.link || it.url || '#',
        heat: (typeof it.heat === 'number') ? it.heat : 0,
        hot: !!it.hot,
        rank: (typeof it.rank === 'number') ? it.rank : 0
      };
    }).filter(function(it) { return !!it.title; });
    // 按已展示标题去重，避免「换一换」拿到同一批内容
    var unseen = list.filter(function(it) { return (shownTitles || []).indexOf(it.title) === -1; });
    list = (unseen.length >= 5 ? unseen : list).slice(0, 15);
    if (!list.length) throw new Error('empty');
    newsPanelItems = list;
    renderNewsContent(content, list);
    try {
      localStorage.setItem('aviationNewsHistory', JSON.stringify({
        date: today,
        shownTitles: (shownTitles || []).concat(list.map(function(x) { return x.title; })).slice(-200),
        shownUrls: (shownUrls || []).concat(list.map(function(x) { return x.link; })).slice(-200)
      }));
    } catch (e) {}
    return true;
  }).catch(function() {
    try { tryFetchRSSAndUpdate(content, today, shownTitles, shownUrls); } catch (e) {}
    return false;
  });
}

