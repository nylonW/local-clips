const FETCH_ATTEMPTS = 2;

function normalizeByteRange(value) {
  if (!value) {
    return null;
  }

  const offset = Number(value.offset);
  const length = Number(value.length);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length <= 0 ||
    !Number.isSafeInteger(offset + length)
  ) {
    throw new Error("Invalid MPEG-TS byte range");
  }
  return { offset, length, end: offset + length - 1 };
}

function selectRequestedBytes(buffer, response, byteRange) {
  if (!byteRange) {
    return buffer;
  }

  if (response.status === 206) {
    if (buffer.byteLength < byteRange.length) {
      throw new Error("Incomplete byte-range response");
    }
    return buffer.slice(0, byteRange.length);
  }

  if (buffer.byteLength <= byteRange.end) {
    throw new Error("The CDN ignored the byte range and returned incomplete media");
  }
  return buffer.slice(byteRange.offset, byteRange.end + 1);
}

export async function fetchSegment(segment) {
  const url = segment?.url;
  if (typeof url !== "string") {
    throw new Error("Missing MPEG-TS segment URL");
  }

  const byteRange = normalizeByteRange(segment.byteRange);
  let lastError;

  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        cache: "force-cache",
        credentials: "include",
        ...(byteRange
          ? { headers: { Range: `bytes=${byteRange.offset}-${byteRange.end}` } }
          : {}),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const buffer = selectRequestedBytes(
        await response.arrayBuffer(),
        response,
        byteRange,
      );
      if (!buffer.byteLength) {
        throw new Error("Empty response");
      }
      return buffer;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Unable to fetch ${new URL(url).pathname.split("/").at(-1)}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}
