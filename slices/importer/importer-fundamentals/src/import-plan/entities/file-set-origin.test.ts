import { describe, expect, it } from 'vite-plus/test'

import * as DecodedFileSet from '../../decoded-file-set.ts'
import type * as PickedFile from '../../picked-file.ts'
import * as SectionedList from '../../sectioned-list.ts'
import * as FileSetOrigin from './file-set-origin.ts'

/** Covers a file set's origin: what it is read off, when two are one set, and its key prefix. */

/** A picked file of `fileName` at batch position `position`. */
const pickedFile = (position: number, fileName: string): PickedFile.Type => ({
  id: `${position}:${fileName}`,
  fileName,
  bytes: new Uint8Array(),
})

const FIRST_STUDY_FILE = pickedFile(0, 'scan-1.dcm')
const SECOND_STUDY_FILE = pickedFile(1, 'scan-2.dcm')

/** A file set of `pickedFiles` holding nothing. */
const fileSetOf = (
  pickedFiles: readonly [PickedFile.Type, ...PickedFile.Type[]]
): DecodedFileSet.Type => ({
  pickedFiles: [
    DecodedFileSet.unidentified(pickedFiles[0]),
    ...pickedFiles.slice(1).map(DecodedFileSet.unidentified),
  ],
  sectionedList: SectionedList.empty(),
  notes: [],
})

describe('FileSetOrigin.fromFileSet', () => {
  it('should read the set’s picked files in pick order beside its format', () => {
    // Arrange / Act
    const origin = FileSetOrigin.fromFileSet(
      'dicom',
      fileSetOf([FIRST_STUDY_FILE, SECOND_STUDY_FILE])
    )

    // Assert
    expect(origin).toEqual({ format: 'dicom', pickedFiles: [FIRST_STUDY_FILE, SECOND_STUDY_FILE] })
  })
})

describe('FileSetOrigin.equivalence', () => {
  it('should hold two origins one set when their format and picked files agree, in order', () => {
    // Arrange
    const study = FileSetOrigin.fromFileSet(
      'dicom',
      fileSetOf([FIRST_STUDY_FILE, SECOND_STUDY_FILE])
    )
    const sameStudy = FileSetOrigin.fromFileSet(
      'dicom',
      fileSetOf([FIRST_STUDY_FILE, SECOND_STUDY_FILE])
    )
    const otherFormat = FileSetOrigin.fromFileSet(
      'har',
      fileSetOf([FIRST_STUDY_FILE, SECOND_STUDY_FILE])
    )
    const firstFileAlone = FileSetOrigin.fromFileSet('dicom', fileSetOf([FIRST_STUDY_FILE]))

    // Act / Assert
    expect([
      FileSetOrigin.equivalence(study, sameStudy),
      FileSetOrigin.equivalence(study, otherFormat),
      FileSetOrigin.equivalence(study, firstFileAlone),
    ]).toEqual([true, false, false])
  })
})

describe('FileSetOrigin.keyPrefixOf', () => {
  it('should prefix every review key of the set by its first picked file', () => {
    // Arrange / Act
    const prefix = FileSetOrigin.keyPrefixOf(
      FileSetOrigin.fromFileSet('dicom', fileSetOf([FIRST_STUDY_FILE, SECOND_STUDY_FILE]))
    )

    // Assert
    expect(prefix).toBe('0:scan-1.dcm/')
  })
})
