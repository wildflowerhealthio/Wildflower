import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { AnnotateArrayWithArbitrary } from 'kitchen-sink/schema'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { atMostOnePopulatedSlot } from '../../data-types/base/choice-element-passthrough-fields.test-helpers.ts'
import { Code } from '../../data-types/base/code.ts'
import {
  Attachment,
  CodeableConcept,
  IdentifierAndReference,
  Meta,
  Period,
} from '../../data-types/index.ts'
import * as DiagnosticReportMedia from './diagnostic-report-media.ts'
import * as DiagnosticReport from './diagnostic-report.ts'

// ---------------------------------------------------------------------------
// Decomposed wire-format proof (see observation.test.ts for the rationale):
// one property per field over a fixed shell, each encoding/decoding the WHOLE
// DiagnosticReport through `DiagnosticReport.Schema`.
// ---------------------------------------------------------------------------

const sampleDiagnosticReport: typeof DiagnosticReport.Schema.Type = {
  resourceType: 'DiagnosticReport',
  id: 'report-id',
  implicitRules: null,
  language: null,
  meta: null,
  contained: [],
  extension: [],
  modifierExtension: [],
  text: null,
  identifier: [],
  basedOn: [],
  status: 'final',
  category: [],
  code: { id: null, extension: [], coding: [], text: 'Laboratory report' },
  subject: null,
  encounter: null,
  effectiveDateTime: null,
  effectivePeriod: null,
  issued: null,
  performer: [],
  resultsInterpreter: [],
  specimen: [],
  result: [],
  imagingStudy: [],
  media: [],
  conclusion: null,
  conclusionCode: [],
  presentedForm: [],
}

const roundTrip = (report: typeof DiagnosticReport.Schema.Type): void => {
  const fhir = Schema.encodeSync(DiagnosticReport.Schema)(report)
  const decoded = Schema.decodeSync(DiagnosticReport.Schema)(fhir)
  expect(decoded).toSchemaEqual(DiagnosticReport.Schema, report)
}

const overrideArb = <Fields extends Schema.Struct.Fields>(
  fields: Fields
): fc.Arbitrary<Schema.Schema.Type<Schema.Struct<Fields>>> => Arbitrary.make(Schema.Struct(fields))

const referenceArray = Schema.Array(IdentifierAndReference.ReferenceSchema).pipe(
  AnnotateArrayWithArbitrary({ maxLength: 2 })
)

describe('FhirR4DiagnosticReport', () => {
  test('encode-decode round-trip with shell diagnostic report', () => {
    roundTrip(sampleDiagnosticReport)
  })

  test('rejects a report with no status — the spec marks it 1..1', () => {
    const { status: _status, ...withoutStatus } = Schema.encodeSync(DiagnosticReport.Schema)(
      sampleDiagnosticReport
    )
    expect(Schema.decodeUnknownEither(DiagnosticReport.Schema)(withoutStatus)._tag).toBe('Left')
  })

  test('rejects a report with no code — the spec marks it 1..1', () => {
    const { code: _code, ...withoutCode } = Schema.encodeSync(DiagnosticReport.Schema)(
      sampleDiagnosticReport
    )
    expect(Schema.decodeUnknownEither(DiagnosticReport.Schema)(withoutCode)._tag).toBe('Left')
  })

  test('property: status field round-trips', () => {
    fc.assert(
      fc.property(overrideArb({ status: DiagnosticReport.StatusSchema }), (override) =>
        roundTrip({ ...sampleDiagnosticReport, ...override })
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
        (override) => roundTrip({ ...sampleDiagnosticReport, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: reference-array fields round-trip (basedOn / performer / resultsInterpreter / specimen / result / imagingStudy)', () => {
    fc.assert(
      fc.property(
        overrideArb({
          basedOn: referenceArray,
          performer: referenceArray,
          resultsInterpreter: referenceArray,
          specimen: referenceArray,
          result: referenceArray,
          imagingStudy: referenceArray,
        }),
        (override) => roundTrip({ ...sampleDiagnosticReport, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: nullable single references round-trip (subject / encounter)', () => {
    const reference = Schema.NullOr(IdentifierAndReference.ReferenceSchema)
    fc.assert(
      fc.property(overrideArb({ subject: reference, encounter: reference }), (override) =>
        roundTrip({ ...sampleDiagnosticReport, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: CodeableConcept fields round-trip (code / category[] / conclusionCode[])', () => {
    fc.assert(
      fc.property(
        overrideArb({
          code: CodeableConcept.Schema,
          category: Schema.Array(CodeableConcept.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
          conclusionCode: Schema.Array(CodeableConcept.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...sampleDiagnosticReport, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: effective[x] choice field round-trips', () => {
    fc.assert(
      fc.property(
        atMostOnePopulatedSlot({
          effectiveDateTime: Schema.NullOr(Schema.DateTimeUtc),
          effectivePeriod: Schema.NullOr(Period.Schema),
        }),
        (override) => roundTrip({ ...sampleDiagnosticReport, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: media backbone array round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          media: Schema.Array(DiagnosticReportMedia.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...sampleDiagnosticReport, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: presentedForm attachments round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          presentedForm: Schema.Array(Attachment.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...sampleDiagnosticReport, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: shell primitives round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          issued: Schema.NullOr(Schema.DateTimeUtc),
          conclusion: Schema.NullOr(Schema.String),
          language: Schema.NullOr(Code),
          implicitRules: Schema.NullOr(Schema.URL),
          meta: Schema.NullOr(Meta.Schema),
        }),
        (override) => roundTrip({ ...sampleDiagnosticReport, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
