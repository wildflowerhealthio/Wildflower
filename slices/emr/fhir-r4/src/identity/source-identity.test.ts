import { Effect, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  deriveResourceId,
  derivedIdFailureAsParseError,
  DerivedIdUnavailable,
  digestInput,
  FHIR_ID_PATTERN,
  hasSourceIdentifier,
  ID_BYTES,
  sourceIdentifier,
  type SourceIdentity,
} from './source-identity.ts'

/**
 * Covers the derivation a collector re-keys with. Its three properties are
 * asserted directly because each maps to a concrete failure: an unstable id
 * turns every sync into a duplicate instead of an upsert; an id outside FHIR's
 * `[A-Za-z0-9-.]{1,64}` is rejected by the store's `PUT` at runtime, for input
 * the collector cannot control; and two sites (or two resource types) that
 * derive one id overwrite each other silently.
 */

const hapi: SourceIdentity = { prefix: 'fhir-r4', system: new URL('https://hapi.fhir.org/baseR4') }
const rexall: SourceIdentity = { prefix: 'rexall', system: new URL('https://letsbewell.ca') }

/**
 * The resource types a collector actually re-keys, plus the two others in the
 * union — letters only, which is the shape `digestInput`'s delimiter relies on.
 */
const resourceTypeArb = fc.constantFrom(
  'Patient',
  'Observation',
  'MedicationRequest',
  'MedicationDispense',
  'DocumentReference',
  'Binary'
)

const derive = (
  source: SourceIdentity,
  resourceType: string,
  externalId: string
): Promise<string> => Effect.runPromise(deriveResourceId(source, resourceType, externalId))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('deriveResourceId', () => {
  it('should derive a prefixed hex id from the source id', async () => {
    // Arrange / Act
    const id = await derive(hapi, 'Patient', '1234')

    // Assert
    expect(id).toMatch(/^fhir-r4-[0-9a-f]{32}$/)
  })

  it('should always produce a legal FHIR logical id', async () => {
    await fc.assert(
      fc.asyncProperty(resourceTypeArb, fc.string(), async (resourceType, externalId) => {
        // Act
        const id = await derive(rexall, resourceType, externalId)

        // Assert
        expect(id).toMatch(FHIR_ID_PATTERN)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should always derive the same id for the same source, type and id', async () => {
    await fc.assert(
      fc.asyncProperty(resourceTypeArb, fc.string(), async (resourceType, externalId) => {
        // Act
        const first = await derive(hapi, resourceType, externalId)
        const second = await derive(hapi, resourceType, externalId)

        // Assert
        expect(second).toBe(first)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should never derive one id for two different source ids', async () => {
    await fc.assert(
      fc.asyncProperty(
        resourceTypeArb,
        fc.string(),
        fc.string(),
        async (resourceType, one, other) => {
          // Arrange
          fc.pre(one !== other)

          // Act
          const first = await derive(hapi, resourceType, one)
          const second = await derive(hapi, resourceType, other)

          // Assert
          expect(second).not.toBe(first)
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should never derive one id for two sources that share a source id', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (externalId) => {
        // Act — the collision the derivation exists to prevent: two sites, same id
        const onHapi = await derive(hapi, 'Patient', externalId)
        const onRexall = await derive({ ...rexall, prefix: hapi.prefix }, 'Patient', externalId)

        // Assert
        expect(onRexall).not.toBe(onHapi)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should never derive one id for two resource types that share a source id', async () => {
    // Act
    const patient = await derive(hapi, 'Patient', '7')
    const observation = await derive(hapi, 'Observation', '7')

    // Assert
    expect(observation).not.toBe(patient)
  })

  it('should keep the source id out of the derived one', async () => {
    // Arrange — a source id that is itself FHIR-legal, so nothing forces a change
    const externalId = 'uid-abc-123'

    // Act
    const id = await derive(rexall, 'Patient', externalId)

    // Assert
    expect(id).not.toContain(externalId)
  })

  it('should fail when crypto.subtle is unavailable', async () => {
    // Arrange — an insecure context: `crypto` exists, `subtle` does not
    vi.stubGlobal('crypto', {})

    // Act
    const outcome = await Effect.runPromise(
      Effect.either(deriveResourceId(hapi, 'Patient', '1234'))
    )

    // Assert
    expect(outcome._tag).toBe('Left')
    expect(outcome._tag === 'Left' && outcome.left).toBeInstanceOf(DerivedIdUnavailable)
  })
})

describe('digestInput', () => {
  it('should join the source system, resource type and id with a delimiter', () => {
    // Act
    const input = digestInput(rexall, 'Patient', 'uid-abc-123')

    // Assert
    expect(input).toBe('https://letsbewell.ca/|Patient|uid-abc-123')
  })

  it('should never produce one input for two different triples', () => {
    fc.assert(
      fc.property(
        fc.webUrl(),
        resourceTypeArb,
        fc.string(),
        fc.webUrl(),
        resourceTypeArb,
        fc.string(),
        (systemA, typeA, idA, systemB, typeB, idB) => {
          // Arrange
          const a: SourceIdentity = { prefix: 'p', system: new URL(systemA) }
          const b: SourceIdentity = { prefix: 'p', system: new URL(systemB) }
          fc.pre(a.system.href !== b.system.href || typeA !== typeB || idA !== idB)

          // Act / Assert
          expect(digestInput(a, typeA, idA)).not.toBe(digestInput(b, typeB, idB))
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('sourceIdentifier', () => {
  it('should record the source id against the source system', () => {
    // Act
    const identifier = sourceIdentifier(rexall, 'uid-abc-123')

    // Assert
    expect(identifier.system?.href).toBe(rexall.system.href)
    expect(identifier.value).toBe('uid-abc-123')
    expect(identifier.use).toBe('secondary')
  })
})

describe('hasSourceIdentifier', () => {
  it('should recognize an identifier this source already wrote', () => {
    // Arrange
    const identifiers = [sourceIdentifier(rexall, 'uid-abc-123')]

    // Act / Assert
    expect(hasSourceIdentifier(identifiers, rexall)).toBe(true)
  })

  it('should ignore identifiers from other systems', () => {
    // Arrange — the carebook external id a Rexall MedicationRequest arrives with
    const identifiers = [
      {
        ...sourceIdentifier(rexall, 'rx-1'),
        system: new URL('http://schema.carebook.com/v1/fhir'),
      },
    ]

    // Act / Assert
    expect(hasSourceIdentifier(identifiers, rexall)).toBe(false)
  })

  it('should ignore an identifier with no system', () => {
    // Arrange
    const identifiers = [{ ...sourceIdentifier(rexall, 'rx-1'), system: null }]

    // Act / Assert
    expect(hasSourceIdentifier(identifiers, rexall)).toBe(false)
  })
})

describe('derivedIdFailureAsParseError', () => {
  it('should carry the underlying reason into the parse error', () => {
    // Arrange
    const cause = new DerivedIdUnavailable({ reason: 'crypto.subtle is unavailable' })

    // Act — any AST will do; the error only borrows one to name the type it
    // was producing when derivation was attempted
    const error = derivedIdFailureAsParseError(Schema.String.ast, cause)

    // Assert
    expect(error.message).toContain('crypto.subtle is unavailable')
  })
})

describe('ID_BYTES', () => {
  it('should leave a derived id inside the FHIR length bound', () => {
    // Arrange — the longest prefix in use, plus the separator and the hex
    const longest = 'fhir-r4'

    // Act
    const length = longest.length + 1 + ID_BYTES * 2

    // Assert
    expect(length).toBeLessThanOrEqual(64)
  })
})
