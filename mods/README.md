# GobboNet mods

Drop-in features you paste into **// MODS**. No core files are patched, so an
upstream update never conflicts and removing one is deleting an entry.

## imagine.mod.js — local image generation

`/imagine a goblin at a green CRT --w 512 --h 512 --steps 10`

Talks to a local image server. It tries, in order:

1. `window.GOBBO_IMAGE_BASE`, if you set one (a non-default port lives here);
2. GobboNet's own `/image` proxy, if your fileserver has it;
3. `http://127.0.0.1:8188` directly.

Route 3 needs ComfyUI started with CORS, because a browser on one origin may
not POST to another:

```
python main.py --enable-cors-header
```

Measured: without that flag ComfyUI answers a cross-origin request with **403**
before reading it, and nothing in the failure names a header — so it reads as
"the backend rejected my job".

**No GPU is fine.** `python main.py --cpu` works. Measured on one box, same
prompt, only the device differing: 768px SDXL-lightning **9s** on an RTX 5090,
**107s** on 32 CPU cores; SD1.5 at 512px, 12 steps, **85s** on CPU. Prefer an
SD1.5-class model and a few-step checkpoint on CPU — the step count is what you
are paying for.

Images are inlined as `data:` URLs, never left as `/view` links. GobboNet
suppresses remote `<img src>` by design so an imported or synced card cannot
beacon your IP; a `data:` URL is what that same rule allows, and it means the
picture survives ComfyUI stopping.

Verified end to end on a STOCK checkout — no core patch — generating on CPU
through CORS and persisting across a re-render.
