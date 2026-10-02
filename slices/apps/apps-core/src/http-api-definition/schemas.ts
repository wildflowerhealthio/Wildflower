import { Schema } from 'effect'
import { InsufficientScopeSchema } from 'shared-structures-core/http-api-definition'

/**
 * Validates an app launch-URL string. Stricter than the Rust server's `AppUrl`,
 * which also accepts `http://`. Accepts an `https://` absolute URL, an
 * origin-relative `/path` (not `//`, a protocol-relative authority), or a
 * template starting with `{origin}` (substituted at launch). Rejects `http://`,
 * `javascript:`, `data:`, `file:`, etc. — open-redirect / XSS vectors when a
 * launch hands the URL to a browser.
 */
const AppUrlSchema = Schema.String.pipe(
  Schema.filter((value) => {
    if (value.length === 0) return 'url must not be empty'
    if (value.startsWith('{origin}')) return true
    if (value.startsWith('/') && !value.startsWith('//')) return true
    if (value.startsWith('https://')) return true
    return 'url must be an absolute https:// URL, an origin-relative /path, or start with the {origin} placeholder'
  })
)

/**
 * Wire shape for `GET /apps`, `PUT /home-screen`, and `GET`/`POST`/`PUT /apps…`
 * — one `AppRegistration` per app (mirrors the Rust `AppRegistration`). `isSmart`
 * is derived from the row's soft `client_id`; `position` stays on the host (the
 * `GET /apps` array order is the display order).
 */
const AppRegistrationSchema = Schema.Struct({
  id: Schema.String,
  /** Whether the app's tile shows on the home screen. */
  onHomescreen: Schema.Boolean,
  name: Schema.String,
  /** Optional descriptive line shown under the app name. */
  subtitle: Schema.optional(Schema.NonEmptyString),
  /**
   * The stored launch URL **template** (`{origin}` / `{launch}` tokens, resolved
   * only at launch).
   */
  url: Schema.String,
  /** The declared no-egress flag (a homescreen badge). */
  localOnly: Schema.Boolean,
  /** Whether this is a SMART app (the registration carries a `client_id`). */
  isSmart: Schema.Boolean,
  /** Whether a launch must bring the tunnel up first (the Tunnel pill). */
  requiresTunnel: Schema.Boolean,
})

const AppListSchema = Schema.Array(AppRegistrationSchema)

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
 * placement.
 */
const HomeScreenSchema = Schema.Array(HomeScreenEntrySchema)

const AppIdPathSchema = Schema.Struct({ id: Schema.String })

const AppNotFoundSchema = Schema.Struct({
  error: Schema.Literal('AppNotFound'),
  id: Schema.String,
})

/**
 * Body for a write-side field validation 400. `error` discriminates a bad url
 * (`InvalidUrl`) from an empty name (`InvalidName`) so the client can render
 * the right inline message;
 * `message` is the human-readable reason. Matches the Rust server's
 * `InvalidFieldBody`.
 */
const InvalidFieldSchema = Schema.Struct({
  error: Schema.Literal('InvalidUrl', 'InvalidName'),
  message: Schema.String,
})

/**
 * Body shared by `POST /apps` (create) and `PUT /apps/:id` (content replace) — an
 * app's editable content as **JSON** (mirrors the Rust `AppBody`).
 * `name` is non-empty and `url` is well-formed ({@link AppUrlSchema}); empty
 * `subtitle` (`""`) or an omitted one clears it.
 */
const AppBodySchema = Schema.Struct({
  name: Schema.NonEmptyString,
  subtitle: Schema.optional(Schema.String),
  url: AppUrlSchema,
  requiresTunnel: Schema.Boolean,
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

/**
 * A forwarded launch's `200` body: the resolved launch URL for the calling page to
 * navigate to (mirrors the Rust `LaunchTargetBody`). A loopback launch answers
 * `204` instead — the host opened the app itself.
 */
const LaunchTargetSchema = Schema.Struct({ url: Schema.String })

export {
  AppBodySchema,
  AppIdPathSchema,
  AppListSchema,
  AppNotFoundSchema,
  AppRegistrationSchema,
  AppUrlSchema,
  HomeScreenEntrySchema,
  HomeScreenSchema,
  InsufficientScopeSchema,
  InvalidFieldSchema,
  InvalidHomeScreenSchema,
  LaunchTargetSchema,
}
