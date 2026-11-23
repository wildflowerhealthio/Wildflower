import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { LogicalReference, literalReferenceOf } from '@wildflowerhealthio/fhir-r4/resources'
import { Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import {
  candidate,
  detached,
  storedBrown,
  storedTyra,
  tyraA,
  tyraWire,
} from '../import-plan.test-helpers.ts'
import * as ImportedCopy from './imported-copy.ts'
import * as RecordKey from './record-key.ts'
import * as StoredMatch from './stored-match.ts'

/**
 * Covers a stored match: built from pairs, read by record and by reference
 * with nothing found where there is no entry, and the stored copies of a
 * record.
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
      records: [[tyraKey, entry]],
      references: [[TYRA_REFERENCE, referenceCandidates]],
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
    const record = StoredMatch.ofRecord(
      match,
      RecordKey.ByImporterAssignedKey({ reviewKey: 'a.har/binary' })
    )
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
