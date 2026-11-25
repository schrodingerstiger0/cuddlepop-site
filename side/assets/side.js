/* The guest page: say your side with no app and no account (docs/18 §3, §4, §6).
 *
 * Two layers in one file, no build step:
 *  - createSide(env): the state machine. No DOM; talks to the API through env.fetch. Node runs
 *    it in apps/web/tools/side-check.js.
 *  - the browser layer at the bottom renders state with createElement/textContent only (never
 *    innerHTML), so nothing the initiator typed (the fight title, their name) can inject markup.
 *
 * The guest token lives in localStorage, one entry per invite code with its expiry, so a new tab
 * or a reopened link on the same phone picks up where the guest left off (the server allows one
 * live guest per invite and re-issues the token only to whoever presents it). It is sent as
 * `Authorization: Bearer` on /v1/guest/*. No cookies, no third-party scripts.
 */
(function (root) {
  'use strict';

  // docs/18 §4, verbatim. The server sends the same lines; these are the fallback.
  var PROMISES_INTRO = 'Before you say anything, three things from me.';
  var PROMISES = [
    "I won't repeat what they said. Not a word.",
    'Nothing you tell me gets shared unless you say yes.',
    "And you can delete the whole thing, any time. I'll drop it like it never happened.",
  ];
  var HALF_HEARD = 'Oliver has only heard one side of this.';
  var MAX_SIDE = 4000; // fights.sides.SIDE_MAX on the server
  // Screens that offer the app: the guest gets a claim code there to prove the side is theirs.
  var CLAIM_SCREENS = { done: true, notyet: true, sealed: true, reveal: true };
  var CLOSED_STATUSES = { resolved: true, archived: true };
  var RETRY_MAX_MS = 30000;
  var CODE_RE = /^[A-Za-z0-9]{4,12}$/;

  function parseCode(loc) {
    var m = (loc.pathname || '').match(/\/(?:join|side)\/([A-Za-z0-9]{4,12})\/?$/);
    if (m) return m[1].toUpperCase();
    var q = (loc.search || '').match(/[?&]code=([A-Za-z0-9]{4,12})(?:&|$)/);
    return q ? q[1].toUpperCase() : '';
  }

  function apiBaseFrom(meta, origin) {
    var v = (meta || '').trim().replace(/\/+$/, '');
    return v || String(origin || '').replace(/\/+$/, '') + '/v1';
  }

  function ApiFailure(status, code, retryAfter, requestId) {
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter == null ? null : retryAfter;
    this.requestId = requestId || null;
  }

  function isExpired(code) {
    return /expired/.test(code || '');
  }

  // Errors in the site voice. `name` is the initiator's first name when we know it.
  function errorCopy(err, name) {
    var them = name || 'them';
    var code = err && err.code;
    if (code === 'missing_code') {
      return {
        title: 'This link is missing its code.',
        body: "Ask them to send it again, or type the code from their message into the app's Join screen.",
        retry: false,
      };
    }
    if (code === 'invite_not_found') {
      return {
        title: "That link doesn't ring a bell.",
        body: "Check it's the whole link they sent. If it still won't open, ask " + them + ' for a new one.',
        retry: false,
      };
    }
    if (isExpired(code)) {
      return {
        title: 'This link ran out.',
        body: 'Invite links last 7 days. Ask ' + them + ' for a fresh one, it takes two taps.',
        retry: false,
      };
    }
    if (code === 'invite_claimed') {
      return {
        title: "You're in. Open the app.",
        body: 'This link was used to join in the app, so everything you did here is waiting for you there.',
        retry: false,
      };
    }
    if (code === 'invite_used' && err.held) {
      return {
        title: 'This link is already used up.',
        body: "If you joined in the app, you're in: open Cuddle Pop. If not, ask " + them + ' for a new one.',
        retry: false,
      };
    }
    if (code === 'invite_used') {
      return {
        title: 'Someone already opened this link.',
        body: 'Each link works for one person. If that was you on another phone, carry on there. If not, ask ' + them + ' for a new one.',
        retry: false,
      };
    }
    if (code === 'relationship_full' || code === 'relationship_ended') {
      return {
        title: 'This invite is closed.',
        body: 'There is no space waiting on the other end any more. If that seems wrong, ask ' + them + ' to send a new one.',
        retry: false,
      };
    }
    if (code === 'fight_not_found' || code === 'session_not_found') {
      return {
        title: "This one's gone.",
        body: "It was deleted, so there's nothing left to add here.",
        retry: false,
      };
    }
    if (code === 'invalid_token') {
      return {
        title: 'This page lost its place.',
        body: 'Open the link from their message again on this phone and you will pick up where you left off.',
        retry: true,
      };
    }
    if (code === 'rate_limited') {
      var secs = err.retryAfter;
      var wait = secs ? (secs >= 90 ? Math.ceil(secs / 60) + ' minutes' : secs + ' seconds') : 'a minute';
      return { title: "Easy, that's a lot of tries.", body: 'Give it ' + wait + ' and try again.', retry: true };
    }
    if (code === 'network') {
      return { title: "Can't reach Cuddle Pop right now.", body: 'Check your connection and try again.', retry: true };
    }
    if (code === 'side_too_long') {
      return { title: "That's a lot for one go.", body: 'Keep it under ' + MAX_SIDE + ' characters and it will save.', retry: false };
    }
    if (code === 'side_empty') {
      return { title: 'Say a little first.', body: 'Even a sentence is enough. Oliver is listening.', retry: false };
    }
    return { title: 'Something went sideways.', body: 'Give it a moment and try again.', retry: true };
  }

  // Errors that end the guest's rights: show a full screen instead of an inline notice.
  function isFatal(err) {
    var c = err && err.code;
    return (
      c === 'invite_used' || c === 'invite_claimed' || c === 'invite_not_found' || isExpired(c) ||
      c === 'fight_not_found' || c === 'session_not_found' || c === 'relationship_full' ||
      c === 'relationship_ended' || c === 'invalid_token'
    );
  }

  // Worth trying the same save again later: offline, rate limited or a server hiccup.
  function isTransient(err) {
    var c = err && err.code;
    return c === 'network' || c === 'rate_limited' || (err && err.status >= 500);
  }

  // A display name from the API, or '' (never the strings "null"/"undefined").
  function cleanName(v) {
    return typeof v === 'string' ? v.trim().slice(0, 40) : '';
  }

  function createSide(env) {
    var code = env.code || '';
    var storage = env.storage || null;
    var tokenKey = 'cp_guest_' + code;
    var goneKey = 'cp_guest_gone_' + code; // 'deleted' once the guest dropped the fight here
    var retryTimer = null;
    var retryCount = 0;
    var lastSaveError = null;
    var later = env.setTimeout || setTimeout;
    var cancel = env.clearTimeout || clearTimeout;
    var saveDelay = env.saveDelay == null ? 1200 : env.saveDelay;
    var saveTimer = null;
    var saving = null; // the in-flight save promise
    var savedText = null; // last text the server has

    var s = {
      screen: 'loading',
      code: code,
      token: null,
      name: '', // the inviter's first name
      you: '', // the guest's own name as the inviter typed it (your_name); '' when not given
      mode: null,
      fight: null,
      gameId: null,
      game: null,
      qIndex: 0,
      promisesIntro: PROMISES_INTRO,
      promises: PROMISES.slice(),
      expiresAt: null,
      sideText: '',
      saveState: 'idle', // idle | dirty | saving | saved | error (retrying) | stuck (will not retry)
      gameIntroSeen: false,
      confirmDelete: false,
      busy: false,
      notice: null, // inline {title, body}
      error: null, // full-screen ApiFailure
      claimCode: null, // from POST /guest/claim-code, minted once per visit
      claimExpiresAt: null,
    };
    var claimRequested = false;

    function emit() {
      if (env.onChange) env.onChange(s);
    }
    function set(patch) {
      for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) s[k] = patch[k];
      emit();
      if (patch.screen && CLAIM_SCREENS[patch.screen]) mintClaimCode();
    }

    // The app's Join step asks for this code once the guest wrote anything (409
    // claim_code_needed), so nobody else holding the link can take their side. Minting again
    // replaces the old code, so it happens once per visit. Failures stay quiet: the page still
    // works, the app then asks for the code and the guest can come back here for it.
    function mintClaimCode() {
      if (claimRequested || !(readToken() || s.token)) return Promise.resolve();
      claimRequested = true;
      return api('POST', '/guest/claim-code', undefined, true).then(
        function (data) {
          if (data && data.claim_code) set({ claimCode: data.claim_code, claimExpiresAt: data.expires_at || null });
        },
        function () { claimRequested = false; }
      );
    }

    function now() { return env.now ? env.now() : Date.now(); }
    // Stored as {"t": token, "exp": iso}; a bare string (older pages) is read as a token too.
    function readToken() {
      var raw = null;
      try { raw = storage ? storage.getItem(tokenKey) : null; } catch (e) { return null; }
      if (!raw) return null;
      var parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
      if (!parsed || typeof parsed !== 'object') return raw;
      var exp = parsed.exp ? Date.parse(parsed.exp) : NaN;
      if (!isNaN(exp) && exp <= now()) { writeToken(null); return null; }
      return typeof parsed.t === 'string' ? parsed.t : null;
    }
    function writeToken(t, exp) {
      try {
        if (!storage) return;
        if (t) storage.setItem(tokenKey, JSON.stringify({ t: t, exp: exp || null }));
        else storage.removeItem(tokenKey);
      } catch (e) { /* private mode */ }
    }
    function readGone() {
      try { return storage ? storage.getItem(goneKey) : null; } catch (e) { return null; }
    }
    function markGone(v) {
      try { if (storage) storage.setItem(goneKey, v); } catch (e) { /* private mode */ }
    }

    function api(method, path, body, useToken) {
      var headers = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      // Another tab on this phone may have re-opened the link (which re-issues the token): the
      // stored one is always the newest.
      var tok = useToken ? readToken() || s.token : null;
      if (tok) { s.token = tok; headers.Authorization = 'Bearer ' + tok; }
      var init = { method: method, headers: headers, credentials: 'omit', mode: 'cors', cache: 'no-store' };
      if (body !== undefined) init.body = JSON.stringify(body);
      return Promise.resolve()
        .then(function () { return env.fetch(env.apiBase + path, init); })
        .then(
          function (res) {
            if (res.status === 204) return null;
            return Promise.resolve(res.json ? res.json() : null)
              .catch(function () { return null; })
              .then(function (data) {
                if (res.ok) return data;
                var e = (data && data.error) || {};
                var retry = e.retry_after;
                if (retry == null && res.headers && res.headers.get) {
                  var h = parseInt(res.headers.get('Retry-After') || '', 10);
                  if (!isNaN(h)) retry = h;
                }
                var errCode = e.code || 'http_' + res.status;
                // The schema caps a side at MAX_SIDE, so an over-long one is a plain 422.
                if (res.status === 422 && /\/side$/.test(path)) errCode = 'side_too_long';
                throw new ApiFailure(res.status, errCode, retry, e.request_id);
              });
          },
          function () { throw new ApiFailure(0, 'network'); }
        );
    }

    function fail(err) {
      if (err && (err.code === 'invite_used' || err.code === 'invite_claimed')) writeToken(null);
      if (err && err.code === 'guest_dropped') return gone();
      set({ screen: 'error', error: err, busy: false, notice: null });
    }
    function gone() {
      writeToken(null);
      markGone('deleted');
      stopTimers();
      s.sideText = '';
      set({ busy: false, screen: 'deleted', confirmDelete: false, notice: null });
    }
    function stopTimers() {
      if (saveTimer) { cancel(saveTimer); saveTimer = null; }
      if (retryTimer) { cancel(retryTimer); retryTimer = null; }
    }
    // Errors that move the guest somewhere instead of failing: true when handled.
    function routeError(err) {
      var c = err && err.code;
      if (c === 'fight_closed') {
        stopTimers();
        set({ busy: false, screen: 'closed', confirmDelete: false, notice: null });
        return true;
      }
      if (c === 'side_already_shared') {
        stopTimers();
        set({ busy: false, screen: 'done', confirmDelete: false, notice: null });
        return true;
      }
      if (c === 'guest_dropped') { gone(); return true; }
      return false;
    }
    // An action failed: fatal errors take the screen, the rest stay inline with a retry.
    function trouble(err) {
      if (routeError(err)) return;
      if (isFatal(err)) return fail(err);
      set({ busy: false, notice: errorCopy(err, s.name) });
    }

    function applyState(data) {
      if (data.guest_token) {
        s.token = data.guest_token;
        writeToken(data.guest_token, data.expires_at);
      }
      var rel = data.relationship || {};
      s.name = rel.initiator_first_name || '';
      // your_name greets the guest by name. your_gender is deliberately not read: the copy here
      // is pronoun-free, so it would change nothing visible, and it is never kept or stored.
      s.you = cleanName(data.your_name);
      s.mode = rel.mode || null;
      s.fight = data.fight || null;
      s.gameId = data.game_session_id || null;
      s.expiresAt = data.expires_at || null;
      if (data.promises_intro) s.promisesIntro = data.promises_intro;
      if (data.promises && data.promises.length === 3) s.promises = data.promises.slice();
      var side = s.fight && s.fight.my_side;
      if (side) {
        s.sideText = side.text || '';
        savedText = s.sideText;
        s.saveState = s.sideText ? 'saved' : 'idle';
      }
    }

    function routeFight() {
      var side = s.fight.my_side;
      if (side && side.consented) return 'done';
      // Wrapped up before they said yes: nothing to add, but their sealed side can still go.
      if (CLOSED_STATUSES[s.fight.status]) return 'closed';
      if (side && side.text) return 'side';
      return 'promises';
    }

    // ---- start ----
    function start() {
      if (!code || !CODE_RE.test(code)) {
        fail(new ApiFailure(0, 'missing_code'));
        return Promise.resolve();
      }
      // They dropped the whole thing from this phone: it stays gone, the link has nothing left.
      if (readGone() === 'deleted') {
        set({ screen: 'deleted', error: null, notice: null });
        return Promise.resolve();
      }
      s.token = readToken();
      var held = !!s.token;
      set({ screen: 'loading', error: null, notice: null });
      // Sending a live token back re-issues it on this device (one guest per invite).
      return api('POST', '/invites/' + encodeURIComponent(code) + '/guest', undefined, held).then(
        function (data) {
          applyState(data || {});
          if (s.fight) return set({ screen: routeFight() });
          if (s.gameId) return loadGame();
          set({ screen: 'code' });
        },
        function (err) {
          // We held this link's token and it is used anyway: most likely they joined in the app.
          if (err && err.code === 'invite_used' && held) err.held = true;
          fail(err);
        }
      );
    }

    // ---- fight path ----
    function acceptPromises() {
      set({ screen: 'side', notice: null });
    }

    function editSide(text) {
      text = String(text == null ? '' : text).slice(0, MAX_SIDE);
      s.sideText = text;
      s.saveState = text === savedText ? 'saved' : 'dirty';
      if (saveTimer) cancel(saveTimer);
      saveTimer = later(function () { saveTimer = null; saveSide(); }, saveDelay);
      emit();
    }

    function saveSide() {
      if (saving) return saving.then(function () { return saveSide(); });
      if (retryTimer) { cancel(retryTimer); retryTimer = null; }
      var text = s.sideText;
      if (!s.fight || text === savedText || !text.trim()) {
        return Promise.resolve(true);
      }
      set({ saveState: 'saving' });
      saving = api('POST', '/guest/fights/' + s.fight.id + '/side', { text: text }, true).then(
        function (fight) {
          saving = null;
          savedText = text;
          retryCount = 0;
          lastSaveError = null;
          if (fight) s.fight = fight;
          // Typed more while this was in flight: the debounce timer will catch it.
          set({ saveState: s.sideText === savedText ? 'saved' : 'dirty', notice: null });
          return true;
        },
        function (err) {
          saving = null;
          lastSaveError = err;
          if (routeError(err)) return false;
          if (isFatal(err)) { fail(err); return false; }
          if (isTransient(err)) {
            // "Still trying" is true: back off and save again (2 s, 4 s, ... up to 30 s).
            var wait = err.retryAfter ? err.retryAfter * 1000 : Math.min(RETRY_MAX_MS, 2000 * Math.pow(2, retryCount));
            retryCount += 1;
            retryTimer = later(function () { retryTimer = null; saveSide(); }, wait);
            set({ saveState: 'error' });
          } else {
            // The server said no to this text (too long, empty): say why, do not loop.
            set({ saveState: 'stuck', notice: errorCopy(err, s.name) });
          }
          return false;
        }
      );
      return saving;
    }

    function finishSide() {
      if (!s.sideText.trim()) {
        set({ notice: { title: 'Say a little first.', body: 'Even a sentence is enough. Oliver is listening.' } });
        return Promise.resolve();
      }
      stopTimers();
      set({ busy: true, notice: null });
      return saveSide().then(function (ok) {
        if (s.screen !== 'side') return; // routed elsewhere (closed, already shared, error)
        if (!ok) {
          var e = lastSaveError;
          var body = e && e.code === 'network'
            ? 'Check your connection and tap again. Your words are still here.'
            : e && !isTransient(e) ? errorCopy(e, s.name).body : 'Give it a moment and tap again. Your words are still here.';
          return set({ busy: false, notice: { title: "That didn't save.", body: body } });
        }
        set({ busy: false, screen: 'yes', confirmDelete: false });
      });
    }

    function consent() {
      if (!s.fight) return Promise.resolve();
      set({ busy: true, notice: null });
      return api('POST', '/guest/fights/' + s.fight.id + '/consent', { share: true }, true).then(
        function (fight) {
          if (fight) s.fight = fight;
          set({ busy: false, screen: 'done', confirmDelete: false });
        },
        trouble
      );
    }

    // "Not yet" changes nothing on the server: the side just stays sealed.
    function notYet() { set({ screen: 'notyet', confirmDelete: false, notice: null }); }
    function editAgain() { set({ screen: 'side', confirmDelete: false, notice: null }); }
    function askDelete() { set({ confirmDelete: true, notice: null }); }
    function cancelDelete() { set({ confirmDelete: false }); }

    function confirmDelete() {
      if (!s.fight) return Promise.resolve();
      stopTimers();
      set({ busy: true, notice: null });
      return api('DELETE', '/guest/fights/' + s.fight.id, undefined, true).then(
        gone,
        function (err) {
          // Already gone on the server (deleted from another tab): same result for them.
          if (err && err.code === 'fight_not_found') return gone();
          trouble(err);
        }
      );
    }

    // ---- game path (docs/18 §6) ----
    function firstOpen(game) {
      var qs = (game.game && game.game.questions) || [];
      var done = {};
      (game.my_answers || []).forEach(function (a) { done[a.question_id] = true; });
      for (var i = 0; i < qs.length; i++) if (!done[qs[i].id]) return i;
      return qs.length;
    }

    function gameScreen(game) {
      var qs = (game.game && game.game.questions) || [];
      if (game.guest_completed || firstOpen(game) >= qs.length) {
        return game.both_answered ? 'reveal' : 'sealed';
      }
      // Before they type anything, Oliver says hello and how the reveal works (founder change #3).
      if (!s.gameIntroSeen && !(game.my_answers || []).length) return 'gameintro';
      return 'game';
    }

    function startGame() {
      s.gameIntroSeen = true;
      set({ screen: s.game ? gameScreen(s.game) : 'game', notice: null });
    }

    function loadGame() {
      set({ busy: true, notice: null });
      return api('GET', '/guest/games/' + s.gameId, undefined, true).then(function (game) {
        set({ busy: false, game: game, qIndex: firstOpen(game), screen: gameScreen(game) });
      }, trouble);
    }

    function currentQuestion() {
      var qs = (s.game && s.game.game && s.game.game.questions) || [];
      return qs[s.qIndex] || null;
    }

    function answer(value) {
      var q = currentQuestion();
      if (!q || s.busy) return Promise.resolve();
      if (q.type === 'text') {
        value = String(value == null ? '' : value).trim();
        if (!value) {
          set({ notice: { title: 'Type something first.', body: 'A word or two is plenty.' } });
          return Promise.resolve();
        }
      }
      set({ busy: true, notice: null });
      var body = { answers: [{ question_id: q.id, answer_json: value }] };
      return api('POST', '/guest/games/' + s.gameId + '/answers', body, true).then(function (game) {
        set({ busy: false, game: game, qIndex: firstOpen(game), screen: gameScreen(game) });
      }, trouble);
    }

    function retry() {
      if (s.screen === 'error' || s.screen === 'loading') return start();
      if (s.gameId && !s.fight) return loadGame();
      set({ notice: null });
      return Promise.resolve();
    }

    return {
      state: function () { return s; },
      start: start,
      acceptPromises: acceptPromises,
      editSide: editSide,
      saveSide: saveSide,
      finishSide: finishSide,
      consent: consent,
      notYet: notYet,
      editAgain: editAgain,
      askDelete: askDelete,
      cancelDelete: cancelDelete,
      confirmDelete: confirmDelete,
      loadGame: loadGame,
      startGame: startGame,
      refreshGame: loadGame,
      answer: answer,
      currentQuestion: currentQuestion,
      retry: retry,
      mintClaimCode: mintClaimCode,
    };
  }

  var exported = {
    createSide: createSide,
    parseCode: parseCode,
    apiBaseFrom: apiBaseFrom,
    errorCopy: errorCopy,
    cleanName: cleanName,
    PROMISES_INTRO: PROMISES_INTRO,
    PROMISES: PROMISES,
    HALF_HEARD: HALF_HEARD,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (typeof document === 'undefined') return;

  // ======================= browser layer =======================

  var doc = document;
  function meta(name) {
    var m = doc.querySelector('meta[name="' + name + '"]');
    return m ? m.getAttribute('content') || '' : '';
  }

  // el('p.small', {text: '...'}, children...)
  function el(spec, props) {
    var parts = spec.split('.');
    var node = doc.createElement(parts[0]);
    if (parts.length > 1) node.className = parts.slice(1).join(' ');
    var first = 2;
    if (props && (props.nodeType || Array.isArray(props) || typeof props === 'string')) {
      first = 1; // no props: the second argument is already a child
      props = {};
    }
    props = props || {};
    for (var k in props) {
      if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
      var v = props[k];
      if (v == null || v === false) continue;
      if (k === 'text') node.textContent = v;
      else if (k === 'on') for (var ev in v) node.addEventListener(ev, v[ev]);
      else if (k in node && k !== 'list') node[k] = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (var i = first; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) node.appendChild(x); });
      else node.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
    }
    return node;
  }

  var stores = { ios: meta('app-store-ios'), android: meta('app-store-android') };
  var app;
  var appEl = doc.getElementById('app');
  var openBtn = doc.getElementById('open-app');
  var lastScreen = null;
  var appState = { known: false, tried: false, missing: false };

  function rememberApp() {
    appState.known = true;
    try { localStorage.setItem('cp_app_seen', '1'); } catch (e) { /* ignore */ }
  }
  try { if (localStorage.getItem('cp_app_seen') === '1') appState.known = true; } catch (e) { /* ignore */ }

  function schemeUrl() {
    var st = app.state();
    return 'cuddlepop://join/' + st.code + (st.claimCode ? '?claim=' + encodeURIComponent(st.claimCode) : '');
  }
  function spacedClaim(c) { return c.length === 8 ? c.slice(0, 4) + ' ' + c.slice(4) : c; }

  // Opens the app if it is on this phone. A hidden iframe never shows Safari's "cannot open"
  // dialog; if the page is still visible after the timeout, the app is not installed and we
  // say so in the page instead of leaving a dead button.
  function tryOpenApp() {
    appState.tried = true;
    var left = false;
    function onHide() { if (doc.hidden) left = true; }
    doc.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    var frame = el('iframe', { src: schemeUrl(), hidden: true, title: 'open app', tabindex: '-1' });
    frame.style.display = 'none';
    doc.body.appendChild(frame);
    setTimeout(function () {
      doc.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      if (frame.parentNode) frame.parentNode.removeChild(frame);
      if (left || doc.hidden) rememberApp();
      else appState.missing = true;
      render(app.state());
    }, 1600);
  }

  function syncOpenButton(st) {
    var show = appState.known && !!st.code && st.screen !== 'error' && st.screen !== 'deleted';
    openBtn.hidden = !show;
    openBtn.href = show ? schemeUrl() : '#';
  }
  openBtn.addEventListener('click', function (e) { e.preventDefault(); tryOpenApp(); });

  // Android Chrome can tell us directly (needs related_applications in the manifest).
  if (navigator.getInstalledRelatedApps) {
    navigator.getInstalledRelatedApps().then(function (apps) {
      if (apps && apps.length) { rememberApp(); if (app) render(app.state()); }
    }).catch(function () { /* unsupported */ });
  }

  function notice(st) {
    if (!st.notice) return null;
    return el('div.notice', { role: 'status' }, el('strong', { text: st.notice.title }), ' ', st.notice.body);
  }

  function promisesCard(st) {
    return el('div.card.butter',
      el('p.promise-intro', { text: st.promisesIntro }),
      el('ol.promises', null, st.promises.map(function (p, i) {
        return el('li', null, el('span.num', { text: String(i + 1), 'aria-hidden': 'true' }), el('span', { text: p }));
      }))
    );
  }

  function codeCard(st) {
    return el('div.card.lavender',
      el('p.small', { text: 'Your code' }),
      el('p.code', { text: st.code }),
      el('p.small', { text: 'Open the app, tap Join and type this. Whatever you did here comes with you.' }),
      st.claimCode ? el('p.small', { text: 'Your claim code' }) : null,
      st.claimCode ? el('p.code', { text: spacedClaim(st.claimCode), 'data-testid': 'claim-code' }) : null,
      st.claimCode ? el('p.small', { text: 'The app asks for it when you join. It works for a day; open this link again on this phone for a fresh one.' }) : null
    );
  }

  function installBlock(st) {
    var links = [];
    if (stores.ios) links.push(el('a.btn.primary', { href: stores.ios, rel: 'noopener', text: 'Get it on the App Store' }));
    if (stores.android) links.push(el('a.btn.primary', { href: stores.android, rel: 'noopener', text: 'Get it on Google Play' }));
    var openRow = null;
    if (appState.known) {
      openRow = el('a.btn.lemon', { href: schemeUrl(), text: 'Open in the app', on: { click: function (e) { e.preventDefault(); tryOpenApp(); } } });
    } else if (appState.missing) {
      openRow = el('p.small', { text: "Looks like the app isn't on this phone yet. Get it, then use the code below." });
    } else {
      openRow = el('button.link', { type: 'button', text: 'I already have the app', on: { click: tryOpenApp } });
    }
    return [
      links.length ? el('div.btns', null, links) : el('p.small', { text: 'Search for Cuddle Pop in the App Store or Google Play.' }),
      openRow,
      codeCard(st),
    ];
  }

  function deleteBlock(st) {
    if (!st.confirmDelete) {
      return el('button.link.danger', { type: 'button', text: 'Delete the whole thing', on: { click: app.askDelete } });
    }
    return el('div.card.peach', { role: 'group', 'aria-label': 'Confirm delete' },
      el('p.promise-intro', { text: 'Delete it for both of you?' }),
      el('p.lede', { text: 'Your side, the fight, all of it. Oliver drops it like it never happened, and ' + (st.name ? st.name + ' only hears' : 'they only hear') + ' that you asked for that.' }),
      el('div.btns.row',
        el('button.btn.danger', { type: 'button', text: 'Yes, delete it', disabled: st.busy, on: { click: app.confirmDelete } }),
        el('button.btn', { type: 'button', text: 'Keep it', disabled: st.busy, on: { click: app.cancelDelete } })
      )
    );
  }

  // The first-screen greeting: "Hey Sam 👋" when the inviter gave the guest's name, else null.
  function hey(st) {
    return st.you ? 'Hey ' + st.you + ' 👋' : null;
  }
  // "Thanks, Sam. " on the closing screens; nothing without a name.
  function thanks(st) {
    return st.you ? 'Thanks, ' + st.you + '. ' : '';
  }

  // One lemon word per screen title (docs/08 highlighter rule); the text reads "Hey, I'm Oliver."
  function oliverTitle() {
    return el('h1.title', null, "Hey, I'm ", el('span.hl', { text: 'Oliver' }), '.');
  }

  var textarea = null; // kept across renders so typing never loses focus or the caret

  function saveLabel(st) {
    switch (st.saveState) {
      case 'saving': return 'Saving…';
      case 'saved': return 'Saved. Only you can see this.';
      case 'error': return "Couldn't save. Still trying.";
      case 'stuck': return "Couldn't save this. Your words are still here.";
      case 'dirty': return 'Typing…';
      default: return 'Saves as you type.';
    }
  }

  var screens = {
    loading: function () {
      return [el('p.eyebrow', { text: 'One sec' }), el('h1.title', { text: 'Getting Cuddle Pop…' })];
    },

    error: function (st) {
      var c = errorCopy(st.error, st.name);
      return [
        el('h1.title', { text: c.title }),
        el('p.lede', { text: c.body }),
        c.retry ? el('div.btns', null, el('button.btn.primary', { type: 'button', text: 'Try again', on: { click: app.retry } })) : null,
        st.error && st.error.requestId ? el('p.small', { text: 'Ref ' + st.error.requestId }) : null,
        el('a.link', { href: '/', text: 'What is Cuddle Pop?' }),
      ];
    },

    promises: function (st) {
      var f = st.fight;
      return [
        el('p.eyebrow', { text: hey(st) || (st.name || 'Someone') + ' asked Oliver to hear you out' }),
        oliverTitle(),
        el('p.lede', { text: "I'm the friend you two have in common. " + (st.name || 'They') + ' told me a bit about you, and about “' + f.title + '”. Now it’s your turn, and only on your terms.' }),
        f.heard === 'one_side' ? el('p.chip', null, el('span', { 'aria-hidden': 'true', text: '🧸 ' }), HALF_HEARD) : null,
        promisesCard(st),
        el('div.btns', null, el('button.btn.primary', { type: 'button', text: "Okay, I'll say my side", on: { click: app.acceptPromises } })),
        el('p.small', { text: 'No app, no account. Just you and me for a minute.' }),
      ];
    },

    side: function (st) {
      if (!textarea) {
        textarea = el('textarea', {
          id: 'side-text', maxLength: MAX_SIDE, placeholder: 'What happened, from where you were standing.',
          'aria-label': 'Your side', on: { input: function (e) { app.editSide(e.target.value); } },
        });
      }
      if (textarea.value !== st.sideText) textarea.value = st.sideText;
      sideView = {
        label: el('span', { text: saveLabel(st), 'aria-live': 'polite' }),
        count: el('span', { text: st.sideText.length + ' / ' + MAX_SIDE }),
        slot: el('div', null, notice(st)),
        button: el('button.btn.primary', { type: 'button', text: "That's my side", disabled: st.busy, on: { click: app.finishSide } }),
      };
      return [
        el('p.eyebrow', { text: 'Your side' }),
        el('h1.title', null, 'Oliver is ', el('span.hl', { text: 'listening' }), '. Take your time.'),
        textarea,
        el('div.save-row', null, sideView.label, sideView.count),
        sideView.slot,
        el('div.btns', null, sideView.button),
        el('p.small', { text: (st.name || 'They') + " can't read this. Nothing goes anywhere until you say yes." }),
      ];
    },

    yes: function (st) {
      return [
        el('p.eyebrow', { text: 'Your call' }),
        el('h1.title', { text: 'Share this with Oliver so both sides get heard?' }),
        el('p.lede', { text: 'Until you say yes it stays sealed. Oliver hasn’t read it, and ' + (st.name ? st.name + ' only sees' : 'they only see') + ' that you wrote something, never the words.' }),
        notice(st),
        el('div.btns.row',
          el('button.btn.primary', { type: 'button', text: 'Yes', disabled: st.busy, on: { click: app.consent } }),
          el('button.btn', { type: 'button', text: 'Not yet', disabled: st.busy, on: { click: app.notYet } })
        ),
        el('button.link', { type: 'button', text: 'Change what I wrote', on: { click: app.editAgain } }),
        deleteBlock(st),
      ];
    },

    notyet: function (st) {
      var until = '';
      if (st.expiresAt) {
        var d = new Date(st.expiresAt);
        if (!isNaN(d.getTime())) until = ' It works until ' + d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) + '.';
      }
      return [
        el('p.eyebrow', { text: 'Sealed' }),
        el('h1.title', { text: 'No rush.' }),
        el('p.lede', { text: 'Your side stays sealed and Oliver won’t read it. Open this link again on this phone whenever you’re ready.' + until }),
        notice(st),
        el('div.btns',
          el('button.btn.primary', { type: 'button', text: 'Share it now', disabled: st.busy, on: { click: app.consent } }),
          el('button.btn', { type: 'button', text: 'Change what I wrote', on: { click: app.editAgain } })
        ),
        deleteBlock(st),
      ];
    },

    done: function (st) {
      return [
        el('p.eyebrow', { text: 'Shared' }),
        el('h1.title', { text: 'Oliver has both sides now.' }),
        el('p.lede', { text: thanks(st) + 'Want to see what Oliver said? Get the app, your side is already in it.' }),
      ].concat(installBlock(st));
    },

    closed: function (st) {
      var side = st.fight && st.fight.my_side;
      var wrote = !!(side && side.text) || !!(st.sideText && st.sideText.trim());
      return [
        el('p.eyebrow', { text: 'Wrapped up' }),
        el('h1.title', { text: 'They already wrapped this one up.' }),
        el('p.lede', { text: (st.name || 'They') + ' closed this one, so there’s nothing to add here now.' + (wrote ? ' Your side stayed sealed: Oliver never read it.' : '') }),
        notice(st),
        wrote ? deleteBlock(st) : null,
        el('a.link', { href: '/', text: 'What is Cuddle Pop?' }),
      ];
    },

    deleted: function (st) {
      return [
        el('p.eyebrow', { text: 'Dropped' }),
        el('h1.title', { text: 'Gone, like it never happened.' }),
        el('p.lede', { text: (st.name ? st.name + ' only hears' : 'They only hear') + ' that you asked Oliver to drop it. Nothing you wrote, nothing else.' }),
        el('a.link', { href: '/', text: 'What is Cuddle Pop?' }),
      ];
    },

    code: function (st) {
      return [
        el('p.eyebrow', { text: hey(st) || 'An invite from ' + (st.name || 'your person') }),
        el('h1.title', { text: (st.name || 'Someone') + ' wants you to meet Oliver.' }),
        el('p.lede', { text: "I'm Oliver, the friend you two have in common. " + (st.name || 'They') + ' told me a bit about you. Now it’s your turn, and only on your terms. Get the app and you’re in.' }),
        promisesCard(st),
      ].concat(installBlock(st));
    },

    gameintro: function (st) {
      var g = st.game;
      var who = (g && g.initiator_first_name) || st.name || 'Your person';
      // No delete promise here: a guest cannot delete game answers, so none is implied.
      return [
        el('p.eyebrow', { text: hey(st) || 'A 2-minute game from ' + who }),
        oliverTitle(),
        el('p.lede', { text: "I'm the friend you two have in common. " + who + ' told me a bit about you and picked a 2-minute game for you both. Now it’s your turn, and only on your terms.' }),
        el('div.card.butter',
          el('p.promise-intro', { text: 'How this works.' }),
          el('ol.promises', null, [
            'Your answers stay sealed until you have both answered.',
            'Then you each see the other’s shared answers, side by side. Nothing else.',
            'No app, no account. Just a few taps.',
          ].map(function (p, i) {
            return el('li', null, el('span.num', { text: String(i + 1), 'aria-hidden': 'true' }), el('span', { text: p }));
          }))
        ),
        el('div.btns', null, el('button.btn.primary', { type: 'button', text: "Let's play", on: { click: app.startGame } })),
      ];
    },

    game: function (st) {
      var g = st.game;
      var qs = g.game.questions;
      var q = app.currentQuestion();
      var body;
      if (q.type === 'choice') {
        body = el('div.choices', null, (q.options || []).map(function (opt) {
          return el('button.choice', { type: 'button', text: opt, disabled: st.busy, on: { click: function () { app.answer(opt); } } });
        }));
      } else if (q.type === 'scale') {
        var lo = q.min == null ? 1 : q.min, hi = q.max == null ? 5 : q.max, nums = [];
        for (var n = lo; n <= hi; n++) nums.push(n);
        body = el('div.choices.scale', { role: 'group', 'aria-label': 'From ' + lo + ' to ' + hi }, nums.map(function (v) {
          return el('button.choice', { type: 'button', text: String(v), disabled: st.busy, on: { click: function () { app.answer(v); } } });
        }));
      } else {
        var input = el('textarea', { maxLength: 500, placeholder: 'Your answer', 'aria-label': q.prompt });
        input.style.minHeight = '120px';
        body = el('div.btns', null, input,
          el('button.btn.primary', { type: 'button', text: 'Next', disabled: st.busy, on: { click: function () { app.answer(input.value); } } }));
      }
      var pct = Math.round((st.qIndex / qs.length) * 100);
      return [
        el('p.eyebrow', { text: 'A 2-minute game from ' + (g.initiator_first_name || st.name || 'your person') }),
        el('div.progress', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(qs.length), 'aria-valuenow': String(st.qIndex) }, (function () { var b = el('span'); b.style.width = pct + '%'; return b; })()),
        el('p.small', { text: g.game.title + ' · ' + (st.qIndex + 1) + ' of ' + qs.length }),
        el('h1.title', { text: q.prompt }),
        body,
        notice(st),
        el('p.small', { text: 'Your answers stay sealed until you have both answered.' }),
      ];
    },

    sealed: function (st) {
      var who = (st.game && st.game.initiator_first_name) || st.name || 'They';
      return [
        el('p.eyebrow', { text: 'Sealed' }),
        el('h1.title', { text: 'Your answers are in.' }),
        el('p.lede', { text: thanks(st) + who + " hasn't finished yet. Nobody sees anything until you've both answered." }),
        notice(st),
        el('div.btns', null, el('button.btn', { type: 'button', text: 'Check again', disabled: st.busy, on: { click: app.refreshGame } })),
        el('p.promise-intro', { text: 'You two are in. Get the app to keep going.' }),
      ].concat(installBlock(st));
    },

    reveal: function (st) {
      var g = st.game;
      var who = g.initiator_first_name || st.name || 'Them';
      var byId = {};
      g.game.questions.forEach(function (q) { byId[q.id] = q; });
      function show(v) { return v == null ? '—' : typeof v === 'string' ? v : String(v); }
      var items = (g.revealed || []).map(function (r) {
        var q = byId[r.question_id];
        return el('li.card', null,
          el('p.q', { text: q ? q.prompt : '' }),
          el('dl', null, el('dt', { text: 'You' }), el('dd', { text: show(r.mine) }), el('dt', { text: who }), el('dd', { text: show(r.theirs) }))
        );
      });
      return [
        el('p.eyebrow', { text: g.game.title }),
        el('h1.title', { text: "Here's how you both answered." }),
        st.you ? el('p.lede', { text: 'Thanks for playing, ' + st.you + '.' }) : null,
        items.length ? el('ul.reveal', null, items) : el('p.lede', { text: 'These ones stay between each of you and Oliver.' }),
        el('p.promise-intro', { text: 'You two are in. Get the app to keep going.' }),
      ].concat(installBlock(st));
    },
  };

  // The side screen is built once and then patched, so typing never re-mounts the textarea
  // (re-mounting would drop focus and the caret on every keystroke).
  var sideView = null;
  function patchSide(st) {
    sideView.label.textContent = saveLabel(st);
    sideView.count.textContent = st.sideText.length + ' / ' + MAX_SIDE;
    sideView.button.disabled = !!st.busy;
    var n = notice(st);
    sideView.slot.replaceChildren ? sideView.slot.replaceChildren() : (sideView.slot.textContent = '');
    if (n) sideView.slot.appendChild(n);
    if (textarea.value !== st.sideText) textarea.value = st.sideText;
  }

  function render(st) {
    syncOpenButton(st);
    if (st.screen === 'side' && lastScreen === 'side' && sideView) return patchSide(st);
    sideView = null;
    var make = screens[st.screen] || screens.loading;
    var kids = make(st);
    var section = el('section.screen', null, kids);
    appEl.replaceChildren ? appEl.replaceChildren(section) : (appEl.textContent = '', appEl.appendChild(section));
    if (st.screen !== 'side') textarea = null;
    if (lastScreen !== st.screen) {
      lastScreen = st.screen;
      window.scrollTo(0, 0);
      if (st.screen === 'side' && textarea) textarea.focus();
      else appEl.focus({ preventScroll: true });
    }
  }

  // localStorage, so a new tab or a reopened link on this phone keeps the guest's place (see top).
  var store = null;
  try { store = window.localStorage; } catch (e) { store = null; }
  app = createSide({
    fetch: window.fetch.bind(window),
    apiBase: apiBaseFrom(meta('api-base'), location.origin),
    code: parseCode(location),
    storage: store,
    onChange: render,
  });
  // Save whatever is typed if they leave mid-sentence.
  window.addEventListener('pagehide', function () { if (app.state().screen === 'side') app.saveSide(); });
  app.start();
})(this);
