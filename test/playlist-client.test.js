import test from "node:test";
import assert from "node:assert/strict";

import { fetchPlaylistText } from "../src/playlist-client.js";

function mockResponse({ status = 200, text = "#EXTM3U" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: "https://cdn.test/final.m3u8",
    headers: { get() { return null; } },
    async text() { return text; },
  };
}

test("returns playlist text and the final response URL", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => mockResponse();

  try {
    assert.deepEqual(
      await fetchPlaylistText("https://cdn.test/input.m3u8", 1_024),
      {
        text: "#EXTM3U",
        url: "https://cdn.test/final.m3u8",
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not retry a permanent HTTP error", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return mockResponse({ status: 404 });
  };

  try {
    await assert.rejects(
      fetchPlaylistText("https://cdn.test/missing.m3u8", 1_024),
      /HTTP 404/,
    );
    assert.equal(attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects an oversized playlist without retrying it", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return mockResponse({ text: "#EXTM3U\n".repeat(20) });
  };

  try {
    await assert.rejects(
      fetchPlaylistText("https://cdn.test/large.m3u8", 32),
      /safe parsing limit/,
    );
    assert.equal(attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
