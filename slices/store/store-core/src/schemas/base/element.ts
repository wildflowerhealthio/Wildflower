import { type Arbitrary, type FastCheck, Schema, pipe } from 'effect'

import { Schema as ExtensionSchema } from '../special-purpose/extension.ts'

const ElementSchema = Schema.Struct({
  id: pipe(
    Schema.NullOr(Schema.String),
    Schema.annotations({
      arbitrary: (): Arbitrary.LazyArbitrary<null | string> => (fc: typeof FastCheck) =>
        fc.constant(null),
    })
  ),
  extension: pipe(
    Schema.Array(ExtensionSchema),
    Schema.annotations({
      arbitrary:
        (): Arbitrary.LazyArbitrary<readonly (typeof ExtensionSchema.Type)[]> =>
        (fc: typeof FastCheck) =>
          fc.constant([]),
    })
  ),
})

export { ElementSchema as Schema }
