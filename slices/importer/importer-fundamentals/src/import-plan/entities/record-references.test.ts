import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { LogicalReference } from '@wildflowerhealthio/fhir-r4/resources'
import { HashSet, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import {
  copyOf,
  detached,
  drBrownWire,
  NAMES,
  OTHER_SOURCE,
  prescriptionWire,
  SOURCE,
  tyraWire,
} from '../import-plan.test-helpers.ts'
import * as ImportedCopy from './imported-copy.ts'
import * as ImportedRecord from './imported-record.ts'
import * as RecordReferences from './record-references.ts'

const prescription = copyOf(
  detached(prescriptionWire('rx-1', { system: NAMES, value: 'Dr. Brown' })),
  'rx-1'
)
const drBrown = copyOf(detached(drBrownWire), 'rx-1#implied', 'a.har', { isImplied: true })

describe('RecordReferences.of', () => {
  it('should find the records another record references and the references that name no record', () => {
    // Arrange
    const records = ImportedRecord.fromCopies([prescription, drBrown])
    const tyraReference = LogicalReference.make(
      'Patient',
      Option.getOrThrow(DetachedResource.keyIdentifierOf(detached(tyraWire('tyra'))))
    )

    // Act
    const references = RecordReferences.of(records)

    // Assert
    expect({
      referenced: [...HashSet.values(references.referenced)],
      unresolved: references.unresolved.map(LogicalReference.key),
    }).toEqual({
      referenced: [ImportedCopy.recordKeyOf(drBrown)],
      unresolved: [LogicalReference.key(tyraReference)],
    })
  })

  it('should find a record referenced by an identifier other than its key', () => {
    // Arrange
    const brownByLicence = copyOf(
      detached({
        ...drBrownWire,
        identifier: [...drBrownWire.identifier, { system: SOURCE, value: 'licence-7' }],
      }),
      'brown'
    )
    const byLicence = copyOf(
      detached(prescriptionWire('rx-2', { system: SOURCE, value: 'licence-7' })),
      'rx-2'
    )

    // Act
    const references = RecordReferences.of(ImportedRecord.fromCopies([byLicence, brownByLicence]))

    // Assert
    expect([...HashSet.values(references.referenced)]).toEqual([
      ImportedCopy.recordKeyOf(brownByLicence),
    ])
  })

  it('should name each record by every qualified identifier its copies carry, and a shared identifier both records', () => {
    // Arrange
    const tyra = copyOf(detached(tyraWire('tyra')), 'tyra')
    const twin = copyOf(
      detached(
        tyraWire('twin', {
          identifier: [
            { system: OTHER_SOURCE, value: 'twin' },
            { system: SOURCE, value: 'tyra' },
          ],
        })
      ),
      'twin'
    )

    // Act
    const references = RecordReferences.of(ImportedRecord.fromCopies([tyra, twin]))

    // Assert
    expect(
      references.named.map(({ logicalReference, keys }) => ({
        value: logicalReference.identifier[0].value,
        keys: keys.length,
      }))
    ).toEqual([
      { value: 'tyra', keys: 2 },
      { value: 'twin', keys: 1 },
    ])
  })

  it('should not count a record naming itself as referenced', () => {
    // Arrange
    const selfNaming = copyOf(
      detached(
        tyraWire('tyra', {
          link: [
            {
              type: 'seealso',
              other: { type: 'Patient', identifier: { system: SOURCE, value: 'tyra' } },
            },
          ],
        })
      ),
      'tyra'
    )

    // Act
    const references = RecordReferences.of(ImportedRecord.fromCopies([selfNaming]))

    // Assert
    expect({
      referenced: HashSet.size(references.referenced),
      unresolved: references.unresolved.length,
    }).toEqual({ referenced: 0, unresolved: 0 })
  })
})
