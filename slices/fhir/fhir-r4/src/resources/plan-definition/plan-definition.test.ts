import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { AnnotateArrayWithArbitrary } from 'kitchen-sink/schema'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import {
  atLeastTwoPopulatedSlots,
  atMostOnePopulatedSlot,
  expectChoiceElementGuardFailure,
} from '../../data-types/base/choice-element-passthrough-fields.test-helpers.ts'
import { Code } from '../../data-types/base/code.ts'
import { UriSchema } from '../../data-types/base/primitives.ts'
import {
  CodeableConcept,
  Duration,
  IdentifierAndReference,
  Meta,
  Period,
  Range,
  Timing,
} from '../../data-types/index.ts'
import * as PlanDefinitionAction from './plan-definition-action.ts'
import * as PlanDefinition from './plan-definition.ts'
import { SearchParams } from './search-params.ts'

// ---------------------------------------------------------------------------
// Decomposed wire-format proof (see observation.test.ts): each property
// generates one field group from the component schema the struct embeds,
// spreads it over a fixed shell, and round-trips the WHOLE PlanDefinition.
// ---------------------------------------------------------------------------

const samplePlanDefinition: typeof PlanDefinition.Schema.Type = {
  resourceType: 'PlanDefinition',
  id: 'pd-1',
  implicitRules: null,
  language: null,
  meta: null,
  contained: [],
  extension: [],
  modifierExtension: [],
  text: null,
  url: null,
  identifier: [],
  version: null,
  name: null,
  title: null,
  subtitle: null,
  type: null,
  status: 'active',
  experimental: null,
  subjectCodeableConcept: null,
  subjectReference: null,
  date: null,
  publisher: null,
  contact: [],
  description: null,
  useContext: [],
  jurisdiction: [],
  purpose: null,
  usage: null,
  copyright: null,
  approvalDate: null,
  lastReviewDate: null,
  effectivePeriod: null,
  topic: [],
  author: [],
  editor: [],
  reviewer: [],
  endorser: [],
  relatedArtifact: [],
  library: [],
  goal: [],
  action: [],
}

const sampleAction: typeof PlanDefinitionAction.Schema.Type = {
  id: null,
  extension: [],
  modifierExtension: [],
  prefix: null,
  title: null,
  description: null,
  textEquivalent: null,
  priority: null,
  code: [],
  reason: [],
  documentation: [],
  goalId: [],
  subjectCodeableConcept: null,
  subjectReference: null,
  trigger: [],
  condition: [],
  input: [],
  output: [],
  relatedAction: [],
  timingDateTime: null,
  timingAge: null,
  timingPeriod: null,
  timingDuration: null,
  timingRange: null,
  timingTiming: null,
  participant: [],
  type: null,
  groupingBehavior: null,
  selectionBehavior: null,
  requiredBehavior: null,
  precheckBehavior: null,
  cardinalityBehavior: null,
  definitionCanonical: null,
  definitionUri: null,
  transform: null,
  dynamicValue: [],
  action: [],
}

/** The shell plan definition carrying the single action `action`. */
const withAction = (
  action: typeof PlanDefinitionAction.Schema.Type
): typeof PlanDefinition.Schema.Type => ({
  ...samplePlanDefinition,
  action: [action],
})

const roundTrip = (resource: typeof PlanDefinition.Schema.Type): void => {
  const fhir = Schema.encodeSync(PlanDefinition.Schema)(resource)
  const decoded = Schema.decodeSync(PlanDefinition.Schema)(fhir)
  expect(decoded).toSchemaEqual(PlanDefinition.Schema, resource)
}

// The wire → decoded → wire image of `wire`. Used for the untyped
// (`Schema.Any`) passthroughs, whose decoded values carry no schema
// equivalence beyond reference identity, so they are compared as wire JSON.
const reEncode = (wire: unknown): typeof PlanDefinition.Schema.Encoded =>
  Schema.encodeSync(PlanDefinition.Schema)(Schema.decodeUnknownSync(PlanDefinition.Schema)(wire))

// The entries of `encoded` under the keys of `expected` — the fields a
// passthrough property populated, without the defaulted rest.
const pickKeysOf = (
  encoded: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>
): Record<string, unknown> =>
  Object.fromEntries(Object.keys(expected).map((key) => [key, encoded[key]]))

const overrideArb = <Fields extends Schema.Struct.Fields>(
  fields: Fields
): fc.Arbitrary<Schema.Schema.Type<Schema.Struct<Fields>>> => Arbitrary.make(Schema.Struct(fields))

const codeableConceptArray = Schema.Array(CodeableConcept.Schema).pipe(
  AnnotateArrayWithArbitrary({ maxLength: 2 })
)

// A JSON array of JSON objects — the wire shape of every passthrough field.
const passthroughWireArray = fc.array(fc.dictionary(fc.string(), fc.jsonValue()), {
  maxLength: 2,
})

describe('FhirR4PlanDefinition', () => {
  test('decodes a minimal wire plan definition, defaulting every absent field', () => {
    // Arrange — only the 1..1 elements
    const wire = { resourceType: 'PlanDefinition', id: 'pd-1', status: 'active' }

    // Act
    const decoded = Schema.decodeUnknownSync(PlanDefinition.Schema)(wire)

    // Assert
    expect(decoded).toSchemaEqual(PlanDefinition.Schema, samplePlanDefinition)
  })

  test('encode-decode round-trip with shell plan definition', () => {
    roundTrip(samplePlanDefinition)
  })

  test('encode-decode round-trip with a shell action', () => {
    roundTrip(withAction(sampleAction))
  })

  test.each(['status', 'resourceType'] as const)(
    'rejects a plan definition with no %s — the spec marks it 1..1',
    (field) => {
      const { [field]: _dropped, ...without } = Schema.encodeSync(PlanDefinition.Schema)(
        samplePlanDefinition
      )
      expect(Schema.decodeUnknownEither(PlanDefinition.Schema)(without)._tag).toBe('Left')
    }
  )

  test.each([
    // `completed` is a request status, not a publication status
    { field: 'status', value: 'completed' },
    { field: 'resourceType', value: 'ActivityDefinition' },
  ])('rejects $field=$value', ({ field, value }) => {
    const wire = Schema.encodeSync(PlanDefinition.Schema)(samplePlanDefinition)
    expect(
      Schema.decodeUnknownEither(PlanDefinition.Schema)({ ...wire, [field]: value })._tag
    ).toBe('Left')
  })

  test.each([
    { field: 'priority', value: 'eventually' },
    { field: 'groupingBehavior', value: 'any' },
    { field: 'selectionBehavior', value: 'none' },
    { field: 'requiredBehavior', value: 'should' },
    { field: 'precheckBehavior', value: 'maybe' },
    { field: 'cardinalityBehavior', value: 'many' },
  ])('rejects action.$field=$value outside its value set', ({ field, value }) => {
    expect(
      Schema.decodeUnknownEither(PlanDefinition.Schema)({
        ...Schema.encodeSync(PlanDefinition.Schema)(samplePlanDefinition),
        action: [{ [field]: value }],
      })._tag
    ).toBe('Left')
  })

  test('property: status round-trips', () => {
    fc.assert(
      fc.property(overrideArb({ status: PlanDefinition.StatusSchema }), (override) =>
        roundTrip({ ...samplePlanDefinition, ...override })
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
        (override) => roundTrip({ ...samplePlanDefinition, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: type, jurisdiction, topic and effectivePeriod round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          type: Schema.NullOr(CodeableConcept.Schema),
          jurisdiction: codeableConceptArray,
          topic: codeableConceptArray,
          effectivePeriod: Schema.NullOr(Period.Schema),
        }),
        (override) => roundTrip({ ...samplePlanDefinition, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: shell primitives round-trip', () => {
    const nullableString = Schema.NullOr(Schema.String)
    fc.assert(
      fc.property(
        overrideArb({
          url: nullableString,
          version: nullableString,
          name: nullableString,
          title: nullableString,
          subtitle: nullableString,
          experimental: Schema.NullOr(Schema.Boolean),
          date: nullableString,
          publisher: nullableString,
          description: nullableString,
          purpose: nullableString,
          usage: nullableString,
          copyright: nullableString,
          approvalDate: nullableString,
          lastReviewDate: nullableString,
          library: Schema.Array(Schema.String),
          language: Schema.NullOr(Code),
          implicitRules: Schema.NullOr(Schema.URL),
          meta: Schema.NullOr(Meta.Schema),
        }),
        (override) => roundTrip({ ...samplePlanDefinition, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: passthrough arrays re-encode to the wire unchanged', () => {
    fc.assert(
      fc.property(
        fc.record({
          contact: passthroughWireArray,
          useContext: passthroughWireArray,
          author: passthroughWireArray,
          editor: passthroughWireArray,
          reviewer: passthroughWireArray,
          endorser: passthroughWireArray,
          relatedArtifact: passthroughWireArray,
          goal: passthroughWireArray,
        }),
        (passthroughs) => {
          const encoded = reEncode({
            resourceType: 'PlanDefinition',
            status: 'draft',
            ...passthroughs,
          })
          expect(pickKeysOf({ ...encoded }, passthroughs)).toEqual(passthroughs)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: subject[x] choice field round-trips', () => {
    fc.assert(
      fc.property(
        atMostOnePopulatedSlot({
          subjectCodeableConcept: Schema.NullOr(CodeableConcept.Schema),
          subjectReference: Schema.NullOr(IdentifierAndReference.ReferenceSchema),
        }),
        (override) => roundTrip({ ...samplePlanDefinition, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: action[] round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          action: Schema.Array(PlanDefinitionAction.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...samplePlanDefinition, ...override })
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('a nested action keeps its sub-action, code and extension through the wire', () => {
    // Arrange
    const wire = {
      resourceType: 'PlanDefinition',
      status: 'active',
      action: [
        {
          title: 'Week 1',
          selectionBehavior: 'all',
          action: [
            {
              title: 'Back squat',
              code: [{ coding: [{ system: 'http://example.com/lifts', code: 'squat' }] }],
              extension: [{ url: 'http://example.com/sets', valueInteger: 5 }],
            },
          ],
        },
      ],
    }

    // Act
    const decoded = Schema.decodeUnknownSync(PlanDefinition.Schema)(wire)

    // Assert
    const subAction = decoded.action[0]?.action[0]
    expect(subAction?.title).toBe('Back squat')
    expect(subAction?.code[0]?.coding[0]?.code).toBe('squat')
    expect(subAction?.extension[0]?.valueInteger).toBe(5)
    // Encode also emits the defaulted fields, so compare only what the wire set
    expect(Schema.encodeSync(PlanDefinition.Schema)(decoded)).toMatchObject(wire)
  })

  test('a nested action’s choice-element guard still applies', () => {
    const result = Schema.decodeUnknownEither(PlanDefinition.Schema)({
      resourceType: 'PlanDefinition',
      status: 'active',
      action: [
        {
          action: [{ definitionCanonical: 'http://a.example', definitionUri: 'http://b.example' }],
        },
      ],
    })
    expectChoiceElementGuardFailure(result, 'definition', [
      ['definitionCanonical', 'http://a.example'],
      ['definitionUri', 'http://b.example'],
    ])
  })

  describe('action', () => {
    test('property: non-choice fields round-trip', () => {
      const nullableString = Schema.NullOr(Schema.String)
      fc.assert(
        fc.property(
          overrideArb({
            prefix: nullableString,
            title: nullableString,
            description: nullableString,
            textEquivalent: nullableString,
            priority: Schema.NullOr(PlanDefinitionAction.PrioritySchema),
            code: codeableConceptArray,
            reason: codeableConceptArray,
            goalId: Schema.Array(Schema.String),
            type: Schema.NullOr(CodeableConcept.Schema),
            groupingBehavior: Schema.NullOr(PlanDefinitionAction.GroupingBehaviorSchema),
            selectionBehavior: Schema.NullOr(PlanDefinitionAction.SelectionBehaviorSchema),
            requiredBehavior: Schema.NullOr(PlanDefinitionAction.RequiredBehaviorSchema),
            precheckBehavior: Schema.NullOr(PlanDefinitionAction.PrecheckBehaviorSchema),
            cardinalityBehavior: Schema.NullOr(PlanDefinitionAction.CardinalityBehaviorSchema),
            transform: nullableString,
          }),
          (override) => roundTrip(withAction({ ...sampleAction, ...override }))
        ),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })

    test('property: passthrough arrays re-encode to the wire unchanged', () => {
      fc.assert(
        fc.property(
          fc.record({
            documentation: passthroughWireArray,
            trigger: passthroughWireArray,
            condition: passthroughWireArray,
            input: passthroughWireArray,
            output: passthroughWireArray,
            relatedAction: passthroughWireArray,
            participant: passthroughWireArray,
            dynamicValue: passthroughWireArray,
          }),
          (passthroughs) => {
            const encoded = reEncode({
              resourceType: 'PlanDefinition',
              status: 'draft',
              action: [passthroughs],
            })
            expect(pickKeysOf({ ...encoded.action?.[0] }, passthroughs)).toEqual(passthroughs)
          }
        ),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })

    test('property: subject[x] choice field round-trips', () => {
      fc.assert(
        fc.property(
          atMostOnePopulatedSlot({
            subjectCodeableConcept: Schema.NullOr(CodeableConcept.Schema),
            subjectReference: Schema.NullOr(IdentifierAndReference.ReferenceSchema),
          }),
          (override) => roundTrip(withAction({ ...sampleAction, ...override }))
        ),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })

    // `timingAge` is left out: `Age` is an unregistered datatype, so its slot
    // only ever decodes to `null` (see "Unregistered choice-element datatypes"
    // in the Client Capabilities Reference).
    test('property: timing[x] choice field round-trips', () => {
      fc.assert(
        fc.property(
          atMostOnePopulatedSlot({
            timingDateTime: Schema.NullOr(Schema.DateTimeUtc),
            timingPeriod: Schema.NullOr(Period.Schema),
            timingDuration: Schema.NullOr(Duration.Schema),
            timingRange: Schema.NullOr(Range.Schema),
            timingTiming: Schema.NullOr(Timing.Schema),
          }),
          (override) => roundTrip(withAction({ ...sampleAction, ...override }))
        ),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })

    test('property: definition[x] choice field round-trips', () => {
      fc.assert(
        fc.property(
          atMostOnePopulatedSlot({
            definitionCanonical: Schema.NullOr(UriSchema),
            definitionUri: Schema.NullOr(UriSchema),
          }),
          (override) => roundTrip(withAction({ ...sampleAction, ...override }))
        ),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })
  })

  describe.each([
    {
      prefix: 'subject',
      slots: atLeastTwoPopulatedSlots({
        subjectCodeableConcept: CodeableConcept.Schema,
        subjectReference: IdentifierAndReference.ReferenceSchema,
      }),
    },
  ])('$prefix[x] at-most-one guard', ({ prefix, slots }) => {
    test('property: rejects decoding a wire plan definition populating two or more slots', () => {
      fc.assert(
        fc.property(slots, (populated) => {
          // Arrange — each slot's wire JSON, merged onto the shell's
          const wire = {
            ...Schema.encodeSync(PlanDefinition.Schema)(samplePlanDefinition),
            ...Object.fromEntries(
              populated.map(([key, value]) => [key, wirePlanDefinitionSlot(key, value)])
            ),
          }

          // Act
          const result = Schema.decodeUnknownEither(PlanDefinition.Schema)(wire)

          // Assert
          expectChoiceElementGuardFailure(result, prefix, populated)
        }),
        { numRuns: numRunsFor({ base: 50 }) }
      )
    })

    test('property: rejects encoding a plan definition populating two or more slots', () => {
      fc.assert(
        fc.property(slots, (populated) => {
          // Arrange
          const planDefinition = { ...samplePlanDefinition, ...Object.fromEntries(populated) }

          // Act
          const result = Schema.encodeEither(PlanDefinition.Schema)(planDefinition)

          // Assert
          expectChoiceElementGuardFailure(result, prefix, populated)
        }),
        { numRuns: numRunsFor({ base: 50 }) }
      )
    })
  })

  describe.each([
    {
      prefix: 'subject',
      slots: atLeastTwoPopulatedSlots({
        subjectCodeableConcept: CodeableConcept.Schema,
        subjectReference: IdentifierAndReference.ReferenceSchema,
      }),
    },
    {
      prefix: 'timing',
      slots: atLeastTwoPopulatedSlots({
        timingDateTime: Schema.DateTimeUtc,
        timingPeriod: Period.Schema,
        timingDuration: Duration.Schema,
        timingRange: Range.Schema,
        timingTiming: Timing.Schema,
      }),
    },
    {
      prefix: 'definition',
      slots: atLeastTwoPopulatedSlots({
        definitionCanonical: UriSchema,
        definitionUri: UriSchema,
      }),
    },
  ])('action.$prefix[x] at-most-one guard', ({ prefix, slots }) => {
    test('property: rejects decoding a wire action populating two or more slots', () => {
      fc.assert(
        fc.property(slots, (populated) => {
          // Arrange — each slot's wire JSON, merged onto the shell action's
          const wireAction = {
            ...Schema.encodeSync(PlanDefinitionAction.Schema)(sampleAction),
            ...Object.fromEntries(
              populated.map(([key, value]) => [key, wireActionSlot(key, value)])
            ),
          }

          // Act
          const result = Schema.decodeUnknownEither(PlanDefinition.Schema)({
            ...Schema.encodeSync(PlanDefinition.Schema)(samplePlanDefinition),
            action: [wireAction],
          })

          // Assert
          expectChoiceElementGuardFailure(result, prefix, populated)
        }),
        { numRuns: numRunsFor({ base: 50 }) }
      )
    })

    test('property: rejects encoding an action populating two or more slots', () => {
      fc.assert(
        fc.property(slots, (populated) => {
          // Arrange
          const action = { ...sampleAction, ...Object.fromEntries(populated) }

          // Act
          const result = Schema.encodeEither(PlanDefinition.Schema)(withAction(action))

          // Assert
          expectChoiceElementGuardFailure(result, prefix, populated)
        }),
        { numRuns: numRunsFor({ base: 50 }) }
      )
    })
  })
})

describe('PlanDefinitionSearchParams', () => {
  test('carries every declared parameter through the wire unchanged', () => {
    // Arrange
    const query = {
      _count: '20',
      _pageToken: 'opaque-server-token',
      _id: 'pd-1',
      identifier: 'http://example.com/plans|pd-1',
      url: 'http://example.com/PlanDefinition/starting-strength',
      name: 'StartingStrength',
      title: 'Starting Strength',
      status: 'active',
      date: 'ge2026-01-01',
      topic: 'https://wildflowerhealth.io/fhir/CodeSystem/feature|strength-training',
    }

    // Act
    const reEncoded = Schema.encodeSync(SearchParams)(Schema.decodeUnknownSync(SearchParams)(query))

    // Assert
    expect(reEncoded).toEqual(query)
  })

  test.each([
    { reason: 'a status outside the PlanDefinition value set', query: { status: 'completed' } },
    { reason: 'a _count above the 1000 page ceiling', query: { _count: '1001' } },
    { reason: 'a date with an unknown prefix', query: { date: 'xx2026' } },
  ])('rejects $reason', ({ query }) => {
    expect(Schema.decodeUnknownEither(SearchParams)(query)._tag).toBe('Left')
  })
})

// Helpers

// The wire JSON of one top-level choice slot, encoded through the whole
// plan definition.
const wirePlanDefinitionSlot = (key: string, value: unknown): unknown => {
  const encoded: Readonly<Record<string, unknown>> = {
    ...Schema.encodeSync(PlanDefinition.Schema)({ ...samplePlanDefinition, [key]: value }),
  }
  return encoded[key]
}

// The wire JSON of one `action` choice slot, encoded through the whole action.
const wireActionSlot = (key: string, value: unknown): unknown => {
  const encoded: Readonly<Record<string, unknown>> = {
    ...Schema.encodeSync(PlanDefinitionAction.Schema)({ ...sampleAction, [key]: value }),
  }
  return encoded[key]
}
