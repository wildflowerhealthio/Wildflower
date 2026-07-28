import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { SOURCE_PREFIX, withSourceIdentity } from './source-identity.ts'

/**
 * Covers the two things this package still states about identity: its prefix,
 * and that both entity URL shapes reduce to one namespace. The second is only
 * checkable here — `fhir-r4`'s suite proves `fhirServiceBase` agrees when told
 * the right shape; this proves the entities tell it the right shape.
 */

const patient = { resourceType: 'Patient', id: '42', identifier: [] as const }
const observation = { resourceType: 'Observation', id: 'obs-1', identifier: [] as const }

describe('SOURCE_PREFIX', () => {
  it('should be usable inside a FHIR logical id', () => {
    // Act / Assert — it is concatenated into one, so it must be FHIR id characters
    expect(SOURCE_PREFIX).toMatch(/^[A-Za-z0-9\-.]+$/)
  })
})

describe('withSourceIdentity', () => {
  it('should label derived ids with this collector', async () => {
    // Act
    const adopted = await Effect.runPromise(
      withSourceIdentity('https://hapi.fhir.org/baseR4/Patient/42', 'instance', Schema.String.ast, [
        patient,
      ])
    )

    // Assert
    expect(adopted[0]?.id).toMatch(/^fhir-r4-[0-9a-f]{32}$/)
  })

  it('should put both entity URL shapes in one namespace', async () => {
    // Arrange — the instance URL `PatientEntity` matches, and the search URL
    // `ObservationListEntity` matches, from the same server
    const fromInstance = await Effect.runPromise(
      withSourceIdentity('https://hapi.fhir.org/baseR4/Patient/42', 'instance', Schema.String.ast, [
        patient,
      ])
    )

    // Act
    const fromSearch = await Effect.runPromise(
      withSourceIdentity(
        'https://hapi.fhir.org/baseR4/Observation?subject=42',
        'search',
        Schema.String.ast,
        [{ ...observation, subject: { reference: 'Patient/42', identifier: null } }]
      )
    )

    // Assert — the `subject` resolves only because the two agree on the base
    expect(fromSearch[0]?.subject.reference).toBe(`Patient/${fromInstance[0]?.id}`)
  })
})
