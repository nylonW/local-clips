import { estimateSegmentSeconds } from "./segment-utils.js";

export async function showBufferStatus(tabId, segments, targetSeconds) {
  const availableSeconds = Math.min(
    targetSeconds,
    estimateSegmentSeconds(segments),
  );
  const text = availableSeconds >= 100
    ? String(availableSeconds)
    : `${availableSeconds}s`;
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

export async function showRewindStatus(tabId, availableSeconds, targetSeconds) {
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

export async function showKickClipStatus(tabId, durationSeconds) {
  const roundedSeconds = Math.max(1, Math.round(durationSeconds));
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text: "↓" }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#16a34a" }),
    chrome.action.setTitle({
      tabId,
      title: `Download this complete ${roundedSeconds}-second Kick clip`,
    }),
  ]).catch(() => undefined);
}

export async function showPreparing(tabId, segmentCount) {
  await Promise.all([
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" }),
    chrome.action.setBadgeText({ tabId, text: "0%" }),
    chrome.action.setTitle({
      tabId,
      title: `Preparing ${segmentCount} stream segments…`,
    }),
  ]);
}

export async function showProgress(tabId, completed, total) {
  const percent = Math.min(99, Math.max(0, Math.round((completed / total) * 100)));
  await chrome.action
    .setBadgeText({ tabId, text: `${percent}%` })
    .catch(() => undefined);
  await chrome.action
    .setTitle({
      tabId,
      title: `Preparing Local Clip… ${completed}/${total} segments`,
    })
    .catch(() => undefined);
}

export async function showTemporaryResult(tabId, badge, title, color) {
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text: badge }),
    chrome.action.setBadgeBackgroundColor({ tabId, color }),
    chrome.action.setTitle({ tabId, title }),
  ]).catch(() => undefined);
}
