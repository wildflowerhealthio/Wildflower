import { Schema } from 'effect'

/**
 * Validates an app launch-URL string. Acceptable shapes (mirrors the Rust
 * server's `AppUrl`):
 *
 * 1. An `https://` absolute URL.
 * 2. A path-relative URL starting with `/` (must NOT start with `//`, which
 *    would be a protocol-relative authority — an open redirect).
 * 3. A template starting with `{origin}` — the `LaunchApp` handler substitutes
 *    the live origin at request time.
 *
 * Rejects `http://`, `javascript:`, `data:`, `file:`, and other schemes — these
 * would be open-redirect or XSS vectors when issued through `LaunchApp`'s 302.
 */
const AppUrlSchema = Schema.String.pipe(
  Schema.filter((value) => {
    if (value.length === 0) return 'url must not be empty'
    if (value.startsWith('{origin}')) return true
    if (value.startsWith('/') && !value.startsWith('//')) return true
    if (value.startsWith('https://')) return true
    return 'url must be https://, an origin-relative /path, or start with the {origin} placeholder'
  })
)

/**
 * Wire shape for a single app. Mirrors the Rust server's `AppEntry` (see
 * `apps-rust`): no provenance tag — every app is just an app — with the launch
 * `url` as a first-class field.
 */
const AppEntrySchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** Optional descriptive line shown under the app name. */
  subtitle: Schema.optional(Schema.NonEmptyString),
  /** The launch URL template (`{origin}` / `{launch}` placeholders). */
  url: Schema.String,
  requiresTunnel: Schema.Boolean,
  enabled: Schema.Boolean,
})

const AppListSchema = Schema.Array(AppEntrySchema)

const AppIdPathSchema = Schema.Struct({ id: Schema.String })

const AppNotFoundSchema = Schema.Struct({
  error: Schema.Literal('AppNotFound'),
  id: Schema.String,
})

/**
 * Body for a write-side field validation 400. `error` discriminates an empty
 * name (`InvalidName`) from a bad url (`InvalidUrl`) so the client can render
 * the right inline message; `message` is the human-readable reason. Matches
 * the Rust server's `InvalidFieldBody`.
 */
const InvalidFieldSchema = Schema.Struct({
  error: Schema.Literal('InvalidUrl', 'InvalidName'),
  message: Schema.String,
})

/**
 * Body for `CreateApp` and (partially) `UpdateApp`. `name` is required-non-empty
 * on create; `url` must pass {@link AppUrlSchema}. These write-side checks close
 * the open-redirect surface a launch-time validator alone can't cover (a bad URL
 * would never reach the row).
 */
const CreateAppBodySchema = Schema.Struct({
  name: Schema.NonEmptyString,
  url: AppUrlSchema,
  requiresTunnel: Schema.Boolean,
  subtitle: Schema.optional(Schema.String),
})

/**
 * Body for `UpdateApp`. All fields optional; `name`/`url` carry the same
 * non-empty / well-formed constraints as on create so a partial update cannot
 * relax them. An explicit `subtitle` (including the empty string) replaces the
 * stored subtitle.
 */
const UpdateAppBodySchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.NonEmptyString),
  url: Schema.optional(AppUrlSchema),
  requiresTunnel: Schema.optional(Schema.Boolean),
  subtitle: Schema.optional(Schema.String),
})

export {
  AppEntrySchema,
  AppIdPathSchema,
  AppListSchema,
  AppNotFoundSchema,
  AppUrlSchema,
  CreateAppBodySchema,
  InvalidFieldSchema,
  UpdateAppBodySchema,
}
