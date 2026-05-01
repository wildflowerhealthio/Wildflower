import { Schema, pipe } from 'effect'
import type { Arbitrary, FastCheck } from 'effect'

import { Schema as ElementSchema } from '../datatypes/element.ts'
import { Schema as ExtensionSchema } from '../datatypes/extension.ts'

/**
 * Factory that returns a plain Effect Schema struct for a given FHIR R4
 * BackboneElement type, plus its branded id schema and the literal resource
 * type.
 *
 * Extends {@link Element} with a `modifierExtension` array. Used for nested
 * structures within FHIR resources.
 *
 * Returns `{ Schema, ResourceType }`. Consumers spread
 * `Schema.fields` to compose per-type structs.
 */
const BackboneElementSchema = Schema.Struct({
  ...ElementSchema.fields,
  modifierExtension: pipe(
    Schema.Array(ExtensionSchema),
    Schema.annotations({
      arbitrary:
        (): Arbitrary.LazyArbitrary<readonly (typeof ExtensionSchema.Type)[]> =>
        (fc: typeof FastCheck) =>
          fc.constant([]),
    })
  ),
})

export { BackboneElementSchema as Schema }
