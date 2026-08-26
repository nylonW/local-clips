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

function makeVideoPacket(timestampSeconds) {
  const bytes = new Uint8Array(188).fill(0xff);
  const payload = 4;
  const pts = BigInt(Math.round(timestampSeconds * 90_000));
  bytes[0] = 0x47;
  bytes[1] = 0x40;
  bytes[3] = 0x10;
  bytes[payload] = 0x00;
  bytes[payload + 1] = 0x00;
  bytes[payload + 2] = 0x01;
  bytes[payload + 3] = 0xe0;
  bytes[payload + 6] = 0x80;
  bytes[payload + 7] = 0x80;
  bytes[payload + 8] = 0x05;
  bytes[payload + 9] =
    0x20 | Number(((pts >> 30n) & 0x07n) << 1n) | 1;
  bytes[payload + 10] = Number((pts >> 22n) & 0xffn);
  bytes[payload + 11] = Number(((pts >> 15n) & 0x7fn) << 1n) | 1;
  bytes[payload + 12] = Number((pts >> 7n) & 0xffn);
  bytes[payload + 13] = Number((pts & 0x7fn) << 1n) | 1;
  return bytes.buffer;
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
      url: "https://video-weaver.test/channel/index.m3u8?token=refreshed&_HLS_msn=20&_HLS_part=3",
      initiator: "https://www.twitch.tv",
      timeStamp: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(playlistFetchCount, 1);
    assert.equal(
      sessionData["active-playlist-for-tab-7"].url,
      "https://video-weaver.test/channel/index.m3u8?token=refreshed",
    );

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
    assert.equal(sessionData["active-playlist-for-tab-8"], undefined);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("Kick rewind is detected from HLS sequence jumps and ignores IVS prefetch", async () => {
  const listeners = {};
  const sessionData = {};
  const badgeTexts = [];
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  let mergeRequest;
  let downloadRequest;

  const archiveStartedAt = new Date(Date.now() - 300_000).toISOString();
  const liveStartedAt = new Date(Date.now() - 30_000).toISOString();
  const archivePlaylistText = [
    "#EXTM3U",
    "#EXT-X-PLAYLIST-TYPE:EVENT",
    "#EXT-X-TARGETDURATION:13",
    "#EXT-X-MEDIA-SEQUENCE:0",
    `#EXT-X-PROGRAM-DATE-TIME:${archiveStartedAt}`,
    ...Array.from({ length: 30 }, (_, index) => [
      "#EXTINF:10,",
      `${index}.ts`,
    ]).flat(),
  ].join("\n");
  const livePlaylistText = [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:6",
    "#EXT-X-MEDIA-SEQUENCE:1000",
    `#EXT-X-PROGRAM-DATE-TIME:${liveStartedAt}`,
    ...Array.from({ length: 15 }, (_, index) => [
      "#EXTINF:2,",
      `${1000 + index}.ts`,
    ]).flat(),
    "#EXT-X-PREFETCH:1015.ts",
    "#EXT-X-PREFETCH:1016.ts",
  ].join("\n");
  const clipPlaylistText = `#EXTM3U
#EXT-X-TARGETDURATION:5
#EXT-X-BYTERANGE:4662212@8928120
#EXTINF:4.167,
1928.ts
#EXT-X-BYTERANGE:4334904@0
#EXTINF:4.167,
1929.ts
#EXT-X-BYTERANGE:4430032@4334904
#EXTINF:4.166,
1929.ts
#EXT-X-BYTERANGE:4456352@8764936
#EXTINF:4.167,
1929.ts
#EXT-X-BYTERANGE:4492260@0
#EXTINF:4.167,
1930.ts
#EXT-X-BYTERANGE:4344868@4492260
#EXTINF:4.166,
1930.ts
#EXT-X-ENDLIST`;

  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener(listener) { listeners.installed = listener; } },
      onStartup: { addListener(listener) { listeners.startup = listener; } },
      onMessage: { addListener(listener) { listeners.message = listener; } },
      getURL(path) { return `chrome-extension://test/${path}`; },
      async getContexts() { return []; },
      async sendMessage(message) {
        if (
          message.target === "offscreen" &&
          message.type === "merge-and-download"
        ) {
          mergeRequest = message;
          return { ok: true, objectUrl: "blob:test", failedCount: 0 };
        }
        return { ok: true };
      },
    },
    tabs: {
      onUpdated: { addListener(listener) { listeners.tabUpdated = listener; } },
      onRemoved: { addListener(listener) { listeners.tabRemoved = listener; } },
      async get() { return { url: "https://kick.com/example" }; },
    },
    webRequest: {
      onBeforeRequest: {
        addListener(listener) { listeners.beforeRequest = listener; },
      },
    },
    action: {
      onClicked: { addListener(listener) { listeners.actionClicked = listener; } },
      async setBadgeText({ text }) { badgeTexts.push(text); },
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
        async get() { return { clipSeconds: 30 }; },
        async set() {},
      },
      onChanged: { addListener(listener) { listeners.storageChanged = listener; } },
    },
    offscreen: {
      async createDocument() {},
    },
    downloads: {
      async download(request) {
        downloadRequest = request;
        return 1;
      },
    },
  };

  globalThis.fetch = async (url) => {
    const historicalMatch = url.match(/\/old-(\d+)\.ts/);
    return {
      ok: true,
      status: 200,
      url,
      headers: { get() { return null; } },
      async text() {
        if (url.includes("/clips/")) {
          return clipPlaylistText;
        }
        return url.includes("/archive/")
          ? archivePlaylistText
          : livePlaylistText;
      },
      async arrayBuffer() {
        return historicalMatch
          ? makeVideoPacket(1_000 + Number(historicalMatch[1]) * 10)
          : new ArrayBuffer(0);
      },
    };
  };

  try {
    await import(`../src/service-worker.js?rewind-integration=${Date.now()}`);

    listeners.beforeRequest({
      tabId: 12,
      method: "GET",
      url: "https://cdn.kick.test/live/playlist.m3u8?token=fresh",
      initiator: "https://kick.com",
      timeStamp: Date.now(),
    });
    await waitFor(() => sessionData["active-playlist-for-tab-12"]);

    const rewindStartedAt = Date.now() - 13_000;
    listeners.beforeRequest({
      tabId: 12,
      method: "GET",
      url: "https://cdn.kick.test/live/1014.ts?token=fresh",
      initiator: "https://kick.com",
      timeStamp: rewindStartedAt - 1_000,
    });
    await waitFor(
      () => sessionData["segments-for-tab-12"]?.some(
        (segment) => segment.url.includes("/1014.ts"),
      ),
    );

    listeners.beforeRequest({
      tabId: 12,
      method: "GET",
      url: "https://cdn.kick.test/archive/playlist.m3u8?token=fresh",
      initiator: "https://kick.com",
      timeStamp: Date.now(),
    });
    await waitFor(
      () => sessionData["active-playlist-for-tab-12"]?.url.includes("/archive/"),
    );

    listeners.beforeRequest({
      tabId: 12,
      method: "GET",
      url: "https://cdn.kick.test/archive/10.ts?token=fresh",
      initiator: "https://kick.com",
      timeStamp: rewindStartedAt,
    });
    for (let sequence = 11; sequence <= 16; sequence += 1) {
      listeners.beforeRequest({
        tabId: 12,
        method: "GET",
        url: `https://cdn.kick.test/archive/${sequence}.ts?token=fresh`,
        initiator: "https://kick.com",
        timeStamp: Date.now(),
      });
    }
    await waitFor(
      () => sessionData["rewind-capture-for-tab-12"]?.segments.length === 7,
    );

    listeners.actionClicked({
      id: 12,
      url: "https://kick.com/example",
      title: "Example | Kick",
    });
    await waitFor(() => downloadRequest);

    assert.deepEqual(
      mergeRequest.segments.map((segment) => new URL(segment.url).pathname),
      [
        "/archive/9.ts",
        "/archive/10.ts",
        "/archive/11.ts",
      ],
    );
    assert.equal(
      mergeRequest.segments.some((segment) => segment.url.includes("/archive/16.ts")),
      false,
    );
    assert.equal(badgeTexts.includes("!"), false);
    assert.equal(badgeTexts.includes("30s"), true);
    assert.equal(downloadRequest.saveAs, true);

    listeners.beforeRequest({
      tabId: 12,
      method: "GET",
      url: "https://cdn.kick.test/live/playlist.m3u8?token=fresh",
      initiator: "https://kick.com",
      timeStamp: Date.now(),
    });
    listeners.beforeRequest({
      tabId: 12,
      method: "GET",
      url: "https://cdn.kick.test/live/1014.ts?token=fresh",
      initiator: "https://kick.com",
      timeStamp: Date.now(),
    });
    await waitFor(
      () => sessionData["rewind-capture-for-tab-12"] === undefined,
    );
    await waitFor(
      () =>
        sessionData["segments-for-tab-12"]?.length === 1 &&
        sessionData["segments-for-tab-12"][0].url.includes("/live/1014.ts"),
    );

    mergeRequest = null;
    downloadRequest = null;
    const unindexedStartedAt = Date.now() - 19_000;
    for (let index = 0; index < 4; index += 1) {
      listeners.beforeRequest({
        tabId: 12,
        method: "GET",
        url: `https://historical.kick.test/old-${index}.ts?token=fresh`,
        initiator: "https://kick.com",
        timeStamp: index === 0 ? unindexedStartedAt : Date.now(),
      });
    }
    await waitFor(
      () =>
        sessionData["rewind-capture-for-tab-12"]?.mode === "unindexed" &&
        sessionData["rewind-capture-for-tab-12"]?.segments.length === 4,
    );
    assert.deepEqual(
      sessionData["rewind-capture-for-tab-12"].segments.map(
        (segment) => segment.durationSeconds,
      ),
      [10, 10, 10, 10],
    );

    listeners.actionClicked({
      id: 12,
      url: "https://kick.com/example",
      title: "Example | Kick",
    });
    await waitFor(() => downloadRequest);
    assert.deepEqual(
      mergeRequest.segments.map((segment) => new URL(segment.url).pathname),
      ["/old-0.ts", "/old-1.ts"],
    );
    assert.equal(badgeTexts.includes("20s"), true);
    assert.equal(
      mergeRequest.segments.some((segment) => segment.url.includes("/live/1014.ts")),
      false,
    );

    listeners.beforeRequest({
      tabId: 12,
      method: "GET",
      url: "https://cdn.kick.test/live/playlist.m3u8?token=fresh",
      initiator: "https://kick.com",
      timeStamp: Date.now(),
    });
    listeners.beforeRequest({
      tabId: 12,
      method: "GET",
      url: "https://cdn.kick.test/live/1014.ts?token=fresh",
      initiator: "https://kick.com",
      timeStamp: Date.now(),
    });
    await waitFor(
      () => sessionData["rewind-capture-for-tab-12"] === undefined,
    );
    await waitFor(
      () =>
        sessionData["segments-for-tab-12"]?.length === 1 &&
        sessionData["segments-for-tab-12"][0].url.includes("/live/1014.ts"),
    );

    listeners.beforeRequest({
      tabId: 12,
      method: "GET",
      url: "https://cdn.kick.test/archive/playlist.m3u8?token=fresh",
      initiator: "https://kick.com",
      timeStamp: Date.now(),
    });
    listeners.beforeRequest({
      tabId: 12,
      method: "GET",
      url: "https://cdn.kick.test/archive/2.ts?token=fresh",
      initiator: "https://kick.com",
      timeStamp: Date.now(),
    });
    await waitFor(
      () => sessionData["rewind-capture-for-tab-12"]?.anchorSequence === 2,
    );

    listeners.tabRemoved(12);
    await waitFor(
      () => sessionData["rewind-capture-for-tab-12"] === undefined,
    );

    mergeRequest = null;
    downloadRequest = null;
    const clipPageUrl =
      "https://kick.com/mlekosz666/clips/clip_01M0Y0M794D8KJGAJRC8VK97F1";
    listeners.tabUpdated(13, { url: clipPageUrl }, { url: clipPageUrl });
    listeners.beforeRequest({
      tabId: 13,
      method: "GET",
      url: "https://clips.kick.test/clips/72/clip_01M0Y0M794D8KJGAJRC8VK97F1/playlist.m3u8",
      initiator: "https://kick.com",
      timeStamp: Date.now(),
    });
    await waitFor(
      () => sessionData["kick-clip-for-tab-13"]?.segments.length === 6,
    );

    listeners.beforeRequest({
      tabId: 13,
      method: "GET",
      url: "https://clips.kick.test/clips/72/clip_01M0Y0M794D8KJGAJRC8VK97F1/1929.ts",
      initiator: "https://kick.com",
      timeStamp: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(sessionData["segments-for-tab-13"], undefined);

    listeners.actionClicked({
      id: 13,
      url: clipPageUrl,
      title: "policja | Kick",
    });
    await waitFor(() => downloadRequest);
    assert.deepEqual(
      mergeRequest.segments.map((segment) => ({
        path: new URL(segment.url).pathname,
        durationSeconds: segment.durationSeconds,
        byteRange: segment.byteRange,
      })),
      [
        {
          path: "/clips/72/clip_01M0Y0M794D8KJGAJRC8VK97F1/1928.ts",
          durationSeconds: 4.167,
          byteRange: { offset: 8_928_120, length: 4_662_212 },
        },
        {
          path: "/clips/72/clip_01M0Y0M794D8KJGAJRC8VK97F1/1929.ts",
          durationSeconds: 4.167,
          byteRange: { offset: 0, length: 4_334_904 },
        },
        {
          path: "/clips/72/clip_01M0Y0M794D8KJGAJRC8VK97F1/1929.ts",
          durationSeconds: 4.166,
          byteRange: { offset: 4_334_904, length: 4_430_032 },
        },
        {
          path: "/clips/72/clip_01M0Y0M794D8KJGAJRC8VK97F1/1929.ts",
          durationSeconds: 4.167,
          byteRange: { offset: 8_764_936, length: 4_456_352 },
        },
        {
          path: "/clips/72/clip_01M0Y0M794D8KJGAJRC8VK97F1/1930.ts",
          durationSeconds: 4.167,
          byteRange: { offset: 0, length: 4_492_260 },
        },
        {
          path: "/clips/72/clip_01M0Y0M794D8KJGAJRC8VK97F1/1930.ts",
          durationSeconds: 4.166,
          byteRange: { offset: 4_492_260, length: 4_344_868 },
        },
      ],
    );
    assert.equal(mergeRequest.completePlaylist, true);
    assert.equal(badgeTexts.includes("↓"), true);
    assert.equal(downloadRequest.saveAs, true);

    listeners.tabRemoved(13);
    await waitFor(() => sessionData["kick-clip-for-tab-13"] === undefined);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});
