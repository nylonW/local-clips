export const DEFAULT_CLIP_SECONDS = 90;
export const MIN_CLIP_SECONDS = 15;
export const MAX_CLIP_SECONDS = 300;
export const BUFFER_MARGIN_SECONDS = 30;

const SUPPORTED_PAGE_HOSTS = [
  "twitch.tv",
  "kick.com",
];

/**
 * Returns true only for Twitch and Kick pages. CDN URLs are intentionally not
 * accepted here; this function identifies the page that initiated a request.
 */
export function isSupportedPageUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return SUPPORTED_PAGE_HOSTS.some(
      (host) => hostname === host || hostname.endsWith(`.${host}`),
    );
  } catch {
    return false;
  }
}

/**
 * Twitch and Kick currently deliver their normal HLS media as MPEG-TS files.
 * Query strings and mixed-case suffixes are supported.
 */
export function isTransportStreamUrl(value) {
  try {
    return new URL(value).pathname.toLowerCase().endsWith(".ts");
  } catch {
    return false;
  }
}

export function clampClipSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return DEFAULT_CLIP_SECONDS;
  }

  return Math.min(MAX_CLIP_SECONDS, Math.max(MIN_CLIP_SECONDS, Math.round(number)));
}

export function sortAndDedupeSegments(segments) {
  const byUrl = new Map();

  for (const segment of Array.isArray(segments) ? segments : []) {
    if (
      !segment ||
      typeof segment.url !== "string" ||
      !Number.isFinite(segment.observedAt)
    ) {
      continue;
    }

    const existing = byUrl.get(segment.url);
    if (!existing || segment.observedAt < existing.observedAt) {
      byUrl.set(segment.url, {
        url: segment.url,
        observedAt: segment.observedAt,
      });
    }
  }

  return [...byUrl.values()].sort((a, b) => a.observedAt - b.observedAt);
}

export function pruneSegments(segments, now, retentionSeconds) {
  const cutoff = now - Math.max(1, retentionSeconds) * 1000;
  return sortAndDedupeSegments(segments).filter(
    (segment) => segment.observedAt >= cutoff,
  );
}

function median(values) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function estimateSegmentSeconds(segments) {
  const sorted = sortAndDedupeSegments(segments);
  if (sorted.length < 2) {
    return sorted.length ? 2 : 0;
  }

  const gaps = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const gapSeconds = (sorted[index].observedAt - sorted[index - 1].observedAt) / 1000;
    if (gapSeconds > 0.1 && gapSeconds < 15) {
      gaps.push(gapSeconds);
    }
  }

  const typicalSegmentSeconds = Math.min(10, Math.max(1, median(gaps) || 2));
  const elapsedSeconds =
    (sorted.at(-1).observedAt - sorted[0].observedAt) / 1000;

  return Math.max(0, Math.round(elapsedSeconds + typicalSegmentSeconds));
}

/**
 * Includes the segment immediately before the cutoff because its media usually
 * overlaps the exact requested boundary.
 */
export function selectClipSegments(segments, clipSeconds) {
  const sorted = sortAndDedupeSegments(segments);
  if (!sorted.length) {
    return [];
  }

  const duration = clampClipSeconds(clipSeconds);
  const latestObservedAt = sorted.at(-1).observedAt;
  const cutoff = latestObservedAt - duration * 1000;
  let firstIndex = sorted.findIndex((segment) => segment.observedAt >= cutoff);

  if (firstIndex < 0) {
    firstIndex = 0;
  } else if (firstIndex > 0) {
    firstIndex -= 1;
  }

  return sorted.slice(firstIndex);
}

function sortTimedSegments(segments) {
  const bySequence = new Map();

  for (const segment of Array.isArray(segments) ? segments : []) {
    if (
      !segment ||
      !Number.isSafeInteger(segment.sequence) ||
      !Number.isFinite(segment.durationSeconds) ||
      segment.durationSeconds <= 0
    ) {
      continue;
    }

    const existing = bySequence.get(segment.sequence);
    if (
      !existing ||
      (typeof existing.url !== "string" && typeof segment.url === "string")
    ) {
      bySequence.set(segment.sequence, { ...segment });
    }
  }

  return [...bySequence.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
}

/**
 * Selects a clip around a network-derived HLS rewind anchor. The first older
 * segment request is the anchor; elapsed wall time advances through the real
 * EXTINF durations, so segments prefetched by the player are not counted as
 * already watched.
 */
export function selectTimedClipSegments(
  segments,
  anchorSequence,
  elapsedSeconds,
  clipSeconds,
) {
  const ordered = sortTimedSegments(segments);
  const anchorIndex = ordered.findIndex(
    (segment) => segment.sequence === anchorSequence,
  );
  if (
    anchorIndex < 0 ||
    !Number.isFinite(elapsedSeconds) ||
    elapsedSeconds < 0
  ) {
    return [];
  }

  let endIndex = anchorIndex;
  let remainingElapsed = elapsedSeconds;
  while (
    endIndex < ordered.length - 1 &&
    ordered[endIndex + 1].sequence === ordered[endIndex].sequence + 1 &&
    remainingElapsed >= ordered[endIndex].durationSeconds
  ) {
    remainingElapsed -= ordered[endIndex].durationSeconds;
    endIndex += 1;
  }

  const wantedSeconds = clampClipSeconds(clipSeconds);
  let startIndex = endIndex;
  let selectedSeconds = ordered[startIndex].durationSeconds;
  while (
    startIndex > 0 &&
    selectedSeconds < wantedSeconds &&
    ordered[startIndex - 1].sequence === ordered[startIndex].sequence - 1
  ) {
    startIndex -= 1;
    selectedSeconds += ordered[startIndex].durationSeconds;
  }

  const selected = ordered.slice(startIndex, endIndex + 1);
  return selected.every((segment) => typeof segment.url === "string")
    ? selected
    : [];
}

export function sumMediaDuration(segments) {
  return (Array.isArray(segments) ? segments : []).reduce(
    (total, segment) =>
      total +
      (Number.isFinite(segment?.durationSeconds) && segment.durationSeconds > 0
        ? segment.durationSeconds
        : 0),
    0,
  );
}

export function createClipFilename(pageTitle, date = new Date()) {
  const cleanTitle = String(pageTitle || "livestream")
    .replace(/\s*[|\-–—]\s*(Twitch|Kick)\s*$/i, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 70) || "livestream";

  const timestamp = date
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/:/g, "-");

  return `${cleanTitle} ${timestamp}.ts`;
}
