const FETCH_CONCURRENCY = 4;
const FETCH_ATTEMPTS = 2;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") {
    return false;
  }

  if (message.type === "release-object-url") {
    const delayMs = Math.max(0, Number(message.delayMs) || 0);
    setTimeout(() => URL.revokeObjectURL(message.objectUrl), delayMs);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "merge-and-download") {
    mergeSegments(message)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return true;
  }

  return false;
});

async function mergeSegments({ tabId, segments }) {
  if (!Array.isArray(segments) || !segments.length) {
    throw new Error("No stream segments were supplied");
  }

  const buffers = new Array(segments.length);
  const failed = [];
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (nextIndex < segments.length) {
      const index = nextIndex;
      nextIndex += 1;

      try {
        buffers[index] = await fetchSegment(segments[index].url);
      } catch (error) {
        failed.push({
          index,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        completed += 1;
        void chrome.runtime
          .sendMessage({
            target: "service-worker",
            type: "clip-progress",
            tabId,
            completed,
            total: segments.length,
          })
          .catch(() => undefined);
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(FETCH_CONCURRENCY, segments.length) },
      () => worker(),
    ),
  );

  const availableBuffers = buffers.filter(Boolean);
  if (!availableBuffers.length) {
    throw new Error("The stream CDN no longer made those segments available");
  }

  if (failed.length > Math.max(2, Math.floor(segments.length * 0.25))) {
    throw new Error(`Too many stream segments were unavailable (${failed.length}/${segments.length})`);
  }

  const clipBlob = new Blob(availableBuffers, { type: "video/mp2t" });
  const objectUrl = URL.createObjectURL(clipBlob);

  return {
    ok: true,
    objectUrl,
    failedCount: failed.length,
    byteLength: clipBlob.size,
  };
}

async function fetchSegment(url) {
  let lastError;

  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        cache: "force-cache",
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const buffer = await response.arrayBuffer();
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
