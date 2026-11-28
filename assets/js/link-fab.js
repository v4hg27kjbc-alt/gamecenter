
(function () {
  var fab = document.getElementById('gcLinkFab');
  var panel = document.getElementById('gcLinkPanel');
  var mask = document.getElementById('gcLinkMask');
  if (!fab || !panel) return;
  function open() { panel.classList.add('on'); mask.classList.add('on'); }
  function close() { panel.classList.remove('on'); mask.classList.remove('on'); }
  fab.addEventListener('click', function () { panel.classList.contains('on') ? close() : open(); });
  mask.addEventListener('click', close);
  var cb = document.getElementById('gcLpClose'); if (cb) cb.addEventListener('click', close);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  var tabs = document.querySelectorAll('.gc-lp-tab');
  var panes = { onetap: 'gcLpOneTap', transfer: 'gcLpTransfer', receive: 'gcLpReceive' };
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].addEventListener('click', function (e) {
      var name = e.currentTarget.getAttribute('data-lp');
      for (var j = 0; j < tabs.length; j++) tabs[j].classList.toggle('on', tabs[j] === e.currentTarget);
      Object.keys(panes).forEach(function (k) {
        var el = document.getElementById(panes[k]);
        if (el) el.classList.toggle('on', k === name);
      });
    });
  }

  function msg(id, text, kind) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || '';
    el.className = 'gc-lp-msg' + (kind ? ' ' + kind : '');
  }
  function tk() { try { return localStorage.getItem('gc_acct_token') || ''; } catch (e) { return ''; } }

  /* ---------- 图片 / 文字速传 ---------- */
  var drop = document.getElementById('gcLpDrop');
  var fileInput = document.getElementById('gcLpFile');
  if (drop && fileInput) {
    drop.addEventListener('click', function () { fileInput.click(); });
    drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
    drop.addEventListener('drop', function (e) {
      e.preventDefault(); drop.classList.remove('over');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', function () { if (fileInput.files[0]) handleFile(fileInput.files[0]); });
  }
  function handleFile(f) {
    if (!/^image\//.test(f.type)) { msg('gcLpTransferMsg', '请选择图片文件', 'err'); return; }
    if (f.size > 1800000) { msg('gcLpTransferMsg', '图片过大（上限约 1.8MB），请压缩后再传', 'err'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      msg('gcLpTransferMsg', '正在上传…');
      fetch('/api/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'upload', kind: 'image', name: f.name, dataUrl: reader.result }) })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || !d.ok) { msg('gcLpTransferMsg', (d && d.message) || '上传失败', 'err'); return; }
          showShareCode(d.code);
          msg('gcLpTransferMsg', '已生成速传码，30 分钟内有效，在另一台设备「接收」里输入即可', 'ok');
        })
        .catch(function () { msg('gcLpTransferMsg', '网络异常，上传失败', 'err'); });
    };
    reader.readAsDataURL(f);
  }
  var sendText = document.getElementById('gcLpSendText');
  if (sendText) sendText.addEventListener('click', function () {
    var t = (document.getElementById('gcLpText').value || '').trim();
    if (!t) { msg('gcLpTransferMsg', '请先输入要传的文字', 'err'); return; }
    sendText.disabled = true;
    fetch('/api/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'upload', kind: 'text', text: t }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        sendText.disabled = false;
        if (!d || !d.ok) { msg('gcLpTransferMsg', (d && d.message) || '发送失败', 'err'); return; }
        showShareCode(d.code);
        msg('gcLpTransferMsg', '文字已生成速传码，30 分钟内有效', 'ok');
      })
      .catch(function () { sendText.disabled = false; msg('gcLpTransferMsg', '网络异常', 'err'); });
  });
  function showShareCode(code) {
    var el = document.getElementById('gcLpShareCode');
    if (!el) return;
    el.style.display = 'block';
    el.textContent = code.slice(0, 3) + ' ' + code.slice(3);
    el.title = '点击复制';
    el.style.cursor = 'pointer';
    el.onclick = function () {
      try { navigator.clipboard.writeText(code); msg('gcLpTransferMsg', '速传码已复制', 'ok'); } catch (e) {}
    };
  }

  /* ---------- 接收 ---------- */
  var recvBtn = document.getElementById('gcLpRecvBtn');
  if (recvBtn) recvBtn.addEventListener('click', function () {
    var code = (document.getElementById('gcLpRecvCode').value || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
    if (code.length < 4) { msg('gcLpRecvMsg', '请输入速传码', 'err'); return; }
    recvBtn.disabled = true; recvBtn.innerHTML = '<span class="gc-lp-spin"></span>';
    var recvStatus = 0;
    fetch('/api/share?action=get&code=' + encodeURIComponent(code), { cache: 'no-store' })
      .then(function (r) { recvStatus = r.status; return r.text().then(function (t) { try { return JSON.parse(t); } catch (e) { return { ok: false, _raw: t }; } }); })
      .then(function (d) {
        recvBtn.disabled = false; recvBtn.textContent = '取回';
        var box = document.getElementById('gcLpPreview');
        if (!d || !d.ok) {
          if (box) box.classList.remove('on');
          /* 回显后端真实错误：优先 hint → message → error → code，最后才用通用文案 */
          var em = (d && (d.hint || d.message || d.error || d.code)) || '';
          if (!em) em = recvStatus ? ('取回失败（HTTP ' + recvStatus + '）') : '取回失败，请稍后重试';
          else if (recvStatus && recvStatus !== 200) em += '（HTTP ' + recvStatus + '）';
          msg('gcLpRecvMsg', em, 'err');
          return;
        }
        box.classList.add('on'); box.innerHTML = '';
        if (d.kind === 'image') {
          var img = document.createElement('img');
          img.src = d.dataUrl; img.alt = d.name || 'image';
          box.appendChild(img);
          var bar = document.createElement('div');
          bar.style.cssText = 'display:flex;gap:8px;padding:9px;border-top:1px solid #eef1f7';
          var a = document.createElement('a');
          a.href = d.dataUrl; a.download = d.name || 'gc-image.png';
          a.textContent = '保存图片';
          a.style.cssText = 'flex:1;text-align:center;font-size:12.5px;padding:8px;border-radius:9px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;text-decoration:none';
          bar.appendChild(a);
          box.appendChild(bar);
          msg('gcLpRecvMsg', '已取回图片', 'ok');
        } else {
          var pre = document.createElement('div');
          pre.className = 'txt'; pre.textContent = d.text || '';
          box.appendChild(pre);
          msg('gcLpRecvMsg', '已取回文字，可长按选择复制', 'ok');
        }
      })
      .catch(function () { recvBtn.disabled = false; recvBtn.textContent = '取回'; msg('gcLpRecvMsg', '网络异常', 'err'); });
  });
})();
