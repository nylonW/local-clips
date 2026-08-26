import test from "node:test";
import assert from "node:assert/strict";

import {
  isHlsPlaylistUrl,
  parseHlsClipPlaylist,
  parseHlsMediaIndex,
  parseHlsMediaPlaylist,
  parseHlsMediaTimeline,
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

test("keeps HLS durations for network-derived media selection", () => {
  const result = parseHlsMediaTimeline(
    `#EXTM3U
#EXT-X-PLAYLIST-TYPE:EVENT
#EXTINF:4.5,
10.ts
#EXTINF:5.5,
11.ts`,
    "https://cdn.test/live/index.m3u8",
  );

  assert.deepEqual(result, [
    {
      url: "https://cdn.test/live/10.ts",
      durationSeconds: 4.5,
      programDateTime: null,
    },
    {
      url: "https://cdn.test/live/11.ts",
      durationSeconds: 5.5,
      programDateTime: null,
    },
  ]);
});

test("indexes media sequences and propagates program timestamps", () => {
  const result = parseHlsMediaIndex(
    `#EXTM3U
#EXT-X-MEDIA-SEQUENCE:700
#EXT-X-PROGRAM-DATE-TIME:2026-08-26T12:00:00.000Z
#EXTINF:5.5,
700.ts
#EXTINF:6.25,
701.ts`,
    "https://cdn.test/live/index.m3u8",
  );

  assert.deepEqual(
    result.map((segment) => ({
      sequence: segment.sequence,
      durationSeconds: segment.durationSeconds,
      programStartMs: segment.programStartMs,
    })),
    [
      {
        sequence: 700,
        durationSeconds: 5.5,
        programStartMs: Date.parse("2026-08-26T12:00:00.000Z"),
      },
      {
        sequence: 701,
        durationSeconds: 6.25,
        programStartMs: Date.parse("2026-08-26T12:00:05.500Z"),
      },
    ],
  );
});

test("indexes Kick IVS prefetch segments without adding them to clip prefill", () => {
  const playlist = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-PROGRAM-DATE-TIME:2026-08-26T12:00:00.000Z
#EXTINF:2,live
100.ts
#EXT-X-PREFETCH:101.ts?token=fresh
#EXT-X-PREFETCH:102.ts?token=fresh`;

  const indexed = parseHlsMediaIndex(
    playlist,
    "https://cdn.test/live/index.m3u8",
  );
  const prefilled = parseHlsMediaPlaylist(
    playlist,
    "https://cdn.test/live/index.m3u8",
    100_000,
  );

  assert.deepEqual(
    indexed.map((segment) => ({
      sequence: segment.sequence,
      durationSeconds: segment.durationSeconds,
      prefetch: Boolean(segment.prefetch),
    })),
    [
      { sequence: 100, durationSeconds: 2, prefetch: false },
      { sequence: 101, durationSeconds: 2, prefetch: true },
      { sequence: 102, durationSeconds: 2, prefetch: true },
    ],
  );
  assert.deepEqual(prefilled, [
    {
      url: "https://cdn.test/live/100.ts",
      observedAt: Date.parse("2026-08-26T12:00:02.000Z"),
    },
  ]);
});

test("preserves unavailable durations for safe media-window selection", () => {
  const timeline = parseHlsMediaTimeline(
    `#EXTM3U
#EXTINF:10,
0.ts
#EXT-X-GAP
#EXTINF:10,
1.ts
#EXTINF:10,
2.ts`,
    "https://cdn.test/live/index.m3u8",
  );

  assert.equal(timeline.length, 3);
  assert.equal(timeline[1].url, null);
  assert.equal(timeline[1].durationSeconds, 10);
});

test("parses completed Kick clip byte ranges in playlist order", () => {
  const result = parseHlsClipPlaylist(
    `#EXTM3U
#EXT-X-TARGETDURATION:5
#EXT-X-BYTERANGE:4407096@0
#EXTINF:4.167,
656.ts
#EXT-X-BYTERANGE:4443756
#EXTINF:4.166,
656.ts
#EXT-X-BYTERANGE:4459924@0
#EXTINF:4.167,
657.ts
#EXT-X-ENDLIST`,
    "https://clips.kick.com/clips/cf/playlist.m3u8",
  );

  assert.deepEqual(result, [
    {
      url: "https://clips.kick.com/clips/cf/656.ts",
      durationSeconds: 4.167,
      byteRange: { offset: 0, length: 4_407_096 },
    },
    {
      url: "https://clips.kick.com/clips/cf/656.ts",
      durationSeconds: 4.166,
      byteRange: { offset: 4_407_096, length: 4_443_756 },
    },
    {
      url: "https://clips.kick.com/clips/cf/657.ts",
      durationSeconds: 4.167,
      byteRange: { offset: 0, length: 4_459_924 },
    },
  ]);
});

test("rejects live, encrypted, and malformed clip playlists", () => {
  assert.deepEqual(
    parseHlsClipPlaylist(
      "#EXTM3U\n#EXTINF:4,\n0.ts",
      "https://clips.kick.com/playlist.m3u8",
    ),
    [],
  );
  assert.deepEqual(
    parseHlsClipPlaylist(
      "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128\n#EXTINF:4,\n0.ts\n#EXT-X-ENDLIST",
      "https://clips.kick.com/playlist.m3u8",
    ),
    [],
  );
  assert.deepEqual(
    parseHlsClipPlaylist(
      "#EXTM3U\n#EXT-X-BYTERANGE:100\n#EXTINF:4,\n0.ts\n#EXT-X-ENDLIST",
      "https://clips.kick.com/playlist.m3u8",
    ),
    [],
  );
});
