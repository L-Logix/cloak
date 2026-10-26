'use strict';
(() => {
  const tabs = [...document.querySelectorAll('[data-screen]')];
  const panels = [...document.querySelectorAll('[data-screen-panel]')];
  function select(tab, focus = false) {
    tabs.forEach(item => {
      item.setAttribute('aria-selected', String(item === tab));
      item.tabIndex = item === tab ? 0 : -1;
    });
    panels.forEach(panel => { panel.hidden = panel.dataset.screenPanel !== tab.dataset.screen; });
    if (focus) tab.focus();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', event => {
      const map = { ArrowRight: (index + 1) % tabs.length, ArrowDown: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, ArrowUp: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 };
      if (map[event.key] !== undefined) { event.preventDefault(); select(tabs[map[event.key]], true); }
    });
  });
})();
