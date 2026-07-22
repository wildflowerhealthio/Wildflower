import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { AnnotateArrayWithArbitrary } from 'kitchen-sink/schema'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { Code } from '../../data-types/base/code.ts'
import { CodeableConcept, IdentifierAndReference, Meta } from '../../data-types/index.ts'
import * as DocumentReferenceContent from './document-reference-content.ts'
import * as DocumentReferenceContext from './document-reference-context.ts'
import * as DocumentReferenceRelatesTo from './document-reference-relates-to.ts'
import * as DocumentReference from './document-reference.ts'

// ---------------------------------------------------------------------------
// Decomposed wire-format proof (see observation.test.ts for the rationale):
// one property per field over a fixed shell, each encoding/decoding the WHOLE
// DocumentReference through `DocumentReference.Schema`.
// ---------------------------------------------------------------------------

const sampleDocumentReference: typeof DocumentReference.Schema.Type = {
  resourceType: 'DocumentReference',
  id: 'docref-id',
  implicitRules: null,
  language: null,
  meta: null,
  contained: [],
  extension: [],
  modifierExtension: [],
  text: null,
  masterIdentifier: null,
  identifier: [],
  status: 'current',
  docStatus: null,
  type: null,
  category: [],
  subject: null,
  date: null,
  author: [],
  authenticator: null,
  custodian: null,
  relatesTo: [],
  description: null,
  securityLabel: [],
  content: [],
  context: null,
}

const roundTrip = (documentReference: typeof DocumentReference.Schema.Type): void => {
  const fhir = Schema.encodeSync(DocumentReference.Schema)(documentReference)
  const decoded = Schema.decodeSync(DocumentReference.Schema)(fhir)
  expect(decoded).toSchemaEqual(DocumentReference.Schema, documentReference)
}

const overrideArb = <Fields extends Schema.Struct.Fields>(
  fields: Fields
): fc.Arbitrary<Schema.Schema.Type<Schema.Struct<Fields>>> => Arbitrary.make(Schema.Struct(fields))

describe('FhirR4DocumentReference', () => {
  test('encode-decode round-trip with shell document reference', () => {
    roundTrip(sampleDocumentReference)
  })

  test('property: status field round-trips', () => {
    fc.assert(
      fc.property(overrideArb({ status: DocumentReference.StatusSchema }), (override) =>
        roundTrip({ ...sampleDocumentReference, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: docStatus field round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({ docStatus: Schema.NullOr(DocumentReference.DocStatusSchema) }),
        (override) => roundTrip({ ...sampleDocumentReference, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: identifier fields round-trip (masterIdentifier / identifier[])', () => {
    fc.assert(
      fc.property(
        overrideArb({
          masterIdentifier: Schema.NullOr(IdentifierAndReference.IdentifierSchema),
          identifier: Schema.Array(IdentifierAndReference.IdentifierSchema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...sampleDocumentReference, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: reference-array fields round-trip (author)', () => {
    fc.assert(
      fc.property(
        overrideArb({
          author: Schema.Array(IdentifierAndReference.ReferenceSchema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...sampleDocumentReference, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: nullable single references round-trip (subject / authenticator / custodian)', () => {
    const reference = Schema.NullOr(IdentifierAndReference.ReferenceSchema)
    fc.assert(
      fc.property(
        overrideArb({ subject: reference, authenticator: reference, custodian: reference }),
        (override) => roundTrip({ ...sampleDocumentReference, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: CodeableConcept fields round-trip (type / category[] / securityLabel[])', () => {
    fc.assert(
      fc.property(
        overrideArb({
          type: Schema.NullOr(CodeableConcept.Schema),
          category: Schema.Array(CodeableConcept.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
          securityLabel: Schema.Array(CodeableConcept.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...sampleDocumentReference, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: relatesTo backbone array round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          relatesTo: Schema.Array(DocumentReferenceRelatesTo.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...sampleDocumentReference, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: content backbone array round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          content: Schema.Array(DocumentReferenceContent.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...sampleDocumentReference, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: context backbone round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({ context: Schema.NullOr(DocumentReferenceContext.Schema) }),
        (override) => roundTrip({ ...sampleDocumentReference, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: shell primitives round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          date: Schema.NullOr(Schema.DateTimeUtc),
          description: Schema.NullOr(Schema.String),
          language: Schema.NullOr(Code),
          implicitRules: Schema.NullOr(Schema.URL),
          meta: Schema.NullOr(Meta.Schema),
        }),
        (override) => roundTrip({ ...sampleDocumentReference, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
