import {
  BUFFER_MARGIN_SECONDS,
  DEFAULT_CLIP_SECONDS,
  MAX_CLIP_SECONDS,
  clampClipSeconds,
  createClipFilename,
  estimateSegmentSeconds,
  isSupportedPageUrl,
  isTransportStreamUrl,
  pruneSegments,
  selectClipSegments,
} from "./segment-utils.js";
import {
  isHlsPlaylistUrl,
  parseHlsMediaPlaylist,
} from "./hls-utils.js";

const STORAGE_PREFIX = "segments-for-tab-";
const PLAYLIST_FETCH_ATTEMPTS = 2;
const PLAYLIST_FETCH_TIMEOUT_MS = 5_000;
const PLAYLIST_RETRY_DELAY_MS = 5_000;
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const segmentCache = new Map();
const tabQueues = new Map();
const knownPageUrls = new Map();
const playlistStatesByTab = new Map();
const prefilledPlaylistByTab = new Map();
const tabGenerations = new Map();
const activeJobs = new Set();
let creatingOffscreenDocument = null;

chrome.runtime.onInstalled.addListener(() => {
  void initializeSettings();
  void chrome.action.setBadgeBackgroundColor({ color: "#8b5cf6" });
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.action.setBadgeBackgroundColor({ color: "#8b5cf6" });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const pageUrl = changeInfo.url || tab.url;
  if (!pageUrl) {
    return;
  }

  if (isSupportedPageUrl(pageUrl)) {
    knownPageUrls.set(tabId, pageUrl);
  } else if (changeInfo.url) {
    knownPageUrls.delete(tabId);
    void clearTab(tabId).catch(() => undefined);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  knownPageUrls.delete(tabId);
  void clearTab(tabId).catch(() => undefined);
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0 || details.method !== "GET") {
      return;
    }

    if (isTransportStreamUrl(details.url)) {
      void recordIfSupported(details).catch(() => undefined);
    } else if (isHlsPlaylistUrl(details.url)) {
      void prefillFromPlaylistIfSupported(details).catch(() => undefined);
    }
  },
  { urls: ["https://*/*"], types: ["xmlhttprequest", "media", "other"] },
);

chrome.action.onClicked.addListener((tab) => {
  if (typeof tab.id !== "number") {
    return;
  }

  void createClip(tab).catch((error) => {
    void showTemporaryResult(
      tab.id,
      "!",
      `Local Clips failed: ${error instanceof Error ? error.message : String(error)}`,
      "#ef4444",
    );
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "service-worker") {
    return false;
  }

  if (message.type === "clip-progress") {
    void showProgress(message.tabId, message.completed, message.total);
    sendResponse({ ok: true });
    return false;
  }

  sendResponse({ ok: false, error: "Unknown message" });
  return false;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.clipSeconds) {
    return;
  }

  void refreshAllBadges();
});

async function initializeSettings() {
  const settings = await chrome.storage.local.get("clipSeconds");
  if (settings.clipSeconds === undefined) {
    await chrome.storage.local.set({ clipSeconds: DEFAULT_CLIP_SECONDS });
  }
}

function storageKey(tabId) {
  return `${STORAGE_PREFIX}${tabId}`;
}

function queueForTab(tabId, task) {
  const previous = tabQueues.get(tabId) || Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  tabQueues.set(tabId, next);
  void next
    .finally(() => {
      if (tabQueues.get(tabId) === next) {
        tabQueues.delete(tabId);
      }
    })
    .catch(() => undefined);
  return next;
}

async function loadSegments(tabId) {
  if (segmentCache.has(tabId)) {
    return segmentCache.get(tabId);
  }

  const key = storageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  const segments = Array.isArray(stored[key]) ? stored[key] : [];
  segmentCache.set(tabId, segments);
  return segments;
}

async function isSupportedRequest(details) {
  const initiatingUrl = details.initiator || details.documentUrl;
  if (isSupportedPageUrl(initiatingUrl)) {
    knownPageUrls.set(details.tabId, initiatingUrl);
    return true;
  }

  if (isSupportedPageUrl(knownPageUrls.get(details.tabId))) {
    return true;
  }

  try {
    const tab = await chrome.tabs.get(details.tabId);
    if (isSupportedPageUrl(tab.url)) {
      knownPageUrls.set(details.tabId, tab.url);
      return true;
    }
  } catch {
    // The tab may have closed between the request and this lookup.
  }

  return false;
}

async function recordIfSupported(details) {
  if (!(await isSupportedRequest(details))) {
    return;
  }

  const now = Number.isFinite(details.timeStamp) ? details.timeStamp : Date.now();
  await storeSegments(details.tabId, [{ url: details.url, observedAt: now }], now);
}

async function storeSegments(tabId, additions, now = Date.now()) {
  if (!additions.length) {
    return;
  }

  await queueForTab(tabId, async () => {
    const current = await loadSegments(tabId);
    const next = pruneSegments(
      [...current, ...additions],
      now,
      MAX_CLIP_SECONDS + BUFFER_MARGIN_SECONDS,
    );

    segmentCache.set(tabId, next);
    await chrome.storage.session.set({ [storageKey(tabId)]: next });
    await updateBufferBadge(tabId, next);
  });
}

function getPlaylistStateKey(value) {
  try {
    const url = new URL(value);
    url.searchParams.delete("_HLS_msn");
    url.searchParams.delete("_HLS_part");
    url.searchParams.delete("_HLS_skip");
    return url.href;
  } catch {
    return value;
  }
}

function getPlaylistStates(tabId) {
  if (!playlistStatesByTab.has(tabId)) {
    playlistStatesByTab.set(tabId, new Map());
  }
  return playlistStatesByTab.get(tabId);
}

function getTabGeneration(tabId) {
  return tabGenerations.get(tabId) || 0;
}

async function prefillFromPlaylistIfSupported(details) {
  if (!(await isSupportedRequest(details))) {
    return;
  }

  const states = getPlaylistStates(details.tabId);
  const key = getPlaylistStateKey(details.url);
  const existing = states.get(key);
  const now = Date.now();
  const generation = getTabGeneration(details.tabId);

  if (existing?.completed) {
    return;
  }
  if (existing?.promise) {
    await existing.promise;
    return;
  }
  if (existing?.lastAttemptAt && now - existing.lastAttemptAt < PLAYLIST_RETRY_DELAY_MS) {
    return;
  }

  const state = existing || {};
  state.lastAttemptAt = now;
  state.promise = (async () => {
    try {
      const segments = await fetchPlaylistSegments(details.url);
      if (segments.length && getTabGeneration(details.tabId) === generation) {
        const currentPlaylist = prefilledPlaylistByTab.get(details.tabId);
        if (!currentPlaylist || currentPlaylist === key) {
          prefilledPlaylistByTab.set(details.tabId, key);
          await storeSegments(details.tabId, segments, Date.now());
        }
      }
      state.completed = true;
    } catch (error) {
      state.completed = false;
      console.debug("Local Clips could not prefill an HLS playlist", error);
    } finally {
      state.promise = null;
    }
  })();

  states.set(key, state);
  if (states.size > 20) {
    for (const candidateKey of states.keys()) {
      if (candidateKey !== key) {
        states.delete(candidateKey);
        break;
      }
    }
  }

  await state.promise;
}

async function fetchPlaylistSegments(url) {
  let lastError;

  for (let attempt = 1; attempt <= PLAYLIST_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "include",
        headers: {
          Accept: "application/vnd.apple.mpegurl, application/x-mpegURL, */*",
        },
        signal: AbortSignal.timeout(PLAYLIST_FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < PLAYLIST_FETCH_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
          continue;
        }
        throw new Error(`Playlist request failed with HTTP ${response.status}`);
      }

      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_PLAYLIST_BYTES) {
        throw new Error("Playlist is larger than the safe parsing limit");
      }

      const text = await response.text();
      if (text.length > MAX_PLAYLIST_BYTES) {
        throw new Error("Playlist is larger than the safe parsing limit");
      }

      return parseHlsMediaPlaylist(text, response.url || url, Date.now());
    } catch (error) {
      lastError = error;
      if (attempt < PLAYLIST_FETCH_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  }

  throw lastError || new Error("Playlist request failed");
}

async function clearTab(tabId) {
  tabGenerations.set(tabId, getTabGeneration(tabId) + 1);
  playlistStatesByTab.delete(tabId);
  prefilledPlaylistByTab.delete(tabId);
  await queueForTab(tabId, async () => {
    segmentCache.delete(tabId);
    await chrome.storage.session.remove(storageKey(tabId));
    await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => undefined);
  });
}

async function getClipSeconds() {
  const result = await chrome.storage.local.get("clipSeconds");
  return clampClipSeconds(result.clipSeconds);
}

async function updateBufferBadge(tabId, segments) {
  if (activeJobs.has(tabId)) {
    return;
  }

  const targetSeconds = await getClipSeconds();
  const availableSeconds = Math.min(targetSeconds, estimateSegmentSeconds(segments));
  const text = availableSeconds >= 100 ? String(availableSeconds) : `${availableSeconds}s`;
  const isReady = availableSeconds >= targetSeconds;

  await Promise.all([
    chrome.action.setBadgeText({ tabId, text }),
    chrome.action.setBadgeBackgroundColor({
      tabId,
      color: isReady ? "#16a34a" : "#8b5cf6",
    }),
    chrome.action.setTitle({
      tabId,
      title: isReady
        ? `Save the latest ${targetSeconds}-second Local Clip`
        : `Local Clips is buffering (${availableSeconds}/${targetSeconds} seconds)`,
    }),
  ]);
}

async function refreshAllBadges() {
  for (const [tabId, segments] of segmentCache.entries()) {
    await updateBufferBadge(tabId, segments).catch(() => undefined);
  }
}

async function createClip(tab) {
  const tabId = tab.id;
  if (activeJobs.has(tabId)) {
    await showTemporaryResult(tabId, "…", "A Local Clip is already being prepared", "#f59e0b");
    return;
  }

  if (!isSupportedPageUrl(tab.url)) {
    await showTemporaryResult(tabId, "!", "Local Clips currently supports Twitch and Kick livestream pages", "#ef4444");
    return;
  }

  const segments = await queueForTab(tabId, () => loadSegments(tabId));
  const clipSeconds = await getClipSeconds();
  const selected = selectClipSegments(segments, clipSeconds);

  if (!selected.length) {
    await showTemporaryResult(
      tabId,
      "!",
      "No MPEG-TS stream segments found yet — start the livestream and try again",
      "#ef4444",
    );
    return;
  }

  activeJobs.add(tabId);
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" });
  await chrome.action.setBadgeText({ tabId, text: "0%" });
  await chrome.action.setTitle({ tabId, title: `Preparing ${selected.length} stream segments…` });

  try {
    await ensureOffscreenDocument();
    const response = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "merge-and-download",
      tabId,
      segments: selected,
    });

    if (!response?.ok || !response.objectUrl) {
      throw new Error(response?.error || "The clip could not be created");
    }

    try {
      await chrome.downloads.download({
        url: response.objectUrl,
        filename: createClipFilename(tab.title),
        saveAs: true,
        conflictAction: "uniquify",
      });
    } catch (error) {
      void releaseObjectUrl(response.objectUrl, 0);
      throw error;
    }

    void releaseObjectUrl(response.objectUrl, 60_000);

    const warning = response.failedCount
      ? `Clip ready with ${response.failedCount} unavailable segment${response.failedCount === 1 ? "" : "s"}`
      : "Clip ready — choose where to save it";
    await showTemporaryResult(tabId, "✓", warning, response.failedCount ? "#f59e0b" : "#22c55e");
  } catch (error) {
    await showTemporaryResult(
      tabId,
      "!",
      `Local Clips failed: ${error instanceof Error ? error.message : String(error)}`,
      "#ef4444",
    );
  } finally {
    activeJobs.delete(tabId);
    setTimeout(() => {
      void loadSegments(tabId)
        .then((current) => updateBufferBadge(tabId, current))
        .catch(() => undefined);
    }, 5000);
  }
}

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

async function releaseObjectUrl(objectUrl, delayMs) {
  await chrome.runtime
    .sendMessage({
      target: "offscreen",
      type: "release-object-url",
      objectUrl,
      delayMs,
    })
    .catch(() => undefined);
}

async function showProgress(tabId, completed, total) {
  if (!activeJobs.has(tabId) || !total) {
    return;
  }

  const percent = Math.min(99, Math.max(0, Math.round((completed / total) * 100)));
  await chrome.action.setBadgeText({ tabId, text: `${percent}%` }).catch(() => undefined);
  await chrome.action
    .setTitle({ tabId, title: `Preparing Local Clip… ${completed}/${total} segments` })
    .catch(() => undefined);
}

async function showTemporaryResult(tabId, badge, title, color) {
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text: badge }),
    chrome.action.setBadgeBackgroundColor({ tabId, color }),
    chrome.action.setTitle({ tabId, title }),
  ]).catch(() => undefined);
}
