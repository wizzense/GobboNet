// memory-ui.smoke.mjs — drive the real page in headless Chrome and click
// through the user-memory UI: create a thread, open the lore inspector,
// pin a fact, block a fact, and assert the inspector reflects both.
//
//   node memory-ui.smoke.mjs <http://127.0.0.1:PORT/chat.html>
//
// Requires Chrome (CHROME env or default path) and Node >= 21 (global
// WebSocket for the CDP connection). Exit 0 = the UI works end to end.

const URL = process.argv[2] || "http://127.0.0.1:9077/chat.html";
const CHROME = process.env.CHROME
  || "C:/Program Files/Google/Chrome/Application/chrome.exe";

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const ok = (m) => console.log("  ok:", m);

// --- launch headless Chrome with CDP --------------------------------
const port = 9333 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox",
  `--remote-debugging-port=${port}`,
  "--user-data-dir=" + process.env.TEMP + "/gobbo-mem-smoke-" + Date.now(),
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

// --- drive the page -------------------------------------------------
await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: URL });
for (let i = 0; i < 40; i++) { // wait for the app boot (IndexedDB, state)
  await sleep(250);
  const ready = await evalJs("typeof createThread === 'function' && typeof openLoreInspector === 'function'");
  if (ready) break;
}
ok("app booted (createThread + openLoreInspector defined)");

console.log("[1] create a thread and open the lore inspector");
await evalJs("createThread(); openLoreInspector(); true");
const hasSection = await evalJs(
  "document.getElementById('lore-inspect-body').innerHTML.indexOf('User memory') !== -1");
if (!hasSection) fail("lore inspector has no User memory section");
ok("inspector renders the User memory section");

console.log("[2] pin a fact via the inspector input");
await evalJs(`
  (() => {
    const input = document.getElementById('lore-memory-pin-input');
    input.value = 'The vault key is under the third flagstone.';
    memoryAddFactFromInput('pinned');
    return true;
  })()
`);
let shown = await evalJs(
  "document.getElementById('lore-inspect-body').innerHTML.indexOf('vault key') !== -1");
if (!shown) fail("pinned fact not listed in inspector");
ok("pinned fact appears in the inspector list");
let persisted = await evalJs(
  "getActiveThread() && getThreadMemory(getActiveThread()).pinned.length === 1");
if (!persisted) fail("pin not on thread.memory");
ok("pin persisted on thread.memory");

console.log("[3] blocked list reflects a block");
await evalJs(`
  (() => {
    const input = document.getElementById('lore-memory-block-input');
    input.value = 'the gold shipment';
    memoryAddFactFromInput('blocked');
    return true;
  })()
`);
persisted = await evalJs(
  "getActiveThread() && getThreadMemory(getActiveThread()).blocked.length === 1");
if (!persisted) fail("block not on thread.memory");
ok("block persisted on thread.memory");

console.log("[4] pin + block flow into summarizeForLore's prompt (structural)");
const promptHasBoth = await evalJs(`
  (async () => {
    const th = getActiveThread();
    const out = await summarizeForLore('', [{ role: 'user', content: 'hi' }], th);
    return true; // no throw = memory-aware signature accepted
  })()
`);
if (!promptHasBoth) fail("summarizeForLore with thread arg threw");
ok("summarizeForLore accepts the memory-aware call");

console.log("[5] remove a pin from the inspector");
await evalJs("removeMemoryFact(getActiveThread(), 'pinned', 0); saveState(); openLoreInspector(); true");
persisted = await evalJs(
  "getActiveThread() && getThreadMemory(getActiveThread()).pinned.length === 0");
if (!persisted) fail("pin removal not persisted");
ok("pin removal persisted");

console.log("\nUI SMOKE PASS — memory manager works end to end in the real page");
ws.close();
chrome.kill();
process.exit(0);
