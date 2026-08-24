/* ============================================================================
   GOBBONET MOD — /imagine
   Local image generation, pasted into MODS. No core files patched.

   Paste this whole file into  // MODS → add a script → raw JS.

   WHAT IT NEEDS
   -------------
   A local image server. Either:

     a) GobboNet's own /image proxy, if your fileserver has it (this mod tries
        that first and needs nothing else), or
     b) ComfyUI started with CORS enabled, because a browser on one origin may
        not POST to another:

            python main.py --enable-cors-header

        Measured: without that flag ComfyUI answers a cross-origin request with
        403 before reading it, and nothing in the failure names a header.

   No GPU is fine. `python main.py --cpu` works; expect roughly ten times the
   wait (measured: 768px SDXL-lightning 9s on a 5090, 107s on 32 CPU cores).

   WHY A MOD AND NOT A PATCH
   -------------------------
   The core feature edits chat.html, fileserver.ps1 and three js/ files. That is
   right for a fork and wrong for distribution: a user who patches files cannot
   take an upstream update without a merge. This does the same job from the MODS
   panel, so it survives every upgrade and can be removed by deleting one entry.

   It costs one thing: the core version renders through the message renderer,
   which a mod cannot extend. So this one draws its own images and re-draws them
   after every render (GobboNet re-renders the whole list). They are stored ON
   the message, so they survive a reload like any other thread content.
   ============================================================================ */
(function () {
  'use strict';

  var BUILD = 'gobbonet-imagine 1.0.0';
  if (window.__gobboImagineLoaded) {
    console.log('[' + BUILD + '] already loaded, skipping');
    return;
  }
  window.__gobboImagineLoaded = true;

  var SERVED = window.location.protocol.indexOf('http') === 0;

  /* Two bases, tried in order. The same-origin proxy first because it needs no
     ComfyUI flag; direct loopback second for a stock ComfyUI with CORS on. */
  function bases() {
    var out = [];
    // An explicit override wins. Set it BEFORE this mod runs, e.g. in an
    // earlier MODS script:  window.GOBBO_IMAGE_BASE = 'http://127.0.0.1:8189';
    // Needed by anyone whose ComfyUI is not on the default port -- otherwise
    // they get "no backend reachable" from a probe that never looked there.
    if (window.GOBBO_IMAGE_BASE) out.push(String(window.GOBBO_IMAGE_BASE).replace(/\/+$/, ''));
    if (SERVED) out.push(window.location.origin + '/image');
    out.push('http://127.0.0.1:8188');
    return out;
  }

  var _base = null;

  /* Probe the route GENERATION uses, not /health or /. A server can be alive
     and have no image route, and reporting that as "not running" sends you to
     fix the wrong thing. */
  async function resolveBase() {
    if (_base) return _base;
    var tried = [];
    for (var i = 0; i < bases().length; i++) {
      var b = bases()[i];
      try {
        var r = await fetch(b + '/object_info/CheckpointLoaderSimple', { cache: 'no-store' });
        if (r.ok) { _base = b; return b; }
        tried.push(b + ' -> HTTP ' + r.status);
      } catch (e) {
        tried.push(b + ' -> ' + (e && e.message ? e.message : 'unreachable'));
      }
    }
    throw new Error(
      'No image backend reachable. Tried: ' + tried.join('; ') + '. ' +
      'Start ComfyUI (port 8188). If GobboNet is served over http and ComfyUI ' +
      'is not behind its /image proxy, ComfyUI needs --enable-cors-header, ' +
      'because a browser may not post across origins.'
    );
  }

  function graph(o) {
    return {
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: o.ckpt } },
      '5': { class_type: 'EmptyLatentImage', inputs: { width: o.width, height: o.height, batch_size: 1 } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: o.prompt, clip: ['4', 1] } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: o.negative || '', clip: ['4', 1] } },
      '3': { class_type: 'KSampler', inputs: {
              seed: o.seed, steps: o.steps, cfg: o.cfg,
              sampler_name: 'euler', scheduler: 'normal', denoise: 1,
              model: ['4', 0], positive: ['6', 0], negative: ['7', 0],
              latent_image: ['5', 0] } },
      '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
      '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'GobboNet', images: ['8', 0] } }
    };
  }

  function parseFlags(raw) {
    var o = { prompt: '', width: 768, height: 768, steps: 20, cfg: 6, seed: null, ckpt: '', negative: '' };
    var t = String(raw || '');
    function take(re, cast, key) {
      var m = t.match(re);
      if (m) { o[key] = cast(m[1]); t = t.replace(m[0], ' '); }
    }
    take(/--w(?:idth)?\s+(\d{2,5})/i, Number, 'width');
    take(/--h(?:eight)?\s+(\d{2,5})/i, Number, 'height');
    take(/--steps?\s+(\d{1,3})/i, Number, 'steps');
    take(/--cfg\s+([\d.]{1,6})/i, Number, 'cfg');
    take(/--seed\s+(\d{1,12})/i, Number, 'seed');
    take(/--(?:ckpt|model)\s+(\S+)/i, String, 'ckpt');
    var neg = t.match(/--(?:no|negative)\s+"([^"]*)"/i) || t.match(/--(?:no|negative)\s+(\S+)/i);
    if (neg) { o.negative = neg[1]; t = t.replace(neg[0], ' '); }
    o.prompt = t.replace(/\s+/g, ' ').trim();
    return o;
  }

  /* Inline the bytes. A /view URL renders as NOTHING here: GobboNet suppresses
     remote <img src> by design, so an imported or synced card cannot beacon a
     viewer's IP. That guard is right; a data: URL is what it explicitly allows,
     and it also means the picture survives ComfyUI stopping. */
  async function toDataUrl(url) {
    var r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('Could not read the generated image (HTTP ' + r.status + ').');
    var blob = await r.blob();
    if (!blob.size) throw new Error('The generated image came back empty.');
    return await new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(String(fr.result)); };
      fr.onerror = function () { rej(new Error('Could not decode the generated image.')); };
      fr.readAsDataURL(blob);
    });
  }

  async function generate(o, tick) {
    var base = await resolveBase();
    tick('checkpoints', 'asking what models are available');

    var info = await fetch(base + '/object_info/CheckpointLoaderSimple', { cache: 'no-store' });
    var ckpts = [];
    if (info.ok) {
      try {
        ckpts = (await info.json()).CheckpointLoaderSimple.input.required.ckpt_name[0] || [];
      } catch (e) { ckpts = []; }
    }
    if (!ckpts.length) {
      throw new Error('ComfyUI is running but reports no checkpoints. Put a model in ' +
                      'ComfyUI/models/checkpoints and restart it.');
    }
    var ckpt = (o.ckpt && ckpts.indexOf(o.ckpt) !== -1) ? o.ckpt : ckpts[0];
    var seed = (o.seed !== null && o.seed !== undefined) ? o.seed : Math.floor(Math.random() * 4294967295);

    tick('queue', 'queuing on ' + ckpt);
    var q = await fetch(base + '/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: graph({ prompt: o.prompt, negative: o.negative, width: o.width,
                        height: o.height, steps: o.steps, cfg: o.cfg, seed: seed, ckpt: ckpt }),
        client_id: 'gobbonet-mod-' + Math.random().toString(36).slice(2)
      })
    });
    if (!q.ok) {
      var detail = await q.text().catch(function () { return ''; });
      throw new Error('ComfyUI refused the job (HTTP ' + q.status + '). ' + detail.slice(0, 300));
    }
    var id = (await q.json()).prompt_id;
    if (!id) throw new Error('ComfyUI accepted the job but returned no prompt_id.');

    /* Bounded. An unbounded poll against a wedged backend is a hang that looks
       like a slow model. Generous, because CPU generation is ~10x GPU. */
    var deadline = Date.now() + 600000;
    var n = 0;
    while (Date.now() < deadline) {
      await new Promise(function (r) { setTimeout(r, 900); });
      n++;
      tick('render', 'working (' + n + ')');
      var h = await fetch(base + '/history/' + id, { cache: 'no-store' });
      if (!h.ok) continue;
      var entry = (await h.json())[id];
      if (!entry) continue;
      var urls = [];
      var outs = entry.outputs || {};
      for (var k in outs) {
        (outs[k].images || []).forEach(function (img) {
          urls.push(base + '/view?' + new URLSearchParams({
            filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output'
          }).toString());
        });
      }
      if (urls.length) {
        tick('fetch', 'pulling the bytes');
        var imgs = [];
        for (var j = 0; j < urls.length; j++) imgs.push(await toDataUrl(urls[j]));
        return { images: imgs, ckpt: ckpt };
      }
      if (entry.status && entry.status.status_str === 'error') {
        throw new Error('ComfyUI reported an error running the graph. Check its console.');
      }
    }
    throw new Error('No image within 10 minutes. It may still be working — check ComfyUI.');
  }

  /* ---- rendering -------------------------------------------------------
     A mod cannot extend the message renderer, so it paints its own images and
     re-paints after every render. They live ON the message, so saveState()
     persists them exactly like the rest of the thread. */
  function paint() {
    var thread = (typeof getActiveThread === 'function') ? getActiveThread() : null;
    if (!thread) return;
    var rows = document.querySelectorAll('#messages .message');
    thread.messages.forEach(function (m, i) {
      if (!m.gobboImages || !m.gobboImages.length) return;
      var row = rows[i];
      if (!row || row.querySelector('.gobbo-imagine-wrap')) return;
      var wrap = document.createElement('div');
      wrap.className = 'gobbo-imagine-wrap';
      m.gobboImages.forEach(function (g) {
        if (String(g.dataUrl || '').indexOf('data:image/') !== 0) return;  // local bytes only
        var fig = document.createElement('figure');
        fig.className = 'gobbo-imagine-fig';
        var im = document.createElement('img');
        im.className = 'gobbo-imagine-img';
        im.src = g.dataUrl;
        im.alt = g.prompt || '';
        var cap = document.createElement('figcaption');
        cap.className = 'gobbo-imagine-cap';
        cap.textContent = (g.prompt || '') + (g.ckpt ? '  // ' + g.ckpt : '');
        fig.appendChild(im); fig.appendChild(cap); wrap.appendChild(fig);
      });
      if (wrap.childNodes.length) row.appendChild(wrap);
    });
  }

  if (typeof renderMessages === 'function') {
    var _render = renderMessages;
    window.renderMessages = function () {
      var out = _render.apply(this, arguments);
      try { paint(); } catch (e) { console.error('[imagine] paint:', e); }
      return out;
    };
  }

  var css = document.createElement('style');
  css.className = 'gobbonet-ext';
  css.textContent =
    '.gobbo-imagine-wrap{display:flex;flex-direction:column;gap:10px;margin:8px 0 0 0}' +
    '.gobbo-imagine-fig{margin:0;padding:6px;max-width:640px;' +
      'border:1px solid var(--green-dim,#2a5);background:var(--bg-panel,#0a0f0a)}' +
    '.gobbo-imagine-img{display:block;width:100%;height:auto}' +
    '.gobbo-imagine-cap{font-size:11px;line-height:1.4;padding:6px 2px 2px;' +
      'color:var(--green-dim,#2a5);word-break:break-word}';
  document.head.appendChild(css);

  /* ---- the command ----------------------------------------------------- */
  async function runImagine(raw) {
    var o = parseFlags(raw);
    var thread = getActiveThread();
    if (!thread) { createThread(); thread = getActiveThread(); }

    thread.messages.push({ role: 'user', content: '/imagine ' + String(raw).trim(), timestamp: Date.now() });
    var msg = { role: 'assistant', content: '// starting image generation...', timestamp: Date.now() };
    thread.messages.push(msg);
    if (typeof bumpThreadToTop === 'function') bumpThreadToTop(thread.id);
    saveState(); renderMessages();
    if (typeof scrollToBottom === 'function') scrollToBottom();

    var t0 = Date.now();
    function tick(stage, detail) {
      var s = ((Date.now() - t0) / 1000).toFixed(0);
      msg.content = '// ' + stage + (detail ? ' -- ' + detail : '') + ' (' + s + 's)';
      renderMessages();
    }

    try {
      var out = await generate(o, tick);
      msg.content = '// generated in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's';
      msg.gobboImages = out.images.map(function (d) {
        return { dataUrl: d, prompt: o.prompt, ckpt: out.ckpt };
      });
    } catch (e) {
      /* The message IS the product: every throw above names the lane, the port
         and what to start. Surface it rather than a generic failure. */
      msg.content = '// image generation failed\n\n' + (e && e.message ? e.message : e);
    }
    saveState(); renderMessages();
    if (typeof scrollToBottom === 'function') scrollToBottom();
  }

  /* Wrap sendMessage rather than replacing it — anything else this install has
     layered on top keeps working. */
  if (typeof sendMessage === 'function') {
    var _send = sendMessage;
    window.sendMessage = function (override) {
      var input = document.getElementById('msg-input');
      var content = (override !== undefined) ? override : (input ? input.value.trim() : '');
      if (override === undefined && /^\/(imagine|img)\s/i.test(content)) {
        if (input) { input.value = ''; input.style.height = 'auto'; }
        return runImagine(content.replace(/^\/(imagine|img)\s+/i, ''));
      }
      return _send.apply(this, arguments);
    };
    console.log('%c[' + BUILD + '] ready — type /imagine <prompt>', 'color:#0a0;font-weight:bold');
  } else {
    console.error('[' + BUILD + '] sendMessage not found; load this AFTER GobboNet boots.');
  }

  window.gobboImagine = { generate: generate, parseFlags: parseFlags, resolveBase: resolveBase };
})();
