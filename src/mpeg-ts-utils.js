const TS_PACKET_BYTES = 188;
const PTS_CLOCK_HZ = 90_000;
const PTS_WRAP_SECONDS = 2 ** 33 / PTS_CLOCK_HZ;

function decodePts(bytes, offset) {
  if (offset + 5 > bytes.length) {
    return null;
  }

  const first = bytes[offset];
  const second = bytes[offset + 1];
  const third = bytes[offset + 2];
  const fourth = bytes[offset + 3];
  const fifth = bytes[offset + 4];
  if ((first & 1) !== 1 || (third & 1) !== 1 || (fifth & 1) !== 1) {
    return null;
  }

  const value =
    (first & 0x0e) * 2 ** 29 +
    second * 2 ** 22 +
    (third & 0xfe) * 2 ** 14 +
    fourth * 2 ** 7 +
    ((fifth & 0xfe) >> 1);
  return value / PTS_CLOCK_HZ;
}

/** Returns the first video PES timestamp in an MPEG-TS segment. */
export function findFirstMpegTsTimestampSeconds(buffer) {
  const bytes = buffer instanceof Uint8Array
    ? buffer
    : new Uint8Array(buffer || 0);
  let audioFallback = null;

  for (let packetStart = 0; packetStart + TS_PACKET_BYTES <= bytes.length;) {
    if (bytes[packetStart] !== 0x47) {
      packetStart += 1;
      continue;
    }

    const payloadUnitStart = (bytes[packetStart + 1] & 0x40) !== 0;
    const adaptationControl = (bytes[packetStart + 3] >> 4) & 0x03;
    const hasPayload = adaptationControl === 1 || adaptationControl === 3;
    let payloadStart = packetStart + 4;
    if (adaptationControl === 3) {
      payloadStart += 1 + bytes[payloadStart];
    }

    const packetEnd = packetStart + TS_PACKET_BYTES;
    if (
      payloadUnitStart &&
      hasPayload &&
      payloadStart + 14 <= packetEnd &&
      bytes[payloadStart] === 0 &&
      bytes[payloadStart + 1] === 0 &&
      bytes[payloadStart + 2] === 1
    ) {
      const streamId = bytes[payloadStart + 3];
      const ptsFlags = (bytes[payloadStart + 7] >> 6) & 0x03;
      if (ptsFlags === 2 || ptsFlags === 3) {
        const timestamp = decodePts(bytes, payloadStart + 9);
        if (timestamp !== null) {
          if (streamId >= 0xe0 && streamId <= 0xef) {
            return timestamp;
          }
          if (audioFallback === null && streamId >= 0xc0 && streamId <= 0xdf) {
            audioFallback = timestamp;
          }
        }
      }
    }

    packetStart += TS_PACKET_BYTES;
  }

  return audioFallback;
}

export function mpegTsTimestampDeltaSeconds(current, previous) {
  let delta = current - previous;
  if (delta < -PTS_WRAP_SECONDS / 2) {
    delta += PTS_WRAP_SECONDS;
  } else if (delta > PTS_WRAP_SECONDS / 2) {
    delta -= PTS_WRAP_SECONDS;
  }
  return delta;
}

/**
 * Keeps only the final contiguous MPEG-TS timestamp run. This is a last-line
 * guard against joining live-edge media with segments requested after a seek.
 */
export function selectLastContiguousMpegTsRun(entries, maxForwardGapSeconds = 30) {
  const timestamped = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry?.buffer) {
      continue;
    }
    const timestampSeconds = findFirstMpegTsTimestampSeconds(entry.buffer);
    if (Number.isFinite(timestampSeconds)) {
      timestamped.push({ ...entry, timestampSeconds });
    }
  }

  if (!timestamped.length) {
    return {
      entries: (Array.isArray(entries) ? entries : []).filter(
        (entry) => entry?.buffer,
      ),
      discardedCount: 0,
      timestampsDetected: false,
    };
  }

  let finalRunStart = 0;
  for (let index = 1; index < timestamped.length; index += 1) {
    const delta = mpegTsTimestampDeltaSeconds(
      timestamped[index].timestampSeconds,
      timestamped[index - 1].timestampSeconds,
    );
    const expectedDuration = timestamped[index - 1].expectedDurationSeconds;
    const allowedForwardGap =
      Number.isFinite(expectedDuration) && expectedDuration > 0
        ? Math.max(4, Math.min(maxForwardGapSeconds, expectedDuration * 3))
        : maxForwardGapSeconds;
    if (delta < -1 || delta > allowedForwardGap) {
      finalRunStart = index;
    }
  }

  const selected = timestamped.slice(finalRunStart);
  const inputCount = (Array.isArray(entries) ? entries : []).filter(
    (entry) => entry?.buffer,
  ).length;
  return {
    entries: selected,
    discardedCount: inputCount - selected.length,
    timestampsDetected: true,
  };
}
