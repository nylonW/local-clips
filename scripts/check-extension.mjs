import { access, readFile } from "node:fs/promises";

const requiredFiles = [
  "manifest.json",
  "src/service-worker.js",
  "src/segment-utils.js",
  "src/hls-utils.js",
  "src/mpeg-ts-utils.js",
  "offscreen/offscreen.html",
  "offscreen/offscreen.js",
  "options/options.html",
  "options/options.css",
  "options/options.js",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
];

await Promise.all(requiredFiles.map((file) => access(new URL(`../${file}`, import.meta.url))));

const manifest = JSON.parse(
  await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
);

if (manifest.manifest_version !== 3) {
  throw new Error("manifest.json must use Manifest V3");
}

if (!manifest.permissions.includes("downloads") || !manifest.permissions.includes("offscreen")) {
  throw new Error("manifest.json is missing required download/offscreen permissions");
}

if (manifest.action.default_popup) {
  throw new Error("A default popup would prevent the one-click action handler from running");
}

const offscreenScript = await readFile(
  new URL("../offscreen/offscreen.js", import.meta.url),
  "utf8",
);

if (/chrome\.downloads\b/.test(offscreenScript)) {
  throw new Error("Offscreen documents may only use chrome.runtime extension APIs");
}

console.log(`Local Clips ${manifest.version}: manifest and ${requiredFiles.length} required files are valid.`);
