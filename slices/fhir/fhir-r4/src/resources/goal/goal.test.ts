import { AnnotateArrayWithArbitrary } from '@wildflowerhealthio/kitchen-sink/schema'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import {
  atLeastTwoPopulatedSlots,
  atMostOnePopulatedSlot,
  expectChoiceElementGuardFailure,
} from '../../data-types/base/choice-element-passthrough-fields.test-helpers.ts'
import { Code } from '../../data-types/base/code.ts'
import { DateSchema } from '../../data-types/base/primitives.ts'
import {
  Annotation,
  CodeableConcept,
  Duration,
  IdentifierAndReference,
  Meta,
  Quantity,
  Range,
  Ratio,
} from '../../data-types/index.ts'
import * as GoalTarget from './goal-target.ts'
import * as Goal from './goal.ts'
import { SearchParams } from './search-params.ts'

// ---------------------------------------------------------------------------
// Decomposed wire-format proof (see observation.test.ts): each property
// generates one field group from the component schema the struct embeds,
// spreads it over a fixed shell, and round-trips the WHOLE Goal.
// ---------------------------------------------------------------------------

const sampleGoal: typeof Goal.Schema.Type = {
  resourceType: 'Goal',
  id: 'goal-1',
  implicitRules: null,
  language: null,
  meta: null,
  contained: [],
  extension: [],
  modifierExtension: [],
  text: null,
  identifier: [],
  lifecycleStatus: 'active',
  achievementStatus: null,
  category: [],
  priority: null,
  description: { id: null, extension: [], coding: [], text: 'Walk 10,000 steps a day' },
  subject: {
    id: null,
    extension: [],
    reference: 'Patient/p-1',
    type: null,
    identifier: null,
    display: null,
  },
  startDate: null,
  startCodeableConcept: null,
  target: [],
  statusDate: null,
  statusReason: null,
  expressedBy: null,
  addresses: [],
  note: [],
  outcomeCode: [],
  outcomeReference: [],
}

const sampleTarget: typeof GoalTarget.Schema.Type = {
  id: null,
  extension: [],
  modifierExtension: [],
  measure: null,
  detailQuantity: null,
  detailRange: null,
  detailCodeableConcept: null,
  detailString: null,
  detailBoolean: null,
  detailInteger: null,
  detailRatio: null,
  dueDate: null,
  dueDuration: null,
}

/** The shell goal carrying the single target `target`. */
const withTarget = (target: typeof GoalTarget.Schema.Type): typeof Goal.Schema.Type => ({
  ...sampleGoal,
  target: [target],
})

const roundTrip = (resource: typeof Goal.Schema.Type): void => {
  const fhir = Schema.encodeSync(Goal.Schema)(resource)
  const decoded = Schema.decodeSync(Goal.Schema)(fhir)
  expect(decoded).toSchemaEqual(Goal.Schema, resource)
}

const overrideArb = <Fields extends Schema.Struct.Fields>(
  fields: Fields
): fc.Arbitrary<Schema.Schema.Type<Schema.Struct<Fields>>> => Arbitrary.make(Schema.Struct(fields))

const referenceArray = Schema.Array(IdentifierAndReference.ReferenceSchema).pipe(
  AnnotateArrayWithArbitrary({ maxLength: 2 })
)

const codeableConceptArray = Schema.Array(CodeableConcept.Schema).pipe(
  AnnotateArrayWithArbitrary({ maxLength: 2 })
)

describe('FhirR4Goal', () => {
  test('decodes a minimal wire goal, defaulting every absent field', () => {
    // Arrange — only the 1..1 elements
    const wire = {
      resourceType: 'Goal',
      id: 'goal-1',
      lifecycleStatus: 'active',
      description: { text: 'Walk 10,000 steps a day' },
      subject: { reference: 'Patient/p-1' },
    }

    // Act
    const decoded = Schema.decodeUnknownSync(Goal.Schema)(wire)

    // Assert
    expect(decoded).toSchemaEqual(Goal.Schema, sampleGoal)
  })

  test('encode-decode round-trip with shell goal', () => {
    roundTrip(sampleGoal)
  })

  test('encode-decode round-trip with a shell target', () => {
    roundTrip(withTarget(sampleTarget))
  })

  test.each(['lifecycleStatus', 'description', 'subject'] as const)(
    'rejects a goal with no %s — the spec marks it 1..1',
    (field) => {
      const { [field]: _dropped, ...without } = Schema.encodeSync(Goal.Schema)(sampleGoal)
      expect(Schema.decodeUnknownEither(Goal.Schema)(without)._tag).toBe('Left')
    }
  )

  test('rejects a lifecycleStatus outside the Goal value set', () => {
    const wire = Schema.encodeSync(Goal.Schema)(sampleGoal)
    expect(
      Schema.decodeUnknownEither(Goal.Schema)({ ...wire, lifecycleStatus: 'bogus' })._tag
    ).toBe('Left')
  })

  // `start[x]` / `target.due[x]`'s `date` variant keeps the wire string, so a
  // written Goal carries a conformant FHIR `date` at the precision it was read.
  describe('date choice slots', () => {
    const wireGoal = Schema.encodeSync(Goal.Schema)(sampleGoal)

    test.each(['2026-01-15', '2026-01', '2026'])(
      'startDate %s survives decode → encode unchanged',
      (startDate) => {
        const decoded = Schema.decodeUnknownSync(Goal.Schema)({ ...wireGoal, startDate })
        expect(Schema.encodeSync(Goal.Schema)(decoded).startDate).toBe(startDate)
      }
    )

    test.each(['2026-01-15', '2026-01', '2026'])(
      'target.dueDate %s survives decode → encode unchanged',
      (dueDate) => {
        const decoded = Schema.decodeUnknownSync(Goal.Schema)({
          ...wireGoal,
          target: [{ dueDate }],
        })
        expect(Schema.encodeSync(Goal.Schema)(decoded).target?.[0]?.dueDate).toBe(dueDate)
      }
    )

    test.each(['2026-1-5', '20260115', '2026-01-15T00:00:00.000Z'])(
      'rejects a malformed startDate %s on decode',
      (startDate) => {
        expect(Schema.decodeUnknownEither(Goal.Schema)({ ...wireGoal, startDate })._tag).toBe(
          'Left'
        )
      }
    )
  })

  test('property: lifecycleStatus round-trips', () => {
    fc.assert(
      fc.property(overrideArb({ lifecycleStatus: Goal.LifecycleStatusSchema }), (override) =>
        roundTrip({ ...sampleGoal, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: identifier[] round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          identifier: Schema.Array(IdentifierAndReference.IdentifierSchema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...sampleGoal, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: reference fields round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          subject: IdentifierAndReference.ReferenceSchema,
          expressedBy: Schema.NullOr(IdentifierAndReference.ReferenceSchema),
          addresses: referenceArray,
          outcomeReference: referenceArray,
        }),
        (override) => roundTrip({ ...sampleGoal, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: CodeableConcept fields round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          achievementStatus: Schema.NullOr(CodeableConcept.Schema),
          category: codeableConceptArray,
          priority: Schema.NullOr(CodeableConcept.Schema),
          description: CodeableConcept.Schema,
          outcomeCode: codeableConceptArray,
        }),
        (override) => roundTrip({ ...sampleGoal, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: note round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          note: Schema.Array(Annotation.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
        }),
        (override) => roundTrip({ ...sampleGoal, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: shell primitives round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          statusDate: Schema.NullOr(Schema.String),
          statusReason: Schema.NullOr(Schema.String),
          language: Schema.NullOr(Code),
          implicitRules: Schema.NullOr(Schema.URL),
          meta: Schema.NullOr(Meta.Schema),
        }),
        (override) => roundTrip({ ...sampleGoal, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: start[x] choice field round-trips', () => {
    fc.assert(
      fc.property(
        atMostOnePopulatedSlot({
          startDate: Schema.NullOr(DateSchema),
          startCodeableConcept: Schema.NullOr(CodeableConcept.Schema),
        }),
        (override) => roundTrip({ ...sampleGoal, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: target[] round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          target: Schema.Array(GoalTarget.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...sampleGoal, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  describe('target', () => {
    test('property: measure round-trips', () => {
      fc.assert(
        fc.property(overrideArb({ measure: Schema.NullOr(CodeableConcept.Schema) }), (override) =>
          roundTrip(withTarget({ ...sampleTarget, ...override }))
        ),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })

    test('property: detail[x] choice field round-trips', () => {
      fc.assert(
        fc.property(
          atMostOnePopulatedSlot({
            detailQuantity: Schema.NullOr(Quantity.Schema),
            detailRange: Schema.NullOr(Range.Schema),
            detailCodeableConcept: Schema.NullOr(CodeableConcept.Schema),
            detailString: Schema.NullOr(Schema.String),
            detailBoolean: Schema.NullOr(Schema.Boolean),
            detailInteger: Schema.NullOr(Schema.Int),
            detailRatio: Schema.NullOr(Ratio.Schema),
          }),
          (override) => roundTrip(withTarget({ ...sampleTarget, ...override }))
        ),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })

    test('property: due[x] choice field round-trips', () => {
      fc.assert(
        fc.property(
          atMostOnePopulatedSlot({
            dueDate: Schema.NullOr(DateSchema),
            dueDuration: Schema.NullOr(Duration.Schema),
          }),
          (override) => roundTrip(withTarget({ ...sampleTarget, ...override }))
        ),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })
  })

  describe('start[x] at-most-one guard', () => {
    const slots = atLeastTwoPopulatedSlots({
      startDate: DateSchema,
      startCodeableConcept: CodeableConcept.Schema,
    })

    test('property: rejects decoding a wire goal populating both slots', () => {
      fc.assert(
        fc.property(slots, (populated) => {
          // Arrange — each slot's wire JSON, merged onto the shell goal's
          const wire = {
            ...Schema.encodeSync(Goal.Schema)(sampleGoal),
            ...Object.fromEntries(populated.map(([key, value]) => [key, wireGoalSlot(key, value)])),
          }

          // Act
          const result = Schema.decodeUnknownEither(Goal.Schema)(wire)

          // Assert
          expectChoiceElementGuardFailure(result, 'start', populated)
        }),
        { numRuns: numRunsFor({ base: 50 }) }
      )
    })

    test('property: rejects encoding a goal populating both slots', () => {
      fc.assert(
        fc.property(slots, (populated) => {
          // Act
          const result = Schema.encodeEither(Goal.Schema)({
            ...sampleGoal,
            ...Object.fromEntries(populated),
          })

          // Assert
          expectChoiceElementGuardFailure(result, 'start', populated)
        }),
        { numRuns: numRunsFor({ base: 50 }) }
      )
    })
  })

  describe.each([
    {
      prefix: 'detail',
      slots: atLeastTwoPopulatedSlots({
        detailQuantity: Quantity.Schema,
        detailRange: Range.Schema,
        detailCodeableConcept: CodeableConcept.Schema,
        detailString: Schema.String,
        detailBoolean: Schema.Boolean,
        detailInteger: Schema.Int,
        detailRatio: Ratio.Schema,
      }),
    },
    {
      prefix: 'due',
      slots: atLeastTwoPopulatedSlots({ dueDate: DateSchema, dueDuration: Duration.Schema }),
    },
  ])('target.$prefix[x] at-most-one guard', ({ prefix, slots }) => {
    test('property: rejects decoding a wire goal populating two or more slots', () => {
      fc.assert(
        fc.property(slots, (populated) => {
          // Arrange — each slot's wire JSON, merged onto the shell target's
          const wireTarget = {
            ...Schema.encodeSync(GoalTarget.Schema)(sampleTarget),
            ...Object.fromEntries(
              populated.map(([key, value]) => [key, wireTargetSlot(key, value)])
            ),
          }

          // Act
          const result = Schema.decodeUnknownEither(Goal.Schema)({
            ...Schema.encodeSync(Goal.Schema)(sampleGoal),
            target: [wireTarget],
          })

          // Assert
          expectChoiceElementGuardFailure(result, prefix, populated)
        }),
        { numRuns: numRunsFor({ base: 50 }) }
      )
    })

    test('property: rejects encoding a goal populating two or more slots', () => {
      fc.assert(
        fc.property(slots, (populated) => {
          // Act
          const result = Schema.encodeEither(Goal.Schema)(
            withTarget({ ...sampleTarget, ...Object.fromEntries(populated) })
          )

          // Assert
          expectChoiceElementGuardFailure(result, prefix, populated)
        }),
        { numRuns: numRunsFor({ base: 50 }) }
      )
    })
  })
})

describe('GoalSearchParams', () => {
  test('carries every declared parameter through the wire unchanged', () => {
    // Arrange
    const query = {
      _count: '20',
      _pageToken: 'opaque-server-token',
      _id: 'goal-1',
      'lifecycle-status': 'active',
      subject: 'Patient/p-1',
      patient: 'p-1',
    }

    // Act
    const reEncoded = Schema.encodeSync(SearchParams)(Schema.decodeUnknownSync(SearchParams)(query))

    // Assert
    expect(reEncoded).toEqual(query)
  })

  test.each([
    { reason: 'a lifecycle-status outside the Goal value set', query: { 'lifecycle-status': 'x' } },
    { reason: 'a _count above the 1000 page ceiling', query: { _count: '1001' } },
  ])('rejects $reason', ({ query }) => {
    expect(Schema.decodeUnknownEither(SearchParams)(query)._tag).toBe('Left')
  })
})

// Helpers

// The wire JSON of one `Goal.start[x]` slot, encoded through the whole goal.
const wireGoalSlot = (key: string, value: unknown): unknown => {
  const encoded: Readonly<Record<string, unknown>> = {
    ...Schema.encodeSync(Goal.Schema)({ ...sampleGoal, [key]: value }),
  }
  return encoded[key]
}

// The wire JSON of one `Goal.target` choice slot, encoded through the whole target.
const wireTargetSlot = (key: string, value: unknown): unknown => {
  const encoded: Readonly<Record<string, unknown>> = {
    ...Schema.encodeSync(GoalTarget.Schema)({ ...sampleTarget, [key]: value }),
  }
  return encoded[key]
}
