import { HashSet, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as ImportedRecord from '../../entities/imported-record.ts'
import * as ChangedStoredRecord from '../../entities/kept-record.ts'
import * as OfferedFields from '../../entities/offered-fields.ts'
import * as StoredMatch from '../../entities/stored-match.ts'
import {
  candidate,
  copyOf,
  detached,
  NAMES,
  OTHER_SOURCE,
  prescriptionWire,
  SOURCE,
  stored,
  tyraWire,
} from '../../import-plan.test-helpers.ts'
import * as ComparableReferences from './comparable-references.ts'
import { compareToStored } from './differences-of.ts'

/** What an offer says, its identifiers by value, for a whole-value assertion. */
interface OfferSummary {
  readonly gapFilling: readonly string[]
  readonly overwriting: readonly string[]
  readonly identifiersToAdd: readonly string[]
}

/** No record of an import to compare references by: each compared as it is, or by its identifier. */
const NO_RECORDS = ComparableReferences.of([], StoredMatch.empty)

const summaryOf = (offered: OfferedFields.Type): OfferSummary => ({
  gapFilling: offered.gapFilling,
  overwriting: offered.overwriting,
  identifiersToAdd: offered.identifiersToAdd.map(({ value }) => value),
})

describe('compareToStored', () => {
  it('should offer a field the existing record has no value for as filling a gap', () => {
    // Arrange
    const imported = detached(tyraWire('tyra', { gender: 'female' }))
    const existing = stored({ ...tyraWire('tyra'), id: 'p-1' })

    // Act
    const offered = compareToStored(imported, existing, NO_RECORDS)

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
    const offered = compareToStored(imported, existing, NO_RECORDS)

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
    const offered = compareToStored(imported, existing, NO_RECORDS)

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
    const offered = compareToStored(imported, existing, NO_RECORDS)

    // Assert
    expect({ ...summaryOf(offered), offersNoField: OfferedFields.offersNoField(offered) }).toEqual({
      gapFilling: [],
      overwriting: [],
      identifiersToAdd: ['tyra-at-other'],
      offersNoField: true,
    })
  })

  it('should measure a gap against the stored record as an earlier import resource’s taken fields leave it', () => {
    // Arrange
    const earlier = detached(tyraWire('tyra', { gender: 'male' }))
    const imported = detached(tyraWire('tyra', { gender: 'female' }))
    const existing = stored({ ...tyraWire('tyra'), id: 'p-1' })

    // Act
    const offered = compareToStored(
      imported,
      ChangedStoredRecord.asItStands(
        ChangedStoredRecord.withChange(ChangedStoredRecord.of(existing), {
          resource: earlier,
          fieldsTaken: HashSet.make('gender'),
        })
      ),
      NO_RECORDS
    )

    // Assert
    expect(summaryOf(offered)).toEqual({
      gapFilling: [],
      overwriting: ['gender'],
      identifiersToAdd: [],
    })
  })

  it('should offer nothing an earlier import resource already gives the stored record as it stands', () => {
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
    const offered = compareToStored(
      imported,
      ChangedStoredRecord.asItStands(
        ChangedStoredRecord.withChange(ChangedStoredRecord.of(existing), {
          resource: earlier,
          fieldsTaken: HashSet.make('gender'),
        })
      ),
      NO_RECORDS
    )

    // Assert
    expect(summaryOf(offered)).toEqual({ gapFilling: [], overwriting: [], identifiersToAdd: [] })
  })

  it('should find a stored reference, literal beside type and identifier, the same as the import’s logical reference to that record', () => {
    // Arrange
    const imported = detached(prescriptionWire('rx-1', { system: NAMES, value: 'Dr. Brown' }))
    const existing = stored({
      ...prescriptionWire('rx-1', { system: NAMES, value: 'Dr. Brown' }),
      id: 'rx-stored',
      subject: {
        reference: 'Patient/p-1',
        type: 'Patient',
        identifier: { system: SOURCE, value: 'tyra' },
      },
      requester: {
        reference: 'Practitioner/pr-1',
        type: 'Practitioner',
        identifier: { system: NAMES, value: 'Dr. Brown' },
        display: 'Dr. Brown',
      },
    })

    // Act
    const offered = compareToStored(imported, existing, NO_RECORDS)

    // Assert
    expect(summaryOf(offered)).toEqual({ gapFilling: [], overwriting: [], identifiersToAdd: [] })
  })

  it('should find a stored stub, its display added, the same as the import’s logical reference without one', () => {
    // Arrange
    const imported = detached(prescriptionWire('rx-1', { system: NAMES, value: 'Dr. Brown' }))
    const existing = stored({
      ...prescriptionWire('rx-1', { system: NAMES, value: 'Dr. Brown' }),
      id: 'rx-stored',
      subject: {
        type: 'Patient',
        identifier: { system: SOURCE, value: 'tyra' },
        display: 'Tyra Ashford',
      },
    })

    // Act
    const offered = compareToStored(imported, existing, NO_RECORDS)

    // Assert
    expect(summaryOf(offered)).toEqual({ gapFilling: [], overwriting: [], identifiersToAdd: [] })
  })

  it('should find a reference that is only a display different when its text differs', () => {
    // Arrange
    const withRequester = (display: string): object => ({
      ...prescriptionWire('rx-1', { system: NAMES, value: 'Dr. Brown' }),
      requester: { display },
    })
    const imported = detached(withRequester('Dr. Brown'))
    const existing = stored({ ...withRequester('Dr. B. Brown'), id: 'rx-stored' })

    // Act
    const offered = compareToStored(imported, existing, NO_RECORDS)

    // Assert
    expect(summaryOf(offered)).toEqual({
      gapFilling: [],
      overwriting: ['requester'],
      identifiersToAdd: [],
    })
  })

  it('should find a literal reference to a record’s stage id the same as a stored literal to its stored copy', () => {
    // Arrange
    const tyra = copyOf(detached(tyraWire('tyra')), 'tyra', 'a.har', {
      stageId: { _tag: 'Derived', id: 'p-derived' },
    })
    const storedTyra = stored({ ...tyraWire('tyra'), id: 'p-1' })
    const records = ImportedRecord.fromCopies([tyra])
    const comparable = ComparableReferences.of(
      records,
      StoredMatch.make({
        records: records.map(
          ({ key }) =>
            [
              key,
              StoredMatch.makeEntry(
                [candidate(storedTyra, 'certain', 'identifier')],
                Option.none()
              ),
            ] as const
        ),
        references: [],
      })
    )
    const observationWire = {
      resourceType: 'Observation',
      identifier: [{ system: SOURCE, value: 'a1c-1' }],
      status: 'final',
      code: { text: 'A1c' },
    }
    const imported = detached({ ...observationWire, subject: { reference: 'Patient/p-derived' } })
    const existing = stored({
      ...observationWire,
      id: 'o-1',
      subject: { reference: 'Patient/p-1' },
    })

    // Act
    const offered = compareToStored(imported, existing, comparable)

    // Assert
    expect(summaryOf(offered)).toEqual({ gapFilling: [], overwriting: [], identifiersToAdd: [] })
  })

  it('should find a literal reference to any copy’s stage id of a record a source served at one URL the same as one to its record copy’s', () => {
    // Arrange
    const binaryCopy = (fileName: string): ReturnType<typeof copyOf> =>
      copyOf(detached({ resourceType: 'Binary', contentType: 'text/plain' }), 'binary', fileName, {
        sourceUrl: Option.some(new URL('https://fhir.example/r4/Binary/report-1')),
      })
    const comparable = ComparableReferences.of(
      ImportedRecord.fromCopies([binaryCopy('a.har'), binaryCopy('b.har')]),
      StoredMatch.empty
    )
    const observationWire = {
      resourceType: 'Observation',
      identifier: [{ system: SOURCE, value: 'a1c-1' }],
      status: 'final',
      code: { text: 'A1c' },
    }
    const imported = detached({
      ...observationWire,
      focus: [{ reference: 'Binary/minted/a.har/binary' }],
    })
    const existing = stored({
      ...observationWire,
      id: 'o-1',
      focus: [{ reference: 'Binary/minted/b.har/binary' }],
    })

    // Act
    const offered = compareToStored(imported, existing, comparable)

    // Assert
    expect(summaryOf(offered)).toEqual({ gapFilling: [], overwriting: [], identifiersToAdd: [] })
  })

  it('should not depend on the order the resources’ keys were written in', () => {
    // Arrange
    const imported = detached(
      tyraWire('tyra', { name: [{ given: ['Tyra'], family: 'Ashford' }], gender: 'female' })
    )
    const existing = stored({
      id: 'p-1',
      gender: 'female',
      name: [{ family: 'Ashford', given: ['Tyra'] }],
      ...tyraWire('tyra'),
    })

    // Act
    const offered = compareToStored(imported, existing, NO_RECORDS)

    // Assert
    expect(summaryOf(offered)).toEqual({ gapFilling: [], overwriting: [], identifiersToAdd: [] })
  })
})
