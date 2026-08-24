/* @gobbonet-split js/25-image.js
   Image generation -- local backends only, auto-detected and auto-routed.
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   IMAGE GENERATION

   Same promise as the rest of GobboNet: nothing leaves the machine.
   Every backend here is either a loopback server on the host or a
   model running inside this browser tab. There is no hosted option
   and there is no API key, because there is nowhere to send one.

   THREE LANES, tried in this order:

     comfyui  ComfyUI on the host (default :8188). The one most
              people already have. Highest quality, needs a model.
     sana     Sana via an awdk agent stack (:8202). Fast, small.
     awdk     A generic awdk image API (:9001) if the stack exposes
              one -- this is the lane that "just works" when you are
              already running agents.
     bonsai   In-browser WebGPU. No server at all. Always last: it is
              the slowest and the weakest, but it is the only lane
              that works on a machine with nothing installed.

   WHY DETECTION IS A SERVER CALL AND NOT A fetch() PER PORT
   ---------------------------------------------------------
   Open GobboNet from your phone over the LAN and this browser is not
   on the host. Probing 127.0.0.1 from here probes the PHONE, finds
   nothing, and we would report "no image backend" while ComfyUI is
   running fine on the desktop three feet away. The host is the only
   party that can answer, so fileserver.ps1 answers it at
   /image/backends. Bonsai is the exception and is decided here,
   because the host cannot know whether YOUR browser has WebGPU.

   WHEN NOTHING IS AVAILABLE WE SAY SO, LOUDLY
   -------------------------------------------
   The failure mode this module is written against is the silent
   no-op: a generate button that returns nothing and looks like a
   model with no ideas. Every failure path here names the lane, the
   port, and what to start. An empty result is never rendered as a
   successful empty result.
================================================================ */

const IMAGE_BUILD = '1.0.0-local-lanes';

/* Populated by detectImageBackends(). Null means "not asked yet",
   which is deliberately distinct from [] meaning "asked, none up". */
let imageBackends = null;

/* The lane a generate call will use, or null. Recomputed on detect. */
let activeImageBackend = null;

/**
 * Does this browser have WebGPU? Bonsai needs it; the wasm fallback
 * exists for chat but is far too slow to be honest about for images.
 *
 * Deliberately does NOT request an adapter -- that can prompt, and on
 * some builds it warms a device we may never use. Presence of the API
 * is what we claim, and the Bonsai lane reports its own real failure
 * if the adapter turns out to be unusable.
 */
function browserCanBonsai() {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

/**
 * Ask the HOST which local image servers are answering.
 * Returns an array of {id,label,port,up,note}. Never throws --
 * a detection failure is itself a reportable state, not an exception
 * for a caller to swallow.
 */
async function detectImageBackends() {
  let hostLanes = [];
  let detectError = null;

  if (IS_SERVED) {
    try {
      const r = await fetch(window.location.origin + '/image/backends', {
        method: 'GET',
        cache: 'no-store',
      });
      if (r.ok) {
        const body = await r.json();
        hostLanes = Array.isArray(body.backends) ? body.backends : [];
      } else {
        detectError = `host probe returned HTTP ${r.status}`;
      }
    } catch (e) {
      detectError = `host probe failed: ${e && e.message ? e.message : e}`;
    }
  } else {
    // file:// -- there is no server to ask. We are on the host by
    // definition here, so probing loopback directly is correct.
    detectError = 'opened as file:// -- no host probe, using direct loopback';
    hostLanes = await probeLoopbackDirect();
  }

  // Bonsai is ours to decide, always, regardless of what the host said.
  const lanes = hostLanes.filter(b => b.id !== 'bonsai');
  lanes.push({
    id: 'bonsai',
    label: 'Bonsai (in-browser)',
    port: 0,
    up: browserCanBonsai(),
    note: browserCanBonsai()
      ? 'runs in this tab; no server needed'
      : 'this browser has no WebGPU',
  });

  imageBackends = lanes;
  activeImageBackend = lanes.find(b => b.up === true) || null;

  console.log(
    `%c[image ${IMAGE_BUILD}] ${activeImageBackend ? 'routing to ' + activeImageBackend.label : 'NO backend available'}`,
    'color:#0a0;font-weight:bold',
    lanes,
  );
  if (detectError) console.log('[image] detect note:', detectError);
  return { lanes, active: activeImageBackend, detectError };
}

/**
 * file:// fallback only. Over HTTP the host answers instead -- see the
 * header. Kept small on purpose: this path cannot work from a phone
 * and is not the one most people are on.
 */
async function probeLoopbackDirect() {
  const candidates = [
    { id: 'comfyui', label: 'ComfyUI', port: 8188, probe: '/system_stats' },
    { id: 'sana', label: 'Sana (awdk)', port: 8202, probe: '/health' },
    { id: 'awdk', label: 'awdk image API', port: 9001, probe: '/health' },
  ];
  const out = [];
  for (const c of candidates) {
    let up = false;
    try {
      // no-cors so a bare 200 from a server that does not send CORS
      // headers still resolves. An opaque response proves reachability,
      // which is all we are asking.
      await fetch(`http://127.0.0.1:${c.port}${c.probe}`, {
        mode: 'no-cors',
        cache: 'no-store',
        signal: AbortSignal.timeout ? AbortSignal.timeout(900) : undefined,
      });
      up = true;
    } catch (e) {
      up = false;
    }
    out.push({ id: c.id, label: c.label, port: c.port, up });
  }
  return out;
}

/**
 * One line a human can act on, for when there is no lane.
 * Names every port that was tried -- "no image backend" with no
 * ports in it is a dead end for whoever reads it.
 */
function imageUnavailableMessage() {
  const tried = (imageBackends || [])
    .filter(b => b.id !== 'bonsai')
    .map(b => `${b.label} (127.0.0.1:${b.port})`)
    .join(', ');
  const bonsai = (imageBackends || []).find(b => b.id === 'bonsai');
  const bonsaiWhy = bonsai && bonsai.up === false ? ' This browser has no WebGPU, so the in-browser lane is out too.' : '';
  return (
    `No local image backend answered. Tried: ${tried || 'nothing -- detection did not run'}.` +
    bonsaiWhy +
    ' Start ComfyUI (it listens on 8188 by default) and press Detect again.' +
    ' Nothing is downloaded or installed for you.'
  );
}

/* ================================================================
   COMFYUI

   Uses the /prompt + /history polling API, which every ComfyUI build
   has had since forever, rather than the newer websocket route: this
   goes through the same-origin reverse proxy, and a proxied websocket
   is a second failure surface for no gain at these timescales.
================================================================ */

/** Minimal txt2img graph. Kept literal and commented because a
 *  ComfyUI graph is opaque otherwise, and the next person to touch
 *  this needs to know which node id does what. */
function comfyGraph({ prompt, negative, width, height, steps, cfg, seed, ckpt }) {
  return {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: negative || '', clip: ['4', 1] } },
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed, steps, cfg,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'GobboNet', images: ['8', 0] } },
  };
}

/** Ask ComfyUI which checkpoints it has. Returns [] if it cannot say --
 *  and the caller treats [] as "cannot generate", never as "use the
 *  default", because there is no default that is right on every box. */
async function comfyCheckpoints() {
  const r = await fetch(imageBase() + '/object_info/CheckpointLoaderSimple', { cache: 'no-store' });
  if (!r.ok) return [];
  const info = await r.json();
  try {
    return info.CheckpointLoaderSimple.input.required.ckpt_name[0] || [];
  } catch (e) {
    return [];
  }
}

function imageBase() {
  return IS_SERVED ? window.location.origin + '/image' : 'http://127.0.0.1:8188';
}

/**
 * Fetch a loopback image and return it as a data: URL.
 *
 * Why this exists rather than handing the URL straight to <img>: see the
 * comment at the call site. Short version -- safeImageUrl() drops http(s)
 * sources by design, and it is correct to.
 *
 * Throws rather than returning '' on failure. An empty string would flow
 * into an <img src> and render as a broken box, which reads as "the model
 * made a bad image" instead of "the fetch failed".
 */
async function toDataUrl(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Could not read the generated image (HTTP ${r.status}).`);
  const blob = await r.blob();
  if (!blob.size) throw new Error('The generated image came back empty.');
  return await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('Could not decode the generated image.'));
    fr.readAsDataURL(blob);
  });
}

/**
 * Generate via ComfyUI. Resolves to {images:[dataUrlOrUrl], backend}
 * or throws an Error whose message is safe to show a human.
 *
 * onProgress(stage, detail) is called as it moves so the UI is never
 * a spinner with no explanation -- a 40-second generate that says
 * nothing is indistinguishable from a hang.
 */
async function comfyGenerate(opts, onProgress) {
  const p = onProgress || (() => {});
  p('checkpoints', 'asking ComfyUI what models it has');

  const ckpts = await comfyCheckpoints();
  if (!ckpts.length) {
    throw new Error(
      'ComfyUI is running but reports no checkpoints. Put a model in ' +
      'ComfyUI/models/checkpoints and restart it. GobboNet will not ' +
      'download one for you.',
    );
  }
  const ckpt = opts.ckpt && ckpts.includes(opts.ckpt) ? opts.ckpt : ckpts[0];

  const body = {
    prompt: comfyGraph({
      prompt: opts.prompt,
      negative: opts.negative,
      width: opts.width || 768,
      height: opts.height || 768,
      steps: opts.steps || 20,
      cfg: opts.cfg || 6,
      // Math.random is fine here -- this is an image seed, not a
      // credential, and a user re-rolling wants a different picture.
      seed: opts.seed != null ? opts.seed : Math.floor(Math.random() * 2 ** 32),
      ckpt,
    }),
    client_id: 'gobbonet-' + Math.random().toString(36).slice(2),
  };

  p('queue', `queuing on ${ckpt}`);
  const q = await fetch(imageBase() + '/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!q.ok) {
    const detail = await q.text().catch(() => '');
    throw new Error(`ComfyUI refused the job (HTTP ${q.status}). ${detail.slice(0, 300)}`);
  }
  const { prompt_id: id } = await q.json();
  if (!id) throw new Error('ComfyUI accepted the job but returned no prompt_id.');

  // Poll /history. Bounded: an unbounded poll against a wedged backend
  // is the hang this module exists to avoid.
  const deadline = Date.now() + (opts.timeoutMs || 180000);
  let tick = 0;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 900));
    tick++;
    p('render', `working (${tick})`);
    const h = await fetch(imageBase() + `/history/${id}`, { cache: 'no-store' });
    if (!h.ok) continue;
    const hist = await h.json();
    const entry = hist[id];
    if (!entry) continue;

    const urls = [];
    for (const nodeId of Object.keys(entry.outputs || {})) {
      for (const img of entry.outputs[nodeId].images || []) {
        const qs = new URLSearchParams({
          filename: img.filename,
          subfolder: img.subfolder || '',
          type: img.type || 'output',
        });
        urls.push(imageBase() + '/view?' + qs.toString());
      }
    }
    if (urls.length) {
      p('fetch', 'pulling the bytes');
      // INLINE THE BYTES. Returning the /view URL looks correct and renders
      // as NOTHING: safeImageUrl() in js/18-utils.js suppresses every http(s)
      // <img src> unless allowRemoteImages is on, because a card from an
      // imported file or a synced peer could otherwise beacon the viewer's IP
      // the moment it renders. That guard is right and must not be flipped for
      // this -- it would open the hole for every card, to fix one local lane.
      //
      // A data: URL is what the same doctrine explicitly permits: "the bytes
      // are already on this machine and nothing is fetched". Which is true --
      // we just pulled them from loopback.
      //
      // It also survives the backend: an inlined image is still in the thread
      // after ComfyUI stops, where a /view URL would 404 forever.
      const images = [];
      for (const u of urls) images.push(await toDataUrl(u));
      return { images, backend: 'comfyui', ckpt };
    }

    if (entry.status && entry.status.status_str === 'error') {
      throw new Error('ComfyUI reported an error running the graph. Check its console.');
    }
  }
  throw new Error(
    `ComfyUI did not return an image within ${Math.round((opts.timeoutMs || 180000) / 1000)}s. ` +
    'It may still be working -- check the ComfyUI window.',
  );
}

/* ================================================================
   awdk / Sana lane

   An awdk stack exposes an OpenAI-shaped images endpoint. We speak
   that rather than a bespoke protocol so the same code covers Sana,
   a local SD server, or anything else that adopted the shape.
================================================================ */
async function awdkGenerate(backend, opts, onProgress) {
  const p = onProgress || (() => {});
  p('queue', `asking ${backend.label}`);
  const base = IS_SERVED
    ? window.location.origin + '/image'
    : `http://127.0.0.1:${backend.port}`;

  const r = await fetch(base + '/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: opts.prompt,
      negative_prompt: opts.negative || '',
      size: `${opts.width || 768}x${opts.height || 768}`,
      n: 1,
      response_format: 'b64_json',
    }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`${backend.label} refused the job (HTTP ${r.status}). ${detail.slice(0, 300)}`);
  }
  const body = await r.json();
  const items = (body && body.data) || [];
  const images = items
    .map(d => (d.b64_json ? 'data:image/png;base64,' + d.b64_json : d.url))
    .filter(Boolean);

  // An empty 200 is the silent no-op. Refuse to render it as success.
  if (!images.length) {
    throw new Error(
      `${backend.label} answered 200 with no image. That usually means it has ` +
      'no model loaded -- check its console rather than retrying.',
    );
  }
  return { images, backend: backend.id };
}

/* ================================================================
   PUBLIC ENTRY

   generateImage(opts, onProgress) -> {images, backend}
   Routes to whichever lane is up. Throws with a human-readable
   message when none is.
================================================================ */
async function generateImage(opts, onProgress) {
  if (!opts || !opts.prompt || !opts.prompt.trim()) {
    throw new Error('An image needs a prompt.');
  }
  if (imageBackends === null) await detectImageBackends();

  const forced = opts.backend
    ? (imageBackends || []).find(b => b.id === opts.backend)
    : null;
  const lane = forced || activeImageBackend;

  if (!lane || lane.up !== true) {
    throw new Error(
      forced
        ? `${forced.label} is not answering right now.`
        : imageUnavailableMessage(),
    );
  }

  if (lane.id === 'comfyui') return comfyGenerate(opts, onProgress);
  if (lane.id === 'sana' || lane.id === 'awdk') return awdkGenerate(lane, opts, onProgress);
  if (lane.id === 'bonsai') {
    // The in-browser lane is wired separately in the Bonsai adapter,
    // which owns the worker and the consent gate. Reaching here means
    // the adapter is not loaded -- say that instead of failing blankly.
    if (typeof window.aitherBonsaiImage === 'function') {
      return window.aitherBonsaiImage(opts, onProgress);
    }
    throw new Error(
      'The in-browser Bonsai lane is the only one available, but its adapter ' +
      'is not loaded on this page. Start ComfyUI, or open the browser demo.',
    );
  }
  throw new Error(`Unknown image lane: ${lane.id}`);
}

// Expose for the console and for extensions -- users script this thing.
window.generateImage = generateImage;
window.detectImageBackends = detectImageBackends;

/* ================================================================
   /imagine -- the chat command

   Wired from sendMessage() in js/10-chat.js, which intercepts the
   command before the LLM turn machinery. This function owns the
   whole interaction: it writes the user's turn, writes a placeholder
   assistant turn, and then edits that turn in place as the backend
   reports progress.

   The placeholder matters. A 20-second generate that shows nothing
   is indistinguishable from a hang, and the first thing anyone does
   with a hang is press the button again -- which queues a second
   job on a GPU already busy with the first.
================================================================ */

/** Parse trailing `--flag value` options off a prompt.
 *  Returns {prompt, opts}. Unknown flags are LEFT IN the prompt
 *  rather than dropped: silently eating part of someone's prompt is
 *  worse than passing a stray word to the model. */
function parseImagineFlags(raw) {
  const opts = {};
  let text = String(raw || '');
  const take = (name, re, cast) => {
    const m = text.match(re);
    if (m) { opts[name] = cast(m[1]); text = text.replace(m[0], ' '); }
  };
  take('width',  /--w(?:idth)?\s+(\d{2,5})/i, Number);
  take('height', /--h(?:eight)?\s+(\d{2,5})/i, Number);
  take('steps',  /--steps?\s+(\d{1,3})/i, Number);
  take('cfg',    /--cfg\s+([\d.]{1,6})/i, Number);
  take('seed',   /--seed\s+(\d{1,12})/i, Number);
  take('ckpt',   /--(?:ckpt|model)\s+(\S+)/i, String);
  take('backend',/--backend\s+(\w+)/i, String);
  const neg = text.match(/--(?:no|negative)\s+"([^"]*)"/i) || text.match(/--(?:no|negative)\s+(\S+)/i);
  if (neg) { opts.negative = neg[1]; text = text.replace(neg[0], ' '); }
  opts.prompt = text.replace(/\s+/g, ' ').trim();
  return opts;
}

async function handleImagineCommand(rawPrompt) {
  const opts = parseImagineFlags(rawPrompt);

  let thread = getActiveThread();
  if (!thread) { createThread(); thread = getActiveThread(); }

  const shown = '/imagine ' + String(rawPrompt || '').trim();
  thread.messages.push({ role: 'user', content: shown, timestamp: Date.now() });

  const msg = {
    role: 'assistant',
    content: '// starting image generation...',
    timestamp: Date.now(),
  };
  thread.messages.push(msg);
  bumpThreadToTop(thread.id);
  saveState();
  renderMessages();
  scrollToBottom();

  const started = Date.now();
  const tick = (stage, detail) => {
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    msg.content = `// ${stage}${detail ? ' -- ' + detail : ''} (${secs}s)`;
    renderMessages();
  };

  try {
    const out = await generateImage(opts, tick);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    msg.content = `// generated in ${elapsed}s`;
    msg.generatedImages = out.images.map(dataUrl => ({
      dataUrl,
      prompt: opts.prompt,
      backend: out.backend,
      ckpt: out.ckpt || '',
    }));
  } catch (e) {
    // The message is the product here. Every throw in this module is
    // written to be shown to a person, so surface it verbatim rather
    // than replacing it with a generic failure.
    msg.content = `// image generation failed\n\n${e && e.message ? e.message : e}`;
  }

  saveState();
  renderMessages();
  scrollToBottom();
}

window.handleImagineCommand = handleImagineCommand;
window.parseImagineFlags = parseImagineFlags;
