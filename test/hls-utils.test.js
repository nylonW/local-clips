import test from "node:test";
import assert from "node:assert/strict";

import {
  isHlsPlaylistUrl,
  parseHlsMediaPlaylist,
} from "../src/hls-utils.js";

test("recognizes HLS playlists with query strings", () => {
  assert.equal(isHlsPlaylistUrl("https://cdn.test/live/index.m3u8?token=abc"), true);
  assert.equal(isHlsPlaylistUrl("https://cdn.test/live/INDEX.M3U8"), true);
  assert.equal(isHlsPlaylistUrl("https://cdn.test/live/segment.ts"), false);
});

test("parses relative TS segments and anchors an undated playlist at fetch time", () => {
  const result = parseHlsMediaPlaylist(
    `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:100
#EXTINF:6.0,
100.ts?token=abc
#EXTINF:6.0,
101.ts?token=abc
#EXTINF:6.0,
102.ts?token=abc`,
    "https://cdn.test/channel/index.m3u8?token=abc",
    100_000,
  );

  assert.deepEqual(result, [
    { url: "https://cdn.test/channel/100.ts?token=abc", observedAt: 88_000 },
    { url: "https://cdn.test/channel/101.ts?token=abc", observedAt: 94_000 },
    { url: "https://cdn.test/channel/102.ts?token=abc", observedAt: 100_000 },
  ]);
});

test("uses program date-time and propagates it across following segments", () => {
  const result = parseHlsMediaPlaylist(
    `#EXTM3U
#EXT-X-PROGRAM-DATE-TIME:2026-08-26T12:00:00.000Z
#EXTINF:2.5,
first.ts
#EXTINF:2.5,
second.ts`,
    "https://cdn.test/live/index.m3u8",
    Date.parse("2026-08-26T12:00:10.000Z"),
  );

  assert.deepEqual(result, [
    {
      url: "https://cdn.test/live/first.ts",
      observedAt: Date.parse("2026-08-26T12:00:02.500Z"),
    },
    {
      url: "https://cdn.test/live/second.ts",
      observedAt: Date.parse("2026-08-26T12:00:05.000Z"),
    },
  ]);
});

test("ignores master playlists and completed VOD playlists", () => {
  const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=3000000
720p/index.m3u8`;
  const vod = `#EXTM3U
#EXTINF:6,
one.ts
#EXT-X-ENDLIST`;

  assert.deepEqual(
    parseHlsMediaPlaylist(master, "https://cdn.test/master.m3u8", 100_000),
    [],
  );
  assert.deepEqual(
    parseHlsMediaPlaylist(vod, "https://cdn.test/vod.m3u8", 100_000),
    [],
  );
});

test("skips encrypted, byte-range, gap, and fMP4 media", () => {
  const unsafeTs = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:6,
encrypted.ts
#EXT-X-KEY:METHOD=NONE
#EXT-X-BYTERANGE:1000@0
#EXTINF:6,
range.ts
#EXT-X-GAP
#EXTINF:6,
gap.ts
#EXTINF:6,
safe.ts`;
  const fmp4 = `#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6,
one.m4s`;

  assert.deepEqual(
    parseHlsMediaPlaylist(unsafeTs, "https://cdn.test/index.m3u8", 100_000),
    [{ url: "https://cdn.test/safe.ts", observedAt: 100_000 }],
  );
  assert.deepEqual(
    parseHlsMediaPlaylist(fmp4, "https://cdn.test/index.m3u8", 100_000),
    [],
  );
});
