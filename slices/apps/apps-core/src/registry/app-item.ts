import { Schema } from 'effect'

const AppIdSchema = Schema.String.pipe(Schema.brand('AppItem/id'))
type AppId = typeof AppIdSchema.Type

const AppKindSchema = Schema.Literal('bundled', 'custom', 'action')
type AppKind = typeof AppKindSchema.Type

interface BundledApp {
  readonly id: AppId
  readonly name: string
  readonly subtitle: string
  readonly kind: 'bundled' | 'action'
  readonly requiresTunnel: boolean
  readonly url: (origin: string, launch: string) => string
}

const CustomAppSchema = Schema.Struct({
  id: AppIdSchema,
  name: Schema.String,
  url: Schema.String,
  requiresTunnel: Schema.Boolean,
})
type CustomApp = typeof CustomAppSchema.Type

const makeAppId = (value: string): AppId => AppIdSchema.make(value)

export { AppIdSchema, AppKindSchema, CustomAppSchema, makeAppId }
export type { AppId, AppKind, BundledApp, CustomApp }
