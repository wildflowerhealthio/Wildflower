import { HashSet } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { detached, OTHER_SOURCE, SOURCE, stored, tyraWire } from '../import-plan.test-helpers.ts'
import * as KeptRecord from './kept-record.ts'

/** Covers a kept record as it stands once the import's records merge into it, in order. */

const storedTyra = stored({ ...tyraWire('tyra'), id: 'p-1' })

describe('KeptRecord.asMerged', () => {
  it('should be the kept record itself while nothing merges into it', () => {
    // Arrange / Act
    const asMerged = KeptRecord.asMerged(KeptRecord.of(storedTyra))

    // Assert
    expect(asMerged).toBe(storedTyra)
  })

  it('should lay each merge’s taken fields over the kept record, later ones winning, and join their identifiers', () => {
    // Arrange
    const first = detached(
      tyraWire('tyra', {
        gender: 'male',
        birthDate: '1991-03-04',
        identifier: [
          { system: SOURCE, value: 'tyra' },
          { system: OTHER_SOURCE, value: 'tyra-at-other' },
        ],
      })
    )
    const second = detached(tyraWire('tyra', { gender: 'female' }))
    const keptRecord = KeptRecord.withMerge(
      KeptRecord.withMerge(KeptRecord.of(storedTyra), {
        incoming: first,
        fieldsTaken: HashSet.make('gender'),
      }),
      { incoming: second, fieldsTaken: HashSet.make('gender') }
    )

    // Act
    const asMerged = KeptRecord.asMerged(keptRecord)

    // Assert
    expect(
      asMerged.resourceType === 'Patient'
        ? {
            id: asMerged.id,
            gender: asMerged.gender,
            birthDate: asMerged.birthDate,
            identifiers: asMerged.identifier.map(({ value }) => value),
          }
        : null
    ).toEqual({
      id: 'p-1',
      gender: 'female',
      birthDate: '1990-01-02',
      identifiers: ['tyra', 'tyra-at-other'],
    })
  })
})
