import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { AnnotateArrayWithArbitrary } from 'kitchen-sink/schema'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { Code } from '../../data-types/base/code.ts'
import { CodeableConcept, Coding, IdentifierAndReference, Meta } from '../../data-types/index.ts'
import * as ImagingStudySeries from './imaging-study-series.ts'
import * as ImagingStudy from './imaging-study.ts'

const sampleImagingStudy: typeof ImagingStudy.Schema.Type = {
  resourceType: 'ImagingStudy',
  id: 'study-1',
  implicitRules: null,
  language: null,
  meta: null,
  contained: [],
  extension: [],
  modifierExtension: [],
  text: null,
  identifier: [],
  status: 'available',
  modality: [],
  subject: {
    id: null,
    extension: [],
    reference: 'Patient/p-1',
    type: null,
    identifier: null,
    display: null,
  },
  encounter: null,
  started: null,
  basedOn: [],
  referrer: null,
  interpreter: [],
  endpoint: [],
  numberOfSeries: null,
  numberOfInstances: null,
  procedureReference: null,
  procedureCode: [],
  location: null,
  reasonCode: [],
  reasonReference: [],
  note: [],
  description: null,
  series: [],
}

const roundTrip = (resource: typeof ImagingStudy.Schema.Type): void => {
  const fhir = Schema.encodeSync(ImagingStudy.Schema)(resource)
  const decoded = Schema.decodeSync(ImagingStudy.Schema)(fhir)
  expect(decoded).toSchemaEqual(ImagingStudy.Schema, resource)
}

const overrideArb = <Fields extends Schema.Struct.Fields>(
  fields: Fields
): fc.Arbitrary<Schema.Schema.Type<Schema.Struct<Fields>>> => Arbitrary.make(Schema.Struct(fields))

const referenceArray = Schema.Array(IdentifierAndReference.ReferenceSchema).pipe(
  AnnotateArrayWithArbitrary({ maxLength: 2 })
)

describe('FhirR4ImagingStudy', () => {
  test('encode-decode round-trip with shell imaging study', () => {
    roundTrip(sampleImagingStudy)
  })

  test('rejects a study with no status — the spec marks it 1..1', () => {
    const { status: _status, ...withoutStatus } = Schema.encodeSync(ImagingStudy.Schema)(
      sampleImagingStudy
    )
    expect(Schema.decodeUnknownEither(ImagingStudy.Schema)(withoutStatus)._tag).toBe('Left')
  })

  test('rejects a study with no subject — the spec marks it 1..1', () => {
    const { subject: _subject, ...withoutSubject } = Schema.encodeSync(ImagingStudy.Schema)(
      sampleImagingStudy
    )
    expect(Schema.decodeUnknownEither(ImagingStudy.Schema)(withoutSubject)._tag).toBe('Left')
  })

  test('rejects an invalid status value', () => {
    const wire = Schema.encodeSync(ImagingStudy.Schema)(sampleImagingStudy)
    expect(Schema.decodeUnknownEither(ImagingStudy.Schema)({ ...wire, status: 'bogus' })._tag).toBe(
      'Left'
    )
  })

  test('property: status field round-trips', () => {
    fc.assert(
      fc.property(overrideArb({ status: ImagingStudy.StatusSchema }), (override) =>
        roundTrip({ ...sampleImagingStudy, ...override })
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
        (override) => roundTrip({ ...sampleImagingStudy, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: modality Coding[] round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          modality: Schema.Array(Coding.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
        }),
        (override) => roundTrip({ ...sampleImagingStudy, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: reference-array fields round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          basedOn: referenceArray,
          interpreter: referenceArray,
          endpoint: referenceArray,
          reasonReference: referenceArray,
        }),
        (override) => roundTrip({ ...sampleImagingStudy, ...override })
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
          referrer: reference,
          procedureReference: reference,
          location: reference,
        }),
        (override) => roundTrip({ ...sampleImagingStudy, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: CodeableConcept fields round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          procedureCode: Schema.Array(CodeableConcept.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
          reasonCode: Schema.Array(CodeableConcept.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...sampleImagingStudy, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: numeric fields round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          numberOfSeries: Schema.NullOr(
            Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))
          ),
          numberOfInstances: Schema.NullOr(
            Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))
          ),
        }),
        (override) => roundTrip({ ...sampleImagingStudy, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: series backbone array round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          series: Schema.Array(ImagingStudySeries.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...sampleImagingStudy, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: shell primitives round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          started: Schema.NullOr(Schema.String),
          description: Schema.NullOr(Schema.String),
          language: Schema.NullOr(Code),
          implicitRules: Schema.NullOr(Schema.URL),
          meta: Schema.NullOr(Meta.Schema),
        }),
        (override) => roundTrip({ ...sampleImagingStudy, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('Coding.system round-trips a urn:oid: URI', () => {
    const studyWithOidModality: typeof ImagingStudy.Schema.Type = {
      ...sampleImagingStudy,
      modality: [
        {
          id: null,
          extension: [],
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- branded test literal
          code: '1.2.840.10008.5.1.4.1.1.2' as typeof Code.Type,
          display: 'CT Image Storage',
          system: new URL('urn:oid:1.2.840.10008.5.1.4'),
          userSelected: null,
          version: null,
        },
      ],
    }
    roundTrip(studyWithOidModality)
  })
})
