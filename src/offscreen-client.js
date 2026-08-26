let creatingOffscreenDocument = null;

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL("offscreen/offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl],
  });

  if (contexts.length) {
    return;
  }

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen
      .createDocument({
        url: "offscreen/offscreen.html",
        reasons: ["BLOBS"],
        justification: "Merge recently requested MPEG-TS stream segments into one downloadable video blob.",
      })
      .finally(() => {
        creatingOffscreenDocument = null;
      });
  }

  await creatingOffscreenDocument;
}

export async function mergeSegmentsOffscreen(
  tabId,
  segments,
  { completePlaylist = false } = {},
) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({
    target: "offscreen",
    type: "merge-and-download",
    tabId,
    segments,
    completePlaylist,
  });
}

export async function releaseObjectUrl(objectUrl, delayMs) {
  await chrome.runtime
    .sendMessage({
      target: "offscreen",
      type: "release-object-url",
      objectUrl,
      delayMs,
    })
    .catch(() => undefined);
}
