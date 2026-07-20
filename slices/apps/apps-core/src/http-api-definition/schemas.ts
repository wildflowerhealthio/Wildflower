import { HttpApiSchema, Multipart } from '@effect/platform'
import { Schema } from 'effect'
import { InsufficientScopeSchema } from 'shared-structures-core/http-api-definition'

/**
 * Validates an app launch-URL string (mirrors the Rust server's `AppUrl`).
 * Accepts an `https://` absolute URL, an origin-relative `/path` (not `//`, a
 * protocol-relative authority), or a template starting with `{origin}`
 * (substituted at launch). Rejects `http://`, `javascript:`, `data:`, `file:`,
 * etc. — open-redirect / XSS vectors when issued through `LaunchApp`'s 302.
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
 * Validates a self-hosted app's launch path (mirrors the Rust
 * `validate_launch_path`): either the empty string (clears the launcher, back to
 * root-serving) or an origin-relative `/path` (not `//`). It hangs off the app's
 * own origin at launch, e.g. `/launch.html?launch={launch}&iss={origin}/fhir-r4`
 * with the tokens substituted per request, so absolute / authority forms are
 * rejected. See {@link AppUrlSchema}.
 */
const LaunchPathSchema = Schema.String.pipe(
  Schema.filter((value) => {
    if (value.length === 0) return true
    if (value.startsWith('/') && !value.startsWith('//')) return true
    return 'launch path must be empty or an origin-relative /path'
  })
)

/**
 * Which kind an app is — the class-table-inheritance discriminator (mirrors the
 * Rust `AppKind`): `system` (a shell route), `self-hosted` (served from the
 * device on a dedicated isolated origin), or `cloud` (a remote origin reached
 * through the tunnel). On the wire it's the lowercase-kebab string. Replaces the
 * former `provenance`.
 */
const KindSchema = Schema.Literal('system', 'self-hosted', 'cloud')

/**
 * The fields every registration carries, from the authoritative
 * `app_registrations` row — the uniform shape everything renders. `isSmart` is
 * derived from the row's soft `client_id`; `position` stays on the host (the
 * `GET /apps` array order is the display order). The per-kind detail shapes below
 * add their payload.
 */
const registrationFields = {
  id: Schema.String,
  /** The discriminator — which kind of app this is. */
  kind: KindSchema,
  /** Whether the app's tile shows on the home screen. */
  onHomescreen: Schema.Boolean,
  name: Schema.String,
  /** Optional descriptive line shown under the app name. */
  subtitle: Schema.optional(Schema.NonEmptyString),
  /** The declared no-egress flag (a homescreen badge). */
  localOnly: Schema.Boolean,
  /** Whether this is a SMART app (the registration carries a `client_id`). */
  isSmart: Schema.Boolean,
  /**
   * Whether a launch must bring the tunnel up first (the Tunnel pill). `false`
   * for system / self-hosted; meaningful only for cloud apps.
   */
  requiresTunnel: Schema.Boolean,
} as const

/**
 * Wire shape for `GET /apps` and `PUT /home-screen` — one uniform
 * `AppRegistration` per app of every kind (mirrors the Rust `AppRegistration`),
 * no `provenance` union to narrow. Everything the homescreen tile renders is
 * here; the per-kind payload (`url`, `launchPath`) is an editor concern read on a
 * per-kind detail lookup.
 */
const AppRegistrationSchema = Schema.Struct(registrationFields)

const AppListSchema = Schema.Array(AppRegistrationSchema)

/**
 * Wire shape for `GET`/`POST`/`PUT /cloud-apps…` (mirrors the Rust
 * `CloudAppDetail`) — the registration fields plus the stored launch `url`
 * **template** (`{origin}` / `{launch}` tokens, resolved only at launch) and
 * `isRemovable` (always `true` for a cloud app).
 */
const CloudAppDetailSchema = Schema.Struct({
  ...registrationFields,
  url: Schema.String,
  isRemovable: Schema.Boolean,
})

/**
 * Wire shape for `GET`/`POST`/`PUT /self-hosted-apps…` (mirrors the Rust
 * `SelfHostedAppDetail`) — the registration fields plus its stored `launchPath`
 * (absent for a root-served bundle; see {@link LaunchPathSchema}), the `seeded`
 * flag, and `isRemovable` (`!seeded`).
 */
const SelfHostedAppDetailSchema = Schema.Struct({
  ...registrationFields,
  launchPath: Schema.optional(Schema.String),
  seeded: Schema.Boolean,
  isRemovable: Schema.Boolean,
})

/**
 * Wire shape for `GET /system-apps/{id}` (mirrors the Rust `SystemAppDetail`) —
 * the registration fields plus the display-only launch `url` template. A system
 * app is never editable, so there is no create / replace shape and no `removable`.
 */
const SystemAppDetailSchema = Schema.Struct({
  ...registrationFields,
  url: Schema.String,
})

/**
 * One entry in the `PUT /home-screen` body: an app id and its desired
 * `onHomescreen` flag. The entry's **index in the array is its new display
 * `position`**, so the order is implicit and a swap is well-ordered by
 * construction. Mirrors the Rust `HomeScreenEntry`.
 */
const HomeScreenEntrySchema = Schema.Struct({
  id: Schema.String,
  onHomescreen: Schema.Boolean,
})

/**
 * Body for `PUT /home-screen` — the full ordered homescreen as
 * `{ id, onHomescreen }` entries. Must list **every** registry app exactly once
 * (array order = display order); the server renumbers `position` to the array
 * index and applies each `onHomescreen` atomically. The single writer of order +
 * placement, across every kind.
 */
const HomeScreenSchema = Schema.Array(HomeScreenEntrySchema)

const AppIdPathSchema = Schema.Struct({ id: Schema.String })

const AppNotFoundSchema = Schema.Struct({
  error: Schema.Literal('AppNotFound'),
  id: Schema.String,
})

/**
 * Body for `AppNotEditable` (409) — the app exists but can't be edited/removed:
 * a system app, or a seeded self-hosted app. (A per-kind path given an id of
 * another kind is a `404`, not a `409` — the kind mismatch can't be expressed.)
 * Mirrors the Rust `AppNotEditableBody`.
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
 * Body shared by `POST /cloud-apps` (create) and `PUT /cloud-apps/:id` (content
 * replace) — a cloud app's editable content as **JSON** (mirrors the Rust
 * `CloudAppBody`; the former multipart + `requiresTunnel`-as-text hack is gone).
 * `name` is non-empty and `url` is well-formed ({@link AppUrlSchema}); empty
 * `subtitle` (`""`) or an omitted one clears it.
 */
const CloudAppBodySchema = Schema.Struct({
  name: Schema.NonEmptyString,
  subtitle: Schema.optional(Schema.String),
  url: AppUrlSchema,
  requiresTunnel: Schema.Boolean,
})

/**
 * Body for `CreateSelfHostedApp` (`POST /self-hosted-apps`) — a
 * **`multipart/form-data`** form carrying the app `name`, an optional `subtitle`,
 * and the uploaded `bundle` zip (mirrors the Rust `CreateSelfHostedAppMultipart`).
 * A multipart client payload is an opaque `FormData`; this schema shapes the wire
 * + OpenAPI contract.
 */
const CreateSelfHostedAppBodySchema = HttpApiSchema.Multipart(
  Schema.Struct({
    name: Schema.NonEmptyString,
    // Looser than the read schemas (non-empty): empty `""` clears the subtitle.
    subtitle: Schema.optional(Schema.String),
    bundle: Multipart.FileSchema,
  })
)

/**
 * Body for `ReplaceSelfHostedApp` (`PUT /self-hosted-apps/:id`): just the
 * `launchPath` (see {@link LaunchPathSchema}); empty / omitted clears it back to
 * root-serving. Mirrors the Rust `SelfHostedAppBody`.
 */
const SelfHostedAppBodySchema = Schema.Struct({
  launchPath: Schema.optional(LaunchPathSchema),
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

/**
 * `InsufficientScopeSchema` — the shared `403 InsufficientScope` body (the caller
 * authenticated, but their token doesn't cover the scope the operation requires;
 * `missingScopes` names the scopes they must additionally hold) — is imported from
 * `shared-structures-core` and re-exported below, so apps' HttpApi definitions keep
 * sourcing every schema from this one module while the shape stays single-sourced
 * with the other slices (databases, gatekeeper) and the Rust `InsufficientScopeBody`.
 */

export {
  AppIdPathSchema,
  AppListSchema,
  AppNotEditableSchema,
  AppNotFoundSchema,
  AppRegistrationSchema,
  AppUrlSchema,
  CloudAppBodySchema,
  CloudAppDetailSchema,
  CreateSelfHostedAppBodySchema,
  HomeScreenEntrySchema,
  HomeScreenSchema,
  InsufficientScopeSchema,
  InvalidFieldSchema,
  InvalidHomeScreenSchema,
  KindSchema,
  LaunchPathSchema,
  SelfHostedAppBodySchema,
  SelfHostedAppDetailSchema,
  SystemAppDetailSchema,
}
