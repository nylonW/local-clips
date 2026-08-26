import test from "node:test";
import assert from "node:assert/strict";

import {
  appendUnindexedSegment,
  createIndexedCapture,
  createUnindexedCapture,
  findIndexedSegment,
  mergeMediaIndex,
  selectRewindWindow,
} from "../src/kick-rewind.js";

test("retains old URL aliases when a playlist finalizes a sequence", () => {
  const first = mergeMediaIndex(
    null,
    "playlist",
    "https://cdn.test/playlist.m3u8",
    [{ url: "https://cdn.test/prefetch/1.ts", sequence: 1, durationSeconds: 2 }],
    100,
  );
  const updated = mergeMediaIndex(
    first,
    "playlist",
    "https://cdn.test/playlist.m3u8",
    [{ url: "https://cdn.test/media/1.ts", sequence: 1, durationSeconds: 2 }],
    100,
  );

  assert.equal(
    findIndexedSegment(new Map([["playlist", updated]]), "https://cdn.test/prefetch/1.ts")?.sequence,
    1,
  );
  assert.equal(
    findIndexedSegment(new Map([["playlist", updated]]), "https://cdn.test/media/1.ts")?.sequence,
    1,
  );
});

test("uses measured MPEG-TS spacing for unindexed archive segments", () => {
  const capture = createUnindexedCapture("https://cdn.test/0.ts", 1_000, 2, 100);
  const next = appendUnindexedSegment(
    capture,
    "https://cdn.test/1.ts",
    2_000,
    2,
    110,
  );

  assert.deepEqual(
    next.segments.map((segment) => segment.durationSeconds),
    [10, 10],
  );

  const restarted = appendUnindexedSegment(
    next,
    "https://cdn.test/rewound-again.ts",
    3_000,
    2,
    50,
  );
  assert.equal(restarted.segments.length, 1);
  assert.equal(restarted.startedAt, 3_000);
});

test("selects the configured archive window around the rewind anchor", () => {
  const indexed = Array.from({ length: 6 }, (_, sequence) => ({
    url: `https://cdn.test/${sequence}.ts`,
    sequence,
    durationSeconds: 10,
  }));
  const anchor = {
    ...indexed[3],
    playlistKey: "playlist",
    playlistUrl: "https://cdn.test/playlist.m3u8",
  };
  const capture = createIndexedCapture(anchor, 1_000);

  assert.deepEqual(
    selectRewindWindow(indexed, capture, 30, 1_000).map(
      (segment) => segment.sequence,
    ),
    [1, 2, 3],
  );
});
