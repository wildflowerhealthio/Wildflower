import { Schema } from 'effect'

const AppKindSchema = Schema.Literal('bundled', 'custom', 'action')
type AppKind = typeof AppKindSchema.Type

interface BundledApp {
  readonly id: string
  readonly name: string
  readonly subtitle: string
  readonly kind: 'bundled' | 'action'
  readonly requiresTunnel: boolean
  readonly url: (origin: string, launch: string) => string
}

/**
 * Validates a custom-app URL string. Acceptable shapes:
 *
 * 1. An `https://` absolute URL.
 * 2. A path-relative URL starting with `/` (must NOT start with `//`,
 *    which would be a protocol-relative authority).
 * 3. A template starting with `{origin}` — the `LaunchApp` handler
 *    substitutes the live `Origin` at request time.
 *
 * Rejects `http://`, `javascript:`, `data:`, `file:`, and other URI
 * schemes — these would be open-redirect or XSS vectors when issued
 * through `LaunchApp`'s 302.
 */
const CustomAppUrlSchema = Schema.String.pipe(
  Schema.filter((value) => {
    if (value.length === 0) return 'url must not be empty'
    if (value.startsWith('{origin}')) return true
    if (value.startsWith('/') && !value.startsWith('//')) return true
    if (value.startsWith('https://')) return true
    return 'url must be https://, an origin-relative /path, or start with the {origin} placeholder'
  })
)

const CustomAppSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.NonEmptyString,
  url: CustomAppUrlSchema,
  requiresTunnel: Schema.Boolean,
})
type CustomApp = typeof CustomAppSchema.Type

export { AppKindSchema, CustomAppSchema, CustomAppUrlSchema }
export type { AppKind, BundledApp, CustomApp }
