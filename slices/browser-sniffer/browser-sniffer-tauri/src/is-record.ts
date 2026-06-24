/**
 * Narrow an unknown wire payload to a string-keyed record. A real type guard
 * (not an assertion), so reading `record._tag` / `record.level` / `record.event`
 * downstream stays type-safe without an `as` cast.
 *
 * Shared by both bridge transports — the native-webview bridge
 * ({@link file://./native-bridge.ts}) and the Tauri-IPC filter
 * ({@link file://./filter-tauri-internal.ts}) — so the two transports' payload
 * narrowing can't silently drift, and a future tightening (e.g. excluding
 * arrays, which this currently lets through) lands in one place. Both entries
 * bundle this via esbuild, so it stays self-contained in each injected IIFE.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object'

export { isRecord }
