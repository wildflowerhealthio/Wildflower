import { literalReferenceOf, type LogicalReference } from '@wildflowerhealthio/fhir-r4/resources'
import {
  ImportedRecord,
  RecordReferences,
  StoredMatch,
} from '@wildflowerhealthio/importer-fundamentals'
import { Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { findStoredMatch } from './find-stored-match.ts'
import {
  copyOf,
  derivedId,
  detached,
  NAMES,
  observationWire,
  prescriptionWire,
  runAgainst,
  SOURCE,
  stored,
  tyraWire,
} from './plan-import.test-helpers.ts'

/**
 * Covers matching an import once against an in-memory server: one batch of
 * searches for its records and unresolved references, and one batch of reads
 * of its records' derived ids.
 */

/** A stored match's entries for `records` and `unresolved`, in their order, as literal references, for a whole-value assertion. */
const summaryOf = (
  records: readonly ImportedRecord.Type[],
  unresolved: readonly LogicalReference.Type[],
  storedMatch: StoredMatch.Type
): unknown => ({
  records: records.map(({ key }) => {
    const entry = StoredMatch.ofRecord(storedMatch, key)
    return {
      candidates: entry.candidates.map(({ resource, grade, by }) => [
        literalReferenceOf(resource),
        grade,
        by,
      ]),
      storedUnderDerivedId: Option.map(entry.storedUnderDerivedId, literalReferenceOf),
    }
  }),
  references: unresolved.map((reference) =>
    StoredMatch.ofReference(storedMatch, reference).map(({ resource }) =>
      literalReferenceOf(resource)
    )
  ),
})

describe('findStoredMatch', () => {
  it('should match every record and unresolved reference in one batch of searches, then read every derived id in one batch', async () => {
    // Arrange
    const records = ImportedRecord.fromCopies([
      copyOf(detached(tyraWire), 'tyra'),
      copyOf(detached(observationWire), 'a1c-1'),
      copyOf(detached(prescriptionWire), 'rx-1'),
    ])
    const storedResources = [
      stored({ ...tyraWire, id: 'p-1' }),
      stored({ ...observationWire, identifier: [], id: derivedId('Observation', 'a1c-1') }),
      stored({
        resourceType: 'Practitioner',
        id: 'pr-1',
        identifier: [{ system: NAMES, value: 'Dr. Brown' }],
      }),
    ]

    const { unresolved } = RecordReferences.of(records)

    // Act
    const { result, requests } = await runAgainst(
      findStoredMatch(records, unresolved),
      storedResources
    )

    // Assert
    expect({
      requests: [...requests].toSorted(),
      match: summaryOf(records, unresolved, result),
    }).toEqual({
      requests: [
        `MedicationRequest ${SOURCE}|rx-1`,
        `Observation ${SOURCE}|a1c-1`,
        `Patient ${SOURCE}|tyra`,
        `Practitioner ${NAMES}|Dr. Brown`,
        `read Patient/${derivedId('Patient', 'tyra')}, Observation/${derivedId('Observation', 'a1c-1')}, MedicationRequest/${derivedId('MedicationRequest', 'rx-1')}`,
      ],
      match: {
        records: [
          {
            candidates: [['Patient/p-1', 'certain', 'identifier']],
            storedUnderDerivedId: Option.none(),
          },
          {
            candidates: [],
            storedUnderDerivedId: Option.some(`Observation/${derivedId('Observation', 'a1c-1')}`),
          },
          { candidates: [], storedUnderDerivedId: Option.none() },
        ],
        references: [['Practitioner/pr-1']],
      },
    })
  })

  it('should read the derived id of a record found by identifier too', async () => {
    // Arrange
    const records = ImportedRecord.fromCopies([copyOf(detached(tyraWire), 'tyra')])

    // Act
    const { requests } = await runAgainst(findStoredMatch(records, []), [
      stored({ ...tyraWire, id: 'p-1' }),
    ])

    // Assert
    expect(requests).toEqual([
      `Patient ${SOURCE}|tyra`,
      `read Patient/${derivedId('Patient', 'tyra')}`,
    ])
  })

  it('should read no keyless record, whose stage id is minted', async () => {
    // Arrange
    const records = ImportedRecord.fromCopies([
      copyOf(detached({ resourceType: 'Binary', contentType: 'text/plain' }), 'binary'),
    ])

    // Act
    const { result, requests } = await runAgainst(findStoredMatch(records, []), [])

    // Assert
    expect({ requests, match: summaryOf(records, [], result) }).toEqual({
      requests: [],
      match: { records: [{ candidates: [], storedUnderDerivedId: Option.none() }], references: [] },
    })
  })
})
