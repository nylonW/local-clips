import {
  DEFAULT_CLIP_SECONDS,
  clampClipSeconds,
} from "../src/segment-utils.js";

const durationInput = document.querySelector("#duration");
const durationOutput = document.querySelector("#duration-output");
const saveButton = document.querySelector("#save");
const status = document.querySelector("#status");

function formatDuration(seconds) {
  if (seconds < 60) {
    return `${seconds} seconds`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds
    ? `${minutes} min ${remainingSeconds} sec`
    : `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

function renderDuration() {
  durationOutput.value = formatDuration(Number(durationInput.value));
}

async function restore() {
  const settings = await chrome.storage.local.get("clipSeconds");
  durationInput.value = String(
    clampClipSeconds(settings.clipSeconds ?? DEFAULT_CLIP_SECONDS),
  );
  renderDuration();
}

async function save() {
  const clipSeconds = clampClipSeconds(durationInput.value);
  await chrome.storage.local.set({ clipSeconds });
  durationInput.value = String(clipSeconds);
  renderDuration();
  status.textContent = "Saved. The toolbar badge now uses this clip window.";
  setTimeout(() => {
    status.textContent = "";
  }, 3500);
}

durationInput.addEventListener("input", renderDuration);
saveButton.addEventListener("click", () => void save());
void restore();
