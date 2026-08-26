import test from "node:test";
import assert from "node:assert/strict";

import {
  findFirstMpegTsTimestampSeconds,
  selectLastContiguousMpegTsRun,
} from "../src/mpeg-ts-utils.js";

function makeVideoPacket(timestampSeconds) {
  const bytes = new Uint8Array(188).fill(0xff);
  const payload = 4;
  const pts = BigInt(Math.round(timestampSeconds * 90_000));
  bytes[0] = 0x47;
  bytes[1] = 0x40;
  bytes[2] = 0x00;
  bytes[3] = 0x10;
  bytes[payload] = 0x00;
  bytes[payload + 1] = 0x00;
  bytes[payload + 2] = 0x01;
  bytes[payload + 3] = 0xe0;
  bytes[payload + 4] = 0x00;
  bytes[payload + 5] = 0x00;
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

test("reads a video PTS from an MPEG-TS PES packet", () => {
  assert.equal(findFirstMpegTsTimestampSeconds(makeVideoPacket(17_101.15)), 17_101.15);
});

test("keeps only the final timestamp run after a live-to-rewind jump", () => {
  const entries = [100, 102, 104, 20, 22, 24].map((timestamp, index) => ({
    index,
    buffer: makeVideoPacket(timestamp),
  }));

  const result = selectLastContiguousMpegTsRun(entries);

  assert.deepEqual(result.entries.map((entry) => entry.index), [3, 4, 5]);
  assert.equal(result.discardedCount, 3);
  assert.equal(result.timestampsDetected, true);
});

test("preserves buffers when timestamps are unavailable", () => {
  const entries = [
    { index: 0, buffer: new Uint8Array([1, 2, 3]).buffer },
    { index: 1, buffer: new Uint8Array([4, 5, 6]).buffer },
  ];

  const result = selectLastContiguousMpegTsRun(entries);

  assert.deepEqual(result.entries.map((entry) => entry.index), [0, 1]);
  assert.equal(result.discardedCount, 0);
  assert.equal(result.timestampsDetected, false);
});

test("rejects a sparse timestamp jump relative to the playlist duration", () => {
  const entries = [100, 110, 120].map((timestamp, index) => ({
    index,
    buffer: makeVideoPacket(timestamp),
    expectedDurationSeconds: 2,
  }));

  const result = selectLastContiguousMpegTsRun(entries);

  assert.deepEqual(result.entries.map((entry) => entry.index), [2]);
  assert.equal(result.discardedCount, 2);
});
