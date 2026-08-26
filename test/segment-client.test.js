import test from "node:test";
import assert from "node:assert/strict";

import { fetchSegment } from "../src/segment-client.js";

function response(status, bytes) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async arrayBuffer() { return Uint8Array.from(bytes).buffer; },
  };
}

test("requests and returns an exact MPEG-TS byte range", async () => {
  const originalFetch = globalThis.fetch;
  let requestOptions;
  globalThis.fetch = async (url, options) => {
    requestOptions = options;
    return response(206, [20, 21, 22]);
  };

  try {
    const buffer = await fetchSegment({
      url: "https://clips.kick.com/656.ts",
      byteRange: { offset: 2, length: 3 },
    });
    assert.equal(requestOptions.headers.Range, "bytes=2-4");
    assert.deepEqual([...new Uint8Array(buffer)], [20, 21, 22]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("slices a full cached response when the CDN ignores Range", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response(200, [0, 1, 2, 3, 4, 5]);

  try {
    const buffer = await fetchSegment({
      url: "https://clips.kick.com/656.ts",
      byteRange: { offset: 2, length: 3 },
    });
    assert.deepEqual([...new Uint8Array(buffer)], [2, 3, 4]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects malformed byte ranges before fetching", async () => {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    return response(200, []);
  };

  try {
    await assert.rejects(
      fetchSegment({
        url: "https://clips.kick.com/656.ts",
        byteRange: { offset: -1, length: 3 },
      }),
      /Invalid MPEG-TS byte range/,
    );
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
