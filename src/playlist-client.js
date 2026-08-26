import { findFirstMpegTsTimestampSeconds } from "./mpeg-ts-utils.js";

const FETCH_ATTEMPTS = 2;
const FETCH_TIMEOUT_MS = 5_000;
const SEGMENT_PROBE_BYTES = 128 * 1024;

async function readResponseBytesWithLimit(response, maxBytes) {
  if (!response.body?.getReader) {
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer.slice(0, maxBytes));
  }

  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;

  try {
    while (byteLength < maxBytes) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = value.subarray(0, maxBytes - byteLength);
      chunks.push(chunk);
      byteLength += chunk.byteLength;
      if (chunk.byteLength < value.byteLength || byteLength >= maxBytes) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readPlaylistText(response, maxBytes) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("Playlist is larger than the safe parsing limit");
  }

  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error("Playlist is larger than the safe parsing limit");
    }
    return text;
  }

  const bytes = await readResponseBytesWithLimit(response, maxBytes + 1);
  if (bytes.byteLength > maxBytes) {
    throw new Error("Playlist is larger than the safe parsing limit");
  }
  return new TextDecoder().decode(bytes);
}

export async function fetchPlaylistText(url, maxBytes) {
  let lastError;

  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        cache: "no-store",
        credentials: "include",
        headers: {
          Accept: "application/vnd.apple.mpegurl, application/x-mpegURL, */*",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = error;
      response = null;
    }

    if (response?.ok) {
      return {
        text: await readPlaylistText(response, maxBytes),
        url: response.url || url,
      };
    }

    if (response) {
      lastError = new Error(
        `Playlist request failed with HTTP ${response.status}`,
      );
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable) {
        throw lastError;
      }
    }

    if (attempt < FETCH_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }

  throw lastError || new Error("Playlist request failed");
}

/** Reads only enough of an unknown TS segment to obtain its first PTS. */
export async function probeMpegTsTimestamp(url) {
  try {
    const response = await fetch(url, {
      cache: "force-cache",
      credentials: "include",
      headers: { Range: `bytes=0-${SEGMENT_PROBE_BYTES - 1}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }

    const bytes = await readResponseBytesWithLimit(
      response,
      SEGMENT_PROBE_BYTES,
    );
    const timestamp = findFirstMpegTsTimestampSeconds(bytes);
    return Number.isFinite(timestamp) ? timestamp : null;
  } catch {
    return null;
  }
}
