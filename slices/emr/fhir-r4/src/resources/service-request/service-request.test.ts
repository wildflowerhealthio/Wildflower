import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { AnnotateArrayWithArbitrary } from 'kitchen-sink/schema'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { atMostOnePopulatedSlot } from '../../data-types/base/choice-element-passthrough-fields.test-helpers.ts'
import { Code } from '../../data-types/base/code.ts'
import { CodeableConcept, IdentifierAndReference, Meta, Period } from '../../data-types/index.ts'
import * as ServiceRequest from './service-request.ts'

const sampleServiceRequest: typeof ServiceRequest.Schema.Type = {
  resourceType: 'ServiceRequest',
  id: 'sr-1',
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
  requisition: null,
  status: 'active',
  intent: 'order',
  category: [],
  priority: null,
  doNotPerform: null,
  code: null,
  orderDetail: [],
  quantityQuantity: null,
  quantityRatio: null,
  quantityRange: null,
  subject: {
    id: null,
    extension: [],
    reference: 'Patient/p-1',
    type: null,
    identifier: null,
    display: null,
  },
  encounter: null,
  occurrenceDateTime: null,
  occurrencePeriod: null,
  occurrenceTiming: null,
  asNeededBoolean: null,
  asNeededCodeableConcept: null,
  authoredOn: null,
  requester: null,
  performerType: null,
  performer: [],
  locationCode: [],
  locationReference: [],
  reasonCode: [],
  reasonReference: [],
  insurance: [],
  supportingInfo: [],
  bodySite: [],
  note: [],
  patientInstruction: null,
  relevantHistory: [],
}

const roundTrip = (resource: typeof ServiceRequest.Schema.Type): void => {
  const fhir = Schema.encodeSync(ServiceRequest.Schema)(resource)
  const decoded = Schema.decodeSync(ServiceRequest.Schema)(fhir)
  expect(decoded).toSchemaEqual(ServiceRequest.Schema, resource)
}

const overrideArb = <Fields extends Schema.Struct.Fields>(
  fields: Fields
): fc.Arbitrary<Schema.Schema.Type<Schema.Struct<Fields>>> => Arbitrary.make(Schema.Struct(fields))

const referenceArray = Schema.Array(IdentifierAndReference.ReferenceSchema).pipe(
  AnnotateArrayWithArbitrary({ maxLength: 2 })
)

describe('FhirR4ServiceRequest', () => {
  test('encode-decode round-trip with shell service request', () => {
    roundTrip(sampleServiceRequest)
  })

  test('rejects a request with no status — the spec marks it 1..1', () => {
    const { status: _status, ...withoutStatus } = Schema.encodeSync(ServiceRequest.Schema)(
      sampleServiceRequest
    )
    expect(Schema.decodeUnknownEither(ServiceRequest.Schema)(withoutStatus)._tag).toBe('Left')
  })

  test('rejects a request with no intent — the spec marks it 1..1', () => {
    const { intent: _intent, ...withoutIntent } = Schema.encodeSync(ServiceRequest.Schema)(
      sampleServiceRequest
    )
    expect(Schema.decodeUnknownEither(ServiceRequest.Schema)(withoutIntent)._tag).toBe('Left')
  })

  test('rejects a request with no subject — the spec marks it 1..1', () => {
    const { subject: _subject, ...withoutSubject } = Schema.encodeSync(ServiceRequest.Schema)(
      sampleServiceRequest
    )
    expect(Schema.decodeUnknownEither(ServiceRequest.Schema)(withoutSubject)._tag).toBe('Left')
  })

  test('rejects an invalid status value', () => {
    const wire = Schema.encodeSync(ServiceRequest.Schema)(sampleServiceRequest)
    expect(
      Schema.decodeUnknownEither(ServiceRequest.Schema)({ ...wire, status: 'bogus' })._tag
    ).toBe('Left')
  })

  test('rejects an invalid intent value', () => {
    const wire = Schema.encodeSync(ServiceRequest.Schema)(sampleServiceRequest)
    expect(
      Schema.decodeUnknownEither(ServiceRequest.Schema)({ ...wire, intent: 'bogus' })._tag
    ).toBe('Left')
  })

  test('property: status field round-trips', () => {
    fc.assert(
      fc.property(overrideArb({ status: ServiceRequest.StatusSchema }), (override) =>
        roundTrip({ ...sampleServiceRequest, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: intent field round-trips', () => {
    fc.assert(
      fc.property(overrideArb({ intent: ServiceRequest.IntentSchema }), (override) =>
        roundTrip({ ...sampleServiceRequest, ...override })
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
        (override) => roundTrip({ ...sampleServiceRequest, ...override })
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
          performer: referenceArray,
          locationReference: referenceArray,
          reasonReference: referenceArray,
          insurance: referenceArray,
          supportingInfo: referenceArray,
          relevantHistory: referenceArray,
        }),
        (override) => roundTrip({ ...sampleServiceRequest, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: nullable single references round-trip', () => {
    const reference = Schema.NullOr(IdentifierAndReference.ReferenceSchema)
    fc.assert(
      fc.property(
        overrideArb({
          subject: IdentifierAndReference.ReferenceSchema,
          encounter: reference,
          requester: reference,
        }),
        (override) => roundTrip({ ...sampleServiceRequest, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: CodeableConcept fields round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          code: Schema.NullOr(CodeableConcept.Schema),
          category: Schema.Array(CodeableConcept.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
          orderDetail: Schema.Array(CodeableConcept.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
          performerType: Schema.NullOr(CodeableConcept.Schema),
          bodySite: Schema.Array(CodeableConcept.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
          locationCode: Schema.Array(CodeableConcept.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
          reasonCode: Schema.Array(CodeableConcept.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...sampleServiceRequest, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: occurrence[x] choice field round-trips', () => {
    fc.assert(
      fc.property(
        atMostOnePopulatedSlot({
          occurrenceDateTime: Schema.NullOr(Schema.DateTimeUtc),
          occurrencePeriod: Schema.NullOr(Period.Schema),
        }),
        (override) => roundTrip({ ...sampleServiceRequest, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: asNeeded[x] choice field round-trips', () => {
    fc.assert(
      fc.property(
        atMostOnePopulatedSlot({
          asNeededBoolean: Schema.NullOr(Schema.Boolean),
          asNeededCodeableConcept: Schema.NullOr(CodeableConcept.Schema),
        }),
        (override) => roundTrip({ ...sampleServiceRequest, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: shell primitives round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          authoredOn: Schema.NullOr(Schema.String),
          patientInstruction: Schema.NullOr(Schema.String),
          doNotPerform: Schema.NullOr(Schema.Boolean),
          language: Schema.NullOr(Code),
          implicitRules: Schema.NullOr(Schema.URL),
          meta: Schema.NullOr(Meta.Schema),
        }),
        (override) => roundTrip({ ...sampleServiceRequest, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
