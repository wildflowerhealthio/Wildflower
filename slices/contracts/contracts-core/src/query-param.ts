import { Schema } from 'effect'

/**
 * Slice-neutral URL marker shared across the host/web boundary —
 * declares which kind of host (if any) is rendering the page.
 * Slice-specific URL keys (e.g. `?token=`, `?user_code=`) live with
 * their slice; only the cross-cutting host-type marker lives here.
 *
 * Namespaced as `HostType = { key, Schema }` so callers read a single
 * object instead of two coupled top-level constants. New host-type
 * values land under `HostType.Schema` without polluting the package's
 * top-level export list.
 */
const HostType = {
  /** Query-string key flagging which embedded host is rendering the page. */
  key: 'host',
  Schema: Schema.Enums({ Expo: 'expo' }),
} as const

export { HostType }
