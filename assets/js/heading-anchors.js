document.querySelectorAll('article.post h2[id], article.post h3[id], article.post h4[id]')
  .forEach(function(heading) {
    var link = document.createElement('a');
    link.href = '#' + heading.id;
    link.className = 'heading-anchor';
    link.setAttribute('aria-label', 'Link to section: ' + heading.textContent);
    link.textContent = '#';
    heading.insertBefore(link, heading.firstChild);
  });
