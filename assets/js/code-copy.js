document.querySelectorAll('article.post .highlight, article.post > pre').forEach(function(block) {
  // Skip pre elements that are inside a .highlight (already handled by parent)
  if (block.tagName === 'PRE' && block.closest('.highlight')) return;

  var btn = document.createElement('button');
  btn.className = 'copy-btn';
  btn.setAttribute('aria-label', 'Copy code to clipboard');
  btn.textContent = 'Copy';

  btn.addEventListener('click', function() {
    var code = block.querySelector('code');
    var text = code ? code.textContent : block.textContent;
    navigator.clipboard.writeText(text).then(function() {
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(function() {
        btn.textContent = 'Copy';
        btn.classList.remove('copied');
      }, 2000);
    }, function() {
      btn.textContent = 'Failed';
      setTimeout(function() { btn.textContent = 'Copy'; }, 2000);
    });
  });

  block.style.position = 'relative';
  block.appendChild(btn);
});
