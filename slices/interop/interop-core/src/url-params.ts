import { Schema } from 'effect'

/**
 * Generic URL conventions shared across the interop boundary. Slice-specific
 * URL keys (e.g. `?token=`, `?user_code=`) live with their slice — only the
 * slice-neutral surface marker lives here.
 *
 * Namespaced as `Surface = { key, values: { Expo } }` so callers read
 * a single object instead of two coupled top-level constants. New
 * surface values land under `Surface.values.<Name>` without polluting
 * the package's top-level export surface.
 */
const Surface = {
  /** Query-string key flagging that the page is rendered inside an embedded host. */
  key: 'surface',
  Schema: Schema.Enums({ Expo: 'expo' }),
} as const

export { Surface }
