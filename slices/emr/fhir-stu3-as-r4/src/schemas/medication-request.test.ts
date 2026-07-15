import { Arbitrary, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { AnnotateArrayWithArbitrary } from 'kitchen-sink/schema'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import {
  Duration,
  IdentifierAndReference,
  Period,
  Quantity,
  SimpleQuantity,
} from 'fhir-r4/data-types'
import {
  MedicationRequest as R4MedicationRequest,
  MedicationRequestDispenseRequest as R4DispenseRequest,
} from 'fhir-r4/resources'

import * as MedicationRequest from './medication-request.ts'

const emptyReference: IdentifierAndReference.ReferenceType = {
  id: null,
  extension: [],
  display: null,
  identifier: null,
  reference: null,
  type: null,
}

const sample: typeof MedicationRequest.Schema.Type = {
  resourceType: 'MedicationRequest',
  id: 'mr-sample',
  implicitRules: null,
  language: null,
  meta: null,
  contained: [],
  extension: [],
  modifierExtension: [],
  text: null,
  identifier: [],
  status: 'active',
  intent: 'order',
  medicationReference: null,
  medicationCodeableConcept: null,
  subject: emptyReference,
  context: null,
  authoredOn: null,
  requester: null,
  note: [],
  dispenseRequest: null,
}

const roundTrip = (value: typeof MedicationRequest.Schema.Type): void => {
  const wire = Schema.encodeSync(MedicationRequest.Schema)(value)
  const decoded = Schema.decodeSync(MedicationRequest.Schema)(wire)
  expect(decoded).toSchemaEqual(MedicationRequest.Schema, value)
}

const overrideArb = <Fields extends Schema.Struct.Fields>(
  fields: Fields
): fc.Arbitrary<Schema.Schema.Type<Schema.Struct<Fields>>> => Arbitrary.make(Schema.Struct(fields))

describe('Stu3MedicationRequest', () => {
  test('encode-decode round-trip with shell request', () => {
    roundTrip(sample)
  })

  test('property: status / intent round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          status: MedicationRequest.StatusSchema,
          intent: MedicationRequest.IntentSchema,
        }),
        (override) => roundTrip({ ...sample, ...override })
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('property: medication[x] choice round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          medicationReference: Schema.NullOr(IdentifierAndReference.ReferenceSchema),
        }),
        (override) => roundTrip({ ...sample, ...override })
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('property: identifier array round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          identifier: Schema.Array(IdentifierAndReference.IdentifierSchema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...sample, ...override })
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('property: requester backbone (STU3 agent shape) round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({ requester: Schema.NullOr(MedicationRequest.RequesterSchema) }),
        (override) => roundTrip({ ...sample, ...override })
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('property: dispenseRequest backbone round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({ dispenseRequest: Schema.NullOr(MedicationRequest.DispenseRequestSchema) }),
        (override) => roundTrip({ ...sample, ...override })
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('property: subject / context references round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          subject: IdentifierAndReference.ReferenceSchema,
          context: Schema.NullOr(IdentifierAndReference.ReferenceSchema),
        }),
        (override) => roundTrip({ ...sample, ...override })
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('lenient decode: unknown top-level fields and unknown extension URLs do not fail', () => {
    const decoded = Schema.decodeUnknownSync(MedicationRequest.Schema)({
      resourceType: 'MedicationRequest',
      id: 'mr-lenient',
      status: 'active',
      intent: 'order',
      subject: { reference: 'Patient/p1' },
      // Unmodelled top-level field — must be ignored, not rejected.
      someCarebookOnlyField: { nested: [1, 2, 3] },
      priority: 'routine',
      extension: [
        { url: 'http://example.org/totally-unknown', valueString: 'keep-me' },
        { url: 'http://schemas.carebook.com/v1/fhir/renewable', valueBoolean: true },
      ],
    })

    expect(decoded.id).toBe('mr-lenient')
    // The unknown extension URL survives decode verbatim (R4/STU3 Extension
    // accepts any url), so no source metadata is dropped.
    expect(decoded.extension.map((e) => e.url)).toContain('http://example.org/totally-unknown')
    expect(decoded.extension).toHaveLength(2)
  })
})

// STU3 → R4 → STU3: encode the STU3 value to wire, decode straight to R4, then
// back out to STU3. Lossless only over the R4-representable STU3 subset — a STU3
// `requester` carries `onBehalfOf` and a backbone that R4's flat reference can't
// hold, so `safeStu3Request` restricts `requester` to an agent-only shape.
const stu3ToR4ToStu3 = (stu3: typeof MedicationRequest.Schema.Type): void => {
  const r4 = Schema.decodeSync(MedicationRequest.R4FromStu3Schema)(
    Schema.encodeSync(MedicationRequest.Schema)(stu3)
  )
  const back = Schema.decodeSync(MedicationRequest.Schema)(
    Schema.encodeSync(MedicationRequest.R4FromStu3Schema)(r4)
  )
  expect(back).toSchemaEqual(MedicationRequest.Schema, stu3)
}

// R4 → STU3 → R4 for a value known to be in the STU3-representable subset.
const r4ToStu3ToR4 = (r4: typeof R4MedicationRequest.Schema.Type): void => {
  const back = Schema.decodeSync(MedicationRequest.R4FromStu3Schema)(
    Schema.encodeSync(MedicationRequest.R4FromStu3Schema)(r4)
  )
  expect(back).toSchemaEqual(Schema.typeSchema(R4MedicationRequest.Schema), r4)
}

const widen = (
  simple: typeof SimpleQuantity.Schema.Type | null
): typeof Quantity.Schema.Type | null =>
  simple === null ? null : Quantity.fromSimpleQuantity(simple)

// A STU3 requester that survives the flatten to R4 and back: agent only, no
// `onBehalfOf`, empty backbone.
const safeRequesterArb = fc.option(
  Arbitrary.make(IdentifierAndReference.ReferenceSchema).map(
    (agent): typeof MedicationRequest.RequesterSchema.Type => ({
      id: null,
      extension: [],
      modifierExtension: [],
      agent,
      onBehalfOf: null,
    })
  ),
  { nil: null }
)

const safeStu3Request: fc.Arbitrary<typeof MedicationRequest.Schema.Type> = fc
  .record({
    status: Arbitrary.make(MedicationRequest.StatusSchema),
    intent: Arbitrary.make(MedicationRequest.IntentSchema),
    subject: Arbitrary.make(IdentifierAndReference.ReferenceSchema),
    context: Arbitrary.make(Schema.NullOr(IdentifierAndReference.ReferenceSchema)),
    authoredOn: Arbitrary.make(Schema.NullOr(Schema.DateTimeUtc)),
    requester: safeRequesterArb,
    dispenseRequest: fc.option(Arbitrary.make(MedicationRequest.DispenseRequestSchema), {
      nil: null,
    }),
  })
  .map((over) => ({ ...sample, ...over }))

// The safe R4 dispenseRequest subset: comparator-free quantity, no R4-only
// initialFill / dispenseInterval / performer.
const safeR4DispenseRequest = fc
  .record({
    numberOfRepeatsAllowed: Arbitrary.make(Schema.NullOr(Schema.Int.pipe(Schema.nonNegative()))),
    quantity: Arbitrary.make(Schema.NullOr(SimpleQuantity.Schema)).map(widen),
    expectedSupplyDuration: Arbitrary.make(Schema.NullOr(Duration.Schema)),
    validityPeriod: Arbitrary.make(Schema.NullOr(Period.Schema)),
  })
  .map((over) => ({ ...R4DispenseRequest.empty, ...over }))

// Explicitly constructs the safe R4 subset: R4-only fields stay at `empty`;
// intent is restricted to the STU3 members; requester is a flat reference.
const safeR4Request: fc.Arbitrary<typeof R4MedicationRequest.Schema.Type> = fc
  .record({
    status: Arbitrary.make(MedicationRequest.StatusSchema),
    intent: Arbitrary.make(MedicationRequest.IntentSchema),
    subject: Arbitrary.make(IdentifierAndReference.ReferenceSchema),
    encounter: Arbitrary.make(Schema.NullOr(IdentifierAndReference.ReferenceSchema)),
    authoredOn: Arbitrary.make(Schema.NullOr(Schema.DateTimeUtc)),
    requester: Arbitrary.make(Schema.NullOr(IdentifierAndReference.ReferenceSchema)),
    dispenseRequest: fc.option(safeR4DispenseRequest, { nil: null }),
  })
  .map((over) => ({ ...R4MedicationRequest.empty, ...over }))

describe('MedicationRequest.R4FromStu3Schema', () => {
  test('property: an arbitrary (agent-only requester) STU3 request converts to R4 and back', () => {
    fc.assert(fc.property(safeStu3Request, stu3ToR4ToStu3), {
      numRuns: numRunsFor({ base: 50 }),
    })
  })

  test('property: a representable R4 request converts to STU3 and back without loss', () => {
    fc.assert(fc.property(safeR4Request, r4ToStu3ToR4), { numRuns: numRunsFor({ base: 50 }) })
  })

  test('encoding an R4-only field (performer) back to STU3 fails', () => {
    const withPerformer: typeof R4MedicationRequest.Schema.Type = {
      ...R4MedicationRequest.empty,
      performer: IdentifierAndReference.emptyReference,
    }
    expect(
      Either.isLeft(Schema.encodeEither(MedicationRequest.R4FromStu3Schema)(withPerformer))
    ).toBe(true)
  })

  test('encoding an R4-only intent (option) back to STU3 fails', () => {
    const optionIntent: typeof R4MedicationRequest.Schema.Type = {
      ...R4MedicationRequest.empty,
      intent: 'option',
    }
    expect(
      Either.isLeft(Schema.encodeEither(MedicationRequest.R4FromStu3Schema)(optionIntent))
    ).toBe(true)
  })
})
