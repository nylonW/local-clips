const KNOWN_NON_TS_EXTENSIONS = new Set([
  ".aac",
  ".cmfa",
  ".cmfv",
  ".m4a",
  ".m4s",
  ".mp4",
  ".vtt",
  ".webvtt",
]);

export function isHlsPlaylistUrl(value) {
  try {
    return new URL(value).pathname.toLowerCase().endsWith(".m3u8");
  } catch {
    return false;
  }
}

function getPathExtension(value) {
  try {
    const pathname = new URL(value).pathname.toLowerCase();
    const lastSlash = pathname.lastIndexOf("/");
    const lastDot = pathname.lastIndexOf(".");
    return lastDot > lastSlash ? pathname.slice(lastDot) : "";
  } catch {
    return "";
  }
}

function isPotentialTransportStreamUrl(value) {
  return !KNOWN_NON_TS_EXTENSIONS.has(getPathExtension(value));
}

function isValidMediaPlaylist(text, fetchedAt) {
  if (
    typeof text !== "string" ||
    !text.trimStart().startsWith("#EXTM3U") ||
    (fetchedAt !== undefined && !Number.isFinite(fetchedAt))
  ) {
    return false;
  }

  const upperText = text.toUpperCase();
  return !(
    /(?:^|\n)\s*#EXT-X-ENDLIST\s*(?:\n|$)/.test(upperText) ||
    /(?:^|\n)\s*#EXT-X-PLAYLIST-TYPE:VOD\s*(?:\n|$)/.test(upperText) ||
    /(?:^|\n)\s*#EXT-X-MAP:/.test(upperText)
  );
}

function parseAttributeList(value) {
  const attributes = new Map();
  const pattern = /(?:^|,)([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/gi;
  let match;

  while ((match = pattern.exec(value)) !== null) {
    attributes.set(match[1].toUpperCase(), match[2].replace(/^"|"$/g, ""));
  }

  return attributes;
}

function assignTimeline(segments, fetchedAt) {
  if (!segments.length) {
    return [];
  }

  const starts = segments.map((segment) => {
    const parsed = Date.parse(segment.programDateTime || "");
    return Number.isFinite(parsed) ? parsed : null;
  });

  for (let index = 1; index < starts.length; index += 1) {
    if (starts[index] === null && starts[index - 1] !== null) {
      starts[index] = starts[index - 1] + segments[index - 1].durationSeconds * 1000;
    }
  }

  for (let index = starts.length - 2; index >= 0; index -= 1) {
    if (starts[index] === null && starts[index + 1] !== null) {
      starts[index] = starts[index + 1] - segments[index].durationSeconds * 1000;
    }
  }

  if (starts.every((start) => start === null)) {
    let cursor = fetchedAt;
    for (let index = starts.length - 1; index >= 0; index -= 1) {
      starts[index] = cursor - segments[index].durationSeconds * 1000;
      cursor = starts[index];
    }
  }

  return segments
    .map((segment, index) => ({
      url: segment.url,
      observedAt: starts[index] + segment.durationSeconds * 1000,
    }))
    .filter((segment) => typeof segment.url === "string");
}

/**
 * Parses only directly concatenable media segments from a live HLS playlist.
 * Master playlists, completed VODs, fMP4, encrypted segments, gaps, and
 * byte-range media are intentionally ignored so playlist prefill cannot make
 * the existing MPEG-TS clip path less reliable.
 */
export function parseHlsMediaTimeline(text, playlistUrl) {
  if (!isValidMediaPlaylist(text)) {
    return [];
  }

  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const segments = [];
  let durationSeconds = null;
  let programDateTime = null;
  let encrypted = false;
  let hasByteRange = false;
  let isGap = false;

  for (const line of lines) {
    if (!line) {
      continue;
    }

    if (line.toUpperCase().startsWith("#EXTINF:")) {
      const value = line.slice(line.indexOf(":") + 1).split(",", 1)[0];
      const parsed = Number.parseFloat(value);
      durationSeconds = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      continue;
    }

    if (line.toUpperCase().startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      programDateTime = line.slice(line.indexOf(":") + 1).trim();
      continue;
    }

    if (line.toUpperCase().startsWith("#EXT-X-KEY:")) {
      const attributes = parseAttributeList(line.slice(line.indexOf(":") + 1));
      encrypted = (attributes.get("METHOD") || "NONE").toUpperCase() !== "NONE";
      continue;
    }

    if (line.toUpperCase().startsWith("#EXT-X-BYTERANGE:")) {
      hasByteRange = true;
      continue;
    }

    if (line.toUpperCase() === "#EXT-X-GAP") {
      isGap = true;
      continue;
    }

    if (line.startsWith("#")) {
      continue;
    }

    if (durationSeconds !== null) {
      let url = null;
      try {
        const resolvedUrl = new URL(line, playlistUrl).href;
        if (
          !encrypted &&
          !hasByteRange &&
          !isGap &&
          isPotentialTransportStreamUrl(resolvedUrl)
        ) {
          url = resolvedUrl;
        }
      } catch {
        // Preserve the duration so playback mapping remains accurate, but mark
        // malformed media as unavailable.
      }

      segments.push({
        url,
        durationSeconds,
        programDateTime,
      });
    }

    durationSeconds = null;
    programDateTime = null;
    hasByteRange = false;
    isGap = false;
  }

  return segments;
}

export function parseHlsMediaSegments(text, playlistUrl) {
  return parseHlsMediaTimeline(text, playlistUrl).filter(
    (segment) => typeof segment.url === "string",
  );
}

/**
 * Adds stable HLS media-sequence numbers and real media durations to a parsed
 * playlist. Sequence numbers let the service worker recognize a backwards
 * request jump without reading a site's player controls.
 */
export function parseHlsMediaIndex(text, playlistUrl) {
  const timeline = parseHlsMediaTimeline(text, playlistUrl);
  if (!timeline.length) {
    return [];
  }

  const mediaSequenceMatch = text.match(
    /(?:^|\n)\s*#EXT-X-MEDIA-SEQUENCE:\s*(\d+)\s*(?:\n|$)/i,
  );
  const parsedMediaSequence = mediaSequenceMatch
    ? Number.parseInt(mediaSequenceMatch[1], 10)
    : 0;
  const firstSequence = Number.isSafeInteger(parsedMediaSequence)
    ? parsedMediaSequence
    : 0;
  const targetDurationMatch = text.match(
    /(?:^|\n)\s*#EXT-X-TARGETDURATION:\s*([\d.]+)\s*(?:\n|$)/i,
  );
  const parsedTargetDuration = targetDurationMatch
    ? Number.parseFloat(targetDurationMatch[1])
    : null;

  let relativeStartSeconds = 0;
  let programStartMs = null;

  const indexedSegments = timeline.map((segment, index) => {
    const explicitProgramStartMs = Date.parse(segment.programDateTime || "");
    if (Number.isFinite(explicitProgramStartMs)) {
      programStartMs = explicitProgramStartMs;
    }

    const indexed = {
      ...segment,
      sequence: firstSequence + index,
      relativeStartSeconds,
      relativeEndSeconds: relativeStartSeconds + segment.durationSeconds,
      programStartMs,
    };

    relativeStartSeconds = indexed.relativeEndSeconds;
    if (programStartMs !== null) {
      programStartMs += segment.durationSeconds * 1000;
    }
    return indexed;
  });

  const fallbackDuration =
    timeline.at(-1)?.durationSeconds ||
    (Number.isFinite(parsedTargetDuration) && parsedTargetDuration > 0
      ? parsedTargetDuration
      : null);
  if (!fallbackDuration) {
    return indexedSegments;
  }

  const prefetchLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.toUpperCase().startsWith("#EXT-X-PREFETCH:"));
  for (const line of prefetchLines) {
    try {
      const url = new URL(line.slice(line.indexOf(":") + 1).trim(), playlistUrl).href;
      if (!isPotentialTransportStreamUrl(url)) {
        continue;
      }
      indexedSegments.push({
        url,
        durationSeconds: fallbackDuration,
        programDateTime: null,
        sequence: firstSequence + indexedSegments.length,
        relativeStartSeconds,
        relativeEndSeconds: relativeStartSeconds + fallbackDuration,
        programStartMs,
        prefetch: true,
      });
      relativeStartSeconds += fallbackDuration;
      if (programStartMs !== null) {
        programStartMs += fallbackDuration * 1000;
      }
    } catch {
      // Ignore malformed prefetch URIs without rejecting the media index.
    }
  }

  return indexedSegments;
}

export function parseHlsMediaPlaylist(text, playlistUrl, fetchedAt = Date.now()) {
  if (!isValidMediaPlaylist(text, fetchedAt)) {
    return [];
  }

  return assignTimeline(parseHlsMediaTimeline(text, playlistUrl), fetchedAt);
}
