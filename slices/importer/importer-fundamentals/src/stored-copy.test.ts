import { type FhirResourceWithId, literalReferenceOf } from '@wildflowerhealthio/fhir-r4/resources'
import { Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import {
  decoded,
  DEVICE,
  findAgainst,
  observation,
  SOURCE,
  tyra,
} from './stored-candidates.test-helpers.ts'
import * as StoredCandidates from './stored-candidates.ts'
import * as StoredCopy from './stored-copy.ts'

/**
 * Drives `StoredCopy.of` over stored candidates found against an in-memory
 * server (`stored-candidates.test-helpers.ts`).
 */

/** A stored copy as its literal reference, or `None`. */
const referenceOf = (storedCopy: Option.Option<FhirResourceWithId>): Option.Option<string> =>
  Option.map(storedCopy, literalReferenceOf)

/** An Observation carrying each of `values` under the source's system. */
const observationCarrying = (id: string, values: readonly string[]): FhirResourceWithId =>
  decoded({
    resourceType: 'Observation',
    id,
    identifier: values.map((value) => ({ system: SOURCE, value })),
    status: 'final',
    code: { text: 'A1c' },
  })

describe('StoredCopy.of', () => {
  it('should find the one stored resource carrying the resource’s identifier, under whatever id', async () => {
    // Arrange
    const imported = observation('o-1', 'o-1')
    const { storedCandidates } = await findAgainst([imported], [observation('elsewhere', 'o-1')])

    // Act / Assert
    expect(referenceOf(StoredCopy.of(storedCandidates, imported))).toEqual(
      Option.some('Observation/elsewhere')
    )
  })

  it('should take the copy under the resource’s own id when its identifiers name several', async () => {
    // Arrange
    const imported = observation('o-1', 'o-1')
    const { storedCandidates } = await findAgainst(
      [imported],
      [observation('elsewhere', 'o-1'), observation('o-1', 'o-1')]
    )

    // Act / Assert
    expect(referenceOf(StoredCopy.of(storedCandidates, imported))).toEqual(
      Option.some('Observation/o-1')
    )
  })

  it('should find none when its identifiers name several stored resources, none under its own id', async () => {
    // Arrange
    const imported = observation('o-1', 'o-1')
    const { storedCandidates } = await findAgainst(
      [imported],
      [observation('a', 'o-1'), observation('b', 'o-1')]
    )

    // Act / Assert
    expect(StoredCopy.of(storedCandidates, imported)).toEqual(Option.none())
  })

  it('should find none for a resource whose identifiers name nothing stored', async () => {
    // Arrange
    const imported = observation('o-1', 'o-1')
    const { storedCandidates } = await findAgainst([imported], [])

    // Act / Assert
    expect(StoredCopy.of(storedCandidates, imported)).toEqual(Option.none())
  })

  it('should not find a namesake as a copy, since the diff compares by identifier only', async () => {
    // Arrange
    const imported = tyra('p-1', SOURCE, 'p-1')
    const { storedCandidates } = await findAgainst([imported], [tyra('s-1', DEVICE, 's-1')])

    // Act / Assert
    expect(StoredCopy.of(storedCandidates, imported)).toEqual(Option.none())
  })

  it('should find none for a resource that now carries an identifier it was not matched by', async () => {
    // Arrange: the resource as resolved, having assumed a stored copy's own identifier
    const imported = tyra('p-1', SOURCE, 'p-1')
    const { storedCandidates } = await findAgainst([imported], [tyra('p-1', SOURCE, 'p-1')])
    const resolved = decoded({
      resourceType: 'Patient',
      id: 'p-1',
      identifier: [
        { system: SOURCE, value: 'p-1' },
        { system: DEVICE, value: 's-1' },
      ],
    })

    // Act / Assert
    expect(StoredCopy.of(storedCandidates, resolved)).toEqual(Option.none())
  })

  it('should find the copy whatever order the resource now carries its identifiers in', async () => {
    // Arrange
    const imported = observationCarrying('o-1', ['o-1', 'o-2'])
    const { storedCandidates } = await findAgainst(
      [imported],
      [observationCarrying('elsewhere', ['o-1'])]
    )

    // Act / Assert
    expect(
      referenceOf(StoredCopy.of(storedCandidates, observationCarrying('o-1', ['o-2', 'o-1'])))
    ).toEqual(Option.some('Observation/elsewhere'))
  })

  it('should find none for a resource with no identifier, nor a Binary', async () => {
    // Arrange
    const keyless = decoded({ resourceType: 'Observation', id: 'o-9', status: 'final', code: {} })
    const binary = decoded({ resourceType: 'Binary', id: 'b-1', contentType: 'text/plain' })
    const { storedCandidates, searches } = await findAgainst([keyless, binary], [])

    // Act / Assert
    expect(searches).toEqual([])
    expect(StoredCopy.of(storedCandidates, keyless)).toEqual(Option.none())
    expect(StoredCopy.of(storedCandidates, binary)).toEqual(Option.none())
  })

  it('should find none for a resource that was not matched', () => {
    expect(StoredCopy.of(StoredCandidates.empty, observation('o-1', 'o-1'))).toEqual(Option.none())
  })
})
