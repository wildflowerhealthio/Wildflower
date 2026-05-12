import { Either, Schema } from 'effect'

import * as Entity from './entity.ts'

/**
 * Two reusable test entities for `entity.test.ts` and `remote.test.ts`.
 * Mirror the shape a real entity (e.g. `PatientEntity`) takes — a
 * value built via `Entity.make`, no inheritance.
 */

const SimpleSchema = Schema.Struct({
  name: Schema.String,
  age: Schema.Number,
})

const SimpleEntity: Entity.Entity<typeof SimpleSchema.Type> = Entity.make({
  name: 'SimpleEntity',
  isFoundAt: (url) => /\/people\/\d+$/.test(url),
  parse: (init) =>
    Schema.decodeEither(Schema.parseJson(SimpleSchema))(init.body).pipe(
      Either.map((data) => ({
        resources: [data],
        links: [{ _tag: 'Open' as const, href: `/people/${data.name}` }],
      }))
    ),
})

const AnotherSchema = Schema.Struct({ id: Schema.String })

const AnotherEntity: Entity.Entity<typeof AnotherSchema.Type> = Entity.make({
  name: 'AnotherEntity',
  isFoundAt: (url) => /\/items\//.test(url),
  parse: (init) =>
    Schema.decodeEither(Schema.parseJson(AnotherSchema))(init.body).pipe(
      Either.map((data) => ({ resources: [data], links: [] }))
    ),
})

export { AnotherEntity, SimpleEntity }
