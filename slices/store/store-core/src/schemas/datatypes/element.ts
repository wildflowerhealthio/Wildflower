import { type Arbitrary, type FastCheck, Schema, pipe } from 'effect'

import { Schema as ExtensionSchema } from './extension.ts'

const ElementSchema = Schema.Struct({
  // `Arbitrary.make(...)` always emits `null`. Random ids inflate property-test
  // payloads without exercising any new schema code path; tests that care
  // about non-null ids construct them explicitly.
  id: pipe(
    Schema.NullOr(Schema.String),
    Schema.annotations({
      arbitrary: (): Arbitrary.LazyArbitrary<null | string> => (fc: typeof FastCheck) =>
        fc.constant(null),
    })
  ),
  // `Arbitrary.make(...)` always emits `[]`. Each Extension carries the full
  // ~50-field value[x] choice plus the Reference/Identifier cycle, so non-empty
  // extension arrays explode generation cost. Recursion through `extension` is
  // exercised explicitly by `cycles.test.ts`.
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
