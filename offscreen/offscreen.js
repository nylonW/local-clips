import { selectLastContiguousMpegTsRun } from "../src/mpeg-ts-utils.js";
import { fetchSegment } from "../src/segment-client.js";

const FETCH_CONCURRENCY = 4;

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

async function mergeSegments({ tabId, segments, completePlaylist = false }) {
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
        buffers[index] = await fetchSegment(segments[index]);
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

  const availableEntries = buffers
    .map((buffer, index) => ({
      buffer,
      index,
      expectedDurationSeconds: segments[index]?.durationSeconds,
    }))
    .filter((entry) => entry.buffer);
  if (!availableEntries.length) {
    throw new Error("The stream CDN no longer made those segments available");
  }

  if (completePlaylist && failed.length) {
    throw new Error(
      `The complete clip could not be downloaded (${failed.length}/${segments.length} playlist ranges unavailable)`,
    );
  }

  if (failed.length > Math.max(2, Math.floor(segments.length * 0.25))) {
    throw new Error(`Too many stream segments were unavailable (${failed.length}/${segments.length})`);
  }

  const contiguous = completePlaylist
    ? { entries: availableEntries, discardedCount: 0 }
    : selectLastContiguousMpegTsRun(availableEntries);
  if (!contiguous.entries.length) {
    throw new Error("No contiguous MPEG-TS timestamp window was available");
  }

  const clipBlob = new Blob(
    contiguous.entries.map((entry) => entry.buffer),
    { type: "video/mp2t" },
  );
  const objectUrl = URL.createObjectURL(clipBlob);

  return {
    ok: true,
    objectUrl,
    failedCount: failed.length + contiguous.discardedCount,
    discardedCount: contiguous.discardedCount,
    byteLength: clipBlob.size,
  };
}
