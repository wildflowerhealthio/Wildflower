import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

/**
 * Metadata for a single host database — mirrors the Rust `DatabaseMetadata`
 * (`databases-rust/src/metadata.rs`, `#[serde(rename_all = "camelCase")]`).
 *
 * `sizeBytes` is `u64` on the Rust side; a SQLite file stays well under `2^53`,
 * so `Schema.Int` (not `Schema.Number`) keeps the OpenAPI type `integer` —
 * matching utoipa's `i64`/`u64` so the spec-drift contract test agrees on the
 * wire kind.
 *
 * `tableCount` / `modifiedAt` are optional (the Rust side omits them with
 * `skip_serializing_if` when the file is absent or unreadable), so
 * `Schema.optional` matches both the "may be missing" wire reality and utoipa's
 * not-required marking.
 */
const DatabaseMetadataSchema = Schema.Struct({
  /** Resource id == filename, e.g. `health-data.sqlite`. */
  id: Schema.String,
  /** Human label, e.g. `Health data`. */
  label: Schema.String,
  /** One-line description of what the database holds. */
  description: Schema.String,
  /** Whether the file currently exists on disk. */
  exists: Schema.Boolean,
  /** File size in bytes (`0` when absent). */
  sizeBytes: Schema.Int,
  /** Best-effort user-table count — the "fun" metadata. Absent when unreadable. */
  tableCount: Schema.optional(Schema.Int),
  /**
   * Last-modified time. Decodes the Rust side's RFC 3339 string to an Effect
   * `DateTime.Utc` (encoded back to a string on the wire, so the spec-drift
   * `string` contract holds). Absent when the file is absent.
   */
  modifiedAt: Schema.optional(Schema.DateTimeUtc),
  /**
   * Whether the database is scheduled for deletion at the next startup. It
   * still exists/serves until then, so the UI shows it as "scheduled — restart
   * to finish" rather than gone.
   */
  pendingDeletion: Schema.Boolean,
})

const DatabaseListSchema = Schema.Array(DatabaseMetadataSchema)

const DatabaseIdPathSchema = Schema.Struct({ id: Schema.String })

/**
 * `404` body — an unknown resource id, or a catalogued database that doesn't
 * exist on disk. Matches the Rust `DatabaseNotFoundBody`.
 */
const DatabaseNotFoundSchema = Schema.Struct({
  error: Schema.Literal('DatabaseNotFound'),
  id: Schema.String,
})

/** Success body for a delete — matches the Rust `DeletedBody`. */
const DeletedSchema = Schema.Struct({ deleted: Schema.Boolean })

/**
 * `403` body — the caller authenticated, but their token doesn't cover the
 * target database's declared scope. Matches the shared Rust
 * `InsufficientScopeBody` (`scope-capabilities-rust`); `missingScopes` names
 * the scopes the caller must additionally hold.
 */
const InsufficientScopeSchema = Schema.Struct({
  error: Schema.Literal('InsufficientScope'),
  missingScopes: Schema.Array(Schema.String),
})

/**
 * Data-management endpoints — the JSON surface over the host's SQLite
 * databases. The group carries no middleware; the host authenticates the whole
 * `/databases` surface behind the gatekeeper bearer gate, each database's
 * download/delete is additionally gated by its declared scope on the Rust side
 * (a `403 InsufficientScope` when the token doesn't cover it), and the TS
 * client layer still attaches the bearer (see
 * `databases-react/src/client/databases-client.ts`).
 *
 * The binary export endpoint (`GET /databases/:id`) is deliberately NOT modelled
 * here: its body is a raw SQLite stream, so the React side downloads it through
 * the platform `HttpClient` rather than this generated JSON client. It's
 * documented on the Rust/utoipa side only; the spec-drift test scopes just the
 * two JSON endpoints below.
 */
const httpApiGroup = HttpApiGroup.make('databases', { topLevel: false })
  .add(HttpApiEndpoint.get('ListDatabases', '/databases').addSuccess(DatabaseListSchema))
  .add(
    HttpApiEndpoint.del('DeleteDatabase', '/databases/:id')
      .setPath(DatabaseIdPathSchema)
      .addSuccess(DeletedSchema)
      .addError(InsufficientScopeSchema, { status: 403 })
      .addError(DatabaseNotFoundSchema, { status: 404 })
  )

export {
  DatabaseIdPathSchema,
  DatabaseListSchema,
  DatabaseMetadataSchema,
  DatabaseNotFoundSchema,
  DeletedSchema,
  InsufficientScopeSchema,
  httpApiGroup,
}
