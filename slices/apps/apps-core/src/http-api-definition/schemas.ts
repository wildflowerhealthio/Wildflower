import { Schema } from 'effect'
import { AppKindSchema, CustomAppUrlSchema } from '../registry/app-item.ts'

/** Wire shape for a single entry in the apps list. */
const AppEntrySchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /**
   * Optional. Bundled apps always carry a descriptive subtitle; custom
   * apps may have an empty `customUrl`, in which case no subtitle is
   * surfaced.
   */
  subtitle: Schema.optional(Schema.NonEmptyString),
  requiresTunnel: Schema.Boolean,
  kind: AppKindSchema,
  enabled: Schema.Boolean,
})

const AppListSchema = Schema.Array(AppEntrySchema)

const AppIdPathSchema = Schema.Struct({ id: Schema.String })

const AppNotFoundSchema = Schema.Struct({
  error: Schema.Literal('AppNotFound'),
  id: Schema.String,
})

const BundledAppImmutableSchema = Schema.Struct({
  error: Schema.Literal('BundledAppImmutable'),
  id: Schema.String,
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
})

/**
 * Body for `UpdateApp`. All fields optional; `name`/`url` carry the same
 * non-empty / well-formed constraints as on create so a partial update
 * cannot relax them.
 */
const UpdateAppBodySchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.NonEmptyString),
  url: Schema.optional(CustomAppUrlSchema),
  requiresTunnel: Schema.optional(Schema.Boolean),
})

export {
  AppEntrySchema,
  AppIdPathSchema,
  AppListSchema,
  AppNotFoundSchema,
  BundledAppImmutableSchema,
  CreateCustomAppBodySchema,
  UpdateAppBodySchema,
}
