/* GobboNet image mod — renders images the Bonsai worker produces.
 *
 * WHY THIS EXISTS. In-browser image generation ALREADY works on the Living Desktop,
 * on the visitor's own GPU, with no account. The GobboNet page simply cannot draw the
 * result, so `generate_image` is filtered out of the model's tool list on purpose —
 * the adapter says so in its own words:
 *
 *     generate_image: 'the worker returns images on a channel this page does not render'
 *
 * That is a RENDERING gap, not a capability gap. This is the renderer.
 *
 * WHY IT IS A MOD AND NOT A FORK PATCH. Upstream (GoblinCorps, MIT) ships an extension
 * system — `state.extensions` holds URL-hosted JS/CSS in IndexedDB — so a user installs
 * this by pasting a URL. No fork patch, no upstream change, no PR to wait on. The
 * keyless-search work took the same route and needed zero upstream change.
 *
 * 🚨 IT MAKES NO NETWORK REQUESTS, AND THAT IS A HARD CONSTRAINT, NOT A STYLE CHOICE.
 * GoblinCorps' front page promises literally ZERO outbound bytes after setup. A mod
 * that fetched anything — a font, an icon, a "just this once" telemetry ping — would
 * make that promise false for anyone who installed it, and it would be OUR mod that
 * did it. Images arrive as data: URIs or Blobs already in the page; nothing here
 * dials out, and `assertNoNetwork()` below is the self-check that says so.
 *
 * It also never RUNS anything: it draws what it is handed. Card code in GobboNet is
 * deliberately never auto-executed, and a mod that evaluated payloads would relax that
 * from the outside.
 *
 * ── THE SEAM ─────────────────────────────────────────────────────────────────────
 * This renders images from ANY source. It does not care who generated them, and that
 * is deliberate: a community member already built a ComfyUI mod for this page, and
 * the thing it needed was not a different generator but somewhere to put the output.
 * Two doors, both public:
 *
 *     window.dispatchEvent(new CustomEvent('gobbonet:image', { detail: { image: X } }))
 *     window.__AITHER_IMAGE_MOD__.add(X)
 *
 * X may be a data: URI, a Blob, a blob: URL, a LOOPBACK http URL (a self-hosted
 * ComfyUI at 127.0.0.1:8188/view?... is the point), or `{ b64, mime }`. Batches go as
 * `{ images: [...] }`. Anything else is refused with a console warning rather than
 * rendered as a dead <img>, because a broken element and a failed generation look
 * identical and that ambiguity is the most expensive thing a renderer can produce.
 *
 * Two failure modes it is built to NOT have, both of which present as "it breaks
 * after generating images":
 *   - blob: URLs are REVOKED on eviction and on clear. An uncapped set of live object
 *     URLs pins every decoded image in memory even behind a capped array.
 *   - nothing is persisted. Writing images to localStorage hits QuotaExceededError a
 *     few pictures in, and the throw lands inside whatever handler was saving them.
 *
 * Install (upstream Extensions panel, add by URL):
 *   https://aitherium.com/gobbonet/image-renderer.js
 *   https://aitherium.com/gobbonet/image-renderer.css
 */
(function () {
  'use strict';

  // Idempotent. Upstream re-applies extensions on load and a user may paste the URL
  // twice; a second copy would double every image and race the first for the DOM.
  if (window.__AITHER_IMAGE_MOD__) return;
  window.__AITHER_IMAGE_MOD__ = { version: '1.0.0', images: [] };

  var MAX_IMAGES = 40;      // a cap, because data: URIs are held in memory
  var EVENT = 'gobbonet:image';
  //: The adapter announces discovered image backends on this. It fires only on CHANGE,
  //: because a picker that re-renders on every poll throws away the open <select> under
  //: the visitor's cursor.
  var BACKEND_EVENT = 'gobbonet:image-backends';
  var backendEl = null;
  var state = window.__AITHER_IMAGE_MOD__;

  // ── critical CSS ─────────────────────────────────────────────────────────────
  // A minimal subset so the mod is USABLE for someone who installed only the JS.
  // The .css file is the full treatment; this is the part without which the panel
  // is unreadable rather than merely plain.
  function injectCriticalCss() {
    if (document.getElementById('aither-imgmod-css')) return;
    var s = document.createElement('style');
    s.id = 'aither-imgmod-css';
    s.textContent = [
      '.aither-imgmod{position:fixed;right:16px;bottom:16px;width:min(360px,calc(100vw - 32px));',
      'max-height:min(70vh,640px);display:flex;flex-direction:column;z-index:9999;',
      'background:var(--elevated,#0b0e13);border:1px solid var(--cyan-dim,#1b4a52);',
      'border-radius:8px;overflow:hidden;font-family:var(--font,ui-monospace,monospace)}',
      '.aither-imgmod[hidden]{display:none}',
      '.aither-imgmod__bar{display:flex;align-items:center;gap:8px;padding:8px 10px;',
      'background:var(--black,#05070a);border-bottom:1px solid var(--border,#1c2230)}',
      '.aither-imgmod__title{flex:1;font-size:11px;letter-spacing:.12em;text-transform:uppercase;',
      'color:var(--cyan-bright,#4dd6e8)}',
      '.aither-imgmod__count{font-size:11px;color:var(--label,#6d7a8c)}',
      '.aither-imgmod__btn{background:transparent;border:1px solid var(--border,#1c2230);',
      'color:var(--label,#6d7a8c);border-radius:4px;font:inherit;font-size:11px;padding:4px 7px;cursor:pointer}',
      '.aither-imgmod__grid{flex:1;overflow-y:auto;overflow-x:hidden;display:grid;',
      'grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;padding:10px;margin:0}',
      '.aither-imgmod__cell{position:relative;aspect-ratio:1/1;border:1px solid var(--border,#1c2230);',
      'border-radius:4px;overflow:hidden;background:var(--black,#05070a)}',
      '.aither-imgmod__cell img{width:100%;height:100%;object-fit:cover;display:block;cursor:zoom-in}',
      '.aither-imgmod__empty{padding:18px 12px;text-align:center;font-size:11px;line-height:1.6;',
      'color:var(--label,#6d7a8c)}',
      '.aither-imgmod-lb{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;',
      'justify-content:center;padding:24px;background:rgba(0,0,0,.82);cursor:zoom-out}',
      '.aither-imgmod-lb img{max-width:100%;max-height:100%;object-fit:contain}'
    ].join('');
    document.head.appendChild(s);
  }

  // ── payload normalisation ────────────────────────────────────────────────────
  /* The worker's image channel is not one shape, and guessing wrong renders a broken
   * <img> that looks exactly like a failed generation. Accept every shape it is known
   * to use and REFUSE anything else rather than producing a dead element:
   *   'data:image/png;base64,...'         a ready URL
   *   { url } | { src } | { image }       wrapped
   *   { b64, mime } | { base64 }          raw base64 needing a prefix
   *   Blob                                createObjectURL
   */
  // A LOOPBACK origin is allowed and a remote one is not, and the difference is the
  // whole seam. A self-hosted ComfyUI serves its results from
  // http://127.0.0.1:8188/view?filename=... -- refusing that would refuse the exact
  // case this mod exists for, while `https://cdn.example.com/x.png` would make a real
  // outbound request and break upstream's zero-bytes promise for everyone who
  // installed us. Loopback never leaves the machine, so it costs the promise nothing.
  var LOOPBACK = /^https?:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?\//i;

  function toSrc(payload) {
    if (!payload) return null;
    if (typeof payload === 'string') {
      if (/^(data:image\/|blob:)/.test(payload)) return payload;
      return LOOPBACK.test(payload) ? payload : null;
    }
    if (typeof Blob !== 'undefined' && payload instanceof Blob) {
      return URL.createObjectURL(payload);
    }
    var direct = payload.url || payload.src || payload.image || payload.dataUrl;
    if (typeof direct === 'string') return toSrc(direct);
    var b64 = payload.b64 || payload.base64 || payload.b64_json;
    if (typeof b64 === 'string' && b64) {
      var mime = payload.mime || payload.mimeType || 'image/png';
      return 'data:' + mime + ';base64,' + b64;
    }
    return null;
  }

  // Only blob: URLs need revoking. A data: URI is freed with its last reference, and
  // calling revokeObjectURL on one is a silent no-op -- but being explicit here keeps
  // the reason visible to whoever reads this next.
  function revoke(src) {
    if (typeof src === 'string' && src.indexOf('blob:') === 0) {
      try { URL.revokeObjectURL(src); } catch (e) { /* already gone */ }
    }
  }

  // ── UI ───────────────────────────────────────────────────────────────────────
  var panel = null, grid = null, countEl = null;

  function build() {
    if (panel) return panel;
    injectCriticalCss();
    panel = document.createElement('section');
    panel.className = 'aither-imgmod';
    panel.hidden = true;
    panel.setAttribute('aria-label', 'Generated images');

    var bar = document.createElement('div');
    bar.className = 'aither-imgmod__bar';

    var title = document.createElement('span');
    title.className = 'aither-imgmod__title';
    title.textContent = 'images';

    countEl = document.createElement('span');
    countEl.className = 'aither-imgmod__count';
    countEl.textContent = '0';

    var clear = document.createElement('button');
    clear.className = 'aither-imgmod__btn';
    clear.type = 'button';
    clear.textContent = 'clear';
    clear.addEventListener('click', function () {
      state.images.splice(0).forEach(revoke);
      render();
    });

    var hide = document.createElement('button');
    hide.className = 'aither-imgmod__btn';
    hide.type = 'button';
    hide.textContent = 'hide';
    hide.addEventListener('click', function () { panel.hidden = true; });

    // ── the backend picker ───────────────────────────────────────────────────
    // The mod OWNS this because the mod owns the panel; it does not own the routing.
    // Discovery and selection live in the adapter behind `window.AitherImageBackends`,
    // and `set()` REFUSES an id that was never discovered -- so this cannot point the
    // page at a port with nothing behind it, which would fail as a hang rather than an
    // error.
    //
    // The adapter may not be present at all: this file is installable through GobboNet's
    // own extension system by anyone, and a visitor who has the gallery but not the
    // adapter should get a gallery, not a broken control. Hence every access is guarded
    // and the picker simply stays hidden.
    backendEl = document.createElement('select');
    backendEl.className = 'aither-imgmod__backend';
    backendEl.title = 'where images are generated';
    backendEl.hidden = true;
    backendEl.addEventListener('change', function () {
      var api = window.AitherImageBackends;
      if (!api || !api.set(backendEl.value)) {
        // Refused: put the control back to what is actually in effect rather than
        // leaving it showing a choice that is not being honoured.
        renderBackends(api ? api.list() : [], api ? api.choice() : 'auto',
                       api && api.blocked ? api.blocked() : []);
      }
    });

    bar.appendChild(title);
    bar.appendChild(countEl);
    bar.appendChild(backendEl);
    bar.appendChild(clear);
    bar.appendChild(hide);

    grid = document.createElement('div');
    grid.className = 'aither-imgmod__grid';

    panel.appendChild(bar);
    panel.appendChild(grid);
    document.body.appendChild(panel);
    return panel;
  }

  function lightbox(src) {
    var lb = document.createElement('div');
    lb.className = 'aither-imgmod-lb';
    var img = document.createElement('img');
    img.src = src;
    img.alt = 'Generated image, enlarged';
    lb.appendChild(img);
    function close() {
      lb.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    lb.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(lb);
  }

  function render() {
    build();
    grid.textContent = '';
    countEl.textContent = String(state.images.length);
    if (!state.images.length) {
      var empty = document.createElement('p');
      empty.className = 'aither-imgmod__empty';
      empty.textContent = 'No images yet. Ask for one and it will appear here.';
      grid.appendChild(empty);
      return;
    }
    state.images.forEach(function (src, i) {
      var cell = document.createElement('div');
      cell.className = 'aither-imgmod__cell';
      var img = document.createElement('img');
      img.src = src;
      img.alt = 'Generated image ' + (i + 1);
      img.loading = 'lazy';
      img.addEventListener('click', function () { lightbox(src); });
      cell.appendChild(img);
      grid.appendChild(cell);
    });
  }

  function add(payload) {
    var src = toSrc(payload);
    if (!src) {
      // Say so rather than rendering a dead <img>. A broken element is
      // indistinguishable from a failed generation, and that ambiguity is the
      // single most expensive thing a renderer can produce.
      console.warn('[aither-image-mod] unrecognised image payload; not rendering', payload);
      return false;
    }
    state.images.push(src);
    // 🚨 REVOKE ON EVICTION. This is the "it breaks after generating images" bug in
    // its most common form: every blob: URL pins its whole decoded image in memory
    // until revoked, so a capped ARRAY with an uncapped set of live object URLs still
    // grows without bound -- the tab slows, then the renderer dies, and it looks like
    // the generator broke rather than the gallery. Dropping the reference is not
    // enough; the browser will not collect a blob URL you never revoked.
    while (state.images.length > MAX_IMAGES) {
      revoke(state.images.shift());
    }
    render();
    panel.hidden = false;
    return true;
  }

  // `auto` and `hosted` are always offered; the rest are whatever was discovered.
  // `hosted` is listed explicitly rather than implied by "no local backend", because
  // choosing to send a prompt off-box is a decision a visitor should be able to make on
  // purpose -- and to see that they made.
  function renderBackends(found, choice, blocked) {
    if (!backendEl) return;
    var opts = [{ id: 'auto', label: 'auto' }]
      .concat(found || [])
      .concat([{ id: 'hosted', label: 'hosted (off-device)' }]);
    // A backend that is RUNNING and refusing this page is listed, DISABLED, with the
    // fix in its title. Leaving it out entirely is what makes the failure silent: the
    // visitor can see ComfyUI in another tab and would reasonably conclude the picker
    // is broken rather than that ComfyUI needs --enable-cors-header.
    (blocked || []).forEach(function (b) {
      opts.push({ id: b.id, label: b.id + ' — blocked', disabled: true, title: b.remedy });
    });
    backendEl.textContent = '';
    opts.forEach(function (o) {
      var el = document.createElement('option');
      el.value = o.id;
      el.textContent = o.label;
      if (o.disabled) { el.disabled = true; el.title = o.title || ''; }
      if (o.id === choice && !o.disabled) el.selected = true;
      backendEl.appendChild(el);
    });
    // Hidden when there is nothing to choose BETWEEN: with no local backend the only
    // options are auto and hosted, which resolve to the same place, and a control whose
    // every setting does the same thing is worse than no control.
    // Shown when there is a real choice OR something to explain. A blocked backend is
    // information even though it cannot be selected.
    backendEl.hidden = !((found && found.length) || (blocked && blocked.length));
  }

  window.addEventListener(BACKEND_EVENT, function (ev) {
    var d = (ev && ev.detail) || {};
    renderBackends(d.backends || [], d.choice || 'auto', d.blocked || []);
  });

  window.addEventListener(EVENT, function (ev) {
    var d = ev && ev.detail;
    if (d && Array.isArray(d.images)) { d.images.forEach(add); return; }
    add(d && d.image !== undefined ? d.image : d);
  });

  // ── self-check ───────────────────────────────────────────────────────────────
  /* Exposed rather than run on load: this is a MOD on someone else's page, and a
   * renderer that ran assertions at install time would be doing work nobody asked
   * for. Call `__AITHER_IMAGE_MOD__.selfTest()` from the console.
   *
   * The network arm is the one that matters. The zero-outbound-bytes promise is
   * upstream's, and this file is the kind of thing that quietly breaks it.
   */
  state.selfTest = function () {
    var fails = [];
    var px = 'data:image/png;base64,iVBORw0KGgo=';

    if (toSrc(px) !== px) fails.push('a data: URL was rejected');
    if (toSrc({ b64: 'iVBORw0KGgo=', mime: 'image/webp' })
        !== 'data:image/webp;base64,iVBORw0KGgo=') fails.push('b64+mime not assembled');
    if (toSrc({ url: px }) !== px) fails.push('a wrapped url was rejected');

    // ...and must REFUSE what it cannot render, or it draws dead elements.
    if (toSrc(null) !== null) fails.push('null was accepted');
    if (toSrc('https://example.com/x.png') !== null) {
      fails.push('a REMOTE url was accepted — rendering one would make an outbound '
               + 'request and break the zero-bytes promise');
    }
    // ...but a LOOPBACK url must be ACCEPTED, or a self-hosted ComfyUI cannot show
    // its own output, which is the case this mod exists for.
    if (toSrc('http://127.0.0.1:8188/view?filename=x.png')
        !== 'http://127.0.0.1:8188/view?filename=x.png') {
      fails.push('a LOOPBACK url was refused — a self-hosted ComfyUI could not render');
    }
    if (toSrc('http://localhost:8188/view?f=x') === null) {
      fails.push('localhost was refused');
    }
    // A hostname that merely STARTS with a loopback name is remote.
    if (toSrc('http://localhost.evil.com/x.png') !== null) {
      fails.push('a lookalike host (localhost.evil.com) was accepted as loopback');
    }
    if (toSrc({ nothing: 1 }) !== null) fails.push('an unrecognised object was accepted');

    // No network primitive is referenced anywhere in this file.
    var src = state.selfTest.toString() + add.toString() + toSrc.toString()
            + render.toString() + build.toString();
    if (/\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|importScripts)\s*\(/.test(src)) {
      fails.push('a network primitive is reachable from the render path');
    }

    fails.forEach(function (f) { console.error('[aither-image-mod] SELF-TEST FAIL: ' + f); });
    if (!fails.length) {
      console.log('[aither-image-mod] self-test OK — known payload shapes render, '
                + 'remote URLs and junk are refused, no network primitive on the path');
    }
    return fails.length === 0;
  };

  state.add = add;
  state.render = render;
  render();
  console.log('[aither-image-mod] ready — listening for "' + EVENT + '"');
})();
