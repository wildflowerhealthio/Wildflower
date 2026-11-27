import type { FhirResource, FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import { HashSet, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as Difference from '../../entities/difference.ts'
import * as ImportedRecord from '../../entities/imported-record.ts'
import * as KeptRecord from '../../entities/kept-record.ts'
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
import { differencesOf } from './differences-of.ts'

/** The differences' fields, those that fill a gap and those that overwrite one, for a whole-value assertion. */
interface DifferencesSummary {
  readonly gapFilling: readonly string[]
  readonly overwriting: readonly string[]
}

/** `existing` as merged once an earlier incoming record, `earlier`, merges `fieldsTaken` into it. */
const asMergedAfter = (
  existing: FhirResourceWithId,
  earlier: FhirResource,
  fieldsTaken: HashSet.HashSet<string>
): FhirResourceWithId =>
  KeptRecord.asMerged(
    KeptRecord.make(existing, [{ incoming: earlier, fieldsTaken, isEdit: false }])
  )

/** No record of an import to compare references by: each compared as it is, or by its identifier. */
const NO_RECORDS = ComparableReferences.of([], StoredMatch.empty)

const summaryOf = (differences: readonly Difference.Type[]): DifferencesSummary => ({
  gapFilling: differences.filter(({ _tag }) => _tag === 'FillsGap').map(({ field }) => field),
  overwriting: differences.filter(({ _tag }) => _tag === 'Overwrites').map(({ field }) => field),
})

describe('differencesOf', () => {
  it('should count a field the kept record has no value for as a difference that fills a gap', () => {
    // Arrange
    const incoming = detached(tyraWire('tyra', { gender: 'female' }))
    const kept = stored({ ...tyraWire('tyra'), id: 'p-1' })

    // Act
    const differences = differencesOf(incoming, kept, NO_RECORDS)

    // Assert
    expect(summaryOf(differences)).toEqual({
      gapFilling: ['gender'],
      overwriting: [],
    })
  })

  it('should count a field the kept record has another value for as a difference that overwrites it', () => {
    // Arrange
    const incoming = detached(tyraWire('tyra', { birthDate: '1990-01-03' }))
    const kept = stored({ ...tyraWire('tyra'), id: 'p-1' })

    // Act
    const differences = differencesOf(incoming, kept, NO_RECORDS)

    // Assert
    expect(summaryOf(differences)).toEqual({
      gapFilling: [],
      overwriting: ['birthDate'],
    })
  })

  it('should find no difference in a field the incoming record has no value for', () => {
    // Arrange
    const incoming = detached(tyraWire('tyra'))
    const kept = stored({ ...tyraWire('tyra', { gender: 'female' }), id: 'p-1' })

    // Act
    const differences = differencesOf(incoming, kept, NO_RECORDS)

    // Assert
    expect(summaryOf(differences)).toEqual({
      gapFilling: [],
      overwriting: [],
    })
  })

  it('should find no difference when only identifiers differ', () => {
    // Arrange
    const incoming = detached(
      tyraWire('tyra', {
        identifier: [
          { system: 'https://source.example/id', value: 'tyra' },
          { system: OTHER_SOURCE, value: 'tyra-at-other' },
        ],
      })
    )
    const kept = stored({ ...tyraWire('tyra'), id: 'p-1' })

    // Act
    const differences = differencesOf(incoming, kept, NO_RECORDS)

    // Assert
    expect(summaryOf(differences)).toEqual({
      gapFilling: [],
      overwriting: [],
    })
  })

  it('should measure a gap against the kept record as an earlier merge’s taken fields leave it', () => {
    // Arrange
    const earlier = detached(tyraWire('tyra', { gender: 'male' }))
    const incoming = detached(tyraWire('tyra', { gender: 'female' }))
    const kept = stored({ ...tyraWire('tyra'), id: 'p-1' })

    // Act
    const differences = differencesOf(
      incoming,
      asMergedAfter(kept, earlier, HashSet.make('gender')),
      NO_RECORDS
    )

    // Assert
    expect(summaryOf(differences)).toEqual({
      gapFilling: [],
      overwriting: ['gender'],
    })
  })

  it('should find no difference in what an earlier merge already gives the kept record', () => {
    // Arrange
    const earlier = detached(
      tyraWire('tyra', {
        gender: 'female',
        identifier: [{ system: OTHER_SOURCE, value: 'tyra-at-other' }],
      })
    )
    const incoming = detached(
      tyraWire('tyra', {
        gender: 'female',
        identifier: [{ system: OTHER_SOURCE, value: 'tyra-at-other' }],
      })
    )
    const kept = stored({ ...tyraWire('tyra'), id: 'p-1' })

    // Act
    const differences = differencesOf(
      incoming,
      asMergedAfter(kept, earlier, HashSet.make('gender')),
      NO_RECORDS
    )

    // Assert
    expect(summaryOf(differences)).toEqual({ gapFilling: [], overwriting: [] })
  })

  it('should find a stored reference, literal beside type and identifier, the same as the import’s logical reference to that record', () => {
    // Arrange
    const incoming = detached(prescriptionWire('rx-1', { system: NAMES, value: 'Dr. Brown' }))
    const kept = stored({
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
    const differences = differencesOf(incoming, kept, NO_RECORDS)

    // Assert
    expect(summaryOf(differences)).toEqual({ gapFilling: [], overwriting: [] })
  })

  it('should find a stored stub, its display added, the same as the import’s logical reference without one', () => {
    // Arrange
    const incoming = detached(prescriptionWire('rx-1', { system: NAMES, value: 'Dr. Brown' }))
    const kept = stored({
      ...prescriptionWire('rx-1', { system: NAMES, value: 'Dr. Brown' }),
      id: 'rx-stored',
      subject: {
        type: 'Patient',
        identifier: { system: SOURCE, value: 'tyra' },
        display: 'Tyra Ashford',
      },
    })

    // Act
    const differences = differencesOf(incoming, kept, NO_RECORDS)

    // Assert
    expect(summaryOf(differences)).toEqual({ gapFilling: [], overwriting: [] })
  })

  it('should find a reference that is only a display different when its text differs', () => {
    // Arrange
    const withRequester = (display: string): object => ({
      ...prescriptionWire('rx-1', { system: NAMES, value: 'Dr. Brown' }),
      requester: { display },
    })
    const incoming = detached(withRequester('Dr. Brown'))
    const kept = stored({ ...withRequester('Dr. B. Brown'), id: 'rx-stored' })

    // Act
    const differences = differencesOf(incoming, kept, NO_RECORDS)

    // Assert
    expect(summaryOf(differences)).toEqual({
      gapFilling: [],
      overwriting: ['requester'],
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
        records: records.map(({ key }) => ({
          key,
          entry: StoredMatch.makeEntry(
            [candidate(storedTyra, 'certain', 'identifier')],
            Option.none()
          ),
        })),
        externalReferences: [],
      })
    )
    const observationWire = {
      resourceType: 'Observation',
      identifier: [{ system: SOURCE, value: 'a1c-1' }],
      status: 'final',
      code: { text: 'A1c' },
    }
    const incoming = detached({ ...observationWire, subject: { reference: 'Patient/p-derived' } })
    const kept = stored({
      ...observationWire,
      id: 'o-1',
      subject: { reference: 'Patient/p-1' },
    })

    // Act
    const differences = differencesOf(incoming, kept, comparable)

    // Assert
    expect(summaryOf(differences)).toEqual({ gapFilling: [], overwriting: [] })
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
    const incoming = detached({
      ...observationWire,
      focus: [{ reference: 'Binary/minted/a.har/binary' }],
    })
    const kept = stored({
      ...observationWire,
      id: 'o-1',
      focus: [{ reference: 'Binary/minted/b.har/binary' }],
    })

    // Act
    const differences = differencesOf(incoming, kept, comparable)

    // Assert
    expect(summaryOf(differences)).toEqual({ gapFilling: [], overwriting: [] })
  })

  it('should not depend on the order the resources’ keys were written in', () => {
    // Arrange
    const incoming = detached(
      tyraWire('tyra', { name: [{ given: ['Tyra'], family: 'Ashford' }], gender: 'female' })
    )
    const kept = stored({
      id: 'p-1',
      gender: 'female',
      name: [{ family: 'Ashford', given: ['Tyra'] }],
      ...tyraWire('tyra'),
    })

    // Act
    const differences = differencesOf(incoming, kept, NO_RECORDS)

    // Assert
    expect(summaryOf(differences)).toEqual({ gapFilling: [], overwriting: [] })
  })
})

describe('differencesOf, as one list', () => {
  it('should list every difference once, in the incoming record’s field order as normalized, each filling a gap or overwriting', () => {
    // Arrange
    const incoming = detached(
      tyraWire('tyra', {
        name: [{ family: 'Ashford-Lee', given: ['Tyra'] }],
        gender: 'female',
        birthDate: '1990-01-03',
      })
    )
    const kept = stored({ ...tyraWire('tyra'), id: 'p-1' })

    // Act
    const differences = differencesOf(incoming, kept, NO_RECORDS)

    // Assert
    expect(differences).toEqual([
      Difference.Overwrites({ field: 'birthDate' }),
      Difference.FillsGap({ field: 'gender' }),
      Difference.Overwrites({ field: 'name' }),
    ])
  })

  it('should list nothing for an incoming record that says nothing the kept record does not', () => {
    // Arrange
    const incoming = detached(tyraWire('tyra'))
    const kept = stored({ ...tyraWire('tyra', { gender: 'female' }), id: 'p-1' })

    // Act
    const differences = differencesOf(incoming, kept, NO_RECORDS)

    // Assert
    expect(differences).toEqual([])
  })
})
