import { mpegTsTimestampDeltaSeconds } from "./mpeg-ts-utils.js";
import { selectTimedClipSegments } from "./segment-utils.js";
import { getFetchablePlaylistUrl, urlResourceKey } from "./url-utils.js";

const MAX_CAPTURE_SEGMENTS = 600;
const MAX_CONTIGUOUS_SEGMENT_GAP_SECONDS = 30;

function createCaptureId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createMediaIndex(key, url, segments) {
  const byUrl = new Map();
  for (const segment of segments) {
    if (typeof segment.url === "string") {
      byUrl.set(urlResourceKey(segment.url), segment);
    }
  }
  return {
    key,
    url: getFetchablePlaylistUrl(url),
    segments,
    byUrl,
    latestSequence: segments.at(-1)?.sequence,
  };
}

export function mergeMediaIndex(
  previousIndex,
  key,
  url,
  segments,
  maxSegments,
) {
  if (!segments.length) {
    return null;
  }

  const bySequence = new Map(
    (previousIndex?.segments || []).map((segment) => [segment.sequence, segment]),
  );
  for (const segment of segments) {
    bySequence.set(segment.sequence, segment);
  }

  const merged = [...bySequence.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-maxSegments);
  const index = createMediaIndex(key, url, merged);
  const oldestRetainedSequence = merged[0]?.sequence;

  for (const [segmentUrl, segment] of previousIndex?.byUrl || []) {
    if (
      segment.sequence >= oldestRetainedSequence &&
      !index.byUrl.has(segmentUrl)
    ) {
      index.byUrl.set(segmentUrl, segment);
    }
  }
  return index;
}

export function findIndexedSegment(indexes, url) {
  const segmentKey = urlResourceKey(url);
  for (const index of indexes.values()) {
    const segment = index.byUrl.get(segmentKey);
    if (segment) {
      return {
        ...segment,
        url,
        playlistKey: index.key,
        playlistUrl: index.url,
      };
    }
  }
  return null;
}

function mediaDistanceSeconds(index, fromSequence, toSequence) {
  if (
    !index ||
    !Number.isSafeInteger(fromSequence) ||
    !Number.isSafeInteger(toSequence) ||
    toSequence <= fromSequence
  ) {
    return 0;
  }

  return index.segments.reduce((total, segment) => {
    if (
      segment.sequence >= fromSequence &&
      segment.sequence < toSequence &&
      Number.isFinite(segment.durationSeconds)
    ) {
      return total + segment.durationSeconds;
    }
    return total;
  }, 0);
}

export function backwardJumpSeconds(previous, current, index) {
  if (!previous) {
    return 0;
  }
  if (
    Number.isFinite(previous.programStartMs) &&
    Number.isFinite(current.programStartMs)
  ) {
    return Math.max(0, (previous.programStartMs - current.programStartMs) / 1000);
  }
  if (previous.playlistKey !== current.playlistKey) {
    return 0;
  }
  return mediaDistanceSeconds(index, current.sequence, previous.sequence);
}

export function secondsBehindPlaylistEdge(index, segment) {
  if (!index || segment.playlistKey !== index.key) {
    return Number.POSITIVE_INFINITY;
  }
  return mediaDistanceSeconds(
    index,
    segment.sequence + 1,
    index.latestSequence + 1,
  );
}

function toCapturedSegment(segment) {
  return {
    url: segment.url,
    durationSeconds: segment.durationSeconds,
    sequence: segment.sequence,
  };
}

export function createIndexedCapture(segment, observedAt) {
  return {
    id: createCaptureId(),
    mode: "indexed",
    startedAt: observedAt,
    playlistKey: segment.playlistKey,
    playlistUrl: segment.playlistUrl,
    anchorSequence: segment.sequence,
    segments: [toCapturedSegment(segment)],
  };
}

export function getFallbackSegmentDuration(index) {
  const duration = index?.segments.findLast(
    (segment) => Number.isFinite(segment.durationSeconds),
  )?.durationSeconds;
  return Number.isFinite(duration) && duration > 0 ? duration : 2;
}

export function createUnindexedCapture(
  url,
  observedAt,
  durationSeconds,
  mediaTimestampSeconds,
) {
  return {
    id: createCaptureId(),
    mode: "unindexed",
    startedAt: observedAt,
    anchorSequence: 0,
    segments: [{
      url,
      durationSeconds,
      sequence: 0,
      mediaTimestampSeconds,
    }],
  };
}

export function appendUnindexedSegment(
  capture,
  url,
  observedAt,
  durationSeconds,
  mediaTimestampSeconds,
) {
  if (capture.segments.some((segment) => segment.url === url)) {
    return capture;
  }

  const previousTimestampIndex = capture.segments.findLastIndex(
    (segment) => Number.isFinite(segment.mediaTimestampSeconds),
  );
  const previousTimestampSegment = capture.segments[previousTimestampIndex];
  const timestampDelta =
    previousTimestampSegment && Number.isFinite(mediaTimestampSeconds)
      ? mpegTsTimestampDeltaSeconds(
          mediaTimestampSeconds,
          previousTimestampSegment.mediaTimestampSeconds,
        )
      : null;

  if (
    Number.isFinite(timestampDelta) &&
    (timestampDelta < -1 ||
      timestampDelta > MAX_CONTIGUOUS_SEGMENT_GAP_SECONDS)
  ) {
    return createUnindexedCapture(
      url,
      observedAt,
      durationSeconds,
      mediaTimestampSeconds,
    );
  }

  const segments = capture.segments.map((segment) => ({ ...segment }));
  let measuredDuration = durationSeconds;
  if (Number.isFinite(timestampDelta) && timestampDelta > 0.1) {
    segments[previousTimestampIndex].durationSeconds = timestampDelta;
    measuredDuration = timestampDelta;
  }

  const nextSequence =
    Math.max(-1, ...segments.map((segment) => segment.sequence)) + 1;
  return {
    ...capture,
    segments: [
      ...segments,
      {
        url,
        durationSeconds: measuredDuration,
        sequence: nextSequence,
        mediaTimestampSeconds,
      },
    ].slice(-MAX_CAPTURE_SEGMENTS),
  };
}

export function appendIndexedSegment(capture, segment) {
  const bySequence = new Map(
    capture.segments.map((candidate) => [candidate.sequence, candidate]),
  );
  bySequence.set(segment.sequence, toCapturedSegment(segment));
  return {
    ...capture,
    segments: [...bySequence.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .slice(-MAX_CAPTURE_SEGMENTS),
  };
}

export function selectRewindWindow(
  indexedSegments,
  capture,
  clipSeconds,
  now = Date.now(),
) {
  const bySequence = new Map(
    (capture.mode === "unindexed" ? [] : indexedSegments).map(
      (segment) => [segment.sequence, segment],
    ),
  );
  for (const segment of capture.segments) {
    bySequence.set(segment.sequence, segment);
  }

  const timeline = [...bySequence.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const elapsedSeconds = Math.max(0, (now - capture.startedAt) / 1000);
  return selectTimedClipSegments(
    timeline,
    capture.anchorSequence,
    elapsedSeconds,
    clipSeconds,
  );
}
