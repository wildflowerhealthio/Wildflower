import { Schema } from 'effect'
import { CustomAppUrlSchema } from '../registry/app-item.ts'

/**
 * Wire shape for a single entry in the apps list. Mirrors the Rust server's
 * `AppEntry` (see `apps-rust`): no provenance `kind` — custom apps are
 * identified by their `custom-` id prefix — and the launch `url` is a
 * first-class field.
 */
const AppEntrySchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /**
   * Optional. Bundled apps always carry a descriptive subtitle; custom
   * apps may have none, in which case no subtitle is surfaced.
   */
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
 * Body for `CreateCustomApp` and (partially) `UpdateApp`. `name` is
 * required-non-empty on create; `url` must pass {@link CustomAppUrlSchema}
 * (https://, origin-relative `/path`, or `{origin}` template). These
 * write-side checks close the open-redirect surface a launch-time
 * validator alone can't cover (a bad URL would never reach the row).
 */
const CreateCustomAppBodySchema = Schema.Struct({
  name: Schema.NonEmptyString,
  url: CustomAppUrlSchema,
  requiresTunnel: Schema.Boolean,
  subtitle: Schema.optional(Schema.String),
})

/**
 * Body for `UpdateApp`. All fields optional; `name`/`url` carry the same
 * non-empty / well-formed constraints as on create so a partial update
 * cannot relax them. An explicit `subtitle` (including the empty string)
 * replaces the stored subtitle.
 */
const UpdateAppBodySchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.NonEmptyString),
  url: Schema.optional(CustomAppUrlSchema),
  requiresTunnel: Schema.optional(Schema.Boolean),
  subtitle: Schema.optional(Schema.String),
})

export {
  AppEntrySchema,
  AppIdPathSchema,
  AppListSchema,
  AppNotFoundSchema,
  CreateCustomAppBodySchema,
  InvalidFieldSchema,
  UpdateAppBodySchema,
}
