/**
 * Narrow an unknown wire payload to a string-keyed record. A real type guard
 * (not an assertion), so reading `record._tag` / `record.level` / `record.event`
 * downstream stays type-safe without an `as` cast.
 *
 * Shared by both bridge transports — the native-webview bridge
 * ({@link file://./native-bridge.ts}) and the Tauri-IPC filter
 * ({@link file://./filter-tauri-internal.ts}) — so the two transports' payload
 * narrowing can't silently drift. Arrays are excluded (`typeof [] === 'object'`
 * would otherwise admit them, leaving `record.level` / `record.payload` reads
 * as `undefined` off an array — a violated contract); a future tightening lands
 * in one place. Both entries bundle this via esbuild, so it stays
 * self-contained in each injected IIFE.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export { isRecord }
