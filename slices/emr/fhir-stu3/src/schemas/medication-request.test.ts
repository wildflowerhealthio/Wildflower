import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { AnnotateArrayWithArbitrary } from 'kitchen-sink/schema'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { IdentifierAndReference } from 'fhir-r4/data-types'

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
