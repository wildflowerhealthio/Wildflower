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
import {
  Annotation,
  CodeableConcept,
  IdentifierAndReference,
  Meta,
  Period,
  Quantity,
  Timing,
} from '../../data-types/index.ts'
import * as CarePlanActivityDetail from './care-plan-activity-detail.ts'
import * as CarePlanActivity from './care-plan-activity.ts'
import * as CarePlan from './care-plan.ts'
import { SearchParams } from './search-params.ts'

// ---------------------------------------------------------------------------
// Decomposed wire-format proof (see observation.test.ts): each property
// generates one field group from the component schema the struct embeds,
// spreads it over a fixed shell, and round-trips the WHOLE CarePlan.
// ---------------------------------------------------------------------------

const sampleCarePlan: typeof CarePlan.Schema.Type = {
  resourceType: 'CarePlan',
  id: 'cp-1',
  implicitRules: null,
  language: null,
  meta: null,
  contained: [],
  extension: [],
  modifierExtension: [],
  text: null,
  identifier: [],
  instantiatesCanonical: [],
  instantiatesUri: [],
  basedOn: [],
  replaces: [],
  partOf: [],
  status: 'active',
  intent: 'plan',
  category: [],
  title: null,
  description: null,
  subject: {
    id: null,
    extension: [],
    reference: 'Patient/p-1',
    type: null,
    identifier: null,
    display: null,
  },
  encounter: null,
  period: null,
  created: null,
  author: null,
  contributor: [],
  careTeam: [],
  addresses: [],
  supportingInfo: [],
  goal: [],
  activity: [],
  note: [],
}

const sampleDetail: typeof CarePlanActivityDetail.Schema.Type = {
  id: null,
  extension: [],
  modifierExtension: [],
  kind: null,
  instantiatesCanonical: [],
  instantiatesUri: [],
  code: null,
  reasonCode: [],
  reasonReference: [],
  goal: [],
  status: 'not-started',
  statusReason: null,
  doNotPerform: null,
  scheduledTiming: null,
  scheduledPeriod: null,
  scheduledString: null,
  location: null,
  performer: [],
  productCodeableConcept: null,
  productReference: null,
  dailyAmount: null,
  quantity: null,
  description: null,
}

const sampleActivity: typeof CarePlanActivity.Schema.Type = {
  id: null,
  extension: [],
  modifierExtension: [],
  outcomeCodeableConcept: [],
  outcomeReference: [],
  progress: [],
  reference: null,
  detail: sampleDetail,
}

/** The shell plan carrying one activity whose detail is `detail`. */
const withDetail = (
  detail: typeof CarePlanActivityDetail.Schema.Type
): typeof CarePlan.Schema.Type => ({
  ...sampleCarePlan,
  activity: [{ ...sampleActivity, detail }],
})

const roundTrip = (resource: typeof CarePlan.Schema.Type): void => {
  const fhir = Schema.encodeSync(CarePlan.Schema)(resource)
  const decoded = Schema.decodeSync(CarePlan.Schema)(fhir)
  expect(decoded).toSchemaEqual(CarePlan.Schema, resource)
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

describe('FhirR4CarePlan', () => {
  test('decodes a minimal wire plan, defaulting every absent field', () => {
    // Arrange — only the 1..1 elements
    const wire = {
      resourceType: 'CarePlan',
      id: 'cp-1',
      status: 'active',
      intent: 'plan',
      subject: { reference: 'Patient/p-1' },
    }

    // Act
    const decoded = Schema.decodeUnknownSync(CarePlan.Schema)(wire)

    // Assert
    expect(decoded).toSchemaEqual(CarePlan.Schema, sampleCarePlan)
  })

  test('encode-decode round-trip with shell care plan', () => {
    roundTrip(sampleCarePlan)
  })

  test('encode-decode round-trip with a shell activity detail', () => {
    roundTrip(withDetail(sampleDetail))
  })

  test.each(['status', 'intent', 'subject'] as const)(
    'rejects a plan with no %s — the spec marks it 1..1',
    (field) => {
      const { [field]: _dropped, ...without } = Schema.encodeSync(CarePlan.Schema)(sampleCarePlan)
      expect(Schema.decodeUnknownEither(CarePlan.Schema)(without)._tag).toBe('Left')
    }
  )

  test('rejects an activity detail with no status — the spec marks it 1..1', () => {
    const wire = Schema.encodeSync(CarePlan.Schema)(withDetail(sampleDetail))
    const detail = wire.activity?.[0]?.detail
    if (detail === undefined) throw new Error('fixture: the shell plan carries one detail')
    const { status: _status, ...detailWithoutStatus } = detail
    expect(
      Schema.decodeUnknownEither(CarePlan.Schema)({
        ...wire,
        activity: [{ detail: detailWithoutStatus }],
      })._tag
    ).toBe('Left')
  })

  test.each([
    { field: 'status', value: 'bogus' },
    // `directive` is in the general request-intent set but not CarePlan's
    { field: 'intent', value: 'directive' },
  ])('rejects $field=$value outside the CarePlan value set', ({ field, value }) => {
    const wire = Schema.encodeSync(CarePlan.Schema)(sampleCarePlan)
    expect(Schema.decodeUnknownEither(CarePlan.Schema)({ ...wire, [field]: value })._tag).toBe(
      'Left'
    )
  })

  test.each([
    // `Procedure` is a resource type, but not one R4 binds `kind` to
    { field: 'kind', value: 'Procedure' },
    // `active` is a CarePlan status, not an activity-detail status
    { field: 'status', value: 'active' },
  ])('rejects activity.detail.$field=$value outside its value set', ({ field, value }) => {
    const wireDetail = {
      ...Schema.encodeSync(CarePlanActivityDetail.Schema)(sampleDetail),
      [field]: value,
    }
    expect(
      Schema.decodeUnknownEither(CarePlan.Schema)({
        ...Schema.encodeSync(CarePlan.Schema)(sampleCarePlan),
        activity: [{ detail: wireDetail }],
      })._tag
    ).toBe('Left')
  })

  test('property: status and intent round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({ status: CarePlan.StatusSchema, intent: CarePlan.IntentSchema }),
        (override) => roundTrip({ ...sampleCarePlan, ...override })
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
        (override) => roundTrip({ ...sampleCarePlan, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: reference-array fields round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          basedOn: referenceArray,
          replaces: referenceArray,
          partOf: referenceArray,
          contributor: referenceArray,
          careTeam: referenceArray,
          addresses: referenceArray,
          supportingInfo: referenceArray,
          goal: referenceArray,
        }),
        (override) => roundTrip({ ...sampleCarePlan, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: single references round-trip', () => {
    const reference = Schema.NullOr(IdentifierAndReference.ReferenceSchema)
    fc.assert(
      fc.property(
        overrideArb({
          subject: IdentifierAndReference.ReferenceSchema,
          encounter: reference,
          author: reference,
        }),
        (override) => roundTrip({ ...sampleCarePlan, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: category, period and note round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          category: codeableConceptArray,
          period: Schema.NullOr(Period.Schema),
          note: Schema.Array(Annotation.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
        }),
        (override) => roundTrip({ ...sampleCarePlan, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: shell primitives round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          instantiatesCanonical: Schema.Array(Schema.String),
          instantiatesUri: Schema.Array(Schema.String),
          title: Schema.NullOr(Schema.String),
          description: Schema.NullOr(Schema.String),
          created: Schema.NullOr(Schema.String),
          language: Schema.NullOr(Code),
          implicitRules: Schema.NullOr(Schema.URL),
          meta: Schema.NullOr(Meta.Schema),
        }),
        (override) => roundTrip({ ...sampleCarePlan, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: activity[] round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          activity: Schema.Array(CarePlanActivity.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...sampleCarePlan, ...override })
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  describe('activity.detail', () => {
    test('property: non-choice fields round-trip', () => {
      fc.assert(
        fc.property(
          overrideArb({
            kind: Schema.NullOr(CarePlanActivityDetail.KindSchema),
            status: CarePlanActivityDetail.StatusSchema,
            code: Schema.NullOr(CodeableConcept.Schema),
            reasonCode: codeableConceptArray,
            reasonReference: referenceArray,
            goal: referenceArray,
            statusReason: Schema.NullOr(CodeableConcept.Schema),
            doNotPerform: Schema.NullOr(Schema.Boolean),
            location: Schema.NullOr(IdentifierAndReference.ReferenceSchema),
            performer: referenceArray,
            dailyAmount: Schema.NullOr(Quantity.Schema),
            quantity: Schema.NullOr(Quantity.Schema),
            description: Schema.NullOr(Schema.String),
          }),
          (override) => roundTrip(withDetail({ ...sampleDetail, ...override }))
        ),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })

    test('property: scheduled[x] choice field round-trips', () => {
      fc.assert(
        fc.property(
          atMostOnePopulatedSlot({
            scheduledTiming: Schema.NullOr(Timing.Schema),
            scheduledPeriod: Schema.NullOr(Period.Schema),
            scheduledString: Schema.NullOr(Schema.String),
          }),
          (override) => roundTrip(withDetail({ ...sampleDetail, ...override }))
        ),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })

    test('property: product[x] choice field round-trips', () => {
      fc.assert(
        fc.property(
          atMostOnePopulatedSlot({
            productCodeableConcept: Schema.NullOr(CodeableConcept.Schema),
            productReference: Schema.NullOr(IdentifierAndReference.ReferenceSchema),
          }),
          (override) => roundTrip(withDetail({ ...sampleDetail, ...override }))
        ),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })

    describe.each([
      {
        prefix: 'scheduled',
        slots: atLeastTwoPopulatedSlots({
          scheduledTiming: Timing.Schema,
          scheduledPeriod: Period.Schema,
          scheduledString: Schema.String,
        }),
      },
      {
        prefix: 'product',
        slots: atLeastTwoPopulatedSlots({
          productCodeableConcept: CodeableConcept.Schema,
          productReference: IdentifierAndReference.ReferenceSchema,
        }),
      },
    ])('$prefix[x] at-most-one guard', ({ prefix, slots }) => {
      test('property: rejects decoding a wire plan populating two or more slots', () => {
        fc.assert(
          fc.property(slots, (populated) => {
            // Arrange — each slot's wire JSON, merged onto the shell detail's
            const wireDetail = {
              ...Schema.encodeSync(CarePlanActivityDetail.Schema)(sampleDetail),
              ...Object.fromEntries(populated.map(([key, value]) => [key, wireSlot(key, value)])),
            }

            // Act
            const result = Schema.decodeUnknownEither(CarePlan.Schema)({
              ...Schema.encodeSync(CarePlan.Schema)(sampleCarePlan),
              activity: [{ detail: wireDetail }],
            })

            // Assert
            expectChoiceElementGuardFailure(result, prefix, populated)
          }),
          { numRuns: numRunsFor({ base: 50 }) }
        )
      })

      test('property: rejects encoding a plan populating two or more slots', () => {
        fc.assert(
          fc.property(slots, (populated) => {
            // Arrange
            const detail = { ...sampleDetail, ...Object.fromEntries(populated) }

            // Act
            const result = Schema.encodeEither(CarePlan.Schema)(withDetail(detail))

            // Assert
            expectChoiceElementGuardFailure(result, prefix, populated)
          }),
          { numRuns: numRunsFor({ base: 50 }) }
        )
      })
    })
  })
})

describe('CarePlanSearchParams', () => {
  test('carries every declared parameter through the wire unchanged', () => {
    // Arrange
    const query = {
      _count: '20',
      _pageToken: 'opaque-server-token',
      _id: 'cp-1',
      status: 'active',
      intent: 'plan',
      subject: 'Patient/p-1',
      patient: 'p-1',
      category: 'http://hl7.org/fhir/us/core/CodeSystem/careplan-category|assess-plan',
      date: 'ge2026-01-01',
    }

    // Act
    const reEncoded = Schema.encodeSync(SearchParams)(Schema.decodeUnknownSync(SearchParams)(query))

    // Assert
    expect(reEncoded).toEqual(query)
  })

  test.each([
    { reason: 'a status outside the CarePlan value set', query: { status: 'bogus' } },
    { reason: 'an intent outside the CarePlan value set', query: { intent: 'directive' } },
    { reason: 'a _count above the 1000 page ceiling', query: { _count: '1001' } },
    { reason: 'a date with an unknown prefix', query: { date: 'xx2026' } },
  ])('rejects $reason', ({ query }) => {
    expect(Schema.decodeUnknownEither(SearchParams)(query)._tag).toBe('Left')
  })
})

// Helpers

// The wire JSON of one `activity.detail` choice slot, encoded through the
// whole detail.
const wireSlot = (key: string, value: unknown): unknown => {
  const encoded: Readonly<Record<string, unknown>> = {
    ...Schema.encodeSync(CarePlanActivityDetail.Schema)({ ...sampleDetail, [key]: value }),
  }
  return encoded[key]
}
