import { Schema } from 'effect'

/**
 * The kind of device the host runs on: `ios` or `android`, a phone, which
 * suspends or stops the app's background work once the user leaves it, or
 * `desktop`, which keeps it running.
 *
 * @remarks
 * The host app reads its OS once and passes this to the base's router
 * context; the base never detects it.
 */
const HostPlatformSchema = Schema.Literal('ios', 'android', 'desktop')

/** A decoded {@link HostPlatformSchema}. */
type Type = typeof HostPlatformSchema.Type

export { HostPlatformSchema as Schema }
export type { Type }
