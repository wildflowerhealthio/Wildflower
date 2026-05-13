import { Effect, Schema } from 'effect'

import * as EntityDefinition from './model/entity-definition.ts'

/**
 * Two reusable test entities for `entity-definition.test.ts` and
 * `collector-bridge-message-handler.test.ts`. Mirror the shape a real
 * entity (e.g. `PatientEntity`) takes — a value built via
 * `EntityDefinition.make`, no inheritance.
 */

const SimpleSchema = Schema.Struct({
  name: Schema.String,
  age: Schema.Number,
})

const SimpleEntity: EntityDefinition.EntityDefinition<typeof SimpleSchema.Type> =
  EntityDefinition.make({
    name: 'SimpleEntity',
    isFoundAt: (url) => /\/people\/\d+$/.test(url),
    parse: (response) =>
      Effect.map(Schema.decode(Schema.parseJson(SimpleSchema))(response.text()), (data) => [data]),
  })

const AnotherSchema = Schema.Struct({ id: Schema.String })

const AnotherEntity: EntityDefinition.EntityDefinition<typeof AnotherSchema.Type> =
  EntityDefinition.make({
    name: 'AnotherEntity',
    isFoundAt: (url) => /\/items\//.test(url),
    parse: (response) =>
      Effect.map(Schema.decode(Schema.parseJson(AnotherSchema))(response.text()), (data) => [data]),
  })

export { AnotherEntity, SimpleEntity }
