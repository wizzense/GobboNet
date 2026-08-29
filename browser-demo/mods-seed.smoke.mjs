// mods-seed.smoke.mjs — prove the shipped mods seed onto an EXISTING user.
//
// The owner's live report: the MODS panel on the demo shows nothing and the
// shipped mods don't load. Root cause: 04-state.js promised
// "05-persistence.js seeds them onto existing users exactly once" and no
// such loop existed — a user whose save predates the mods loaded an EMPTY
// extensions list (migrateExtensions of their old save), the panel showed
// nothing, and the hard-tagged mods were gone.
//
// This drives the REAL page in headless Chrome against a seeded localStorage
// save that predates the mods (empty extensions, no seededDefaultExtensions),
// then asserts:
//   1. state.extensions carries the shipped mods (adapter, image renderer,
//      mediaforge, backup) after boot,
//   2. the MODS panel lists them,
//   3. applyExtensions actually INJECTED the adapter (window.__aitherBonsaiAdapter
//      is set, meaning the extension script ran — not just listed),
//   4. the pre-mods save's extension ENABLE flag was honoured (turned on, since
//      an empty pre-mods save is not a deliberate off).
//
//   node mods-seed.smoke.mjs <url>
//   exit 0 = seeded mods load for an existing user; exit 1 = something broke.

const URL = process.argv[2] || "http://127.0.0.1:9080/chat.html";
const CHROME = process.env.CHROME
  || "C:/Program Files/Google/Chrome/Application/chrome.exe";

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const ok = (m) => console.log("  ok:", m);

const port = 9444 + Math.floor(Math.random() * 200);
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox",
  `--remote-debugging-port=${port}`,
  "--user-data-dir=" + process.env.TEMP + "/gobbo-seed-smoke-" + Date.now(),
  "about:blank",
], { stdio: "ignore" });

let wsUrl = null;
for (let i = 0; i < 40 && !wsUrl; i++) {
  await sleep(250);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`);
    const pages = await res.json();
    const page = pages.find((p) => p.type === "page");
    if (page) wsUrl = page.webSocketDebuggerUrl;
  } catch (e) { /* not up yet */ }
}
if (!wsUrl) fail("could not reach Chrome CDP on :" + port);

const ws = new WebSocket(wsUrl);
let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) => new Promise((res) => {
  const id = ++msgId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
await new Promise((res) => (ws.onopen = res));

async function evalJs(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
  if (r.result && r.result.exceptionDetails) {
    fail("page threw: " + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
  }
  return r.result?.result?.value;
}

await send("Page.enable");
await send("Runtime.enable");

// Seed a PRE-MODS save into localStorage BEFORE the app boots: empty
// extensions, no seededDefaultExtensions, no mods — the exact state the
// owner's browser had when the panel showed nothing.
console.log("[0] seed a pre-mods save (empty extensions, no seeding field)");
// about:blank denies localStorage; navigate to the TARGET origin first,
// seed the save, then reload so loadState sees it at boot. Cache-bust every
// navigation: python http.server sends no cache-control, and the browser
// heuristically caches chat.html — a stale page would run the OLD detector
// and cry wolf (measured 2026-08-27: banner at t=0.5s with a correct file).
const bust = (u) => u + (u.includes('?') ? '&' : '?') + 't=' + Date.now();
await send("Page.navigate", { url: bust(URL) });
for (let i = 0; i < 40; i++) {
  await sleep(250);
  const ready = await evalJs("document.readyState === 'complete'");
  if (ready) break;
}
const seeded = await evalJs(`
  (() => {
    localStorage.setItem('gobbonet_chat_state', JSON.stringify({
      threads: [],
      activeThreadId: null,
      settings: { tokenLimit: 24576 },
      characterCards: [],
      personaCards: [],
      extensions: { enabled: false, styles: [], scripts: [] },
      macros: [],
      seededDefaultMacros: ['continue', 'fast_forward', 'auto_continue']
    }));
    return localStorage.getItem('gobbonet_chat_state') ? true : false;
  })()
`);
if (!seeded) fail("could not seed localStorage");

// Reload so the seeded save is what loadState boots from.
await send("Page.navigate", { url: bust(URL) });
for (let i = 0; i < 60; i++) {
  await sleep(250);
  const ready = await evalJs(
    "typeof createThread === 'function' && typeof state !== 'undefined' && state.threads !== undefined && document.readyState === 'complete'");
  if (ready) break;
}
await sleep(500); // let extensions apply

console.log("[1] shipped mods seeded into state.extensions for the existing user");
const ext = await evalJs(`(() => {
  const e = state.extensions;
  return JSON.stringify({
    enabled: !!e.enabled,
    styles: (e.styles || []).map(s => s.id),
    scripts: (e.scripts || []).map(s => s.id)
  });
})()`);
const extParsed = JSON.parse(ext);
const wantScripts = ['mod_js_bonsai_adapter', 'mod_js_image_renderer', 'mod_js_mediaforge', 'mod_js_gobbonet_backup'];
const wantStyles = ['mod_css_image_renderer'];
const missingScripts = wantScripts.filter(id => !extParsed.scripts.includes(id));
const missingStyles = wantStyles.filter(id => !extParsed.styles.includes(id));
if (missingScripts.length || missingStyles.length) {
  fail("seeded extensions missing " + JSON.stringify({ missingScripts, missingStyles }) + " — got " + ext);
}
ok("extensions seeded: " + ext);

console.log("[2] the pre-mods empty save is turned ON (not a deliberate off)");
if (!extParsed.enabled) fail("extensions not enabled after seeding an empty pre-mods save");
ok("extensions.enabled = true");

console.log("[3] the MODS panel lists them");
const panelShows = await evalJs(`
  (() => {
    openExtensions();
    const scripts = document.getElementById('ext-scripts-list');
    const styles = document.getElementById('ext-styles-list');
    const ids = [];
    for (const list of [scripts, styles]) {
      if (!list) continue;
      for (const el of list.querySelectorAll('.ext-entry')) {
        const id = el.getAttribute('data-ext-entry');
        if (id) ids.push(id);
      }
    }
    closeExtensions();
    return ids;
  })()
`);
for (const id of wantScripts.concat(wantStyles)) {
  if (!panelShows.includes(id)) fail("MODS panel missing " + id + " — got: " + JSON.stringify(panelShows));
}
ok("panel lists all " + (wantScripts.length + wantStyles.length) + " shipped mods");

console.log("[4] the adapter ACTUALLY LOADED (not just listed)");
const adapterLoaded = await evalJs("!!window.__aitherBonsaiAdapter");
if (!adapterLoaded) fail("adapter extension script did not run (applyExtensions failed?)");
ok("window.__aitherBonsaiAdapter is set — extension executed");

console.log("[5] no 'ADAPTER FAILED TO LOAD' banner (hard-tag removal didn't break detection)");
// Query the DOM for a RENDERED banner element — document.body.textContent
// would also match the detector's own <script> source (script text is DOM
// text), a false positive measured 2026-08-27.
const banner = await evalJs(`
  (() => {
    const els = Array.from(document.querySelectorAll('[role="alert"],div'))
      .filter(e => e.textContent && e.textContent.indexOf('ADAPTER FAILED') !== -1);
    return els.length > 0;
  })()
`);
if (banner) fail("false 'adapter failed' banner shown despite loaded adapter");
ok("no false failure banner");

console.log("\nMODS-SEED SMOKE PASS — shipped mods load for an existing pre-mods user");
ws.close();
chrome.kill();
process.exit(0);
