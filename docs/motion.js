'use strict';
(() => {
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const numbers = [...document.querySelectorAll('[data-number]')];
  const targets = [...document.querySelectorAll('.idea-section .section-heading, .proof-numbers, .lab-section .section-heading, .lab-shell, .interface-shell, .project-section .section-heading, .engineering-disclosure, .privacy-details, .install-top, .install-steps, .medical-gallery, .compatibility-section')];
  // Keep the scope link useful with or without animation enabled.
  function revealAnchor() {
    if (location.hash === '#impact-sources') document.getElementById('impact-sources').open = true;
    if (location.hash === '#healthcare-scope') {
      const detail = document.getElementById('healthcare-scope');
      detail.open = true;
      detail.closest('.privacy-details').classList.add('is-visible');
    }
  }
  addEventListener('hashchange', revealAnchor);
  revealAnchor();
  if (preference.matches || !('IntersectionObserver' in window)) return;

  // The accessible value stays final; only the decorative digit reels move.
  for (const number of numbers) {
    const formatted = Number(number.dataset.number).toLocaleString('en-US');
    number.setAttribute('aria-label', formatted);
    number.replaceChildren(...[...formatted].map((digit, index) => {
      if (digit === ',') {
        const separator = document.createElement('span');
        separator.textContent = digit;
        separator.setAttribute('aria-hidden', 'true');
        return separator;
      }
      const reel = document.createElement('span');
      reel.className = 'number-reel';
      reel.setAttribute('aria-hidden', 'true');
      const track = document.createElement('span');
      track.className = 'number-track';
      track.style.setProperty('--digit-delay', `${index * 100}ms`);
      // One full revolution, then settle on the actual value.
      for (let n = 0; n <= 10 + Number(digit); n++) {
        const item = document.createElement('span');
        item.textContent = String(n % 10);
        track.append(item);
      }
      track.dataset.offset = String((10 + Number(digit)) * 1.1);
      reel.append(track);
      return reel;
    }));
  }
  function settle(element) {
    element.classList.add('is-visible');
    element.querySelectorAll('.number-track').forEach(track => {
      track.style.transform = `translateY(-${track.dataset.offset}em)`;
    });
  }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      settle(entry.target);
      observer.unobserve(entry.target);
    }
  }, { threshold: 0, rootMargin: '0px 0px -35px 0px' });
  targets.forEach(target => {
    target.classList.add('scroll-reveal');
    observer.observe(target);
  });
  preference.addEventListener('change', event => {
    if (event.matches) { targets.forEach(settle); observer.disconnect(); }
  });
})();
