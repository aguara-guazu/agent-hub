(function () {
  var q = new URLSearchParams(location.search);
  var root = document.querySelector('.ah.shell');
  function setTheme(t) {
    if (!root) return;
    root.classList.remove('t-dark', 't-light');
    root.classList.add(t === 'light' ? 't-light' : 't-dark');
    document.body.classList.toggle('light', t === 'light');
  }
  if (q.get('theme')) setTheme(q.get('theme'));
  var tg = document.querySelector('[data-theme-toggle]');
  if (tg) tg.addEventListener('click', function () { setTheme(root.classList.contains('t-light') ? 'dark' : 'light'); });
  if (q.get('chrome') === '0' && tg) tg.remove();

  var tabs = document.querySelectorAll('[data-tab]');
  function show(id) {
    tabs.forEach(function (t) { var on = t.getAttribute('data-tab') === id; if (t.tagName === 'BUTTON') t.setAttribute('aria-pressed', String(on)); else t.classList.toggle('is-active', on); });
    document.querySelectorAll('[data-pane]').forEach(function (p) { p.hidden = p.getAttribute('data-pane') !== id; });
    document.querySelectorAll('[data-pane-not]').forEach(function (p) { p.hidden = p.getAttribute('data-pane-not') === id; });
  }
  tabs.forEach(function (t) { t.addEventListener('click', function (e) { e.preventDefault(); show(t.getAttribute('data-tab')); }); });
  document.querySelectorAll('[data-goto]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); show(a.getAttribute('data-goto')); }); });
  var start = q.get('tab') || (location.hash ? location.hash.slice(1) : '');
  if (start && document.querySelector('[data-pane="' + start + '"]')) show(start);

  var mt = document.querySelector('[data-menu-toggle]');
  var menu = document.querySelector('[data-menu]');
  if (mt && menu) {
    mt.addEventListener('click', function (e) { e.stopPropagation(); menu.hidden = !menu.hidden; mt.setAttribute('aria-expanded', String(!menu.hidden)); });
    document.addEventListener('click', function () { menu.hidden = true; mt.setAttribute('aria-expanded', 'false'); });
  }
  document.querySelectorAll('a[href="#"]').forEach(function (a) { if (!a.hasAttribute('data-tab') && !a.hasAttribute('data-goto')) a.addEventListener('click', function (e) { e.preventDefault(); }); });
})();
