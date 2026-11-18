import { HttpClient, HttpClientResponse } from '@effect/platform'
import { FhirR4ResourcesHttpApiClient } from '@wildflowerhealthio/fhir-r4/clients'
import { literalReferenceOf } from '@wildflowerhealthio/fhir-r4/resources'
import { Effect, Exit, HashMap, Layer } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { DEVICE, findAgainst, observation, SOURCE, tyra } from './stored-candidates.test-helpers.ts'
import * as StoredCandidates from './stored-candidates.ts'

/** Drives `StoredCandidates` over an in-memory server (`stored-candidates.test-helpers.ts`). */

describe('StoredCandidates.find', () => {
  it('should search every resource of a type in one identifier search, and Patients by birth date only for one nothing was found for', async () => {
    // Arrange
    const resources = [
      tyra('p-1', SOURCE, 'p-1'),
      observation('o-1', 'o-1'),
      observation('o-2', 'o-2'),
    ]

    // Act
    const { searches } = await findAgainst(resources, [])

    // Assert
    expect(searches.toSorted()).toEqual(
      [
        `Patient ${SOURCE}|p-1`,
        `Observation ${SOURCE}|o-1,${SOURCE}|o-2`,
        'Patient birthdate=1990-01-02',
      ].toSorted()
    )
  })

  it('should search no birth date when every Patient is found by identifier', async () => {
    // Act
    const { searches } = await findAgainst(
      [tyra('p-1', SOURCE, 'p-1')],
      [tyra('p-1', SOURCE, 'p-1')]
    )

    // Assert
    expect(searches).toEqual([`Patient ${SOURCE}|p-1`])
  })

  it('should give each resource its candidates by its literal reference, a namesake graded probable', async () => {
    // Arrange
    const imported = tyra('p-1', SOURCE, 'p-1')
    const stored = tyra('s-1', DEVICE, 's-1')

    // Act
    const { storedCandidates } = await findAgainst([imported], [stored])

    // Assert
    expect(
      StoredCandidates.of(storedCandidates, imported).map(({ resource, grade, by }) => ({
        reference: literalReferenceOf(resource),
        grade,
        by,
      }))
    ).toEqual([{ reference: 'Patient/s-1', grade: 'probable', by: 'name' }])
  })

  it('should keep the identifiers each resource was matched by', async () => {
    // Arrange
    const imported = observation('o-1', 'o-1')

    // Act
    const { storedCandidates } = await findAgainst([imported], [])

    // Assert
    expect(
      HashMap.toEntries(storedCandidates).map(([reference, { matchedBy }]) => [
        reference,
        matchedBy.map(({ system, value }) => `${system.href}|${value}`),
      ])
    ).toEqual([['Observation/o-1', [`${SOURCE}|o-1`]]])
  })

  it('should match a resource once however many times it is given', async () => {
    // Act
    const { searches } = await findAgainst(
      [observation('o-1', 'o-1'), observation('o-1', 'o-1')],
      []
    )

    // Assert
    expect(searches).toEqual([`Observation ${SOURCE}|o-1`])
  })

  it('should fail when a search fails, rather than read it as no match', async () => {
    // Arrange
    const failing = FhirR4ResourcesHttpApiClient.layer.pipe(
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response('down', { status: 503 }))
            )
          )
        )
      )
    )

    // Act
    const exit = await Effect.runPromiseExit(
      StoredCandidates.find([observation('o-1', 'o-1')]).pipe(Effect.provide(failing))
    )

    // Assert
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe('StoredCandidates.of', () => {
  it('should give an empty list for a resource that was not matched', () => {
    expect(StoredCandidates.of(StoredCandidates.empty, observation('o-1', 'o-1'))).toEqual([])
  })
})
