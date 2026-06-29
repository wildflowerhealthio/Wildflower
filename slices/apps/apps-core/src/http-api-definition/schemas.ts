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
 * How an app's launch target resolves (mirrors the Rust `Provenance`):
 * `system` (a shell route / compiled-in backend), `self-hosted` (served from
 * the device on a dedicated isolated origin), or `cloud` (a remote origin
 * reached through the tunnel). On the wire it's the lowercase-kebab string.
 */
const ProvenanceSchema = Schema.Literal('system', 'self-hosted', 'cloud')

/**
 * Wire shape for a single **cloud** app on admin write responses
 * (`POST /apps`, `PATCH /apps/:id`). Mirrors the Rust server's `AppEntry`:
 * the launch `url` is a first-class field so an edited row round-trips back
 * to the client. Only cloud apps are editable through the admin surface.
 *
 * The public list (`GET /apps`) uses {@link AppListEntrySchema}, which
 * **omits** `url`: the launch endpoint is the only thing that resolves a
 * URL (and only at request time, so a forwarded caller and a loopback
 * caller see the right origin), so the catalogue doesn't need to predict
 * it.
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

/**
 * Wire shape for `GET /apps`. Carries the catalogue-display fields plus the
 * registry flags the homescreen renders as badges — `provenance`, `localOnly`,
 * `smart` — and `requiresTunnel`. Omits the launch `url` (the launch endpoint
 * resolves it at request time). Mirrors the Rust `AppListEntry`.
 */
const AppListEntrySchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  subtitle: Schema.optional(Schema.NonEmptyString),
  /** How this app's launch target resolves; see {@link ProvenanceSchema}. */
  provenance: ProvenanceSchema,
  /** The declared no-egress flag (a homescreen badge this pass). */
  localOnly: Schema.Boolean,
  /** Whether this is a SMART app (the registry row carries a `client_id`). */
  smart: Schema.Boolean,
  /** Whether a launch needs the tunnel up (cloud apps only). */
  requiresTunnel: Schema.Boolean,
  enabled: Schema.Boolean,
})

const AppListSchema = Schema.Array(AppListEntrySchema)

/**
 * One entry in the `PUT /home-screen` body: an app id and its desired `enabled`
 * flag. The entry's **index in the array is its new display `position`**, so the
 * order is implicit and a swap is well-ordered by construction. Mirrors the Rust
 * `HomeScreenEntry`.
 */
const HomeScreenEntrySchema = Schema.Struct({
  id: Schema.String,
  enabled: Schema.Boolean,
})

/**
 * Body for `PUT /home-screen` — the full ordered homescreen as `{ id, enabled }`
 * entries. Must list **every** registry app exactly once (array order = display
 * order); the server renumbers `position` to the array index and applies each
 * `enabled` atomically. The single writer of order + enabled, across every
 * provenance.
 */
const HomeScreenSchema = Schema.Array(HomeScreenEntrySchema)

const AppIdPathSchema = Schema.Struct({ id: Schema.String })

const AppNotFoundSchema = Schema.Struct({
  error: Schema.Literal('AppNotFound'),
  id: Schema.String,
})

/**
 * Body for `AppNotEditable` (409) — the app exists but isn't a cloud app, so
 * the cloud-admin update/delete surface can't touch it (system + self-hosted
 * apps are not user-editable). Mirrors the Rust `AppNotEditableBody`.
 */
const AppNotEditableSchema = Schema.Struct({
  error: Schema.Literal('AppNotEditable'),
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
  // Looser than the read schemas (non-empty): empty `""` clears — see the Rust
  // `SubtitlePatch`.
  subtitle: Schema.optional(Schema.String),
})

/**
 * Body for `UpdateApp`. All fields optional; `name`/`url` carry the same
 * non-empty / well-formed constraints as on create so a partial update cannot
 * relax them. An explicit `subtitle` replaces the stored subtitle; empty `""`
 * **clears** it — see the Rust `SubtitlePatch` for the tri-state.
 */
const UpdateAppBodySchema = Schema.Struct({
  name: Schema.optional(Schema.NonEmptyString),
  url: Schema.optional(AppUrlSchema),
  requiresTunnel: Schema.optional(Schema.Boolean),
  subtitle: Schema.optional(Schema.String),
})

/**
 * Body for `InvalidHomeScreen` (400) — the `PUT /home-screen` payload wasn't an
 * exact permutation of the registry (a missing, duplicated, or unknown id), so
 * the atomic reorder/enable can't be applied. Mirrors the Rust
 * `InvalidHomeScreenBody`.
 */
const InvalidHomeScreenSchema = Schema.Struct({
  error: Schema.Literal('InvalidHomeScreen'),
  message: Schema.String,
})

export {
  AppEntrySchema,
  AppIdPathSchema,
  AppListEntrySchema,
  AppListSchema,
  AppNotEditableSchema,
  AppNotFoundSchema,
  AppUrlSchema,
  CreateAppBodySchema,
  HomeScreenEntrySchema,
  HomeScreenSchema,
  InvalidFieldSchema,
  InvalidHomeScreenSchema,
  ProvenanceSchema,
  UpdateAppBodySchema,
}
