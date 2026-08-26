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
  selectTimedClipSegments,
  sumMediaDuration,
} from "./segment-utils.js";
import {
  isHlsPlaylistUrl,
  parseHlsMediaIndex,
  parseHlsMediaPlaylist,
} from "./hls-utils.js";
import {
  findFirstMpegTsTimestampSeconds,
  mpegTsTimestampDeltaSeconds,
} from "./mpeg-ts-utils.js";

const STORAGE_PREFIX = "segments-for-tab-";
const ACTIVE_PLAYLIST_STORAGE_PREFIX = "active-playlist-for-tab-";
const REWIND_CAPTURE_STORAGE_PREFIX = "rewind-capture-for-tab-";
const PLAYLIST_FETCH_ATTEMPTS = 2;
const PLAYLIST_FETCH_TIMEOUT_MS = 5_000;
const PLAYLIST_RETRY_DELAY_MS = 5_000;
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const MAX_REWIND_PLAYLIST_BYTES = 8 * 1024 * 1024;
const KICK_PLAYLIST_REFRESH_MS = 1_500;
const KICK_REWIND_JUMP_SECONDS = 12;
const KICK_LIVE_EDGE_SECONDS = 12;
const KICK_MAX_CONTIGUOUS_SEGMENT_GAP_SECONDS = 30;
const SEGMENT_PROBE_BYTES = 128 * 1024;
const SEGMENT_PROBE_TIMEOUT_MS = 5_000;
const MAX_REWIND_CAPTURE_SEGMENTS = 600;
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
    const previousPageUrl = knownPageUrls.get(tabId);
    knownPageUrls.set(tabId, pageUrl);
    if (
      changeInfo.url &&
      previousPageUrl &&
      getPageIdentity(previousPageUrl) !== getPageIdentity(pageUrl)
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

function activePlaylistStorageKey(tabId) {
  return `${ACTIVE_PLAYLIST_STORAGE_PREFIX}${tabId}`;
}

function rewindCaptureStorageKey(tabId) {
  return `${REWIND_CAPTURE_STORAGE_PREFIX}${tabId}`;
}

function getPageIdentity(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
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

function mediaSegmentKey(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

function getMediaIndexes(tabId) {
  if (!mediaIndexesByTab.has(tabId)) {
    mediaIndexesByTab.set(tabId, new Map());
  }
  return mediaIndexesByTab.get(tabId);
}

function createMediaIndex(key, url, segments) {
  const byUrl = new Map();
  for (const segment of segments) {
    if (typeof segment.url === "string") {
      byUrl.set(mediaSegmentKey(segment.url), segment);
    }
  }
  return {
    key,
    url: getFetchablePlaylistUrl(url),
    segments,
    byUrl,
    latestSequence: segments.at(-1)?.sequence,
    indexedAt: Date.now(),
  };
}

function rememberMediaIndex(tabId, key, url, segments) {
  if (!segments.length) {
    return null;
  }
  const indexes = getMediaIndexes(tabId);
  const previousIndex = indexes.get(key);
  const previous = previousIndex?.segments || [];
  const bySequence = new Map(
    previous.map((segment) => [segment.sequence, segment]),
  );
  for (const segment of segments) {
    bySequence.set(segment.sequence, segment);
  }
  const merged = [...bySequence.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-MAX_INDEXED_MEDIA_SEGMENTS);
  const index = createMediaIndex(key, url, merged);
  const oldestRetainedSequence = merged[0]?.sequence;
  for (const [segmentUrl, segment] of previousIndex?.byUrl || []) {
    if (
      segment.sequence >= oldestRetainedSequence &&
      !index.byUrl.has(segmentUrl)
    ) {
      index.byUrl.set(segmentUrl, segment);
    }
  }
  indexes.set(key, index);
  if (indexes.size > 20) {
    indexes.delete(indexes.keys().next().value);
  }
  return index;
}

function findIndexedKickSegment(tabId, url) {
  const segmentKey = mediaSegmentKey(url);
  for (const index of getMediaIndexes(tabId).values()) {
    const segment = index.byUrl.get(segmentKey);
    if (segment) {
      return {
        ...segment,
        url,
        playlistKey: index.key,
        playlistUrl: index.url,
      };
    }
  }
  return null;
}

async function waitForPlaylistIndexes(tabId) {
  const promises = [...getPlaylistStates(tabId).values()]
    .map((state) => state.promise)
    .filter(Boolean);
  if (promises.length) {
    await Promise.allSettled(promises);
  }
}

function mediaDistanceSeconds(index, fromSequence, toSequence) {
  if (
    !index ||
    !Number.isSafeInteger(fromSequence) ||
    !Number.isSafeInteger(toSequence) ||
    toSequence <= fromSequence
  ) {
    return 0;
  }

  return index.segments.reduce((total, segment) => {
    if (
      segment.sequence >= fromSequence &&
      segment.sequence < toSequence &&
      Number.isFinite(segment.durationSeconds)
    ) {
      return total + segment.durationSeconds;
    }
    return total;
  }, 0);
}

function backwardJumpSeconds(previous, current, index) {
  if (!previous) {
    return 0;
  }
  if (
    Number.isFinite(previous.programStartMs) &&
    Number.isFinite(current.programStartMs)
  ) {
    return Math.max(0, (previous.programStartMs - current.programStartMs) / 1000);
  }
  if (previous.playlistKey !== current.playlistKey) {
    return 0;
  }
  return mediaDistanceSeconds(index, current.sequence, previous.sequence);
}

function secondsBehindPlaylistEdge(index, segment) {
  if (!index || segment.playlistKey !== index.key) {
    return Number.POSITIVE_INFINITY;
  }
  return mediaDistanceSeconds(
    index,
    segment.sequence + 1,
    index.latestSequence + 1,
  );
}

function toCapturedSegment(segment, observedAt) {
  return {
    url: segment.url,
    durationSeconds: segment.durationSeconds,
    sequence: segment.sequence,
    programStartMs: segment.programStartMs,
    observedAt,
  };
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
  const capture = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    mode: "indexed",
    startedAt: observedAt,
    playlistKey: segment.playlistKey,
    playlistUrl: segment.playlistUrl,
    anchorSequence: segment.sequence,
    segments: [toCapturedSegment(segment, observedAt)],
  };
  await saveRewindCapture(tabId, capture);
  return capture;
}

function getFallbackSegmentDuration(index) {
  const duration = index?.segments
    ?.slice()
    .reverse()
    .find((segment) => Number.isFinite(segment.durationSeconds))
    ?.durationSeconds;
  return Number.isFinite(duration) && duration > 0 ? duration : 2;
}

async function startUnindexedKickRewindCapture(
  tabId,
  url,
  observedAt,
  durationSeconds,
  mediaTimestampSeconds,
) {
  const capture = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    mode: "unindexed",
    startedAt: observedAt,
    anchorSequence: 0,
    segments: [{
      url,
      durationSeconds,
      sequence: 0,
      observedAt,
      mediaTimestampSeconds,
    }],
  };
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
  if (capture.segments.some((segment) => segment.url === url)) {
    return capture;
  }
  const previousTimestampIndex = capture.segments.findLastIndex(
    (segment) => Number.isFinite(segment.mediaTimestampSeconds),
  );
  const previousTimestampSegment = capture.segments[previousTimestampIndex];
  const timestampDelta =
    previousTimestampSegment && Number.isFinite(mediaTimestampSeconds)
      ? mpegTsTimestampDeltaSeconds(
          mediaTimestampSeconds,
          previousTimestampSegment.mediaTimestampSeconds,
        )
      : null;

  if (
    Number.isFinite(timestampDelta) &&
    (timestampDelta < -1 ||
      timestampDelta > KICK_MAX_CONTIGUOUS_SEGMENT_GAP_SECONDS)
  ) {
    return startUnindexedKickRewindCapture(
      tabId,
      url,
      observedAt,
      durationSeconds,
      mediaTimestampSeconds,
    );
  }

  const segments = capture.segments.map((segment) => ({ ...segment }));
  let measuredDuration = durationSeconds;
  if (Number.isFinite(timestampDelta) && timestampDelta > 0.1) {
    segments[previousTimestampIndex].durationSeconds = timestampDelta;
    measuredDuration = timestampDelta;
  }

  const nextSequence =
    Math.max(-1, ...capture.segments.map((segment) => segment.sequence)) + 1;
  const next = {
    ...capture,
    segments: [
      ...segments,
      {
        url,
        durationSeconds: measuredDuration,
        sequence: nextSequence,
        observedAt,
        mediaTimestampSeconds,
      },
    ].slice(-MAX_REWIND_CAPTURE_SEGMENTS),
  };
  await saveRewindCapture(tabId, next);
  return next;
}

async function appendKickRewindSegment(tabId, capture, segment, observedAt) {
  const bySequence = new Map(
    capture.segments.map((candidate) => [candidate.sequence, candidate]),
  );
  bySequence.set(segment.sequence, toCapturedSegment(segment, observedAt));
  const next = {
    ...capture,
    segments: [...bySequence.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .slice(-MAX_REWIND_CAPTURE_SEGMENTS),
  };
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
    await clearKickRewindCapture(tabId, { url: segment.url, observedAt });
  } else if (capture && capture.playlistKey === segment.playlistKey) {
    await appendKickRewindSegment(tabId, capture, segment, observedAt);
  }

  lastKickMediaByTab.set(tabId, segment);
}

function getPlaylistStateKey(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

function getFetchablePlaylistUrl(value) {
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
  const isKick = isKickPageUrl(knownPageUrls.get(details.tabId));
  const refreshAfterMs = isKick
    ? KICK_PLAYLIST_REFRESH_MS
    : PLAYLIST_RETRY_DELAY_MS;

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

async function readResponseTextWithLimit(response, maxBytes) {
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

  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw new Error("Playlist is larger than the safe parsing limit");
      }
      chunks.push(value);
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
  return new TextDecoder().decode(bytes);
}

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

      const remaining = maxBytes - byteLength;
      const chunk = value.byteLength > remaining
        ? value.subarray(0, remaining)
        : value;
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

async function probeMpegTsTimestamp(url) {
  try {
    const response = await fetch(url, {
      cache: "force-cache",
      credentials: "include",
      headers: { Range: `bytes=0-${SEGMENT_PROBE_BYTES - 1}` },
      signal: AbortSignal.timeout(SEGMENT_PROBE_TIMEOUT_MS),
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

async function fetchPlaylistText(url, maxBytes) {
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

      return {
        text: await readResponseTextWithLimit(response, maxBytes),
        url: response.url || url,
      };
    } catch (error) {
      lastError = error;
      if (attempt < PLAYLIST_FETCH_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  }

  throw lastError || new Error("Playlist request failed");
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
  await queueForTab(tabId, async () => {
    segmentCache.delete(tabId);
    await Promise.all([
      chrome.storage.session.remove(storageKey(tabId)),
      chrome.storage.session.remove(activePlaylistStorageKey(tabId)),
      chrome.storage.session.remove(rewindCaptureStorageKey(tabId)),
    ]);
    await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => undefined);
  });
}

async function getClipSeconds() {
  const result = await chrome.storage.local.get("clipSeconds");
  return clampClipSeconds(result.clipSeconds);
}

async function clearKickRewindCapture(tabId, liveSegment = null) {
  const timer = rewindBadgeTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    rewindBadgeTimers.delete(tabId);
  }
  rewindCaptureLoadedTabs.add(tabId);
  rewindCapturesByTab.delete(tabId);
  await chrome.storage.session.remove(rewindCaptureStorageKey(tabId));

  if (liveSegment) {
    await queueForTab(tabId, async () => {
      const segments = [liveSegment];
      segmentCache.set(tabId, segments);
      await chrome.storage.session.set({ [storageKey(tabId)]: segments });
      await updateBufferBadge(tabId, segments);
    });
    return;
  }

  const segments = await loadSegments(tabId);
  await updateBufferBadge(tabId, segments);
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

function getKickRewindTimeline(tabId, capture) {
  const indexed = capture.mode === "unindexed"
    ? []
    : getMediaIndexes(tabId).get(capture.playlistKey)?.segments || [];
  const bySequence = new Map(
    indexed.map((segment) => [segment.sequence, segment]),
  );
  for (const segment of capture.segments) {
    bySequence.set(segment.sequence, segment);
  }
  return [...bySequence.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
}

function selectCurrentKickRewindWindow(
  tabId,
  capture,
  clipSeconds,
  now = Date.now(),
) {
  const elapsedSeconds = Math.max(0, (now - capture.startedAt) / 1000);
  return selectTimedClipSegments(
    getKickRewindTimeline(tabId, capture),
    capture.anchorSequence,
    elapsedSeconds,
    clipSeconds,
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
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text: `${availableSeconds}s` }),
    chrome.action.setBadgeBackgroundColor({
      tabId,
      color: availableSeconds >= targetSeconds ? "#16a34a" : "#8b5cf6",
    }),
    chrome.action.setTitle({
      tabId,
      title: availableSeconds
        ? `Kick rewind clip: ${availableSeconds}/${targetSeconds} seconds of HLS media`
        : "Kick rewind detected — indexing the requested HLS segments",
    }),
  ]).catch(() => undefined);
}

async function updateBufferBadge(tabId, segments) {
  if (activeJobs.has(tabId) || rewindCapturesByTab.has(tabId)) {
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
  for (const [tabId, capture] of rewindCapturesByTab.entries()) {
    await updateRewindBadge(tabId, capture).catch(() => undefined);
  }
  for (const [tabId, segments] of segmentCache.entries()) {
    await updateBufferBadge(tabId, segments).catch(() => undefined);
  }
}

function isKickPageUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "kick.com" || hostname.endsWith(".kick.com");
  } catch {
    return false;
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
    if (isKickPageUrl(tab.url)) {
      await (kickRequestQueues.get(tabId) || Promise.resolve()).catch(
        () => undefined,
      );
    }
    const rewindCapture = isKickPageUrl(tab.url)
      ? await loadRewindCapture(tabId)
      : null;
    const isKickRewind = Boolean(rewindCapture);
    let selected;

    if (isKickRewind) {
      selected = await selectKickRewindSegments(
        tabId,
        rewindCapture,
        clipSeconds,
      );
    } else {
      const segments = await queueForTab(tabId, () => loadSegments(tabId));
      selected = selectClipSegments(segments, clipSeconds);
    }

    if (!selected.length) {
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

    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" });
    await chrome.action.setBadgeText({ tabId, text: "0%" });
    await chrome.action.setTitle({ tabId, title: `Preparing ${selected.length} stream segments…` });

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
      void loadRewindCapture(tabId)
        .then((capture) =>
          capture
            ? updateRewindBadge(tabId, capture)
            : loadSegments(tabId).then((current) =>
                updateBufferBadge(tabId, current),
              ),
        )
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
