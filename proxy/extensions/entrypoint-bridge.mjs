// entrypoint-bridge — span the interactive→headless-resume prompt-cache gap.
//
// PROBLEM (measured on Claude Code 2.1.221, see docs/monitoring.md and the
// fix/2.1.221-resume-gap investigation): `claude -p --resume <sid>` replays
// the recorded conversation byte-identically (message history, SessionStart
// hook outputs, attachments — all verified equal), but the STATIC PREFIX in
// front of it is built by a different entrypoint and diverges in four spots:
//
//   1. system[0]  billing header: `cc_entrypoint=cli` vs `cc_entrypoint=sdk-cli`
//   2. system[1]  identity: "You are Claude Code, Anthropic's official CLI…"
//                 vs "You are a Claude agent, built on Anthropic's Claude
//                 Agent SDK."
//   3. system[2]  "# Session-specific guidance" bullets differ, and the
//                 per-session "# Scratchpad Directory" section (which embeds
//                 the session id) is present only interactively
//   4. tools      the headless roster drops interactive-only tools
//                 (measured: Artifact, AskUserQuestion, EnterPlanMode,
//                 ExitPlanMode, SendUserFile — 48 → 43) and ships a
//                 different WebFetch description
//
// Tools serialize FIRST in the cache prefix, so the divergence starts at the
// second tool and the entire conversation body re-prefills on every headless
// resume (cache_creation ≈ full body) even though the recorded history is
// byte-identical.
//
// FIX (opt-in): persist the interactive (`cc_entrypoint=cli`) prefix shape —
// full tools array + the three system texts — keyed by a hash of
// messages[0] (the recorded first user message, which a resume replays
// byte-identically; the key therefore binds a snapshot to its exact session
// lineage and nothing else). When a `sdk-cli` request arrives whose
// messages[0] matches a fresh snapshot, substitute the interactive shape so
// the upstream request byte-matches the interactive session's cached prefix.
//
// TRADEOFF (why this is DEFAULT OFF, gated on CACHE_FIX_ENTRYPOINT_BRIDGE=1):
// bridging re-declares interactive-only tool schemas to a headless client.
// If the model chooses to call one of them (e.g. AskUserQuestion), the
// headless client receives a tool_use it did not declare and will answer
// with an unknown-tool error result — one wasted round-trip, not a crash,
// but a real behavior delta. Operators who resume with narrow prompts (the
// intended fork-and-summarize workflow) opt in; everyone else keeps the
// status-quo cache miss.
//
// SAFETY RAILS (all fail-open to a no-op, never a throw):
//   - bridge only when the snapshot's cc_version AND model match the request
//   - bridge only when the snapshot is fresh (default 2h — a stale snapshot
//     cannot hit the 1h-TTL cache anyway, so rewriting the prompt would be
//     all risk and no reward)
//   - only text/tools are substituted; the request's own cache_control
//     markers, metadata and thinking config are never touched
//
// The tools array is adopted WHOLESALE from the snapshot — including
// dropping tools the headless request declares that the recorded session
// had deferred (CC demotes unused MCP tools to ToolSearch-deferral
// mid-session, so the recorded roster is often a strict subset plus the
// interactive-only tools). Dropping is the safe direction: the model simply
// cannot call the dropped tool — the same constraint the recorded
// interactive session already ran under. Added and dropped names are
// counted in the stats and debug log.

import {
  mkdir as _mkdir,
  readFile as _readFile,
  writeFile as _writeFile,
  rename as _rename,
  readdir as _readdir,
  stat as _stat,
  unlink as _unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { claudeHome } from "../claude-home.mjs";

const SNAPSHOT_VERSION = 1;
const BILLING_MARKER = "x-anthropic-billing-header:";
const ENTRYPOINT_RE = /cc_entrypoint=([a-z0-9_-]+)/;
const CC_VERSION_RE = /cc_version=([^;\s]+)/;

// Snapshots older than this are not bridged (and are swept). The prompt
// cache TTL is at most 1h, so anything past ~2h cannot produce a cache hit;
// substituting a prompt for zero cache value is all downside.
const DEFAULT_MAX_AGE_MS = 2 * 60 * 60 * 1000;
// Retention sweep: delete snapshots older than this, at most once per
// SWEEP_THROTTLE_MS per process. Snapshots are per-session (~150KB), so
// without a sweep the state dir grows one file per interactive session.
const SWEEP_AGE_MS = 48 * 60 * 60 * 1000;
const SWEEP_THROTTLE_MS = 10 * 60 * 1000;

const DEFAULT_FS = {
  mkdir: _mkdir,
  readFile: _readFile,
  writeFile: _writeFile,
  rename: _rename,
  readdir: _readdir,
  stat: _stat,
  unlink: _unlink,
};

// Env is read per call (image-strip #98 pattern) so tests and operators
// flipping the flag at runtime see live behavior.
function bridgeEnabled() {
  return process.env.CACHE_FIX_ENTRYPOINT_BRIDGE === "1";
}

function maxAgeMs() {
  const raw = parseInt(process.env.CACHE_FIX_ENTRYPOINT_BRIDGE_MAX_AGE_MS, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_AGE_MS;
}

function debug(msg) {
  if (process.env.CACHE_FIX_DEBUG === "1") {
    process.stderr.write(`[entrypoint-bridge] ${msg}\n`);
  }
}

function getSnapshotDir() {
  return join(claudeHome(), "cache-fix-state");
}

function snapshotPath(dir, key) {
  return join(dir, `entrypoint-bridge-${key}.json`);
}

/**
 * Parse `cc_entrypoint` and `cc_version` out of the billing-header system
 * block. Returns { entrypoint, ccVersion } or null when the request does not
 * have the expected CC v2.1.x shape (system array with the billing block at
 * index 0 and at least three text blocks).
 */
function parsePrefixShape(body) {
  if (!body || !Array.isArray(body.system) || body.system.length < 3) return null;
  const s0 = body.system[0];
  if (!s0 || s0.type !== "text" || typeof s0.text !== "string") return null;
  if (!s0.text.includes(BILLING_MARKER)) return null;
  for (const b of body.system) {
    if (!b || b.type !== "text" || typeof b.text !== "string") return null;
  }
  const entrypoint = s0.text.match(ENTRYPOINT_RE)?.[1] ?? null;
  const ccVersion = s0.text.match(CC_VERSION_RE)?.[1] ?? null;
  if (!entrypoint || !ccVersion) return null;
  if (!Array.isArray(body.tools) || body.tools.length === 0) return null;
  if (!Array.isArray(body.messages) || body.messages.length === 0) return null;
  return { entrypoint, ccVersion };
}

/**
 * Snapshot key: hash of the serialized first message. A resume replays the
 * recorded messages[0] byte-identically (verified against CC 2.1.221), so
 * this key matches exactly the session lineage being resumed — a fresh
 * headless session in the same cwd has a different messages[0] and will
 * never bridge.
 */
function deriveKey(body) {
  return createHash("sha256")
    .update(JSON.stringify(body.messages[0]))
    .digest("hex")
    .slice(0, 16);
}

// Atomic write (same lesson as prefix-diff / deferred-tools-restore):
// unique tmp per invocation so concurrent calls don't collide.
async function atomicWriteText(finalPath, data, fs) {
  const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 10)}.tmp`;
  await fs.writeFile(tmpPath, data);
  await fs.rename(tmpPath, finalPath);
}

/**
 * Persist the interactive prefix shape.
 * @returns {Promise<{persisted: boolean, path: string}>}
 */
async function persistShape(body, meta, options) {
  const fs = { ...DEFAULT_FS, ...(options.fs || {}) };
  const path = snapshotPath(options.dir, options.key);
  const snapshot = {
    v: SNAPSHOT_VERSION,
    ts: options.now ?? Date.now(),
    ccVersion: meta.ccVersion,
    model: typeof body.model === "string" ? body.model : null,
    systemTexts: body.system.map((b) => b.text),
    tools: body.tools,
  };
  try {
    await fs.mkdir(options.dir, { recursive: true });
    await atomicWriteText(path, JSON.stringify(snapshot), fs);
    return { persisted: true, path };
  } catch (err) {
    debug(`persist failed at ${path}: ${err?.message ?? err}`);
    return { persisted: false, path };
  }
}

/**
 * Load and validate a snapshot. Returns the parsed snapshot or null.
 */
async function loadShape(options) {
  const fs = { ...DEFAULT_FS, ...(options.fs || {}) };
  const path = snapshotPath(options.dir, options.key);
  let raw;
  try {
    raw = await fs.readFile(path, "utf-8");
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      debug(`snapshot read failed at ${path}: ${err?.message ?? err}`);
    }
    return null;
  }
  let snap;
  try {
    snap = JSON.parse(raw);
  } catch {
    debug(`snapshot corrupt at ${path}`);
    return null;
  }
  if (!snap || snap.v !== SNAPSHOT_VERSION) return null;
  if (typeof snap.ts !== "number" || typeof snap.ccVersion !== "string") return null;
  if (!Array.isArray(snap.systemTexts) || snap.systemTexts.length < 3) return null;
  if (snap.systemTexts.some((t) => typeof t !== "string")) return null;
  if (!Array.isArray(snap.tools) || snap.tools.length === 0) return null;
  return snap;
}

/**
 * Decide whether `snap` may bridge this request. Returns null when OK,
 * otherwise a short skip-reason string (used in stats + debug logs).
 */
function bridgeBlockReason(body, meta, snap, now, maxAge) {
  if (now - snap.ts > maxAge) return "snapshot-stale";
  if (snap.ccVersion !== meta.ccVersion) return "cc-version-mismatch";
  if ((snap.model ?? null) !== (typeof body.model === "string" ? body.model : null)) {
    return "model-mismatch";
  }
  if (snap.systemTexts.length !== body.system.length) return "system-length-mismatch";
  return null;
}

/**
 * Roster delta between the request's declared tools and the snapshot's:
 * `added` = in snapshot only (will be newly declared to the headless client's
 * request), `dropped` = in request only (recorded session had deferred them;
 * they will not be declared upstream).
 */
function toolsDelta(body, snap) {
  const bodyNames = new Set(body.tools.map((t) => t?.name));
  const snapNames = new Set(snap.tools.map((t) => t?.name));
  return {
    added: [...snapNames].filter((n) => !bodyNames.has(n)),
    dropped: [...bodyNames].filter((n) => !snapNames.has(n)),
  };
}

/**
 * Apply the snapshot to the request body: substitute the tools array and the
 * system texts. The request's own cache_control (and any other block fields)
 * are preserved — only `.text` is replaced.
 */
function applyShape(body, snap) {
  const toolsBefore = body.tools.length;
  body.tools = snap.tools;
  for (let i = 0; i < body.system.length; i++) {
    if (body.system[i].text !== snap.systemTexts[i]) {
      body.system[i] = { ...body.system[i], text: snap.systemTexts[i] };
    }
  }
  return { toolsBefore, toolsAfter: snap.tools.length };
}

let _lastSweep = 0;

/** Best-effort retention sweep, throttled per process. */
async function sweepStale(dir, fs, now) {
  if (now - _lastSweep < SWEEP_THROTTLE_MS) return;
  _lastSweep = now;
  try {
    const names = await fs.readdir(dir);
    for (const name of names) {
      if (!name.startsWith("entrypoint-bridge-") || !name.endsWith(".json")) continue;
      const p = join(dir, name);
      try {
        const st = await fs.stat(p);
        if (now - st.mtimeMs > SWEEP_AGE_MS) await fs.unlink(p);
      } catch {}
    }
  } catch {}
}

// Internal test seams — pipeline loading consumes only `default`.
export {
  parsePrefixShape,
  deriveKey,
  persistShape,
  loadShape,
  bridgeBlockReason,
  toolsDelta,
  applyShape,
  SNAPSHOT_VERSION,
};

export default {
  name: "entrypoint-bridge",
  description:
    "Persist the interactive (cli) prefix shape and re-apply it to headless (sdk-cli) resume requests so forks ride the interactive prompt cache",
  enabled: true,
  // Early — before any content-mutating extension — so the snapshot captures
  // and the substitution restores the SAME raw stage; every later extension
  // then processes both legs identically and the upstream bytes converge.
  order: 60,

  async onRequest(ctx) {
    if (!bridgeEnabled()) return;
    if (!ctx || !ctx.body) return;
    try {
      const body = ctx.body;
      const meta = parsePrefixShape(body);
      if (!meta) {
        ctx.meta.entrypointBridgeStats = { action: "skipped", reason: "shape-unrecognized" };
        return;
      }
      const key = deriveKey(body);
      const dir = getSnapshotDir();
      const now = Date.now();

      if (meta.entrypoint === "cli") {
        const result = await persistShape(body, meta, { dir, key, now });
        ctx.meta.entrypointBridgeStats = {
          action: result.persisted ? "persisted" : "skipped",
          reason: result.persisted ? undefined : "persist-failed",
          key,
        };
        if (result.persisted) debug(`persisted cli shape (key=${key})`);
        await sweepStale(dir, DEFAULT_FS, now);
        return;
      }

      if (meta.entrypoint !== "sdk-cli") {
        // sdk-ts / sdk-py / unknown entrypoints run bespoke prompts; never
        // substitute an interactive CC shape into those.
        ctx.meta.entrypointBridgeStats = {
          action: "skipped",
          reason: `entrypoint:${meta.entrypoint}`,
          key,
        };
        return;
      }

      const snap = await loadShape({ dir, key });
      if (!snap) {
        ctx.meta.entrypointBridgeStats = { action: "skipped", reason: "no-snapshot", key };
        debug(`no snapshot for key=${key}`);
        return;
      }
      const blocked = bridgeBlockReason(body, meta, snap, now, maxAgeMs());
      if (blocked) {
        ctx.meta.entrypointBridgeStats = { action: "skipped", reason: blocked, key };
        debug(`bridge blocked (${blocked}) key=${key}`);
        return;
      }
      const delta = toolsDelta(body, snap);
      const { toolsBefore, toolsAfter } = applyShape(body, snap);
      ctx.meta.entrypointBridgeStats = {
        action: "bridged",
        key,
        toolsBefore,
        toolsAfter,
        toolsAdded: delta.added.length,
        toolsDropped: delta.dropped.length,
      };
      if (delta.added.length) debug(`tools added: ${delta.added.join(",")}`);
      if (delta.dropped.length) debug(`tools dropped: ${delta.dropped.join(",")}`);
      process.stderr.write(
        `[entrypoint-bridge] bridged sdk-cli→cli prefix shape (key=${key}, tools ${toolsBefore}→${toolsAfter}, +${delta.added.length}/-${delta.dropped.length})\n`,
      );
    } catch (err) {
      // Defense in depth — the pipeline also catches, but this extension
      // must never influence a request it could not fully process.
      debug(`onRequest unexpected: ${err?.message ?? err}`);
    }
  },
};
