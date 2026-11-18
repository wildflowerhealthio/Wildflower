import { HashSet } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { detached, OTHER_SOURCE, stored, tyraWire } from './import-plan.test-helpers.ts'
import * as OfferedFields from './offered-fields.ts'

/** The fields and identifier values `offered` gives, for a whole-value assertion. */
/** What an offer says, its identifiers by value. */
interface OfferSummary {
  readonly gapFilling: readonly string[]
  readonly overwriting: readonly string[]
  readonly identifiersToAdd: readonly string[]
}

const summaryOf = (offered: OfferedFields.Type): OfferSummary => ({
  gapFilling: offered.gapFilling,
  overwriting: offered.overwriting,
  identifiersToAdd: offered.identifiersToAdd.map(({ value }) => value),
})

describe('OfferedFields.compare', () => {
  it('should offer a field the existing record has no value for as filling a gap', () => {
    // Arrange
    const imported = detached(tyraWire('tyra', { gender: 'female' }))
    const existing = stored({ ...tyraWire('tyra'), id: 'p-1' })

    // Act
    const offered = OfferedFields.compare(imported, existing, [])

    // Assert
    expect(summaryOf(offered)).toEqual({
      gapFilling: ['gender'],
      overwriting: [],
      identifiersToAdd: [],
    })
  })

  it('should offer a field the existing record has another value for as overwriting it', () => {
    // Arrange
    const imported = detached(tyraWire('tyra', { birthDate: '1990-01-03' }))
    const existing = stored({ ...tyraWire('tyra'), id: 'p-1' })

    // Act
    const offered = OfferedFields.compare(imported, existing, [])

    // Assert
    expect(summaryOf(offered)).toEqual({
      gapFilling: [],
      overwriting: ['birthDate'],
      identifiersToAdd: [],
    })
  })

  it('should not offer a field the import has no value for', () => {
    // Arrange
    const imported = detached(tyraWire('tyra'))
    const existing = stored({ ...tyraWire('tyra', { gender: 'female' }), id: 'p-1' })

    // Act
    const offered = OfferedFields.compare(imported, existing, [])

    // Assert
    expect({ ...summaryOf(offered), offersNoField: OfferedFields.offersNoField(offered) }).toEqual({
      gapFilling: [],
      overwriting: [],
      identifiersToAdd: [],
      offersNoField: true,
    })
  })

  it('should offer no field but add the identifiers the existing record lacks when only identifiers differ', () => {
    // Arrange
    const imported = detached(
      tyraWire('tyra', {
        identifier: [
          { system: 'https://source.example/id', value: 'tyra' },
          { system: OTHER_SOURCE, value: 'tyra-at-other' },
        ],
      })
    )
    const existing = stored({ ...tyraWire('tyra'), id: 'p-1' })

    // Act
    const offered = OfferedFields.compare(imported, existing, [])

    // Assert
    expect({ ...summaryOf(offered), offersNoField: OfferedFields.offersNoField(offered) }).toEqual({
      gapFilling: [],
      overwriting: [],
      identifiersToAdd: ['tyra-at-other'],
      offersNoField: true,
    })
  })

  it('should measure a gap after the fields an earlier import resource takes are in place', () => {
    // Arrange
    const earlier = detached(tyraWire('tyra', { gender: 'male' }))
    const imported = detached(tyraWire('tyra', { gender: 'female' }))
    const existing = stored({ ...tyraWire('tyra'), id: 'p-1' })

    // Act
    const offered = OfferedFields.compare(imported, existing, [
      { resource: earlier, fields: HashSet.make('gender') },
    ])

    // Assert
    expect(summaryOf(offered)).toEqual({
      gapFilling: [],
      overwriting: ['gender'],
      identifiersToAdd: [],
    })
  })

  it('should offer nothing an earlier import resource already gives the existing record', () => {
    // Arrange
    const earlier = detached(
      tyraWire('tyra', {
        gender: 'female',
        identifier: [{ system: OTHER_SOURCE, value: 'tyra-at-other' }],
      })
    )
    const imported = detached(
      tyraWire('tyra', {
        gender: 'female',
        identifier: [{ system: OTHER_SOURCE, value: 'tyra-at-other' }],
      })
    )
    const existing = stored({ ...tyraWire('tyra'), id: 'p-1' })

    // Act
    const offered = OfferedFields.compare(imported, existing, [
      { resource: earlier, fields: HashSet.make('gender') },
    ])

    // Assert
    expect(summaryOf(offered)).toEqual({ gapFilling: [], overwriting: [], identifiersToAdd: [] })
  })
})
