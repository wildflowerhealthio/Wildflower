import { withMandatoryId } from '@wildflowerhealthio/fhir-r4/data-types'
import { DocumentReference } from '@wildflowerhealthio/fhir-r4/resources'
import { Effect, Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as DecodedFileSet from '../../decoded-file-set.ts'
import type * as PickedFile from '../../picked-file.ts'
import * as Section from '../../section.ts'
import * as SectionedList from '../../sectioned-list.ts'
import { detached, tyraWire } from '../import-plan.test-helpers.ts'
import * as FileSetOrigin from './file-set-origin.ts'
import * as ImportedCopy from './imported-copy.ts'

/**
 * Covers the two copy constructors: the review key, title, stage id and
 * detached resource each gives a copy.
 */

const PICKED_FILE: PickedFile.Type = { id: '0:a.har', fileName: 'a.har', bytes: new Uint8Array() }

const ORIGIN: FileSetOrigin.Type = FileSetOrigin.fromFileSet('har', {
  pickedFiles: [DecodedFileSet.unidentified(PICKED_FILE)],
  sectionedList: SectionedList.empty(),
  notes: [],
})

/** The placed rows of the records `resources`, keyed under the origin's prefix, each id minted `minted-<n>`. */
const placedRowsOf = (
  resources: readonly ReturnType<typeof detached>[]
): readonly DecodedFileSet.PlacedRow[] => {
  let minted = 0
  const placed = Effect.runSync(
    DecodedFileSet.placedRecordsOf(
      SectionedList.make([
        Section.make(
          'records',
          resources.map((resource, index) => ({
            localKey: `record-${index}`,
            resource,
            sourceUrl: Option.none(),
          }))
        ),
      ]),
      () => {
        minted += 1
        return `minted-${minted}`
      }
    )
  )
  return SectionedList.rows(DecodedFileSet.placedRowsOf(placed, FileSetOrigin.keyPrefixOf(ORIGIN)))
}

describe('ImportedCopy.fromPlacedRow', () => {
  it('should give a keyed record its derived id, its review key, its literal as its title, and its resource detached', () => {
    // Arrange
    const [row] = placedRowsOf([detached(tyraWire('tyra'))])
    if (row === undefined) throw new Error('One record places one row')

    // Act
    const copy = ImportedCopy.fromPlacedRow(ORIGIN, row)

    // Assert
    expect({ ...copy, resource: copy.resource.id }).toEqual({
      origin: ORIGIN,
      reviewKey: '0:a.har/record-0',
      title: `Patient/${row.placed.plan.id}`,
      isImplied: false,
      resource: null,
      sourceUrl: Option.none(),
      stageId: { _tag: 'Derived', id: row.placed.plan.id },
    })
    expect(ImportedCopy.hasDerivedStageId(copy)).toBe(true)
  })

  it('should give a keyless record a minted id, titled by its type and review key', () => {
    // Arrange
    const [row] = placedRowsOf([detached({ resourceType: 'Binary', contentType: 'text/plain' })])
    if (row === undefined) throw new Error('One record places one row')

    // Act
    const copy = ImportedCopy.fromPlacedRow(ORIGIN, row)

    // Assert
    expect({
      reviewKey: copy.reviewKey,
      title: copy.title,
      stageId: copy.stageId,
      hasDerivedStageId: ImportedCopy.hasDerivedStageId(copy),
    }).toEqual({
      reviewKey: '0:a.har/record-0',
      title: 'Binary (0:a.har/record-0)',
      stageId: { _tag: 'Minted', id: 'minted-1' },
      hasDerivedStageId: false,
    })
  })
})

describe('ImportedCopy.fromSourceFile', () => {
  it('should key the source file by its picked file, title it by the file name, and give it its content-derived id', () => {
    // Arrange
    const sourceFile = Schema.decodeUnknownSync(withMandatoryId(DocumentReference.Schema))({
      resourceType: 'DocumentReference',
      id: 'content-hash',
      status: 'current',
      content: [{ attachment: { contentType: 'application/json' } }],
    })

    // Act
    const copy = ImportedCopy.fromSourceFile(ORIGIN, { pickedFile: PICKED_FILE, sourceFile })

    // Assert
    expect(copy).toEqual({
      origin: ORIGIN,
      reviewKey: '0:a.har/source-file/a.har',
      title: 'a.har',
      isImplied: false,
      resource: { ...sourceFile, id: null },
      sourceUrl: Option.none(),
      stageId: { _tag: 'Derived', id: 'content-hash' },
    })
    expect(ImportedCopy.hasDerivedStageId(copy)).toBe(true)
  })
})
