// memory-override.roundtrip.mjs — prove the user memory override works.
//
// Loads the SHIPPED js/07-prompt.js (the same bytes the page serves) and
// drives its real functions — assertPinnedFacts, scrubBlockedFacts,
// addMemoryFact, and the full summarizeForLore pass against a stubbed
// model server. A test that reimplements the logic proves nothing; this
// one executes the code users run.
//
//   node memory-override.roundtrip.mjs
//   exit 0 = every claim held; exit 1 = something broke.
//
// The three customer claims, each tested structurally:
//   1. "I want to be able to override the AI's poor judgement" — a pinned
//      fact the model DROPS comes back (re-asserted after the pass).
//   2. "Remove things that are added in error" — a blocked fact the model
//      INCLUDES is stripped from the summary.
//   3. Pins ride in the prompt too, so the model sees them as MUST-KEEP.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const dir = path.dirname(fileURLToPath(import.meta.url));
const promptSrc = readFileSync(path.join(dir, "js", "07-prompt.js"), "utf-8");

// --- minimal browser-ish globals 07-prompt.js touches at load -----------
globalThis.document = {
  getElementById: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, appendChild() {}, addEventListener() {} }),
};
globalThis.window = globalThis;

// --- stubs for the streaming path summarizeForLore uses -----------------
let lastRequestBody = null; // captured so the test can read the prompt

/** An OpenAI-shaped SSE stream over a canned summary. The "model" drops
 *  the pinned fact and adds a blocked one — i.e. the exact failure the
 *  customer reported. */
function makeStream(summary) {
  const chunks = [`data: ${JSON.stringify({ choices: [{ delta: { content: summary } }] })}\n\n`, "data: [DONE]\n\n"];
  const encoder = new TextEncoder();
  const bytes = encoder.encode(chunks.join(""));
  let offset = 0;
  const reader = {
    read: async () => {
      if (offset >= bytes.length) return { done: true, value: undefined };
      const value = bytes.slice(offset, offset + 24);
      offset += 24;
      return { done: false, value };
    },
  };
  return { ok: true, status: 200, body: { getReader: () => reader } };
}

globalThis.privacyFetch = async (url, options = {}) => {
  lastRequestBody = JSON.parse(options.body || "{}");
  return makeStream(
    "SETTING: A tavern by the sea.\n" +
    "CHARACTERS: Gobbo the goblin.\n" +
    "OPEN: The gold shipment is still owed.\n" +
    "EVENTS: A storm came in." // the model DROPPED the pinned fact here
  );
};

// extractTokenFromLine / processStreamDelta / finalizeStreamMessage live in
// 02-model.js / 03-generation.js — 07-prompt.js calls them, so provide the
// real browser ones? They drag in deepseek/gemma inline parsers. For the
// summary path the server-split branch is enough: llama-server emits
// reasoning_content, which routes straight to msg.reasoning and never
// enters the inline parsers. Reimplementing THAT shape is faithful.
globalThis.extractTokenFromLine = (rawLine) => {
  const trimmed = rawLine.trim();
  if (!trimmed || trimmed === "data: [DONE]" || trimmed === "data:[DONE]") return null;
  let jsonStr = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  if (!jsonStr || jsonStr === "[DONE]") return null;
  try {
    const json = JSON.parse(jsonStr);
    if (json.choices && json.choices[0] && json.choices[0].delta) {
      const d = json.choices[0].delta;
      if (typeof d.content === "string") return { text: d.content, field: "content" };
    }
  } catch (e) { /* not JSON */ }
  return null;
};
globalThis.processStreamDelta = (msg, deltaText, field) => {
  if (!deltaText) return;
  if (field === "reasoning") {
    msg.reasoning = (msg.reasoning || "") + deltaText;
  } else {
    msg.content = (msg.content || "") + deltaText;
  }
};
globalThis.finalizeStreamMessage = (msg) => {
  const c = (msg.content || "").trim();
  if (c) msg.content = c;
  msg._parseState = null;
};
globalThis.normalizeThinkingFormat = () => "none";
globalThis.renderLoreIndicator = () => {};
globalThis.activeModel = { thinkingFormat: "none" };
globalThis.LLAMA_URL = "http://stub";

// --- load the shipped file ----------------------------------------------
// vm.runInThisContext (not new Function): 07-prompt.js declares plain
// top-level functions, and new Function scopes them out of reach. Run in
// the current global context so assertPinnedFacts & friends land where the
// page puts them.
vm.runInThisContext(promptSrc, { filename: "07-prompt.js" });

const fail = (msg) => { console.error("FAIL:", msg); process.exit(1); };
const check = (cond, msg) => { if (!cond) fail(msg); console.log("  ok:", msg); };

console.log("memory-override roundtrip — driving the shipped js/07-prompt.js\n");

// ---- 1. assertPinnedFacts: the AI dropped the pin; it comes back -------
console.log("[1] pinned fact the AI dropped is re-asserted");
const memory = { pinned: [{ text: "The vault key is under the third flagstone.", ts: 1 }], blocked: [] };
const out1 = assertPinnedFacts(
  "SETTING: A tavern by the sea.\nCHARACTERS: Gobbo the goblin.\nEVENTS: A storm came in.",
  memory
);
check(out1.indexOf("vault key is under the third flagstone") !== -1,
      "dropped pinned fact reappears in the summary");
check(out1.indexOf("MEMORY: The vault key is under the third flagstone.") !== -1,
      "re-asserted as its own MEMORY: line (never buried in prose)");

// ---- 2. assertPinnedFacts: pin already present → NOT duplicated ---------
console.log("[2] pinned fact already in the summary is not duplicated");
const out2 = assertPinnedFacts(
  "SETTING: The vault key is under the third flagstone.\nEVENTS: A storm came in.",
  memory
);
check((out2.match(/vault key is under the third flagstone/gi) || []).length === 1,
      "present pin appears exactly once");

// ---- 3. scrubBlockedFacts: the AI added something in error → stripped ---
console.log("[3] blocked fact the AI included is stripped line-by-line");
const memB = { pinned: [], blocked: [{ text: "the gold shipment", ts: 1 }] };
const out3 = scrubBlockedFacts(
  "SETTING: A tavern by the sea.\nOPEN: The gold shipment is still owed.\nEVENTS: A storm came in.",
  memB
);
check(out3.indexOf("gold shipment") === -1, "blocked mention removed");
check(out3.indexOf("SETTING: A tavern by the sea.") !== -1,
      "surrounding fields survive (line-level scrub, not summary deletion)");
check(out3.indexOf("EVENTS: A storm came in.") !== -1, "unrelated lines kept");

// ---- 4. order: blocked scrubbed BEFORE pins re-asserted -----------------
console.log("[4] a fact both blocked AND pinned lands on the pin side");
const memBoth = { pinned: [{ text: "The gold shipment is still owed.", ts: 2 }],
                  blocked: [{ text: "the gold shipment", ts: 1 }] };
const out4 = scrubBlockedFacts(
  "SETTING: Tavern.\nOPEN: The gold shipment is still owed.",
  memBoth
);
const out4f = assertPinnedFacts(out4, memBoth);
check(out4f.indexOf("gold shipment") !== -1,
      "explicit keep beats explicit drop (user pinned it later)");

// ---- 5. addMemoryFact: dedupe + cap -------------------------------------
console.log("[5] addMemoryFact dedupes and caps");
const thread = { id: "t1", memory: { pinned: [], blocked: [] } };
check(addMemoryFact(thread, "pinned", "Keep this fact.") === true, "new fact added");
check(addMemoryFact(thread, "pinned", "  keep this fact.  ") === false,
      "duplicate (case/whitespace-insensitive) rejected");
check(addMemoryFact(thread, "pinned", "x".repeat(500)) === true, "overlong fact still added");
check(thread.memory.pinned[1].text.length <= 401, "overlong fact capped at MAX_FACT+ellipsis");

// ---- 6. the FULL summarizeForLore pass with a stubbed model -------------
console.log("[6] summarizeForLore end-to-end: prompt carries pins, output enforced");
const thread2 = {
  id: "t2",
  memory: {
    pinned: [{ text: "The vault key is under the third flagstone.", ts: 1 }],
    blocked: [{ text: "the gold shipment", ts: 1 }],
  },
};
const msgs = [{ role: "user", content: "The vault key is under the third flagstone. Also the gold shipment is still owed." }];
const result = await summarizeForLore("", msgs, thread2);

check(!!lastRequestBody, "model request was issued");
const sysText = lastRequestBody.messages[0].content;
check(sysText.indexOf("The vault key is under the third flagstone.") !== -1,
      "pinned fact is in the system prompt as MUST-KEEP");
check(sysText.indexOf("the gold shipment") !== -1,
      "blocked fact is in the system prompt as MUST-NOT");
check(result.indexOf("vault key is under the third flagstone") !== -1,
      "pinned fact survives in the OUTPUT (model dropped it, enforcement re-added)");
check(result.indexOf("gold shipment") === -1,
      "blocked fact is absent from the OUTPUT (model included it, scrub removed it)");
check(result.indexOf("SETTING: A tavern by the sea.") !== -1, "rest of summary intact");

console.log("\nROUND-TRIP PASS — user memory override enforced structurally");
process.exit(0);
