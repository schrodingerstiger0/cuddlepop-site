/*
 * Cuddle Pop analytics hook.
 * track(eventName, props) forwards to whichever providers are configured below,
 * and does nothing (loads no third-party script) while both IDs are empty.
 * Debug logging: add ?debug=1 to the URL, or run localStorage.cp_debug = '1'.
 */
(function () {
  'use strict';

  // TODO(confirm): GA4 measurement ID, Meta Pixel ID, and the consent approach
  // (cookie banner / region rules) must be confirmed before either ID is filled in,
  // because filling one in loads that provider's script on every page view.
  var GA_MEASUREMENT_ID = '';
  var META_PIXEL_ID = '';

  var debug = false;
  try {
    debug = new URLSearchParams(window.location.search).get('debug') === '1' ||
      !!window.localStorage.getItem('cp_debug');
  } catch (e) { /* storage blocked: stay quiet */ }

  function loadScript(src) {
    var s = document.createElement('script');
    s.async = true;
    s.src = src;
    document.head.appendChild(s);
  }

  if (GA_MEASUREMENT_ID) {
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', GA_MEASUREMENT_ID);
    loadScript('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA_MEASUREMENT_ID));
  }

  if (META_PIXEL_ID && !window.fbq) {
    var fbq = window.fbq = function () {
      fbq.callMethod ? fbq.callMethod.apply(fbq, arguments) : fbq.queue.push(arguments);
    };
    window._fbq = fbq;
    fbq.push = fbq;
    fbq.loaded = true;
    fbq.version = '2.0';
    fbq.queue = [];
    loadScript('https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', META_PIXEL_ID);
    fbq('track', 'PageView');
  }

  function track(eventName, props) {
    props = props || {};
    if (debug) console.log('[track]', eventName, props);
    try {
      if (GA_MEASUREMENT_ID && window.gtag) window.gtag('event', eventName, props);
      if (META_PIXEL_ID && window.fbq) window.fbq('trackCustom', eventName, props);
    } catch (e) {
      if (debug) console.warn('[track] provider error', e);
    }
  }

  window.track = track;
})();
