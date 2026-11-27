import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { LogicalReference, literalReferenceOf } from '@wildflowerhealthio/fhir-r4/resources'
import { Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import {
  candidate,
  detached,
  keyByImporterAssignedKey,
  storedBrown,
  storedTyra,
  storedTyraUnder,
  tyraA,
  tyraWire,
} from '../import-plan.test-helpers.ts'
import * as ImportedCopy from './imported-copy.ts'
import * as StoredMatch from './stored-match.ts'

/**
 * Covers a stored match: built from pairs, read by record and by reference
 * with nothing found where there is no entry, the stored copies of a
 * record and the name matches a suggestion counts.
 */

const tyraKey = ImportedCopy.recordKeyOf(tyraA)
const TYRA_REFERENCE = LogicalReference.make(
  'Patient',
  Option.getOrThrow(DetachedResource.keyIdentifierOf(detached(tyraWire('tyra'))))
)

describe('StoredMatch.make, ofRecord and ofReference', () => {
  it('should read each record’s entry and each reference’s candidates as given', () => {
    // Arrange
    const entry = StoredMatch.makeEntry(
      [candidate(storedTyra, 'certain', 'identifier')],
      Option.none()
    )
    const referenceCandidates = [candidate(storedTyra, 'certain', 'identifier')]

    // Act
    const match = StoredMatch.make({
      records: [{ key: tyraKey, entry }],
      externalReferences: [{ externalReference: TYRA_REFERENCE, candidates: referenceCandidates }],
    })

    // Assert
    expect({
      record: StoredMatch.ofRecord(match, tyraKey),
      reference: StoredMatch.ofReference(match, TYRA_REFERENCE),
    }).toEqual({ record: entry, reference: referenceCandidates })
  })

  it('should find nothing for a record or a reference with no entry', () => {
    // Arrange
    const match = StoredMatch.empty

    // Act
    const record = StoredMatch.ofRecord(match, keyByImporterAssignedKey('a.har/binary'))
    const reference = StoredMatch.ofReference(match, TYRA_REFERENCE)

    // Assert
    expect({ record, reference }).toEqual({
      record: { candidates: [], storedUnderDerivedId: Option.none() },
      reference: [],
    })
  })
})

describe('StoredMatch.storedCopiesOf', () => {
  it('should give the stored records found by identifier and the one under the derived id, each once, and no name match', () => {
    // Arrange
    const otherTyra = { ...storedTyra, id: 'p-2' }
    const entry = StoredMatch.makeEntry(
      [candidate(storedTyra, 'certain', 'identifier'), candidate(storedBrown, 'probable', 'name')],
      Option.some(storedTyra)
    )
    const withAnother = StoredMatch.makeEntry(
      [candidate(storedTyra, 'certain', 'identifier')],
      Option.some(otherTyra)
    )

    // Act / Assert
    expect({
      sameRecordTwice: StoredMatch.storedCopiesOf(entry).map(literalReferenceOf),
      anotherUnderDerivedId: StoredMatch.storedCopiesOf(withAnother).map(literalReferenceOf),
    }).toEqual({
      sameRecordTwice: ['Patient/p-1'],
      anotherUnderDerivedId: ['Patient/p-1', 'Patient/p-2'],
    })
  })
})

describe('StoredMatch.storedCopiesOfReference', () => {
  it('should give the stored records found by identifier for an external reference, and no name match', () => {
    // Arrange
    const match = StoredMatch.make({
      records: [],
      externalReferences: [
        {
          externalReference: TYRA_REFERENCE,
          candidates: [
            candidate(storedTyra, 'certain', 'identifier'),
            candidate(storedBrown, 'probable', 'name'),
          ],
        },
      ],
    })

    // Act
    const storedCopies = StoredMatch.storedCopiesOfReference(match, TYRA_REFERENCE)

    // Assert
    expect(storedCopies.map(literalReferenceOf)).toEqual(['Patient/p-1'])
  })
})

describe('StoredMatch.nameMatchesOf', () => {
  it('should give the stored records found by name graded certain or probable, best first, and neither one found by identifier nor a possible one', () => {
    // Arrange
    const entry = StoredMatch.makeEntry(
      [
        candidate(storedTyra, 'certain', 'identifier'),
        candidate(storedTyraUnder('p-2'), 'certain', 'name'),
        candidate(storedTyraUnder('p-3'), 'probable', 'name'),
        candidate(storedTyraUnder('p-4'), 'possible', 'name'),
      ],
      Option.none()
    )

    // Act
    const nameMatches = StoredMatch.nameMatchesOf(entry)

    // Assert
    expect(nameMatches.map(literalReferenceOf)).toEqual(['Patient/p-2', 'Patient/p-3'])
  })
})
