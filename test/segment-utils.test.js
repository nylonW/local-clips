import test from "node:test";
import assert from "node:assert/strict";

import {
  clampClipSeconds,
  createClipFilename,
  estimateSegmentSeconds,
  isSupportedPageUrl,
  isTransportStreamUrl,
  pruneSegments,
  selectClipSegments,
} from "../src/segment-utils.js";

test("recognizes Twitch and Kick pages without mistaking lookalike domains", () => {
  assert.equal(isSupportedPageUrl("https://www.twitch.tv/example"), true);
  assert.equal(isSupportedPageUrl("https://player.twitch.tv/?channel=x"), true);
  assert.equal(isSupportedPageUrl("https://kick.com/example"), true);
  assert.equal(isSupportedPageUrl("https://evil-kick.com/example"), false);
  assert.equal(isSupportedPageUrl("not a url"), false);
});

test("recognizes MPEG-TS segment URLs with query strings", () => {
  assert.equal(isTransportStreamUrl("https://cdn.test/live/00001.ts?token=abc"), true);
  assert.equal(isTransportStreamUrl("https://cdn.test/live/00001.TS"), true);
  assert.equal(isTransportStreamUrl("https://cdn.test/live/index.m3u8"), false);
});

test("clamps configured clip duration", () => {
  assert.equal(clampClipSeconds("90"), 90);
  assert.equal(clampClipSeconds(1), 15);
  assert.equal(clampClipSeconds(999), 300);
  assert.equal(clampClipSeconds("invalid"), 90);
});

test("prunes expired entries, orders observations, and removes URL retries", () => {
  const result = pruneSegments(
    [
      { url: "https://cdn/2.ts", observedAt: 2_000 },
      { url: "https://cdn/1.ts", observedAt: 1_000 },
      { url: "https://cdn/2.ts", observedAt: 2_500 },
      { url: "https://cdn/old.ts", observedAt: -10_000 },
    ],
    3_000,
    5,
  );

  assert.deepEqual(result, [
    { url: "https://cdn/1.ts", observedAt: 1_000 },
    { url: "https://cdn/2.ts", observedAt: 2_000 },
  ]);
});

test("selects the requested rolling window plus the overlapping first segment", () => {
  const segments = Array.from({ length: 60 }, (_, index) => ({
    url: `https://cdn/${index}.ts`,
    observedAt: index * 2_000,
  }));

  const result = selectClipSegments(segments, 90);
  assert.equal(result[0].url, "https://cdn/13.ts");
  assert.equal(result.at(-1).url, "https://cdn/59.ts");
  assert.equal(result.length, 47);
  assert.equal(estimateSegmentSeconds(result), 94);
});

test("creates a filesystem-safe MPEG-TS filename", () => {
  const filename = createClipFilename(
    "Streamer: highlights? | Twitch",
    new Date("2026-08-26T12:34:56.000Z"),
  );

  assert.equal(filename, "Streamer highlights 2026-08-26T12-34-56Z.ts");
});
