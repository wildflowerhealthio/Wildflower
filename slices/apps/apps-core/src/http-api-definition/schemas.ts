import { HttpApiSchema } from '@effect/platform'
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
 * Validates a self-hosted app's launch path (mirrors the Rust replace handler's
 * `validate_launch_path`). Either:
 *
 *  - the empty string — clears the launcher, reverting to root-serving
 *    (`index.html`); or
 *  - an origin-relative path starting with a single `/` (NOT `//`, a
 *    protocol-relative authority) — it hangs off the app's own origin at launch,
 *    e.g. `/launch.html?launch={launch}&iss={origin}/fhir-r4`. The `{origin}` /
 *    `{launch}` tokens are substituted per request.
 *
 * `https://…` and other absolute/authority forms are rejected: the value is
 * appended to the app's own origin, so it must stay a same-origin path.
 */
const LaunchPathSchema = Schema.String.pipe(
  Schema.filter((value) => {
    if (value.length === 0) return true
    if (value.startsWith('/') && !value.startsWith('//')) return true
    return 'launch path must be empty or an origin-relative /path'
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
 * The fields every catalogue entry shares, from the parent `apps` registry row.
 * The per-provenance variants below add their typed-child-table fields.
 */
const sharedAppFields = {
  id: Schema.String,
  name: Schema.String,
  /** Optional descriptive line shown under the app name. */
  subtitle: Schema.optional(Schema.NonEmptyString),
  enabled: Schema.Boolean,
  /** The declared no-egress flag (a homescreen badge). */
  localOnly: Schema.Boolean,
  /** Whether this is a SMART app (the registry row carries a `client_id`). */
  smart: Schema.Boolean,
  /**
   * Whether the owner can remove this app through the admin surface: `true`
   * for cloud apps and for uploaded (non-seeded) self-hosted apps, `false` for
   * system apps and the migration-seeded self-hosted apps. The editor's Remove
   * control keys off this rather than re-deriving the rule per client.
   */
  removable: Schema.Boolean,
} as const

/** A system app catalogue entry — no typed child table, no extra fields. */
const SystemAppListEntrySchema = Schema.Struct({
  ...sharedAppFields,
  provenance: Schema.Literal('system'),
})

/**
 * A cloud app catalogue entry — carries its stored launch `url` **template**
 * (`{origin}` / `{launch}` tokens, resolved only at launch) and `requiresTunnel`
 * from the `cloud_apps` child. The template is a stored, origin-independent
 * config value, so it's safe on a read shape (it's never a concrete redirect).
 */
const CloudAppListEntrySchema = Schema.Struct({
  ...sharedAppFields,
  provenance: Schema.Literal('cloud'),
  url: Schema.String,
  requiresTunnel: Schema.Boolean,
})

/**
 * A self-hosted app catalogue entry — carries its stored `launchPath` (absent
 * for a root-served bundle) from the `self_hosted_apps` child; see
 * {@link LaunchPathSchema}.
 */
const SelfHostedAppListEntrySchema = Schema.Struct({
  ...sharedAppFields,
  provenance: Schema.Literal('self-hosted'),
  launchPath: Schema.optional(Schema.String),
})

/**
 * Wire shape for `GET /apps` (and the create / replace responses): a
 * **discriminated union on `provenance`**, mirroring the Rust `AppListEntry`.
 * The shared fields come from the `apps` parent row; each variant adds its typed
 * child-table fields. A consumer narrows on `provenance` to read
 * `url` / `requiresTunnel` (cloud) or `launchPath` (self-hosted).
 */
const AppListEntrySchema = Schema.Union(
  SystemAppListEntrySchema,
  CloudAppListEntrySchema,
  SelfHostedAppListEntrySchema
)

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
 * Body for `AppNotEditable` (409) — the app exists but can't be edited/removed:
 * a system app, a seeded self-hosted app, or (on replace) a body whose
 * `provenance` doesn't match the stored app. Mirrors the Rust `AppNotEditableBody`.
 */
const AppNotEditableSchema = Schema.Struct({
  error: Schema.Literal('AppNotEditable'),
  id: Schema.String,
})

/**
 * Body for a write-side field validation 400. `error` discriminates a bad url
 * (`InvalidUrl`), an empty name (`InvalidName`), and an unusable uploaded
 * bundle (`InvalidZip`) so the client can render the right inline message;
 * `message` is the human-readable reason. Matches the Rust server's
 * `InvalidFieldBody`.
 */
const InvalidFieldSchema = Schema.Struct({
  error: Schema.Literal('InvalidUrl', 'InvalidName', 'InvalidZip'),
  message: Schema.String,
})

/**
 * Body for `CreateApp` (cloud create). `name` is required-non-empty; `url` must
 * pass {@link AppUrlSchema}. These write-side checks close the open-redirect
 * surface a launch-time validator alone can't cover (a bad URL never reaches the
 * row).
 */
const CreateAppBodySchema = Schema.Struct({
  name: Schema.NonEmptyString,
  url: AppUrlSchema,
  requiresTunnel: Schema.Boolean,
  // Looser than the read schemas (non-empty): empty `""` clears the subtitle.
  subtitle: Schema.optional(Schema.String),
})

/**
 * Full-replace content for a **cloud** app (`PUT /apps/:id`). `name` / `url`
 * carry the same non-empty / well-formed constraints as create; empty `subtitle`
 * (`""`) or an omitted one clears it.
 */
const CloudAppContentSchema = Schema.Struct({
  provenance: Schema.Literal('cloud'),
  name: Schema.NonEmptyString,
  subtitle: Schema.optional(Schema.String),
  url: AppUrlSchema,
  requiresTunnel: Schema.Boolean,
})

/**
 * Replace content for a **self-hosted** app (`PUT /apps/:id`): just the
 * `launchPath` (see {@link LaunchPathSchema}); empty / omitted clears it back to
 * root-serving.
 */
const SelfHostedAppContentSchema = Schema.Struct({
  provenance: Schema.Literal('self-hosted'),
  launchPath: Schema.optional(LaunchPathSchema),
})

/**
 * Body for `ReplaceApp` (`PUT /apps/:id`) — a **discriminated union on
 * `provenance`**, matching the Rust `AppContentBody`. Only the editable kinds
 * have an arm (system apps are never editable); the server rejects a body whose
 * arm doesn't match the stored app's provenance (`409`).
 */
const AppContentBodySchema = Schema.Union(CloudAppContentSchema, SelfHostedAppContentSchema)

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

/**
 * Query params for `CreateSelfHostedApp` (`POST /self-hosted-apps`). The human
 * `name` is required-non-empty; the server slugs it into the app's id/subdomain
 * (auto-suffixing on a slug clash). Mirrors the Rust handler's `?name=` param.
 */
const CreateSelfHostedAppUrlParamsSchema = Schema.Struct({
  name: Schema.NonEmptyString,
})

/**
 * Request body for `CreateSelfHostedApp`: the app's static files as a raw zip
 * archive. `withEncoding({ kind: 'Uint8Array', contentType: 'application/zip' })`
 * sends the bytes verbatim (no JSON/base64 wrapping) under an `application/zip`
 * content type, matching the Rust handler's `axum::body::Bytes` reader. The
 * OpenAPI drift guard can't compare this body against utoipa's `Vec<u8>`
 * rendering, so it's excluded via `requestsNotCompared` and pinned by a focused
 * test — see `openapi-drift.test.ts`.
 */
const ZipPayloadSchema = Schema.Uint8ArrayFromSelf.pipe(
  HttpApiSchema.withEncoding({ kind: 'Uint8Array', contentType: 'application/zip' })
)

export {
  AppContentBodySchema,
  AppIdPathSchema,
  AppListEntrySchema,
  AppListSchema,
  AppNotEditableSchema,
  AppNotFoundSchema,
  AppUrlSchema,
  CloudAppListEntrySchema,
  CreateAppBodySchema,
  CreateSelfHostedAppUrlParamsSchema,
  HomeScreenEntrySchema,
  HomeScreenSchema,
  InvalidFieldSchema,
  InvalidHomeScreenSchema,
  LaunchPathSchema,
  ProvenanceSchema,
  SelfHostedAppListEntrySchema,
  SystemAppListEntrySchema,
  ZipPayloadSchema,
}
