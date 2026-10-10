/**
 * Narrow an unknown wire payload to a string-keyed record. A real type guard
 * (not an assertion), so downstream `record._tag` / `record.level` reads stay
 * type-safe without an `as` cast. Shared by both bridge transports
 * (`./native-bridge.ts`, `./filter-tauri-internal.ts`) so their narrowing can't
 * drift.
 *
 * @remarks Arrays are excluded deliberately: `typeof [] === 'object'` would
 * otherwise admit them, and `record.level` / `record.payload` off an array
 * reads `undefined` — a violated contract.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export { isRecord }
