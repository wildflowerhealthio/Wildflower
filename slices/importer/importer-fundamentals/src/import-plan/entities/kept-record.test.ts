import { HashSet } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { detached, OTHER_SOURCE, SOURCE, stored, tyraWire } from '../import-plan.test-helpers.ts'
import * as ChangedStoredRecord from './kept-record.ts'

/** Covers a stored record as it stands once the import's records make their changes, in order. */

const storedTyra = stored({ ...tyraWire('tyra'), id: 'p-1' })

describe('ChangedStoredRecord.asItStands', () => {
  it('should be the stored record itself while nothing changes it', () => {
    // Arrange / Act
    const asItStands = ChangedStoredRecord.asItStands(ChangedStoredRecord.of(storedTyra))

    // Assert
    expect(asItStands).toBe(storedTyra)
  })

  it('should lay each change’s taken fields over the stored record, later ones winning, and join their identifiers', () => {
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
    const changed = ChangedStoredRecord.withChange(
      ChangedStoredRecord.withChange(ChangedStoredRecord.of(storedTyra), {
        resource: first,
        fieldsTaken: HashSet.make('gender'),
      }),
      { resource: second, fieldsTaken: HashSet.make('gender') }
    )

    // Act
    const asItStands = ChangedStoredRecord.asItStands(changed)

    // Assert
    expect(
      asItStands.resourceType === 'Patient'
        ? {
            id: asItStands.id,
            gender: asItStands.gender,
            birthDate: asItStands.birthDate,
            identifiers: asItStands.identifier.map(({ value }) => value),
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
