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

  return segments.map((segment, index) => ({
    url: segment.url,
    observedAt: starts[index] + segment.durationSeconds * 1000,
  }));
}

/**
 * Parses only directly concatenable media segments from a live HLS playlist.
 * Master playlists, completed VODs, fMP4, encrypted segments, gaps, and
 * byte-range media are intentionally ignored so playlist prefill cannot make
 * the existing MPEG-TS clip path less reliable.
 */
export function parseHlsMediaPlaylist(text, playlistUrl, fetchedAt = Date.now()) {
  if (
    typeof text !== "string" ||
    !text.trimStart().startsWith("#EXTM3U") ||
    !Number.isFinite(fetchedAt)
  ) {
    return [];
  }

  const lines = text.split(/\r?\n/).map((line) => line.trim());
  if (
    lines.some(
      (line) =>
        line === "#EXT-X-ENDLIST" ||
        line.toUpperCase() === "#EXT-X-PLAYLIST-TYPE:VOD" ||
        line.toUpperCase().startsWith("#EXT-X-MAP:"),
    )
  ) {
    return [];
  }

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
      try {
        const url = new URL(line, playlistUrl).href;
        if (!encrypted && !hasByteRange && !isGap && isPotentialTransportStreamUrl(url)) {
          segments.push({
            url,
            durationSeconds,
            programDateTime,
          });
        }
      } catch {
        // Ignore malformed media URIs without rejecting the entire playlist.
      }
    }

    durationSeconds = null;
    programDateTime = null;
    hasByteRange = false;
    isGap = false;
  }

  return assignTimeline(segments, fetchedAt);
}
