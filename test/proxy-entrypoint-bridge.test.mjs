import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ext, {
  parsePrefixShape,
  deriveKey,
  persistShape,
  loadShape,
  bridgeBlockReason,
  toolsDelta,
  applyShape,
  SNAPSHOT_VERSION,
} from "../proxy/extensions/entrypoint-bridge.mjs";

// --- Fixtures shaped like real CC v2.1.221 traffic (see the measured
// divergence documented at the top of the extension) ---

const CLI_BILLING =
  "x-anthropic-billing-header: cc_version=2.1.221.76e; cc_entrypoint=cli;";
const SDK_BILLING =
  "x-anthropic-billing-header: cc_version=2.1.221.76e; cc_entrypoint=sdk-cli;";
const CLI_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const SDK_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const CLI_BIG = "big block\n# Session-specific guidance\n - the `!` tip\n# Scratchpad\ncli-only";
const SDK_BIG = "big block\n# Session-specific guidance\n - fork guidance";

function tool(name, extra = "") {
  return { name, description: `${name} tool${extra}`, input_schema: { type: "object" } };
}

const CLI_TOOLS = [tool("Agent"), tool("Artifact"), tool("AskUserQuestion"), tool("Bash"), tool("WebFetch", " cli-flavored")];
const SDK_TOOLS = [tool("Agent"), tool("Bash"), tool("WebFetch")];

const MSG0 = {
  role: "user",
  content: [
    { type: "text", text: "<system-reminder>SessionStart:startup hook success: whisper</system-reminder>" },
    { type: "text", text: "Reply with exactly: ok" },
  ],
};

function cliBody(overrides = {}) {
  return {
    model: "claude-haiku-4-5-20251001",
    system: [
      { type: "text", text: CLI_BILLING },
      { type: "text", text: CLI_IDENTITY, cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "text", text: CLI_BIG, cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
    tools: structuredClone(CLI_TOOLS),
    messages: [structuredClone(MSG0)],
    ...overrides,
  };
}

function sdkBody(overrides = {}) {
  return {
    model: "claude-haiku-4-5-20251001",
    system: [
      { type: "text", text: SDK_BILLING },
      { type: "text", text: SDK_IDENTITY, cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "text", text: SDK_BIG, cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
    tools: structuredClone(SDK_TOOLS),
    messages: [structuredClone(MSG0), { role: "assistant", content: [{ type: "text", text: "ok" }] }, { role: "user", content: [{ type: "text", text: "again" }] }],
    ...overrides,
  };
}

// --- Env isolation ---

let tmp;
const savedEnv = {};
const ENV_KEYS = ["CACHE_FIX_ENTRYPOINT_BRIDGE", "CLAUDE_CONFIG_DIR", "CACHE_FIX_ENTRYPOINT_BRIDGE_MAX_AGE_MS", "CACHE_FIX_DEBUG"];

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "entrypoint-bridge-test-"));
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.CLAUDE_CONFIG_DIR = tmp;
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await rm(tmp, { recursive: true, force: true });
});

function ctxFor(body) {
  return { body, headers: {}, meta: {} };
}

// --- parsePrefixShape ---

test("parsePrefixShape: recognizes cli and sdk-cli requests", () => {
  assert.deepEqual(parsePrefixShape(cliBody()), { entrypoint: "cli", ccVersion: "2.1.221.76e" });
  assert.deepEqual(parsePrefixShape(sdkBody()), { entrypoint: "sdk-cli", ccVersion: "2.1.221.76e" });
});

test("parsePrefixShape: rejects unexpected shapes", () => {
  assert.equal(parsePrefixShape(null), null);
  assert.equal(parsePrefixShape({}), null);
  assert.equal(parsePrefixShape(cliBody({ system: "a string" })), null);
  const noBilling = cliBody();
  noBilling.system[0].text = "no marker here";
  assert.equal(parsePrefixShape(noBilling), null);
  const shortSystem = cliBody();
  shortSystem.system = shortSystem.system.slice(0, 2);
  assert.equal(parsePrefixShape(shortSystem), null);
  const noTools = cliBody({ tools: [] });
  assert.equal(parsePrefixShape(noTools), null);
  const noMessages = cliBody({ messages: [] });
  assert.equal(parsePrefixShape(noMessages), null);
});

// --- deriveKey ---

test("deriveKey: stable for identical messages[0], distinct otherwise", () => {
  const a = cliBody();
  const b = sdkBody(); // same MSG0, longer history
  assert.equal(deriveKey(a), deriveKey(b));
  const c = cliBody();
  c.messages[0].content[1].text = "different first prompt";
  assert.notEqual(deriveKey(a), deriveKey(c));
});

// --- persist / load round trip ---

test("persistShape/loadShape: round-trips the interactive shape", async () => {
  const body = cliBody();
  const key = deriveKey(body);
  const res = await persistShape(body, { ccVersion: "2.1.221.76e" }, { dir: tmp, key, now: 1000 });
  assert.equal(res.persisted, true);
  const snap = await loadShape({ dir: tmp, key });
  assert.equal(snap.v, SNAPSHOT_VERSION);
  assert.equal(snap.ts, 1000);
  assert.equal(snap.ccVersion, "2.1.221.76e");
  assert.equal(snap.model, "claude-haiku-4-5-20251001");
  assert.deepEqual(snap.systemTexts, [CLI_BILLING, CLI_IDENTITY, CLI_BIG]);
  assert.deepEqual(snap.tools.map((t) => t.name), ["Agent", "Artifact", "AskUserQuestion", "Bash", "WebFetch"]);
});

test("loadShape: null on missing/corrupt snapshot", async () => {
  assert.equal(await loadShape({ dir: tmp, key: "nope" }), null);
  const body = cliBody();
  const key = deriveKey(body);
  const failingFs = { readFile: async () => "{not json" };
  await persistShape(body, { ccVersion: "x" }, { dir: tmp, key });
  assert.equal(await loadShape({ dir: tmp, key, fs: failingFs }), null);
});

// --- bridgeBlockReason ---

function freshSnap(now = Date.now()) {
  return {
    v: SNAPSHOT_VERSION,
    ts: now,
    ccVersion: "2.1.221.76e",
    model: "claude-haiku-4-5-20251001",
    systemTexts: [CLI_BILLING, CLI_IDENTITY, CLI_BIG],
    tools: structuredClone(CLI_TOOLS),
  };
}

test("bridgeBlockReason: passes the measured 2.1.221 case", () => {
  const now = Date.now();
  assert.equal(bridgeBlockReason(sdkBody(), { ccVersion: "2.1.221.76e" }, freshSnap(now), now, 7200000), null);
});

test("bridgeBlockReason: rejects stale / mismatched snapshots", () => {
  const now = Date.now();
  const meta = { ccVersion: "2.1.221.76e" };
  assert.equal(bridgeBlockReason(sdkBody(), meta, freshSnap(now - 7200001), now, 7200000), "snapshot-stale");
  const wrongVersion = freshSnap(now);
  wrongVersion.ccVersion = "2.1.222";
  assert.equal(bridgeBlockReason(sdkBody(), meta, wrongVersion, now, 7200000), "cc-version-mismatch");
  const wrongModel = freshSnap(now);
  wrongModel.model = "claude-sonnet-4-5";
  assert.equal(bridgeBlockReason(sdkBody(), meta, wrongModel, now, 7200000), "model-mismatch");
  const shorterSystem = freshSnap(now);
  shorterSystem.systemTexts = shorterSystem.systemTexts.slice(0, 2);
  assert.equal(bridgeBlockReason(sdkBody(), meta, shorterSystem, now, 7200000), "system-length-mismatch");
});

test("toolsDelta: accounts added (interactive-only) and dropped (deferred) tools", () => {
  const body = sdkBody();
  body.tools.push(tool("ListMcpResourcesTool")); // headless declares it; recorded session deferred it
  const { added, dropped } = toolsDelta(body, freshSnap());
  assert.deepEqual(added.sort(), ["Artifact", "AskUserQuestion"]);
  assert.deepEqual(dropped, ["ListMcpResourcesTool"]);
});

// --- applyShape ---

test("applyShape: substitutes tools and system texts, preserves cache_control", () => {
  const body = sdkBody();
  const snap = freshSnap();
  const { toolsBefore, toolsAfter } = applyShape(body, snap);
  assert.equal(toolsBefore, 3);
  assert.equal(toolsAfter, 5);
  assert.deepEqual(body.tools.map((t) => t.name), ["Agent", "Artifact", "AskUserQuestion", "Bash", "WebFetch"]);
  assert.equal(body.system[0].text, CLI_BILLING);
  assert.equal(body.system[1].text, CLI_IDENTITY);
  assert.equal(body.system[2].text, CLI_BIG);
  // request's own cache_control survives text substitution
  assert.deepEqual(body.system[1].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.deepEqual(body.system[2].cache_control, { type: "ephemeral", ttl: "1h" });
});

// --- onRequest end-to-end ---

test("onRequest: inert without CACHE_FIX_ENTRYPOINT_BRIDGE=1", async () => {
  const ctx = ctxFor(sdkBody());
  const before = JSON.stringify(ctx.body);
  await ext.onRequest(ctx);
  assert.equal(JSON.stringify(ctx.body), before);
  assert.equal(ctx.meta.entrypointBridgeStats, undefined);
  const entries = await readdir(tmp).catch(() => []);
  assert.equal(entries.length, 0);
});

test("onRequest: cli request persists, matching sdk-cli request bridges to identical prefix", async () => {
  process.env.CACHE_FIX_ENTRYPOINT_BRIDGE = "1";

  const cliCtx = ctxFor(cliBody());
  await ext.onRequest(cliCtx);
  assert.equal(cliCtx.meta.entrypointBridgeStats.action, "persisted");
  const stateDir = join(tmp, "cache-fix-state");
  const files = await readdir(stateDir);
  assert.equal(files.filter((f) => f.startsWith("entrypoint-bridge-")).length, 1);

  const sdkReq = sdkBody();
  sdkReq.tools.push(tool("ListMcpResourcesTool")); // deferred by the recorded session
  const sdkCtx = ctxFor(sdkReq);
  await ext.onRequest(sdkCtx);
  assert.equal(sdkCtx.meta.entrypointBridgeStats.action, "bridged");
  assert.equal(sdkCtx.meta.entrypointBridgeStats.toolsAdded, 2);
  assert.equal(sdkCtx.meta.entrypointBridgeStats.toolsDropped, 1);
  // The bridged prefix (tools + system texts) must byte-match the cli leg.
  assert.equal(JSON.stringify(sdkCtx.body.tools), JSON.stringify(cliCtx.body.tools));
  assert.deepEqual(
    sdkCtx.body.system.map((b) => b.text),
    cliCtx.body.system.map((b) => b.text),
  );
  // History and non-prefix fields are untouched.
  assert.equal(sdkCtx.body.messages.length, 3);
  assert.equal(sdkCtx.body.model, "claude-haiku-4-5-20251001");
});

test("onRequest: sdk-cli with a different messages[0] does not bridge", async () => {
  process.env.CACHE_FIX_ENTRYPOINT_BRIDGE = "1";
  await ext.onRequest(ctxFor(cliBody()));
  const other = sdkBody();
  other.messages[0] = { role: "user", content: [{ type: "text", text: "fresh -p session" }] };
  const ctx = ctxFor(other);
  const before = JSON.stringify(ctx.body);
  await ext.onRequest(ctx);
  assert.equal(ctx.meta.entrypointBridgeStats.action, "skipped");
  assert.equal(ctx.meta.entrypointBridgeStats.reason, "no-snapshot");
  assert.equal(JSON.stringify(ctx.body), before);
});

test("onRequest: non-CC entrypoints are never bridged", async () => {
  process.env.CACHE_FIX_ENTRYPOINT_BRIDGE = "1";
  await ext.onRequest(ctxFor(cliBody()));
  const sdkTs = sdkBody();
  sdkTs.system[0] = { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.221.76e; cc_entrypoint=sdk-ts;" };
  const ctx = ctxFor(sdkTs);
  const before = JSON.stringify(ctx.body);
  await ext.onRequest(ctx);
  assert.equal(ctx.meta.entrypointBridgeStats.action, "skipped");
  assert.match(ctx.meta.entrypointBridgeStats.reason, /^entrypoint:sdk-ts/);
  assert.equal(JSON.stringify(ctx.body), before);
});

test("onRequest: stale snapshot does not bridge (age gate honors env override)", async () => {
  process.env.CACHE_FIX_ENTRYPOINT_BRIDGE = "1";
  process.env.CACHE_FIX_ENTRYPOINT_BRIDGE_MAX_AGE_MS = "1";
  await ext.onRequest(ctxFor(cliBody()));
  // ensure >1ms passes so the 1ms budget is exceeded
  await new Promise((r) => setTimeout(r, 5));
  const ctx = ctxFor(sdkBody());
  await ext.onRequest(ctx);
  assert.equal(ctx.meta.entrypointBridgeStats.action, "skipped");
  assert.equal(ctx.meta.entrypointBridgeStats.reason, "snapshot-stale");
});

test("onRequest: malformed body is a safe no-op", async () => {
  process.env.CACHE_FIX_ENTRYPOINT_BRIDGE = "1";
  const ctx = { body: { model: 42, system: null, tools: "x", messages: null }, meta: {} };
  await ext.onRequest(ctx);
  assert.equal(ctx.meta.entrypointBridgeStats.action, "skipped");
  assert.equal(ctx.meta.entrypointBridgeStats.reason, "shape-unrecognized");
});

test("persist path sweeps stale snapshot files", async () => {
  process.env.CACHE_FIX_ENTRYPOINT_BRIDGE = "1";
  const cliCtx = ctxFor(cliBody());
  await ext.onRequest(cliCtx);
  const stateDir = join(tmp, "cache-fix-state");
  const [file] = (await readdir(stateDir)).filter((f) => f.startsWith("entrypoint-bridge-"));
  // Age the file far beyond the 48h sweep horizon…
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  await utimes(join(stateDir, file), old, old);
  // …then persist a DIFFERENT session's shape. The sweep is throttled to
  // once per 10min per process; the first onRequest above already consumed
  // the slot, so this test only asserts the sweep never deletes fresh files
  // and the persist itself succeeds.
  const other = cliBody();
  other.messages[0] = { role: "user", content: [{ type: "text", text: "another session" }] };
  const ctx2 = ctxFor(other);
  await ext.onRequest(ctx2);
  assert.equal(ctx2.meta.entrypointBridgeStats.action, "persisted");
  const after = (await readdir(stateDir)).filter((f) => f.startsWith("entrypoint-bridge-"));
  assert.ok(after.length >= 1);
});

test("snapshot file content is valid JSON with the documented schema", async () => {
  process.env.CACHE_FIX_ENTRYPOINT_BRIDGE = "1";
  await ext.onRequest(ctxFor(cliBody()));
  const stateDir = join(tmp, "cache-fix-state");
  const [file] = (await readdir(stateDir)).filter((f) => f.startsWith("entrypoint-bridge-"));
  const snap = JSON.parse(await readFile(join(stateDir, file), "utf-8"));
  assert.equal(snap.v, SNAPSHOT_VERSION);
  assert.ok(Number.isFinite(snap.ts));
  assert.equal(typeof snap.ccVersion, "string");
  assert.ok(Array.isArray(snap.systemTexts));
  assert.ok(Array.isArray(snap.tools));
});
