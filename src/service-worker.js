import {
  BUFFER_MARGIN_SECONDS,
  DEFAULT_CLIP_SECONDS,
  MAX_CLIP_SECONDS,
  clampClipSeconds,
  createClipFilename,
  getKickClipId,
  isKickClipPageUrl,
  isKickPageUrl,
  isSupportedPageUrl,
  isTransportStreamUrl,
  pruneSegments,
  selectClipSegments,
  sumMediaDuration,
} from "./segment-utils.js";
import {
  isHlsPlaylistUrl,
  parseHlsClipPlaylist,
  parseHlsMediaIndex,
  parseHlsMediaPlaylist,
} from "./hls-utils.js";
import {
  appendIndexedSegment,
  appendUnindexedSegment,
  backwardJumpSeconds,
  createIndexedCapture,
  createUnindexedCapture,
  findIndexedSegment,
  getFallbackSegmentDuration,
  mergeMediaIndex,
  secondsBehindPlaylistEdge,
  selectRewindWindow,
} from "./kick-rewind.js";
import {
  fetchPlaylistText,
  probeMpegTsTimestamp,
} from "./playlist-client.js";
import {
  showBufferStatus,
  showKickClipStatus,
  showPreparing,
  showProgress,
  showRewindStatus,
  showTemporaryResult,
} from "./action-ui.js";
import {
  mergeSegmentsOffscreen,
  releaseObjectUrl,
} from "./offscreen-client.js";
import {
  getFetchablePlaylistUrl,
  urlResourceKey,
} from "./url-utils.js";

const STORAGE_PREFIX = "segments-for-tab-";
const ACTIVE_PLAYLIST_STORAGE_PREFIX = "active-playlist-for-tab-";
const REWIND_CAPTURE_STORAGE_PREFIX = "rewind-capture-for-tab-";
const KICK_CLIP_STORAGE_PREFIX = "kick-clip-for-tab-";
const PLAYLIST_RETRY_DELAY_MS = 5_000;
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const MAX_REWIND_PLAYLIST_BYTES = 8 * 1024 * 1024;
const KICK_PLAYLIST_REFRESH_MS = 1_500;
const KICK_REWIND_JUMP_SECONDS = 12;
const KICK_LIVE_EDGE_SECONDS = 12;
const MAX_INDEXED_MEDIA_SEGMENTS = 60_000;
const segmentCache = new Map();
const tabQueues = new Map();
const knownPageUrls = new Map();
const playlistStatesByTab = new Map();
const activePlaylistByTab = new Map();
const mediaIndexesByTab = new Map();
const lastKickMediaByTab = new Map();
const kickRequestQueues = new Map();
const rewindBadgeTimers = new Map();
const rewindCapturesByTab = new Map();
const rewindCaptureLoadedTabs = new Set();
const kickClipsByTab = new Map();
const kickClipLoadedTabs = new Set();
const tabGenerations = new Map();
const activeJobs = new Set();

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
    const previousPageUrl = knownPageUrls.get(tabId);
    knownPageUrls.set(tabId, pageUrl);
    if (
      changeInfo.url &&
      previousPageUrl &&
      urlResourceKey(previousPageUrl) !== urlResourceKey(pageUrl)
    ) {
      void clearTab(tabId).catch(() => undefined);
    }
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
    if (activeJobs.has(message.tabId) && message.total) {
      void showProgress(message.tabId, message.completed, message.total);
    }
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

function activePlaylistStorageKey(tabId) {
  return `${ACTIVE_PLAYLIST_STORAGE_PREFIX}${tabId}`;
}

function rewindCaptureStorageKey(tabId) {
  return `${REWIND_CAPTURE_STORAGE_PREFIX}${tabId}`;
}

function kickClipStorageKey(tabId) {
  return `${KICK_CLIP_STORAGE_PREFIX}${tabId}`;
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

function queueKickRequest(tabId, task) {
  const previous = kickRequestQueues.get(tabId) || Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  kickRequestQueues.set(tabId, next);
  void next
    .finally(() => {
      if (kickRequestQueues.get(tabId) === next) {
        kickRequestQueues.delete(tabId);
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

async function loadActivePlaylist(tabId) {
  if (activePlaylistByTab.has(tabId)) {
    return activePlaylistByTab.get(tabId);
  }

  const key = activePlaylistStorageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  if (activePlaylistByTab.has(tabId)) {
    return activePlaylistByTab.get(tabId);
  }
  const playlist = stored[key];
  if (
    playlist &&
    typeof playlist.key === "string" &&
    typeof playlist.url === "string"
  ) {
    activePlaylistByTab.set(tabId, playlist);
    return playlist;
  }

  return null;
}

async function loadRewindCapture(tabId) {
  if (rewindCapturesByTab.has(tabId)) {
    return rewindCapturesByTab.get(tabId);
  }
  if (rewindCaptureLoadedTabs.has(tabId)) {
    return null;
  }

  const key = rewindCaptureStorageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  rewindCaptureLoadedTabs.add(tabId);
  if (rewindCapturesByTab.has(tabId)) {
    return rewindCapturesByTab.get(tabId);
  }

  const capture = stored[key];
  if (
    capture &&
    typeof capture.id === "string" &&
    Array.isArray(capture.segments)
  ) {
    rewindCapturesByTab.set(tabId, capture);
    scheduleRewindBadge(tabId, capture.id);
    return capture;
  }

  return null;
}

async function loadKickClip(tabId) {
  if (kickClipsByTab.has(tabId)) {
    return kickClipsByTab.get(tabId);
  }
  if (kickClipLoadedTabs.has(tabId)) {
    return null;
  }

  const key = kickClipStorageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  kickClipLoadedTabs.add(tabId);
  if (kickClipsByTab.has(tabId)) {
    return kickClipsByTab.get(tabId);
  }

  const clip = stored[key];
  if (clip && Array.isArray(clip.segments) && clip.segments.length) {
    kickClipsByTab.set(tabId, clip);
    return clip;
  }
  return null;
}

async function saveKickClip(tabId, playlistUrl, segments) {
  const clip = { playlistUrl, segments };
  kickClipLoadedTabs.add(tabId);
  kickClipsByTab.set(tabId, clip);
  await chrome.storage.session.set({ [kickClipStorageKey(tabId)]: clip });
  await updateKickClipBadge(tabId, clip);
  return clip;
}

async function rememberActivePlaylist(
  tabId,
  key,
  url,
  replace = false,
  observedAt = Date.now(),
) {
  let existing = activePlaylistByTab.get(tabId);
  if (!existing) {
    existing = await loadActivePlaylist(tabId);
  }
  existing = activePlaylistByTab.get(tabId) || existing;
  if (!replace && existing?.key && existing.key !== key) {
    return false;
  }

  const normalizedObservedAt = Number.isFinite(observedAt)
    ? observedAt
    : Date.now();
  if (
    replace &&
    existing?.key &&
    existing.key !== key &&
    Number.isFinite(existing.observedAt) &&
    existing.observedAt > normalizedObservedAt
  ) {
    return false;
  }

  const fetchableUrl = getFetchablePlaylistUrl(url);
  if (existing?.key === key && existing.url === fetchableUrl) {
    activePlaylistByTab.set(tabId, {
      ...existing,
      observedAt: Math.max(existing.observedAt || 0, normalizedObservedAt),
    });
    return true;
  }

  const playlist = { key, url: fetchableUrl, observedAt: normalizedObservedAt };
  activePlaylistByTab.set(tabId, playlist);
  await chrome.storage.session.set({
    [activePlaylistStorageKey(tabId)]: playlist,
  });
  return true;
}

async function isSupportedRequest(details) {
  const knownPageUrl = knownPageUrls.get(details.tabId);
  if (isSupportedPageUrl(knownPageUrl)) {
    return true;
  }

  if (isSupportedPageUrl(details.documentUrl)) {
    knownPageUrls.set(details.tabId, details.documentUrl);
    return true;
  }

  if (isSupportedPageUrl(details.initiator)) {
    knownPageUrls.set(details.tabId, details.initiator);
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
  if (isKickClipPageUrl(knownPageUrls.get(details.tabId))) {
    return;
  }

  const now = Number.isFinite(details.timeStamp) ? details.timeStamp : Date.now();
  const liveBuffer = storeSegments(
    details.tabId,
    [{ url: details.url, observedAt: now }],
    now,
  );
  const generation = getTabGeneration(details.tabId);
  const kickTracking = isKickPageUrl(knownPageUrls.get(details.tabId))
    ? queueKickRequest(details.tabId, () =>
        handleKickMediaRequest(details.tabId, details.url, now, generation),
      )
    : Promise.resolve();
  await Promise.all([liveBuffer, kickTracking]);
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

function getMediaIndexes(tabId) {
  if (!mediaIndexesByTab.has(tabId)) {
    mediaIndexesByTab.set(tabId, new Map());
  }
  return mediaIndexesByTab.get(tabId);
}

function rememberMediaIndex(tabId, key, url, segments) {
  const indexes = getMediaIndexes(tabId);
  const index = mergeMediaIndex(
    indexes.get(key),
    key,
    url,
    segments,
    MAX_INDEXED_MEDIA_SEGMENTS,
  );
  if (!index) {
    return null;
  }

  indexes.set(key, index);
  if (indexes.size > 20) {
    indexes.delete(indexes.keys().next().value);
  }
  return index;
}

function findIndexedKickSegment(tabId, url) {
  return findIndexedSegment(getMediaIndexes(tabId), url);
}

async function waitForPlaylistIndexes(tabId) {
  const promises = [...getPlaylistStates(tabId).values()]
    .map((state) => state.promise)
    .filter(Boolean);
  if (promises.length) {
    await Promise.allSettled(promises);
  }
}

async function saveRewindCapture(tabId, capture) {
  rewindCaptureLoadedTabs.add(tabId);
  rewindCapturesByTab.set(tabId, capture);
  await chrome.storage.session.set({
    [rewindCaptureStorageKey(tabId)]: capture,
  });
  await updateRewindBadge(tabId, capture);
  scheduleRewindBadge(tabId, capture.id);
}

async function startKickRewindCapture(tabId, segment, observedAt) {
  const capture = createIndexedCapture(segment, observedAt);
  await saveRewindCapture(tabId, capture);
  return capture;
}

async function startUnindexedKickRewindCapture(
  tabId,
  url,
  observedAt,
  durationSeconds,
  mediaTimestampSeconds,
) {
  const capture = createUnindexedCapture(
    url,
    observedAt,
    durationSeconds,
    mediaTimestampSeconds,
  );
  await saveRewindCapture(tabId, capture);
  return capture;
}

async function appendUnindexedKickRewindSegment(
  tabId,
  capture,
  url,
  observedAt,
  durationSeconds,
  mediaTimestampSeconds,
) {
  const next = appendUnindexedSegment(
    capture,
    url,
    observedAt,
    durationSeconds,
    mediaTimestampSeconds,
  );
  if (next === capture) {
    return capture;
  }
  await saveRewindCapture(tabId, next);
  return next;
}

async function appendKickRewindSegment(tabId, capture, segment) {
  const next = appendIndexedSegment(capture, segment);
  await saveRewindCapture(tabId, next);
  return next;
}

async function handleKickMediaRequest(tabId, url, observedAt, generation) {
  await waitForPlaylistIndexes(tabId);
  if (getTabGeneration(tabId) !== generation) {
    return;
  }
  let segment = findIndexedKickSegment(tabId, url);

  if (!segment) {
    const activePlaylist = await loadActivePlaylist(tabId);
    if (activePlaylist) {
      await refreshPlaylistIndex(
        tabId,
        activePlaylist.key,
        activePlaylist.url,
        MAX_REWIND_PLAYLIST_BYTES,
      ).catch(() => undefined);
      if (getTabGeneration(tabId) !== generation) {
        return;
      }
      segment = findIndexedKickSegment(tabId, url);
    }
  }

  if (!segment) {
    const capture = await loadRewindCapture(tabId);
    const previous = lastKickMediaByTab.get(tabId);
    const previousIndex = previous
      ? getMediaIndexes(tabId).get(previous.playlistKey)
      : null;
    const activePlaylist = await loadActivePlaylist(tabId);
    const activeIndex = activePlaylist
      ? getMediaIndexes(tabId).get(activePlaylist.key)
      : null;
    const durationSeconds = getFallbackSegmentDuration(
      activeIndex || previousIndex,
    );
    const shouldCapture =
      capture?.mode === "unindexed" ||
      Boolean(
        capture ||
        (previous &&
          secondsBehindPlaylistEdge(previousIndex, previous) <=
            KICK_LIVE_EDGE_SECONDS),
      );
    if (!shouldCapture) {
      return;
    }

    const mediaTimestampSeconds = await probeMpegTsTimestamp(url);
    if (getTabGeneration(tabId) !== generation) {
      return;
    }
    if (capture?.mode === "unindexed") {
      await appendUnindexedKickRewindSegment(
        tabId,
        capture,
        url,
        observedAt,
        durationSeconds,
        mediaTimestampSeconds,
      );
    } else {
      await startUnindexedKickRewindCapture(
        tabId,
        url,
        observedAt,
        durationSeconds,
        mediaTimestampSeconds,
      );
    }
    return;
  }

  await rememberActivePlaylist(
    tabId,
    segment.playlistKey,
    segment.playlistUrl,
    true,
    observedAt,
  );

  const index = getMediaIndexes(tabId).get(segment.playlistKey);
  const previous = lastKickMediaByTab.get(tabId);
  const capture = await loadRewindCapture(tabId);
  const jumpSeconds = backwardJumpSeconds(previous, segment, index);
  const nearLiveEdge =
    secondsBehindPlaylistEdge(index, segment) <= KICK_LIVE_EDGE_SECONDS;

  if (jumpSeconds > KICK_REWIND_JUMP_SECONDS) {
    await startKickRewindCapture(tabId, segment, observedAt);
  } else if (capture && nearLiveEdge && segment.sequence > capture.anchorSequence) {
    await returnToKickLive(tabId, { url: segment.url, observedAt });
  } else if (capture && capture.playlistKey === segment.playlistKey) {
    await appendKickRewindSegment(tabId, capture, segment);
  }

  lastKickMediaByTab.set(tabId, segment);
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
  const key = urlResourceKey(details.url);
  const existing = states.get(key);
  const now = Date.now();
  const generation = getTabGeneration(details.tabId);
  const pageUrl = knownPageUrls.get(details.tabId);
  const isKick = isKickPageUrl(pageUrl);
  const isKickClip = isKickClipPageUrl(pageUrl);
  const refreshAfterMs = isKick
    ? KICK_PLAYLIST_REFRESH_MS
    : PLAYLIST_RETRY_DELAY_MS;

  if (isKickClip && existing?.completed) {
    return;
  }

  if (
    existing?.completed &&
    (!isKick || now - existing.lastAttemptAt < refreshAfterMs)
  ) {
    if (isKick && getMediaIndexes(details.tabId).has(key)) {
      await rememberActivePlaylist(
        details.tabId,
        key,
        details.url,
        true,
        Number.isFinite(details.timeStamp) ? details.timeStamp : now,
      );
    } else {
      const activePlaylist = await loadActivePlaylist(details.tabId);
      if (activePlaylist?.key === key) {
        await rememberActivePlaylist(details.tabId, key, details.url);
      }
    }
    return;
  }
  if (existing?.promise) {
    await existing.promise;
    return;
  }
  if (existing?.lastAttemptAt && now - existing.lastAttemptAt < refreshAfterMs) {
    return;
  }

  const state = existing || {};
  state.lastAttemptAt = now;
  state.promise = (async () => {
    try {
      const maxBytes = isKick
        ? MAX_REWIND_PLAYLIST_BYTES
        : MAX_PLAYLIST_BYTES;
      const playlist = await fetchPlaylistText(details.url, maxBytes);
      if (isKickClip) {
        const clipId = getKickClipId(pageUrl);
        const isCurrentClipPlaylist = clipId &&
          new URL(playlist.url).pathname.split("/").includes(clipId);
        const clipSegments = parseHlsClipPlaylist(
          playlist.text,
          playlist.url,
        );
        if (
          isCurrentClipPlaylist &&
          clipSegments.length &&
          getTabGeneration(details.tabId) === generation
        ) {
          await saveKickClip(details.tabId, playlist.url, clipSegments);
        }
        state.completed = true;
        return;
      }

      const indexedSegments = parseHlsMediaIndex(playlist.text, playlist.url);
      const segments = parseHlsMediaPlaylist(
        playlist.text,
        playlist.url,
        Date.now(),
      );
      if (
        indexedSegments.length &&
        getTabGeneration(details.tabId) === generation
      ) {
        rememberMediaIndex(details.tabId, key, playlist.url, indexedSegments);
        const remembered = await rememberActivePlaylist(
          details.tabId,
          key,
          playlist.url,
          isKick,
          Number.isFinite(details.timeStamp) ? details.timeStamp : now,
        );
        if (
          remembered &&
          !state.prefilled &&
          getTabGeneration(details.tabId) === generation
        ) {
          await storeSegments(details.tabId, segments, Date.now());
          state.prefilled = true;
        } else if (getTabGeneration(details.tabId) !== generation) {
          activePlaylistByTab.delete(details.tabId);
          await chrome.storage.session.remove(
            activePlaylistStorageKey(details.tabId),
          );
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

async function refreshPlaylistIndex(tabId, key, url, maxBytes) {
  const playlist = await fetchPlaylistText(url, maxBytes);
  const segments = parseHlsMediaIndex(playlist.text, playlist.url);
  if (!segments.length) {
    return null;
  }
  return rememberMediaIndex(tabId, key, playlist.url, segments);
}

async function clearTab(tabId) {
  tabGenerations.set(tabId, getTabGeneration(tabId) + 1);
  const rewindTimer = rewindBadgeTimers.get(tabId);
  if (rewindTimer) {
    clearTimeout(rewindTimer);
    rewindBadgeTimers.delete(tabId);
  }
  playlistStatesByTab.delete(tabId);
  activePlaylistByTab.delete(tabId);
  mediaIndexesByTab.delete(tabId);
  lastKickMediaByTab.delete(tabId);
  kickRequestQueues.delete(tabId);
  rewindCapturesByTab.delete(tabId);
  rewindCaptureLoadedTabs.delete(tabId);
  kickClipsByTab.delete(tabId);
  kickClipLoadedTabs.delete(tabId);
  await queueForTab(tabId, async () => {
    segmentCache.delete(tabId);
    await Promise.all([
      chrome.storage.session.remove(storageKey(tabId)),
      chrome.storage.session.remove(activePlaylistStorageKey(tabId)),
      chrome.storage.session.remove(rewindCaptureStorageKey(tabId)),
      chrome.storage.session.remove(kickClipStorageKey(tabId)),
    ]);
    await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => undefined);
  });
}

async function getClipSeconds() {
  const result = await chrome.storage.local.get("clipSeconds");
  return clampClipSeconds(result.clipSeconds);
}

async function returnToKickLive(tabId, liveSegment) {
  const timer = rewindBadgeTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    rewindBadgeTimers.delete(tabId);
  }
  rewindCaptureLoadedTabs.add(tabId);
  rewindCapturesByTab.delete(tabId);
  await chrome.storage.session.remove(rewindCaptureStorageKey(tabId));

  await queueForTab(tabId, async () => {
    const segments = [liveSegment];
    segmentCache.set(tabId, segments);
    await chrome.storage.session.set({ [storageKey(tabId)]: segments });
    await updateBufferBadge(tabId, segments);
  });
}

function scheduleRewindBadge(tabId, captureId) {
  if (rewindBadgeTimers.has(tabId)) {
    return;
  }

  const timer = setTimeout(() => {
    rewindBadgeTimers.delete(tabId);
    const capture = rewindCapturesByTab.get(tabId);
    if (!capture || capture.id !== captureId) {
      return;
    }
    void updateRewindBadge(tabId, capture)
      .then(() => scheduleRewindBadge(tabId, captureId))
      .catch(() => undefined);
  }, 1_000);
  rewindBadgeTimers.set(tabId, timer);
}

function selectCurrentKickRewindWindow(
  tabId,
  capture,
  clipSeconds,
  now = Date.now(),
) {
  const indexed = getMediaIndexes(tabId).get(capture.playlistKey)?.segments || [];
  return selectRewindWindow(
    indexed,
    capture,
    clipSeconds,
    now,
  );
}

async function updateRewindBadge(tabId, capture) {
  if (
    activeJobs.has(tabId) ||
    rewindCapturesByTab.get(tabId)?.id !== capture.id
  ) {
    return;
  }

  const targetSeconds = await getClipSeconds();
  const selected = selectCurrentKickRewindWindow(
    tabId,
    capture,
    targetSeconds,
  );
  const availableSeconds = Math.min(
    targetSeconds,
    Math.round(sumMediaDuration(selected)),
  );
  await showRewindStatus(tabId, availableSeconds, targetSeconds);
}

async function updateKickClipBadge(tabId, clip) {
  if (activeJobs.has(tabId) || kickClipsByTab.get(tabId) !== clip) {
    return;
  }
  await showKickClipStatus(tabId, sumMediaDuration(clip.segments));
}

async function updateBufferBadge(tabId, segments) {
  if (
    activeJobs.has(tabId) ||
    rewindCapturesByTab.has(tabId) ||
    kickClipsByTab.has(tabId)
  ) {
    return;
  }

  const targetSeconds = await getClipSeconds();
  await showBufferStatus(tabId, segments, targetSeconds);
}

async function refreshAllBadges() {
  for (const [tabId, clip] of kickClipsByTab.entries()) {
    await updateKickClipBadge(tabId, clip).catch(() => undefined);
  }
  for (const [tabId, capture] of rewindCapturesByTab.entries()) {
    await updateRewindBadge(tabId, capture).catch(() => undefined);
  }
  for (const [tabId, segments] of segmentCache.entries()) {
    await updateBufferBadge(tabId, segments).catch(() => undefined);
  }
}

async function selectKickRewindSegments(tabId, capture, clipSeconds) {
  if (
    capture.mode !== "unindexed" &&
    capture.playlistKey &&
    capture.playlistUrl
  ) {
    try {
      await refreshPlaylistIndex(
        tabId,
        capture.playlistKey,
        capture.playlistUrl,
        MAX_REWIND_PLAYLIST_BYTES,
      );
    } catch (error) {
      console.debug("Local Clips could not refresh the Kick media index", error);
    }
  }

  return selectCurrentKickRewindWindow(
    tabId,
    capture,
    clipSeconds,
  );
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

  activeJobs.add(tabId);
  try {
    const clipSeconds = await getClipSeconds();
    const isKickClip = isKickClipPageUrl(tab.url);
    if (isKickClip) {
      await waitForPlaylistIndexes(tabId);
    } else if (isKickPageUrl(tab.url)) {
      await (kickRequestQueues.get(tabId) || Promise.resolve()).catch(
        () => undefined,
      );
    }
    const kickClip = isKickClip ? await loadKickClip(tabId) : null;
    const rewindCapture = !isKickClip && isKickPageUrl(tab.url)
      ? await loadRewindCapture(tabId)
      : null;
    const isKickRewind = Boolean(rewindCapture);
    let selected;

    if (kickClip) {
      selected = kickClip.segments;
    } else if (isKickRewind) {
      selected = await selectKickRewindSegments(
        tabId,
        rewindCapture,
        clipSeconds,
      );
    } else if (!isKickClip) {
      const segments = await queueForTab(tabId, () => loadSegments(tabId));
      selected = selectClipSegments(segments, clipSeconds);
    } else {
      selected = [];
    }

    if (!selected.length) {
      if (isKickClip) {
        await showTemporaryResult(
          tabId,
          "…",
          "Waiting for Kick's completed clip playlist",
          "#8b5cf6",
        );
        return;
      }
      if (isKickRewind) {
        await showTemporaryResult(
          tabId,
          "0s",
          "Kick rewind detected — waiting for an indexed MPEG-TS segment",
          "#8b5cf6",
        );
        return;
      }

      await showTemporaryResult(
        tabId,
        "!",
        "No MPEG-TS stream segments found yet — start the livestream and try again",
        "#ef4444",
      );
      return;
    }

    await showPreparing(tabId, selected.length);
    const response = await mergeSegmentsOffscreen(tabId, selected, {
      completePlaylist: Boolean(kickClip),
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

    const warning = response.discardedCount
      ? `Clip ready — excluded ${response.discardedCount} segment${response.discardedCount === 1 ? "" : "s"} from another playback position`
      : response.failedCount
        ? `Clip ready with ${response.failedCount} unavailable segment${response.failedCount === 1 ? "" : "s"}`
        : "Clip ready — choose where to save it";
    await showTemporaryResult(
      tabId,
      "✓",
      warning,
      response.failedCount ? "#f59e0b" : "#22c55e",
    );
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
      if (isKickClipPageUrl(tab.url)) {
        void loadKickClip(tabId)
          .then((clip) => clip && updateKickClipBadge(tabId, clip))
          .catch(() => undefined);
      } else {
        void loadRewindCapture(tabId)
          .then((capture) =>
            capture
              ? updateRewindBadge(tabId, capture)
              : loadSegments(tabId).then((current) =>
                  updateBufferBadge(tabId, current),
                ),
          )
          .catch(() => undefined);
      }
    }, 5000);
  }
}
