import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { LogicalReference } from '@wildflowerhealthio/fhir-r4/resources'
import { HashSet, Match, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import type * as ImportPlan from '../entities/import-plan.ts'
import * as ImportedCopy from '../entities/imported-copy.ts'
import * as ImportedRecord from '../entities/imported-record.ts'
import * as PlannedRecord from '../entities/planned-record.ts'
import * as RecordChoice from '../entities/record-choice.ts'
import * as RecordKey from '../entities/record-key.ts'
import * as RecordReferences from '../entities/record-references.ts'
import * as StoredMatch from '../entities/stored-match.ts'
import {
  candidate,
  copyOf,
  detached,
  matchOf,
  OTHER_SOURCE,
  prescription,
  SAMPLE_COPIES,
  sampleMatch,
  samplePlan,
  SOURCE,
  stored,
  storedTyra,
  tyraA,
  tyraWire,
} from '../import-plan.test-helpers.ts'
import { suggestPlan } from './suggest-plan.ts'

/**
 * Covers suggesting a plan: every record suggested by its rule, in plan
 * order, a stored record two records use measured as the earlier one's
 * change leaves it.
 */

/** The plan of `copies`, grouped into records as `planImport` groups them, suggested from `storedMatch`. */
const planOf = (
  copies: readonly ImportedCopy.Type[],
  storedMatch: StoredMatch.Type
): ImportPlan.Type => {
  const records = ImportedRecord.fromCopies(copies)
  return suggestPlan(records, RecordReferences.of(records), storedMatch)
}

/** A plan's records by what a reviewer sees of their suggestion. */
const suggestionsOf = (plan: ImportPlan.Type): unknown =>
  plan.records.map((planned) => ({
    reason: planned.suggestion.reason._tag,
    needsDecision: PlannedRecord.needsDecision(planned),
    label: PlannedRecord.labelOf(planned),
  }))

describe('suggestPlan', () => {
  it('should keep each record’s copies, in plan order, the record where its first copy is', () => {
    // Arrange / Act
    const plan = planOf(SAMPLE_COPIES, sampleMatch())

    // Assert
    expect(
      plan.records.map(({ record: { key, copies } }) => ({
        key: Match.value(key).pipe(
          Match.tagsExhaustive({ Keyed: () => 'keyed', Keyless: ({ reviewKey }) => reviewKey })
        ),
        copies: copies.map(({ reviewKey }) => reviewKey),
      }))
    ).toEqual([
      { key: 'keyed', copies: ['a.har/tyra', 'b.pdf/tyra'] },
      { key: 'keyed', copies: ['a.har/rx-1'] },
      { key: 'keyed', copies: ['a.har/rx-1#implied'] },
    ])
  })

  it('should key each keyless record by its review key', () => {
    // Arrange
    const binary = (reviewKey: string): ImportedCopy.Type =>
      copyOf(detached({ resourceType: 'Binary', contentType: 'text/plain' }), reviewKey)

    // Act
    const plan = planOf([binary('first'), binary('second')], StoredMatch.empty)

    // Assert
    expect(plan.records.map(({ record }) => record.key)).toEqual([
      RecordKey.Keyless({ reviewKey: 'a.har/first' }),
      RecordKey.Keyless({ reviewKey: 'a.har/second' }),
    ])
  })

  it('should suggest each record by its rule, Dr. Brown in Needs a decision with his one candidate', () => {
    // Arrange / Act
    const plan = planOf(SAMPLE_COPIES, sampleMatch())

    // Assert
    expect(suggestionsOf(plan)).toEqual(suggestionsOf(samplePlan()))
  })

  it('should hold each record’s entry of the stored match', () => {
    // Arrange
    const match = sampleMatch()

    // Act
    const plan = planOf(SAMPLE_COPIES, match)

    // Assert
    expect(plan.records.map(({ storedMatch }) => storedMatch)).toEqual(
      plan.records.map(({ record }) => StoredMatch.ofRecord(match, record.key))
    )
  })

  it('should measure a second record using one stored record after the first takes its fields', () => {
    // Arrange
    const sharedStored = stored({
      ...tyraWire('tyra'),
      id: 'p-1',
      identifier: [
        { system: SOURCE, value: 'tyra' },
        { system: OTHER_SOURCE, value: 'tyra-at-other' },
      ],
    })
    const first = copyOf(detached(tyraWire('tyra', { gender: 'female' })), 'tyra', 'a.har')
    const second = copyOf(
      detached(tyraWire('tyra-at-other', { gender: 'male' }, OTHER_SOURCE)),
      'tyra',
      'b.pdf'
    )
    const match = matchOf([
      [ImportedCopy.recordKeyOf(first), [candidate(sharedStored, 'certain', 'identifier')]],
      [ImportedCopy.recordKeyOf(second), [candidate(sharedStored, 'certain', 'identifier')]],
    ])

    // Act
    const plan = planOf([first, second], match)

    // Assert
    expect(
      plan.records.map(({ suggestion }) => ({
        reason: suggestion.reason._tag,
        fieldsTaken: Option.map(suggestion.choice, (choice) =>
          RecordChoice.is('UseExistingRecord')(choice)
            ? [...HashSet.values(choice.fieldsTaken)]
            : []
        ),
      }))
    ).toEqual([
      { reason: 'IdentifierMatchFieldsDiffer', fieldsTaken: Option.some(['gender']) },
      { reason: 'IdentifierMatchFieldsDiffer', fieldsTaken: Option.some([]) },
    ])
  })

  it('should keep the stored candidates of each reference no record of the import resolves', () => {
    // Arrange
    const tyraReference = LogicalReference.make(
      'Patient',
      Option.getOrThrow(DetachedResource.keyIdentifierOf(tyraA.resource))
    )
    const candidates = [candidate(storedTyra, 'certain', 'identifier')]

    // Act
    const plan = planOf(
      [prescription],
      StoredMatch.make({ records: [], references: [[tyraReference, candidates]] })
    )

    // Assert
    expect(StoredMatch.ofReference(plan.storedMatch, tyraReference)).toEqual(candidates)
  })
})
