import { Arbitrary, Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { pickField } from 'kitchen-sink/schema'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, test } from 'vite-plus/test'

import {
  fragmentIdOf,
  fragmentReferenceTo,
  IdentifierSchema,
  ReferenceSchema,
} from './identifier-and-reference.ts'

// ---------------------------------------------------------------------------
// Reference and Identifier are mutually recursive (Reference.identifier →
// Identifier.assigner → Reference). The `Identifier.assigner`
// arbitrary is already pinned to `null`, so the cycle terminates at depth 2,
// but every iteration still walks the full Reference + Identifier graph
// (each Identifier carries Period and CodeableConcept-with-Coding[]).
//
// We preserve the wire-format proof by decomposing into per-field properties:
// each iteration generates only that one field, drops it onto a fixed shell,
// and round-trips the whole record through the fhir-r4 schema.
// ---------------------------------------------------------------------------

const sampleReference: typeof ReferenceSchema.Type = {
  id: null,
  extension: [],
  display: null,
  identifier: null,
  reference: null,
  type: null,
}

const sampleIdentifier: typeof IdentifierSchema.Type = {
  id: null,
  extension: [],
  assigner: null,
  period: null,
  system: null,
  type: null,
  use: null,
  value: null,
}

const roundTripReference = (reference: typeof ReferenceSchema.Type): void => {
  const fhir = Schema.encodeSync(ReferenceSchema)(reference)
  const decoded = Schema.decodeSync(ReferenceSchema)(fhir)
  expect(decoded).toSchemaEqual(ReferenceSchema, reference)
}

const roundTripIdentifier = (identifier: typeof IdentifierSchema.Type): void => {
  const fhir = Schema.encodeSync(IdentifierSchema)(identifier)
  const decoded = Schema.decodeSync(IdentifierSchema)(fhir)
  expect(decoded).toSchemaEqual(IdentifierSchema, identifier)
}

const referenceFieldArb = <const K extends keyof typeof ReferenceSchema.Type>(
  field: K
): fc.Arbitrary<Pick<typeof ReferenceSchema.Type, K>> =>
  Arbitrary.make(pickField(ReferenceSchema, field))

const identifierFieldArb = <const K extends keyof typeof IdentifierSchema.Type>(
  field: K
): fc.Arbitrary<Pick<typeof IdentifierSchema.Type, K>> =>
  Arbitrary.make(pickField(IdentifierSchema, field))

describe('FhirR4Reference', () => {
  test('round-trips empty shell', () => {
    roundTripReference(sampleReference)
  })

  test('property: display field round-trips', () => {
    fc.assert(
      fc.property(referenceFieldArb('display'), (override) =>
        roundTripReference({ ...sampleReference, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: reference field round-trips', () => {
    fc.assert(
      fc.property(referenceFieldArb('reference'), (override) =>
        roundTripReference({ ...sampleReference, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: type field round-trips', () => {
    fc.assert(
      fc.property(referenceFieldArb('type'), (override) =>
        roundTripReference({ ...sampleReference, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: identifier field round-trips (Reference→Identifier cycle, depth 2)', () => {
    fc.assert(
      fc.property(referenceFieldArb('identifier'), (override) =>
        roundTripReference({ ...sampleReference, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('FhirR4Identifier', () => {
  test('round-trips empty shell', () => {
    roundTripIdentifier(sampleIdentifier)
  })

  test('property: system field round-trips', () => {
    fc.assert(
      fc.property(identifierFieldArb('system'), (override) =>
        roundTripIdentifier({ ...sampleIdentifier, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: value field round-trips', () => {
    fc.assert(
      fc.property(identifierFieldArb('value'), (override) =>
        roundTripIdentifier({ ...sampleIdentifier, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: use field round-trips', () => {
    fc.assert(
      fc.property(identifierFieldArb('use'), (override) =>
        roundTripIdentifier({ ...sampleIdentifier, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: period field round-trips', () => {
    fc.assert(
      fc.property(identifierFieldArb('period'), (override) =>
        roundTripIdentifier({ ...sampleIdentifier, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: type field round-trips (CodeableConcept)', () => {
    fc.assert(
      fc.property(identifierFieldArb('type'), (override) =>
        roundTripIdentifier({ ...sampleIdentifier, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: assigner field round-trips (capped to null at the arbitrary level)', () => {
    fc.assert(
      fc.property(identifierFieldArb('assigner'), (override) =>
        roundTripIdentifier({ ...sampleIdentifier, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('fragmentIdOf', () => {
  it('should read the contained id out of a #id reference', () => {
    // Act
    const id = fragmentIdOf('#med-1')

    // Assert
    expect(id).toEqual(Option.some('med-1'))
  })

  it('should read back every id fragmentReferenceTo writes', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (id) => {
        // Act
        const readBack = fragmentIdOf(fragmentReferenceTo(id))

        // Assert
        expect(readBack).toEqual(Option.some(id))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should never read a reference to something outside the resource as a fragment', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.webUrl(),
          fc
            .tuple(fc.constantFrom('Medication', 'Location'), fc.string())
            .map(([resourceType, id]) => `${resourceType}/${id}`)
        ),
        (reference) => {
          // Act
          const id = fragmentIdOf(reference)

          // Assert
          expect(id).toEqual(Option.none())
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should not read a bare # as naming any contained resource', () => {
    expect(fragmentIdOf('#')).toEqual(Option.none())
  })
})
