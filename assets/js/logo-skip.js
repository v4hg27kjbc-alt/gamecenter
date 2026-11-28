
(function () {
  try {
    if (localStorage.getItem('gc_logo_anim_off') === '1') {
      var box = document.getElementById('gcLogoIntro');
      if (box) { box.style.display = 'none'; box.setAttribute('data-gc-skip', '1'); if (box.parentNode) box.parentNode.removeChild(box); }
      try { document.documentElement.style.overflow = ''; document.body.style.overflow = ''; } catch (e) {}
      window.__gcLogoIntroLoaded = true;
      var app = document.querySelector('.app-container');
      if (app) { app.classList.add('gc-pop'); setTimeout(function(){ app.classList.remove('gc-pop'); }, 900); }
    }
  } catch (e) {}
})();
