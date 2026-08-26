# Local Clips

Local Clips is a dependency-free Chrome extension that keeps track of the recent MPEG-TS (`.ts`) media segments requested by Twitch and Kick. Clicking the toolbar action downloads the configured rolling window, concatenates the segments without re-encoding, and opens Chrome's **Save As** dialog.

The default clip window is **90 seconds**. It can be changed from 15 seconds to 5 minutes.

## Install locally

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Choose this `local-clips` directory.
5. Pin **Local Clips** to the toolbar.

## Use it

1. Open a live channel on Twitch or Kick and start playback.
2. Wait for the purple toolbar badge to fill. It turns green when the configured window is ready.
3. Click **Local Clips** once.
4. Wait for the progress badge, then choose a destination in Chrome's **Save As** dialog.

Right-click the toolbar icon and choose **Options** to change the clip duration.

## Why the result is `.ts`

MPEG transport-stream files can be joined at segment boundaries without transcoding. This makes clip creation fast and preserves the source stream's video and audio quality. VLC, IINA, mpv, Chrome, and most video tools can open `.ts` files. Converting/remuxing to MP4 can be added later, but it requires a media muxer and materially increases the packaged extension size.

## Permissions and privacy

- `webRequest` plus HTTPS host access lets the extension observe `.ts` segment addresses served by the changing CDN hosts used by Twitch and Kick.
- `storage` keeps only recent segment addresses and timestamps in Chrome's in-memory session storage. They are cleared when the browser session ends.
- `offscreen` creates the merged video blob without requiring a visible extension page to stay open.
- `downloads` opens the Save As dialog and writes the selected file.

The listener ignores requests unless the initiating tab is on `twitch.tv` or `kick.com`. Video bytes are fetched from the original stream CDN only after the toolbar button is clicked. Nothing is uploaded by this extension.

## Development

```bash
npm test
npm run check
```

After editing, click **Reload** for Local Clips on `chrome://extensions`. Reload the Twitch or Kick tab as well so the rolling buffer starts fresh.

## Current scope

- Twitch and Kick live HLS streams that use unencrypted `.ts` media segments.
- One clip at a time per tab.
- Direct MPEG-TS concatenation, with no re-encoding.

Streams delivered as fragmented MP4 (`.m4s`) or encrypted HLS need a separate remux/decryption path and are not included in this first version.
