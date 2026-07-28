import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import type { IdentifierType } from '../data-types/complex/identifier-and-reference.ts'
import {
  isPlainRecord,
  parseRelativeReference,
  type ReferenceRewrite,
  relativeReferencesIn,
  withRewrittenReferences,
} from './relative-reference.ts'

/**
 * Covers the untyped half of re-keying: the walk that finds a `Reference`
 * wherever a schema put one, and rebuilds the resource around a replacement.
 *
 * `withRewrittenReferences` asserts a return type the compiler cannot check
 * (see its remarks), so the tests here are what stands behind that assertion.
 * Two properties carry it:
 *
 * - a walk that rewrites **nothing** returns a deep-equal value — so the
 *   rebuild never loses, reorders, or invents a field;
 * - a walk that rewrites returns a value differing **only** at `reference` and
 *   `identifier` — so the rebuild is a substitution, not a transformation.
 *
 * Both run over generated values that include the shapes a decoded FHIR
 * resource actually contains, `URL` instances especially: they are the case a
 * naive `Object.entries` rebuild silently erases.
 */

const sourceIdentifier: IdentifierType = {
  id: null,
  extension: [],
  assigner: null,
  period: null,
  system: new URL('https://letsbewell.ca'),
  type: null,
  use: 'secondary',
  value: 'uid-abc-123',
}

/** Rewrites every relative reference to the same type under a derived id. */
const toDerived: ReferenceRewrite = ({ resourceType, id }) => ({
  reference: `${resourceType}/rexall-${id}`,
  identifier: { ...sourceIdentifier, value: id },
})

const rewriteNothing: ReferenceRewrite = () => null

describe('parseRelativeReference', () => {
  it('should split a relative reference into its type and id', () => {
    // Act
    const parsed = parseRelativeReference('Patient/uid-abc-123')

    // Assert
    expect(parsed).toEqual({ resourceType: 'Patient', id: 'uid-abc-123' })
  })

  it.each([
    ['#contained-medication', 'a contained reference'],
    ['https://hapi.fhir.org/baseR4/Patient/1', 'an absolute URL'],
    ['urn:uuid:8f0e1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b', 'a urn'],
    ['Patient/1/_history/2', 'a version-specific reference'],
    ['patient/1', 'a lowercased type'],
    ['Patient/', 'an empty id'],
    ['Patient', 'a bare type'],
    ['Patient/a/b', 'an id with a slash'],
  ])('should decline %s (%s)', (reference) => {
    // Act / Assert
    expect(parseRelativeReference(reference)).toBeNull()
  })

  it('should always round-trip the parts it split out', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('Patient', 'Observation', 'MedicationRequest'),
        sourceAssignedId,
        (resourceType, id) => {
          // Act
          const parsed = parseRelativeReference(`${resourceType}/${id}`)

          // Assert
          expect(parsed).toEqual({ resourceType, id })
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('isPlainRecord', () => {
  it('should reject a URL, whose state is not in its own properties', () => {
    // Act / Assert — the case that makes a naive rebuild erase the field
    expect(isPlainRecord(new URL('https://letsbewell.ca'))).toBe(false)
  })

  it('should accept an object literal', () => {
    expect(isPlainRecord({ reference: 'Patient/1' })).toBe(true)
  })

  it('should accept a null-prototype object', () => {
    expect(isPlainRecord(Object.create(null))).toBe(true)
  })

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'Patient/1'],
    ['a date', new Date(0)],
  ])('should reject %s', (_name, value) => {
    expect(isPlainRecord(value)).toBe(false)
  })
})

describe('withRewrittenReferences', () => {
  it('should replace a relative reference and record where it came from', () => {
    // Arrange
    const observation = { subject: { reference: 'Patient/uid-abc-123', identifier: null } }

    // Act
    const rewritten = withRewrittenReferences(observation, toDerived)

    // Assert
    expect(rewritten.subject.reference).toBe('Patient/rexall-uid-abc-123')
    expect(rewritten.subject.identifier).toEqual({ ...sourceIdentifier, value: 'uid-abc-123' })
  })

  it('should keep an identifier the source already stated', () => {
    // Arrange — a logical reference carries better provenance than a synthesized one
    const stated = { ...sourceIdentifier, value: 'the-source-said-this' }
    const dispense = { subject: { reference: 'Patient/uid-abc-123', identifier: stated } }

    // Act
    const rewritten = withRewrittenReferences(dispense, toDerived)

    // Assert
    expect(rewritten.subject.identifier).toEqual(stated)
  })

  it('should rewrite references nested in arrays and backbone elements', () => {
    // Arrange — `MedicationDispense.performer[].actor`, a slot no field list caught
    const dispense = {
      performer: [{ actor: { reference: 'Practitioner/pr-1', identifier: null } }],
      authorizingPrescription: [{ reference: 'MedicationRequest/rx-9', identifier: null }],
    }

    // Act
    const rewritten = withRewrittenReferences(dispense, toDerived)

    // Assert
    expect(rewritten.performer[0]?.actor.reference).toBe('Practitioner/rexall-pr-1')
    expect(rewritten.authorizingPrescription[0]?.reference).toBe('MedicationRequest/rexall-rx-9')
  })

  it.each([
    ['#contained-medication'],
    ['https://hapi.fhir.org/baseR4/Patient/1'],
    ['urn:uuid:8f0e1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b'],
  ])('should leave %s as it stands', (reference) => {
    // Arrange
    const request = { medicationReference: { reference, identifier: null } }

    // Act
    const rewritten = withRewrittenReferences(request, toDerived)

    // Assert
    expect(rewritten.medicationReference).toEqual({ reference, identifier: null })
  })

  it('should preserve a URL rather than rebuilding it', () => {
    // Arrange
    const system = new URL('http://schema.carebook.com/v1/fhir')
    const request = { identifier: [{ system, value: 'rx-1' }] }

    // Act
    const rewritten = withRewrittenReferences(request, toDerived)

    // Assert
    expect(rewritten.identifier[0]?.system).toBe(system)
  })

  it('should always return a deep-equal value when nothing is rewritten', () => {
    fc.assert(
      fc.property(decodedValue, (value) => {
        // Act
        const rewritten = withRewrittenReferences(value, rewriteNothing)

        // Assert
        expect(rewritten).toEqual(value)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should always leave every non-reference field untouched', () => {
    fc.assert(
      fc.property(decodedValue, (value) => {
        // Act
        const rewritten = withRewrittenReferences(value, toDerived)

        // Assert — the two fields a rewrite may touch, blanked on both sides
        expect(blankReferences(rewritten)).toEqual(blankReferences(value))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should always rewrite every relative reference it reports', () => {
    fc.assert(
      fc.property(decodedValue, (value) => {
        // Act
        const rewritten = withRewrittenReferences(value, toDerived)

        // Assert — nothing reported as rewritable survives the walk unrewritten
        expect(relativeReferencesIn(rewritten).map((r) => r.id)).toEqual(
          relativeReferencesIn(value).map((r) => `rexall-${r.id}`)
        )
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should not mutate the value it was given', () => {
    // Arrange
    const observation = { subject: { reference: 'Patient/uid-abc-123', identifier: null } }

    // Act
    withRewrittenReferences(observation, toDerived)

    // Assert
    expect(observation.subject.reference).toBe('Patient/uid-abc-123')
  })
})

describe('relativeReferencesIn', () => {
  it('should report every relative reference, wherever it sits', () => {
    // Arrange
    const dispense = {
      subject: { reference: 'Patient/p-1' },
      performer: [{ actor: { reference: 'Practitioner/pr-1' } }],
      medicationReference: { reference: '#contained-medication' },
    }

    // Act
    const found = relativeReferencesIn(dispense)

    // Assert
    expect(found).toEqual([
      { resourceType: 'Patient', id: 'p-1' },
      { resourceType: 'Practitioner', id: 'pr-1' },
    ])
  })

  it('should report a repeated reference once per occurrence', () => {
    // Arrange
    const observation = {
      subject: { reference: 'Patient/p-1' },
      performer: [{ reference: 'Patient/p-1' }],
    }

    // Act / Assert
    expect(relativeReferencesIn(observation)).toHaveLength(2)
  })

  it('should report nothing for a resource that references nothing', () => {
    expect(relativeReferencesIn({ resourceType: 'Patient', id: 'p-1' })).toEqual([])
  })
})

// Helpers

/**
 * An id as a *source* assigns it — any non-empty run of characters bar the
 * slash the reference form reserves. Deliberately not held to FHIR's id rule:
 * a source that assigns ids FHIR would reject is the case re-keying exists for.
 */
const sourceAssignedId: fc.Arbitrary<string> = fc
  .string({ minLength: 1 })
  .map((id) => id.split('/').join('-'))

/**
 * Values shaped like decoded FHIR: nested records and arrays, `URL` leaves (the
 * class instance a rebuild must not take apart), and reference records in both
 * the rewritable and the left-alone forms.
 */
const decodedValue: fc.Arbitrary<unknown> = fc.letrec<{ node: unknown }>((tie) => ({
  node: fc.oneof(
    { maxDepth: 4 },
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.webUrl().map((url) => new URL(url)),
    fc
      .tuple(
        fc.constantFrom('Patient', 'Observation', 'MedicationRequest', 'Practitioner'),
        sourceAssignedId
      )
      .map(([resourceType, id]) => ({ reference: `${resourceType}/${id}`, identifier: null })),
    fc
      .constantFrom('#contained', 'https://hapi.fhir.org/baseR4/Patient/1', 'urn:uuid:8f0e')
      .map((reference) => ({ reference, identifier: null })),
    fc.array(tie('node')),
    fc.dictionary(fc.string(), tie('node'))
  ),
})).node

/**
 * Replace every `reference`/`identifier` pair with a constant, so two values can
 * be compared on everything a rewrite is not allowed to touch.
 */
const blankReferences = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item: unknown) => blankReferences(item))
  if (!isPlainRecord(value)) return value
  const rebuilt: Record<string, unknown> = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, blankReferences(child)])
  )
  if (typeof rebuilt['reference'] === 'string') {
    rebuilt['reference'] = '<reference>'
    rebuilt['identifier'] = '<identifier>'
  }
  return rebuilt
}
