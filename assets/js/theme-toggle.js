(function() {
  var toggle = document.querySelector('.theme-toggle');
  if (!toggle) return;

  var html = document.documentElement;
  toggle.addEventListener('click', function() {
    var current = html.getAttribute('data-theme');
    var next;
    if (current === 'dark') next = 'light';
    else if (current === 'light') next = 'dark';
    else {
      // Currently using system default, toggle to opposite
      next = window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'light' : 'dark';
    }
    html.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
  });
})();
