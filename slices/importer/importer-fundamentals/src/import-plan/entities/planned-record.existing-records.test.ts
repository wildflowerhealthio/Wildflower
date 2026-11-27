import { MatchGrade } from '@wildflowerhealthio/fhir-r4/clients'
import { type FhirResourceWithId, literalReferenceOf } from '@wildflowerhealthio/fhir-r4/resources'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Array as Arr, Match, Option } from 'effect'
import fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import {
  candidate,
  storedTyraUnder,
  tyraA,
  tyraEntryArbitrary,
} from '../import-plan.test-helpers.ts'
import type * as ExistingRecord from './existing-record.ts'
import * as ImportedRecord from './imported-record.ts'
import * as PlannedRecord from './planned-record.ts'
import * as RecordChoice from './record-choice.ts'
import * as StoredMatch from './stored-match.ts'
import * as Suggestion from './suggestion.ts'

/**
 * Covers the existing records a planned record could merge into: the
 * search's candidates, the record under its derived id and the reviewer's
 * choice, each stored resource once.
 */

/** Tyra's planned record with `entry`, saved as new by its suggestion, and the reviewer's `chosen` choice if any. */
const plannedTyra = (
  entry: StoredMatch.Entry,
  chosen: Option.Option<RecordChoice.Type> = Option.none()
): PlannedRecord.Type => {
  const [record] = ImportedRecord.fromCopies([tyraA])
  if (record === undefined) throw new Error('Tyra makes a record')
  const planned = PlannedRecord.make({
    record,
    storedMatch: entry,
    suggestion: Suggestion.make(Option.some(RecordChoice.SaveAsNewRecord()), Suggestion.NoMatch()),
  })
  return Option.match(chosen, {
    onNone: () => planned,
    onSome: (choice) => PlannedRecord.withChoice(planned, choice),
  })
}

/** An existing record as its stored resource's literal and how the plan knows of it, for a whole-value assertion. */
const summaryOf = ({ resource, knownBy }: ExistingRecord.Type): unknown => ({
  resource: literalReferenceOf(resource),
  knownBy: Match.value(knownBy).pipe(
    Match.tagsExhaustive({
      MatchedBySearch: ({ grade, evidence }) => `${grade} by ${evidence}`,
      StoredUnderDerivedId: () => 'under derived id',
      ChosenByReviewer: () => 'chosen',
    })
  ),
})

/** Merge into `existing`, taking no field. */
const mergeInto = (existing: FhirResourceWithId): Option.Option<RecordChoice.Type> =>
  Option.some(RecordChoice.mergeTakingNoField(existing))

describe('PlannedRecord.existingRecordsOf', () => {
  it('should list the search’s candidates, then the record under the derived id, then the reviewer’s choice nothing else lists', () => {
    // Arrange
    const entry = StoredMatch.makeEntry(
      [
        candidate(storedTyraUnder('p-1'), 'certain', 'identifier'),
        candidate(storedTyraUnder('p-2'), 'possible', 'name'),
      ],
      Option.some(storedTyraUnder('p-3'))
    )

    // Act
    const existingRecords = PlannedRecord.existingRecordsOf(
      plannedTyra(entry, mergeInto(storedTyraUnder('p-4')))
    )

    // Assert
    expect(existingRecords.map(summaryOf)).toEqual([
      { resource: 'Patient/p-1', knownBy: 'certain by identifier' },
      { resource: 'Patient/p-2', knownBy: 'possible by name' },
      { resource: 'Patient/p-3', knownBy: 'under derived id' },
      { resource: 'Patient/p-4', knownBy: 'chosen' },
    ])
  })

  it('should list a candidate that is also the record under the derived id, or the reviewer’s choice, once, as matched by search', () => {
    // Arrange
    const entry = StoredMatch.makeEntry(
      [
        candidate(storedTyraUnder('p-1'), 'probable', 'name'),
        candidate(storedTyraUnder('p-2'), 'possible', 'name'),
      ],
      Option.some(storedTyraUnder('p-1'))
    )

    // Act
    const existingRecords = PlannedRecord.existingRecordsOf(
      plannedTyra(entry, mergeInto(storedTyraUnder('p-2')))
    )

    // Assert
    expect(existingRecords.map(summaryOf)).toEqual([
      { resource: 'Patient/p-1', knownBy: 'probable by name' },
      { resource: 'Patient/p-2', knownBy: 'possible by name' },
    ])
  })

  it('should list each stored resource once, in the order search, derived id, reviewer’s choice, a searched one with the best grade any of its candidates has, found by that candidate’s evidence', () => {
    fc.assert(
      fc.property(
        tyraEntryArbitrary,
        fc.option(fc.constantFrom('p-1', 'p-3', 'p-4', 'p-9').map(storedTyraUnder), {
          nil: undefined,
        }),
        (entry, chosenExisting) => {
          // Arrange
          const literalsOf = (resources: readonly FhirResourceWithId[]): readonly string[] =>
            Arr.dedupe(resources.map(literalReferenceOf))
          const searched = literalsOf(entry.candidates.map(({ resource }) => resource))
          const underDerivedId = literalsOf(Option.toArray(entry.storedUnderDerivedId)).filter(
            (literal) => !searched.includes(literal)
          )
          const chosen = literalsOf(Option.toArray(Option.fromNullable(chosenExisting))).filter(
            (literal) => !searched.includes(literal) && !underDerivedId.includes(literal)
          )
          const bestGradeOf = (literal: string): MatchGrade.Type =>
            Option.getOrThrow(
              Arr.head(
                Arr.sort(
                  entry.candidates
                    .filter(({ resource }) => literalReferenceOf(resource) === literal)
                    .map(({ grade }) => grade),
                  MatchGrade.bestFirst
                )
              )
            )

          const evidenceOfBestOf = (literal: string): readonly string[] =>
            Arr.dedupe(
              entry.candidates
                .filter(
                  ({ resource, grade }) =>
                    literalReferenceOf(resource) === literal && grade === bestGradeOf(literal)
                )
                .map(({ by }) => by)
            )

          // Act
          const existingRecords = PlannedRecord.existingRecordsOf(
            plannedTyra(entry, Option.flatMap(Option.fromNullable(chosenExisting), mergeInto))
          )

          // Assert
          expect(
            existingRecords.map(({ resource, knownBy }) => ({
              resource: literalReferenceOf(resource),
              knownBy:
                knownBy._tag === 'MatchedBySearch'
                  ? {
                      grade: knownBy.grade,
                      evidenceOfABestCandidate: evidenceOfBestOf(
                        literalReferenceOf(resource)
                      ).includes(knownBy.evidence),
                    }
                  : knownBy._tag,
            }))
          ).toEqual([
            ...searched.map((literal) => ({
              resource: literal,
              knownBy: { grade: bestGradeOf(literal), evidenceOfABestCandidate: true },
            })),
            ...underDerivedId.map((literal) => ({
              resource: literal,
              knownBy: 'StoredUnderDerivedId',
            })),
            ...chosen.map((literal) => ({ resource: literal, knownBy: 'ChosenByReviewer' })),
          ])
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
