
(function () {
  'use strict';
  function idle(fn) {
    if (window.requestIdleCallback) { window.requestIdleCallback(fn, { timeout: 2500 }); }
    else { setTimeout(fn, 1500); }
  }
  function addScript(src, attrs) {
    var s = document.createElement('script');
    s.src = src; s.defer = true; s.async = true;
    if (attrs) { for (var k in attrs) { s.setAttribute(k, attrs[k]); } }
    document.head.appendChild(s);
  }
  function boot() {
    addScript('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js');
    addScript('https://cloud.umami.is/script.js', { 'data-website-id': '1b107f5a-12d4-4db7-a8bd-c1d9cd2ecbb7' });
  }
  if (document.readyState === 'complete') { idle(boot); }
  else { window.addEventListener('load', function () { idle(boot); }); }
})();
