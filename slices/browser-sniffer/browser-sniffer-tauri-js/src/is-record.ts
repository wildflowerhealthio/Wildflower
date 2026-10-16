/**
 * Narrow an unknown wire payload to a string-keyed record. A real type guard
 * (not an assertion), so downstream `record.event` / `record.payload` reads
 * stay type-safe without an `as` cast. Used by `./native-bridge.ts` to parse
 * inbound envelopes.
 *
 * @remarks Arrays are excluded deliberately: `typeof [] === 'object'` would
 * otherwise admit them, and `record.event` / `record.payload` off an array
 * reads `undefined` — a violated contract.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export { isRecord }
