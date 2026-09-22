import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { streamResponse, createTelemetryRecord } from "../proxy/stream.mjs";

// A multi-byte UTF-8 character (Korean = 3 bytes) that straddles two network
// chunks must survive: decoding each chunk on its own turns each half into U+FFFD.
const TEXT = "감싼 것으로";
const SSE =
  `event: content_block_delta\n` +
  `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${TEXT}"}}\n\n`;

function fakeClient() {
  const chunks = [];
  return {
    chunks,
    ended: false,
    write(s) { chunks.push(String(s)); return true; },
    once() {},
    end() { this.ended = true; },
  };
}

async function* upstreamSplitAt(bytes, ...cuts) {
  let prev = 0;
  for (const cut of cuts) { yield bytes.subarray(prev, cut); prev = cut; }
  yield bytes.subarray(prev);
}

async function relay(bytes, ...cuts) {
  const client = fakeClient();
  await streamResponse(upstreamSplitAt(bytes, ...cuts), client, createTelemetryRecord(), [], {}, null);
  assert.equal(client.ended, true);
  return client.chunks.join("");
}

describe("streamResponse UTF-8 across chunk boundaries", () => {
  const bytes = Buffer.from(SSE, "utf8");
  const charAt = Buffer.byteLength(SSE.slice(0, SSE.indexOf("것")), "utf8");

  it("1+2 byte split inside a character", async () => {
    const out = await relay(bytes, charAt + 1);
    assert.ok(!out.includes("�"), `replacement char in: ${out}`);
    assert.equal(out, SSE);
  });

  it("2+1 byte split inside a character", async () => {
    const out = await relay(bytes, charAt + 2);
    assert.ok(!out.includes("�"), `replacement char in: ${out}`);
    assert.equal(out, SSE);
  });

  it("one byte per chunk", async () => {
    const cuts = Array.from({ length: bytes.length - 1 }, (_, i) => i + 1);
    const out = await relay(bytes, ...cuts);
    assert.equal(out, SSE);
  });

  it("split on a line boundary and a final line without newline", async () => {
    const tail = `data: {"type":"message_stop"}`;
    const all = Buffer.from(SSE + tail, "utf8");
    const out = await relay(all, bytes.length);
    assert.equal(out, SSE + tail + "\n");
  });
});
