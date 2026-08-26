/** Returns a stable key while ignoring short-lived CDN query tokens. */
export function urlResourceKey(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

/** Removes low-latency HLS cursor parameters before a playlist is refetched. */
export function getFetchablePlaylistUrl(value) {
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
