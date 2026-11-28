
(function () {
  'use strict';
  if (window.__gcLogoIntroLoaded) return;
  window.__gcLogoIntroLoaded = true;
  var box = document.getElementById('gcLogoIntro');
  if (!box) return;
  var LS_KEY = 'gc_logo_anim_off';
  var start = Date.now();
  var done = false;
  function unlockBody() {
    try { document.documentElement.style.overflow = ''; document.body.style.overflow = ''; } catch (e) {}
  }
  function reveal() {
    var app = document.querySelector('.app-container') || document.querySelector('.app-container');
    if (!app) return;
    app.classList.add('gc-pop');
    setTimeout(function () { app.classList.remove('gc-pop'); }, 1150);
  }
  function hardRemove() {
    if (box && box.parentNode) box.parentNode.removeChild(box);
    unlockBody();
  }
  function finish(fade) {
    if (done) return;
    done = true;
    try { box.style.pointerEvents = 'none'; } catch (e) {}
    if (fade === false) { box.style.display = 'none'; hardRemove(); return; }
    box.classList.add('gc-exit');
    reveal();
    box.style.display = 'none';
    setTimeout(hardRemove, 120);
  }
  function skipNow() { finish(false); }

  var skipBtn = document.getElementById('gcLogoSkip');
  if (skipBtn) {
    skipBtn.addEventListener('click', function (ev) { if (ev) { ev.preventDefault(); ev.stopPropagation(); } skipNow(); });
    skipBtn.addEventListener('touchend', function (ev) { ev.preventDefault(); skipNow(); }, { passive: false });
  }
  var offBox = document.getElementById('gcLogoOff');
  function readOff() { try { return localStorage.getItem(LS_KEY) === '1'; } catch (e) { return false; } }
  if (offBox) {
    offBox.checked = readOff();
    offBox.addEventListener('change', function () {
      try { localStorage.setItem(LS_KEY, offBox.checked ? '1' : '0'); } catch (e) {}
      if (offBox.checked) skipNow();
    });
  }
  var pressTimer = null;
  function pressStart() { if (!pressTimer) pressTimer = setTimeout(skipNow, 520); }
  function pressEnd() { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } }
  box.addEventListener('pointerdown', pressStart);
  box.addEventListener('pointerup', pressEnd);
  box.addEventListener('pointercancel', pressEnd);
  box.addEventListener('pointerleave', pressEnd);
  box.addEventListener('touchstart', pressStart, { passive: true });
  box.addEventListener('touchend', pressEnd, { passive: true });
  box.addEventListener('touchcancel', pressEnd, { passive: true });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') skipNow(); });
  setTimeout(function () { finish(false); }, 3000);
  window.addEventListener('load', function () {
    if (!done && Date.now() - start >= 2800) finish(false);
  });
  setTimeout(function () { if (!done) finish(false); }, 4200);
})();
