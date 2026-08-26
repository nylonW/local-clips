import test from "node:test";
import assert from "node:assert/strict";

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the service worker test condition");
}

test("playlist prefill augments the existing direct TS capture path", async () => {
  const listeners = {};
  const sessionData = {};
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  let playlistFetchCount = 0;
  let resolveDelayedPlaylist;

  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener(listener) { listeners.installed = listener; } },
      onStartup: { addListener(listener) { listeners.startup = listener; } },
      onMessage: { addListener(listener) { listeners.message = listener; } },
      getURL(path) { return `chrome-extension://test/${path}`; },
      async getContexts() { return []; },
      async sendMessage() { return { ok: true }; },
    },
    tabs: {
      onUpdated: { addListener(listener) { listeners.tabUpdated = listener; } },
      onRemoved: { addListener(listener) { listeners.tabRemoved = listener; } },
      async get() { return { url: "https://www.twitch.tv/example" }; },
    },
    webRequest: {
      onBeforeRequest: {
        addListener(listener) { listeners.beforeRequest = listener; },
      },
    },
    action: {
      onClicked: { addListener(listener) { listeners.actionClicked = listener; } },
      async setBadgeText() {},
      async setBadgeBackgroundColor() {},
      async setTitle() {},
    },
    storage: {
      session: {
        async get(key) { return { [key]: sessionData[key] }; },
        async set(values) { Object.assign(sessionData, values); },
        async remove(key) { delete sessionData[key]; },
      },
      local: {
        async get() { return { clipSeconds: 90 }; },
        async set() {},
      },
      onChanged: { addListener(listener) { listeners.storageChanged = listener; } },
    },
    offscreen: {
      async createDocument() {},
    },
    downloads: {
      async download() { return 1; },
    },
  };

  globalThis.fetch = async (url) => {
    playlistFetchCount += 1;
    const response = {
      ok: true,
      status: 200,
      url,
      headers: { get() { return null; } },
      async text() {
        return `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXTINF:2,
100.ts
#EXTINF:2,
101.ts
#EXTINF:2,
102.ts`;
      },
    };
    if (url.includes("delayed")) {
      return new Promise((resolve) => {
        resolveDelayedPlaylist = () => resolve(response);
      });
    }
    return response;
  };

  try {
    await import(`../src/service-worker.js?integration=${Date.now()}`);

    listeners.beforeRequest({
      tabId: 7,
      method: "GET",
      url: "https://video-weaver.test/channel/index.m3u8?token=abc",
      initiator: "https://www.twitch.tv",
      timeStamp: Date.now(),
    });

    await waitFor(() => sessionData["segments-for-tab-7"]?.length === 3);
    assert.equal(playlistFetchCount, 1);
    assert.deepEqual(
      sessionData["segments-for-tab-7"].map((segment) => new URL(segment.url).pathname),
      ["/channel/100.ts", "/channel/101.ts", "/channel/102.ts"],
    );

    const directSegmentUrl = "https://video-weaver.test/channel/103.ts";
    listeners.beforeRequest({
      tabId: 7,
      method: "GET",
      url: directSegmentUrl,
      initiator: "https://www.twitch.tv",
      timeStamp: Date.now() + 2_000,
    });

    await waitFor(() => sessionData["segments-for-tab-7"]?.length === 4);
    assert.equal(sessionData["segments-for-tab-7"].at(-1).url, directSegmentUrl);

    listeners.beforeRequest({
      tabId: 7,
      method: "GET",
      url: "https://video-weaver.test/channel/index.m3u8?token=abc",
      initiator: "https://www.twitch.tv",
      timeStamp: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(playlistFetchCount, 1);

    listeners.beforeRequest({
      tabId: 7,
      method: "GET",
      url: "https://video-weaver.test/other-quality/index.m3u8?token=abc",
      initiator: "https://www.twitch.tv",
      timeStamp: Date.now(),
    });
    await waitFor(() => playlistFetchCount === 2);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(sessionData["segments-for-tab-7"].length, 4);
    assert.equal(
      sessionData["segments-for-tab-7"].some((segment) => segment.url.includes("other-quality")),
      false,
    );

    listeners.beforeRequest({
      tabId: 8,
      method: "GET",
      url: "https://video-weaver.test/delayed/index.m3u8?token=abc",
      initiator: "https://www.twitch.tv",
      timeStamp: Date.now(),
    });
    await waitFor(() => typeof resolveDelayedPlaylist === "function");
    listeners.tabRemoved(8);
    resolveDelayedPlaylist();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(sessionData["segments-for-tab-8"], undefined);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});
