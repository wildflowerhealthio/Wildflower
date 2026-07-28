import { Effect, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, vi } from 'vite-plus/test'

import type { IdentifierType } from '../data-types/complex/identifier-and-reference.ts'
import {
  adoptSourceIdentity,
  adoptSourceIdentityAll,
  parseWithSourceIdentity,
  type SourceKeyedResource,
} from './adopt-source-identity.ts'
import { FHIR_ID_PATTERN, type SourceIdentity } from './source-identity.ts'

/**
 * Covers re-keying as the single operation it has to be: the resource's own id,
 * the identifier that records the source's, and the references that would
 * otherwise be left pointing at ids the store no longer holds.
 *
 * The load-bearing test is "should keep a resource and its subject linked" — it
 * is the whole reason references are rewritten rather than left alone, and it
 * is what a naive per-resource re-key silently breaks: the Patient stores fine,
 * the MedicationRequest stores fine, and the link between them is gone.
 */

const rexall: SourceIdentity = { prefix: 'rexall', system: new URL('https://letsbewell.ca') }
const hapi: SourceIdentity = { prefix: 'fhir-r4', system: new URL('https://hapi.fhir.org/baseR4') }

interface TestPatient extends SourceKeyedResource {
  readonly resourceType: 'Patient'
  readonly birthDate?: string
}

interface TestMedicationRequest extends SourceKeyedResource {
  readonly resourceType: 'MedicationRequest'
  readonly subject: {
    readonly reference: string | null
    readonly identifier: IdentifierType | null
  }
}

const patient = (id: string | null, identifier: readonly IdentifierType[] = []): TestPatient => ({
  resourceType: 'Patient',
  id,
  identifier,
})

const medicationRequest = (id: string, subjectId: string): TestMedicationRequest => ({
  resourceType: 'MedicationRequest',
  id,
  identifier: [],
  subject: { reference: `Patient/${subjectId}`, identifier: null },
})

const adopt = <TResource extends SourceKeyedResource>(
  source: SourceIdentity,
  resource: TResource
): Promise<TResource> => Effect.runPromise(adoptSourceIdentity(source, resource))

describe('adoptSourceIdentity', () => {
  it('should re-key the resource onto a derived id', async () => {
    // Act
    const adopted = await adopt(rexall, patient('uid-abc-123'))

    // Assert
    expect(adopted.id).toMatch(/^rexall-[0-9a-f]{32}$/)
  })

  it('should record the source id as an identifier', async () => {
    // Act
    const adopted = await adopt(rexall, patient('uid-abc-123'))

    // Assert — the only way back to the record on the site
    expect(adopted.identifier).toEqual([
      expect.objectContaining({ system: rexall.system, value: 'uid-abc-123' }),
    ])
  })

  it('should keep identifiers the source already stated', async () => {
    // Arrange — the carebook external id a Rexall MedicationRequest arrives with
    const carebook: IdentifierType = {
      id: null,
      extension: [],
      assigner: null,
      period: null,
      system: new URL(
        'http://schema.carebook.com/v1/fhir/identifier/medicationrequest-external-id'
      ),
      type: null,
      use: null,
      value: 'rx-9',
    }

    // Act
    const adopted = await adopt(rexall, patient('uid-abc-123', [carebook]))

    // Assert
    expect(adopted.identifier[0]).toBe(carebook)
    expect(adopted.identifier).toHaveLength(2)
  })

  it('should keep a resource and its subject linked', async () => {
    // Arrange — the two halves of one Rexall run, re-keyed independently
    const uid = 'uid-abc-123'

    // Act
    const adoptedPatient = await adopt(rexall, patient(uid))
    const adoptedRequest = await adopt(rexall, medicationRequest('rx-9', uid))

    // Assert
    expect(adoptedRequest.subject.reference).toBe(`Patient/${adoptedPatient.id}`)
  })

  it('should record where a rewritten reference pointed', async () => {
    // Act
    const adopted = await adopt(rexall, medicationRequest('rx-9', 'uid-abc-123'))

    // Assert — a rewritten reference stays traceable, like the resource itself
    expect(adopted.subject.identifier).toEqual(
      expect.objectContaining({ system: rexall.system, value: 'uid-abc-123' })
    )
  })

  it('should leave a resource with no id entirely untouched', async () => {
    // Arrange — nothing to derive from, and `upsertResource` skips it anyway
    const unkeyed = patient(null)

    // Act
    const adopted = await adopt(rexall, unkeyed)

    // Assert
    expect(adopted).toBe(unkeyed)
  })

  it('should be idempotent', async () => {
    // Arrange — `parse` is where re-keying happens, and a resource can reach a
    // sink by more than one path
    const once = await adopt(rexall, medicationRequest('rx-9', 'uid-abc-123'))

    // Act
    const twice = await adopt(rexall, once)

    // Assert
    expect(twice).toEqual(once)
  })

  it('should always derive a legal FHIR id, whatever the source called it', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1 }), async (externalId) => {
        // Act
        const adopted = await adopt(rexall, patient(externalId))

        // Assert
        expect(adopted.id).toMatch(FHIR_ID_PATTERN)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should never let two sources claim one id', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1 }), async (externalId) => {
        // Act — the same source id, collected from two different sites
        const onRexall = await adopt(rexall, patient(externalId))
        const onHapi = await adopt(hapi, patient(externalId))

        // Assert
        expect(onHapi.id).not.toBe(onRexall.id)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should always keep a subject reference resolvable to the re-keyed patient', async () => {
    await fc.assert(
      fc.asyncProperty(referenceableId, fc.string({ minLength: 1 }), async (uid, requestId) => {
        // Act
        const adoptedPatient = await adopt(rexall, patient(uid))
        const adoptedRequest = await adopt(rexall, medicationRequest(requestId, uid))

        // Assert
        expect(adoptedRequest.subject.reference).toBe(`Patient/${adoptedPatient.id}`)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

describe('adoptSourceIdentityAll', () => {
  it('should re-key a whole parse output', async () => {
    // Arrange
    const resources = [
      medicationRequest('rx-9', 'uid-abc-123'),
      medicationRequest('rx-10', 'uid-abc-123'),
    ]

    // Act
    const adopted = await Effect.runPromise(adoptSourceIdentityAll(rexall, resources))

    // Assert
    expect(adopted.map((resource) => resource.id)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^rexall-[0-9a-f]{32}$/)])
    )
    expect(new Set(adopted.map((resource) => resource.id)).size).toBe(2)
  })

  it('should rewrite one shared subject to one derived reference', async () => {
    // Arrange — every medication in a Rexall bundle names the same patient
    const resources = [
      medicationRequest('rx-9', 'uid-abc-123'),
      medicationRequest('rx-10', 'uid-abc-123'),
    ]

    // Act
    const adopted = await Effect.runPromise(adoptSourceIdentityAll(rexall, resources))

    // Assert
    expect(adopted[1]?.subject.reference).toBe(adopted[0]?.subject.reference)
  })

  it('should return nothing for an empty parse', async () => {
    expect(await Effect.runPromise(adoptSourceIdentityAll(rexall, []))).toEqual([])
  })
})

describe('parseWithSourceIdentity', () => {
  it('should re-key a parse output', async () => {
    // Act
    const adopted = await Effect.runPromise(
      parseWithSourceIdentity(rexall, Schema.String.ast, [patient('uid-abc-123')])
    )

    // Assert
    expect(adopted[0]?.id).toMatch(/^rexall-[0-9a-f]{32}$/)
  })

  it('should surface a derivation failure as a ParseError', async () => {
    // Arrange — an insecure context: `crypto` exists, `subtle` does not
    vi.stubGlobal('crypto', {})

    // Act
    const outcome = await Effect.runPromise(
      Effect.either(parseWithSourceIdentity(rexall, Schema.String.ast, [patient('uid-abc-123')]))
    )
    vi.unstubAllGlobals()

    // Assert — `EntityDefinition.parse` may fail with nothing else
    expect(outcome._tag === 'Left' && outcome.left._tag).toBe('ParseError')
  })
})

// Helpers

/**
 * A source id that a relative reference can actually name — anything without a
 * slash. Ids *are* re-keyed regardless of what they contain; the exclusion is a
 * property of `Type/id` syntax, which cannot express an id containing a slash
 * for this module or for the source that wrote it.
 */
const referenceableId: fc.Arbitrary<string> = fc
  .string({ minLength: 1 })
  .map((id) => id.split('/').join('-'))
