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

/**
 * The parent registry row — the `PATCH /apps/:id/placement` response. Carries
 * the registry fields including `position`; the kind-specific launch detail
 * lives in the per-kind child tables (not on this shape). Mirrors the Rust
 * `App`.
 */
const AppSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  subtitle: Schema.optional(Schema.NullOr(Schema.String)),
  enabled: Schema.Boolean,
  position: Schema.Int,
  provenance: ProvenanceSchema,
  localOnly: Schema.Boolean,
  /** Soft reference to a gatekeeper `clients.client_id`; absent for non-SMART. */
  clientId: Schema.optional(Schema.NullOr(Schema.String)),
})

const AppListSchema = Schema.Array(AppListEntrySchema)

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
  // Looser than the read schemas (non-empty): accepts `""`, which the server
  // normalizes to "no subtitle" so it never persists as `""` and breaks the
  // catalogue decode — see {@link AppEntrySchema}.
  subtitle: Schema.optional(Schema.String),
})

/**
 * Body for `UpdateApp`. All fields optional; `name`/`url` carry the same
 * non-empty / well-formed constraints as on create so a partial update cannot
 * relax them. An explicit `subtitle` replaces the stored subtitle; the empty
 * string `""` **clears** it — the server normalizes empty to none so it never
 * persists as `""` and round-trips through the non-empty read schema.
 */
const UpdateAppBodySchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.NonEmptyString),
  url: Schema.optional(AppUrlSchema),
  requiresTunnel: Schema.optional(Schema.Boolean),
  subtitle: Schema.optional(Schema.String),
})

/**
 * Body for `PATCH /apps/:id/placement` — homescreen placement updates that
 * apply to **any** provenance. Both fields optional: `enabled` toggles tile
 * visibility, `position` sets the display order (drag-to-reorder). Distinct
 * from {@link UpdateAppBodySchema}, which edits a cloud app's content. Mirrors
 * the Rust `PlacementBody`.
 */
const PlacementBodySchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  position: Schema.optional(Schema.Int),
})

export {
  AppEntrySchema,
  AppIdPathSchema,
  AppListEntrySchema,
  AppListSchema,
  AppNotEditableSchema,
  AppNotFoundSchema,
  AppSchema,
  AppUrlSchema,
  CreateAppBodySchema,
  InvalidFieldSchema,
  PlacementBodySchema,
  ProvenanceSchema,
  UpdateAppBodySchema,
}
