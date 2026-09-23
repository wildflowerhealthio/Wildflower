import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'

/**
 * Arbitrary over the decoded slots of one choice element (`value[x]`,
 * `effective[x]`, …) that populates at most one of them — the only shapes
 * `choiceElementSetExclusive` lets through. Each field schema must accept
 * `null` (e.g. `Schema.NullOr(Period.Schema)`); every slot but the chosen one
 * is set to `null`, and choosing index `fields.length` leaves them all `null`.
 */
const atMostOnePopulatedSlot = <Fields extends Schema.Struct.Fields>(
  fields: Fields
): fc.Arbitrary<Schema.Struct.Type<Fields>> =>
  fc
    .tuple(
      Arbitrary.make(Schema.Struct(fields)),
      fc.integer({ min: 0, max: Object.keys(fields).length })
    )
    .map(
      ([record, keep]) =>
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.fromEntries widens to Record<string, unknown>; every key comes from `record` and each value is either its own or `null`, which every field schema accepts.
        Object.fromEntries(
          Object.entries(record).map(([key, value], index) => [key, index === keep ? value : null])
        ) as Schema.Struct.Type<Fields>
    )

export { atMostOnePopulatedSlot }
