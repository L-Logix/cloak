'use strict';
/**
 * Cloak website GA4 instrumentation.
 * Sends detailed events through gtag() (already loaded with Consent Mode v2).
 * Events are safe when analytics_storage is denied - GA4 consent mode handles them.
 */
(() => {
  const YT_ID = 'Q5fzbLAetjo';
  const sentScroll = new Set();
  const sentSections = new Set();
  const sentVideoProgress = new Set();
  let videoStarted = false;
  let videoReady = false;
  let progressTimer = null;

  function gtagEvent(name, params) {
    try {
      if (typeof window.gtag === 'function') window.gtag('event', name, params || {});
    } catch (_) { /* analytics must never break the site */ }
  }

  function clean(str, max) {
    return String(str || '').replace(/\s+/g, ' ').trim().slice(0, max || 120);
  }

  function labelFor(el) {
    if (!el) return '';
    const explicit = el.getAttribute('data-track-label') || el.getAttribute('aria-label') || el.getAttribute('title');
    if (explicit) return clean(explicit);
    return clean(el.innerText || el.textContent || el.value || '');
  }

  function sectionFor(el) {
    if (el.closest('#cloak-cookies-consent-panel')) return 'consent_modal';
    const sec = el.closest('section, header, footer, .hero, .project-strip');
    if (!sec) return 'unknown';
    return sec.id || clean(sec.className.split(/\s+/)[0] || 'unknown', 40);
  }

  function track(name, params) {
    const base = { page_path: location.pathname + location.search, page_title: document.title };
    gtagEvent(name, Object.assign(base, params || {}));
  }

  // Expose for inline scripts (consent modal)
  window.CloakTrack = track;

  function trackPageContext() {
    const params = {
      referrer_domain: document.referrer ? (() => { try { return new URL(document.referrer).hostname; } catch (_) { return ''; } })() : '(direct)',
      viewport: window.innerWidth + 'x' + window.innerHeight,
      language: navigator.language || ''
    };
    const utm = new URLSearchParams(location.search);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach(k => {
      if (utm.has(k)) params[k] = clean(utm.get(k), 100);
    });
    track('page_context', params);
  }

  function setupScrollDepth() {
    const marks = [25, 50, 75, 90, 100];
    function check() {
      const doc = document.documentElement;
      const max = doc.scrollHeight - window.innerHeight;
      if (max <= 0) return;
      const pct = Math.min(100, Math.round((window.scrollY / max) * 100));
      marks.forEach(m => {
        if (pct >= m && !sentScroll.has(m)) {
          sentScroll.add(m);
          track('scroll_depth', { percent: m });
        }
      });
    }
    let ticking = false;
    window.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => { check(); ticking = false; });
    }, { passive: true });
    check();
  }

  function setupSectionViews() {
    const sections = document.querySelectorAll('section[id], footer, .project-strip');
    if (!('IntersectionObserver' in window) || !sections.length) return;
    const obs = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        const id = el.id || clean(el.className, 40) || 'unknown';
        if (sentSections.has(id)) return;
        sentSections.add(id);
        track('section_view', { section_id: id, section_label: clean(el.querySelector('h1,h2,h3,.eyebrow')?.innerText || id, 80) });
      });
    }, { threshold: 0.35 });
    sections.forEach(s => obs.observe(s));
  }

  function setupEngagementTimers() {
    const start = Date.now();
    [30, 60, 120, 300].forEach(sec => {
      setTimeout(() => {
        track('engaged_time', { seconds: sec, engaged_seconds: Math.round((Date.now() - start) / 1000) });
      }, sec * 1000);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        track('page_engagement_end', { engaged_seconds: Math.round((Date.now() - start) / 1000), scroll_percents_seen: Array.from(sentScroll).sort((a, b) => a - b).join(',') });
      }
    });
  }

  function setupClickTracking() {
    document.addEventListener('click', e => {
      const a = e.target.closest('a');
      const btn = e.target.closest('button');
      const el = a || btn;
      if (!el) return;

      const text = labelFor(el);
      const section = sectionFor(el);
      const href = a ? (a.getAttribute('href') || '') : '';
      const abs = a ? a.href : '';

      if (el.classList.contains('card-accept')) { track('consent_choice', { choice: 'accept', method: 'button', section }); return; }
      if (el.classList.contains('card-reject')) { track('consent_choice', { choice: 'reject', method: 'button', section }); return; }

      if (a && (a.hasAttribute('download') || /\.zip(\?|#|$)/i.test(href))) {
        track('file_download', { file_name: clean(href.split('/').pop() || href, 80), link_url: abs, link_text: text, section });
        return;
      }
      if (/github\.com/i.test(abs)) {
        track('github_click', { link_url: abs, link_text: text, section, destination: /blob|tree/.test(abs) ? 'source_file' : 'repo' });
        return;
      }
      if (/youtube\.com\/watch|youtu\.be\//i.test(abs)) {
        track('video_open_youtube', { link_url: abs, link_text: text, section, video_id: YT_ID });
        return;
      }
      if (a && /^https?:/i.test(abs) && !abs.startsWith(location.origin)) {
        let domain = ''; try { domain = new URL(abs).hostname; } catch (_) {}
        track('outbound_click', { link_url: abs, link_domain: domain, link_text: text, section });
        return;
      }
      if (a && href.startsWith('#')) { track('anchor_click', { target: href, link_text: text, section }); return; }

      if (el.dataset.example) { track('demo_preset_select', { preset: el.dataset.example, section }); return; }
      if (el.dataset.view) { track('demo_view_switch', { view: el.dataset.view, section }); return; }
      if (el.dataset.screen) { track('screenshot_tab_view', { screen: el.dataset.screen, section }); return; }
      if (el.dataset.medical) { track('medical_stage_view', { stage: el.dataset.medical, section }); return; }
      if (el.id === 'run-stream') { track('demo_stream_run', { chunk_size: Number(document.getElementById('chunk-size')?.value || 0), section }); return; }
      if (el.id === 'run-checks') { track('demo_checks_run', { section }); return; }
      if (el.id === 'clear') { track('demo_clear', { section }); return; }

      if (el.classList.contains('nav-cta') || el.closest('nav')) {
        track('nav_click', { link_text: text, link_url: abs || href, section: 'header' });
        return;
      }
      if (el.classList.contains('button') || el.classList.contains('hero-github')) {
        track('cta_click', { link_text: text, link_url: abs || href, section, button_style: el.classList.contains('primary') ? 'primary' : (el.classList.contains('secondary') ? 'secondary' : 'other') });
        return;
      }
      if (btn || (a && href)) {
        track('ui_click', { element: el.tagName.toLowerCase(), link_text: text, link_url: abs || href, section, element_id: el.id || '' });
      }
    }, { capture: true });
  }

  function setupDetailsTracking() {
    document.querySelectorAll('details').forEach(d => {
      d.addEventListener('toggle', () => {
        const summary = clean(d.querySelector('summary')?.innerText || d.id || 'details', 100);
        track('details_toggle', { open: d.open, detail_id: d.id || '', summary, section: sectionFor(d) });
      });
    });
  }

  function setupDemoTracking() {
    document.querySelectorAll('.coverage input[type="checkbox"]').forEach(cb => cb.addEventListener('change', () => {
      track('demo_coverage_toggle', { category: cb.value, enabled: cb.checked, section: 'lab' });
    }));
    const custom = document.getElementById('custom-term');
    if (custom) custom.addEventListener('change', () => { const v = clean(custom.value, 40); if (v) track('demo_custom_term_set', { length: v.length, section: 'lab' }); });
    const chunk = document.getElementById('chunk-size');
    if (chunk) chunk.addEventListener('change', () => { track('demo_chunk_size_change', { chunk_size: Number(chunk.value || 0), section: 'project' }); });
  }

  function setupYouTubeTracking() {
    const iframe = document.getElementById('demo-video-frame') || document.querySelector('.hero-video-frame iframe');
    if (!iframe) return;
    const src = iframe.getAttribute('src') || '';
    if (!/youtube(-nocookie)?\.com\/embed\//.test(src)) return;

    try {
      const u = new URL(src, location.href);
      let changed = false;
      if (!u.searchParams.has('enablejsapi')) { u.searchParams.set('enablejsapi', '1'); changed = true; }
      if (!u.searchParams.has('origin') && location.origin && location.origin !== 'null') { u.searchParams.set('origin', location.origin); changed = true; }
      if (changed) iframe.src = u.toString();
    } catch (_) { /* ignore */ }

    function post(cmd) {
      try { iframe.contentWindow.postMessage(JSON.stringify(cmd), '*'); } catch (_) {}
    }

    function startProgressPolling() {
      if (progressTimer) return;
      progressTimer = setInterval(() => {
        post({ event: 'listening', id: iframe.id || 'demo-video-frame', channel: 'widget' });
        if (sentVideoProgress.has(100)) { clearInterval(progressTimer); progressTimer = null; }
      }, 5000);
    }

    window.addEventListener('message', e => {
      if (!/youtube(-nocookie)?\.com/.test(String(e.origin || ''))) return;
      let data = e.data;
      try { if (typeof data === 'string') data = JSON.parse(data); } catch (_) { return; }
      if (!data || typeof data !== 'object') return;

      if (data.event === 'onReady' || data.event === 'initialDelivery') {
        if (!videoReady) {
          videoReady = true;
          post({ event: 'listening', id: iframe.id || 'demo-video-frame', channel: 'widget' });
          post({ event: 'command', func: 'addEventListener', args: ['onStateChange'] });
          track('video_ready', { video_id: YT_ID, video_provider: 'youtube', section: 'hero' });
        }
      }

      if (data.event === 'onStateChange' || (data.event === 'infoDelivery' && data.info && typeof data.info.playerState === 'number')) {
        const state = data.event === 'onStateChange' ? data.info : data.info.playerState;
        if (state === 1) {
          if (!videoStarted) { videoStarted = true; track('video_start', { video_id: YT_ID, video_provider: 'youtube', section: 'hero' }); }
          track('video_play', { video_id: YT_ID, video_provider: 'youtube', section: 'hero' });
          startProgressPolling();
        } else if (state === 2) {
          track('video_pause', { video_id: YT_ID, video_provider: 'youtube', section: 'hero' });
        } else if (state === 0) {
          track('video_complete', { video_id: YT_ID, video_provider: 'youtube', section: 'hero' });
          if (!sentVideoProgress.has(100)) { sentVideoProgress.add(100); track('video_progress', { video_id: YT_ID, percent: 100, video_provider: 'youtube' }); }
        }
      }

      if (data.event === 'infoDelivery' && data.info && data.info.currentTime != null && data.info.duration) {
        const pct = Math.floor((data.info.currentTime / data.info.duration) * 100);
        [25, 50, 75, 100].forEach(m => {
          if (pct >= m && !sentVideoProgress.has(m)) {
            sentVideoProgress.add(m);
            track('video_progress', { video_id: YT_ID, percent: m, video_provider: 'youtube' });
          }
        });
      }
    });

    iframe.addEventListener('load', () => {
      post({ event: 'listening', id: iframe.id || 'demo-video-frame', channel: 'widget' });
      post({ event: 'command', func: 'addEventListener', args: ['onStateChange'] });
    });
    setTimeout(() => {
      post({ event: 'listening', id: iframe.id || 'demo-video-frame', channel: 'widget' });
      post({ event: 'command', func: 'addEventListener', args: ['onStateChange'] });
    }, 1500);
  }

  function init() {
    trackPageContext();
    setupScrollDepth();
    setupSectionViews();
    setupEngagementTimers();
    setupClickTracking();
    setupDetailsTracking();
    setupDemoTracking();
    setupYouTubeTracking();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
