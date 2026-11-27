import { writeDicom } from '@wildflowerhealthio/dicom/test-helpers'
import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import {
  DecodedFileSet,
  FileImporter,
  type FormatDecode,
  type ImportedCopy,
  type PickedFile,
  Section,
  SectionedList,
} from '@wildflowerhealthio/importer-fundamentals'
import { Effect, Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { fileCopiesOf } from './file-copies-of.ts'
import {
  decodedOf,
  detached,
  NAMES,
  prescriptionWire,
  sourceFileFormat,
  tyraWire,
} from './plan-import.test-helpers.ts'
import { defaultFormatSettings, formatRegistry } from './registry.ts'

/**
 * Covers reading a format's decode as copies of records: each file set
 * placed, linked and stamped by the import stage's own steps, no reference
 * between its records resolved.
 */

describe('fileCopiesOf', () => {
  it('should carry its decode’s format, the format every copy’s file set came from', async () => {
    // Arrange
    const decoded = decodedOf([['tyra', detached(tyraWire)]])

    // Act
    const { format, copies } = await Effect.runPromise(fileCopiesOf({ sourceFileFormat }, decoded))

    // Assert
    expect({ format, origins: copies.map(({ origin }) => origin.format) }).toEqual({
      format: 'test',
      origins: ['test', 'test'],
    })
  })

  it('should read a file set as its source file, then its records, then the records they imply, all detached', async () => {
    // Arrange
    const decoded = decodedOf([
      ['tyra', detached(tyraWire)],
      ['rx-1', detached(prescriptionWire)],
    ])

    // Act
    const { copies } = await Effect.runPromise(fileCopiesOf({ sourceFileFormat }, decoded))

    // Assert
    expect(
      copies.map(({ reviewKey, resource, isImplied, stageId }) => ({
        reviewKey,
        resourceType: resource.resourceType,
        id: resource.id,
        isImplied,
        stage: stageId._tag,
      }))
    ).toEqual([
      {
        reviewKey: '0:a.test/source-file/a.test',
        resourceType: 'DocumentReference',
        id: null,
        isImplied: false,
        stage: 'Derived',
      },
      {
        reviewKey: '0:a.test/tyra',
        resourceType: 'Patient',
        id: null,
        isImplied: false,
        stage: 'Derived',
      },
      {
        reviewKey: '0:a.test/rx-1',
        resourceType: 'MedicationRequest',
        id: null,
        isImplied: false,
        stage: 'Derived',
      },
      {
        reviewKey: `0:a.test/rx-1#implied:Practitioner|${NAMES}|Dr. Brown`,
        resourceType: 'Practitioner',
        id: null,
        isImplied: true,
        stage: 'Derived',
      },
    ])
  })

  it('should keep each reference between a set’s records as decoded', async () => {
    // Arrange
    const decoded = decodedOf([
      ['tyra', detached(tyraWire)],
      ['rx-1', detached(prescriptionWire)],
    ])

    // Act
    const { copies } = await Effect.runPromise(fileCopiesOf({ sourceFileFormat }, decoded))

    // Assert
    const prescription = copies.find(
      ({ resource }) => resource.resourceType === 'MedicationRequest'
    )
    expect(
      prescription?.resource.resourceType === 'MedicationRequest'
        ? prescription.resource.subject
        : null
    ).toMatchObject({
      reference: null,
      type: 'Patient',
      identifier: { value: 'tyra' },
    })
  })

  it('should report a set the stage cannot finish as unreadable rows, keeping the other sets’ copies and notes', async () => {
    // Arrange
    const goodFile: PickedFile.Type = {
      id: '0:good.test',
      fileName: 'good.test',
      bytes: new Uint8Array([1]),
    }
    const badFile: PickedFile.Type = {
      id: '1:bad.test',
      fileName: 'bad.test',
      bytes: new Uint8Array([2]),
    }
    const setOf = (
      pickedFile: PickedFile.Type,
      localKey: string,
      wire: object,
      note: string
    ): DecodedFileSet.Type => ({
      pickedFiles: [DecodedFileSet.unidentified(pickedFile)],
      sectionedList: SectionedList.make([
        Section.make('records', [{ localKey, resource: detached(wire), sourceUrl: Option.none() }]),
      ]),
      notes: [note],
    })
    const decoded: FormatDecode.Decoded<string> = {
      format: 'test',
      files: [goodFile, badFile],
      fileSets: [
        setOf(goodFile, 'tyra', tyraWire, 'good set'),
        setOf(badFile, 'rx-1', prescriptionWire, 'bad set'),
      ],
      unreadableFiles: [],
    }
    const missingFile = Schema.decodeUnknownSync(IdentifierAndReference.IdentifierSchema)({
      system: 'urn:ietf:rfc:3986',
      value: 'urn:oid:1.2.3',
    })
    const failingOnPrescriptions = {
      sourceFileFormat,
      linkToSourceFiles: (
        resource: FhirResourceWithId
      ): Effect.Effect<FhirResourceWithId, FileImporter.SourceFileNotFound> =>
        resource.resourceType === 'MedicationRequest'
          ? Effect.fail(new FileImporter.SourceFileNotFound({ identifier: missingFile }))
          : Effect.succeed(resource),
    }

    // Act
    const result = await Effect.runPromise(fileCopiesOf(failingOnPrescriptions, decoded))

    // Assert
    expect({
      copies: result.copies.map(({ reviewKey }) => reviewKey),
      files: result.files,
      notes: result.notes,
      unreadable: result.unreadableFiles.map(({ title, error }) => [title, error._tag]),
    }).toEqual({
      copies: ['0:good.test/source-file/good.test', '0:good.test/tyra'],
      files: [goodFile, badFile],
      notes: [{ origin: { format: 'test', pickedFiles: [goodFile] }, notes: ['good set'] }],
      unreadable: [['bad.test', 'SourceFileNotFound']],
    })
  })
})

/** One file of a two-file DICOM study, named by its instance, at batch position `instance - 1`. */
const studyFile = (instance: number): PickedFile.Type => ({
  id: `${instance - 1}:scan-${instance}.dcm`,
  fileName: `scan-${instance}.dcm`,
  bytes: writeDicom({
    StudyInstanceUID: '1.2.3.4.5',
    SeriesInstanceUID: '1.2.3.4.5.1',
    SOPInstanceUID: `1.2.3.4.5.1.${instance}`,
    InstanceNumber: instance,
    SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
    PatientName: { family: 'Doe', given: 'John', text: 'Doe John' },
    PatientID: 'P001',
    Modality: 'CT',
  }),
})

/** The copy of `resourceType` among `copies`. */
const copyOfType = (
  copies: readonly ImportedCopy.Type[],
  resourceType: string
): ImportedCopy.Type => {
  const found = copies.find(({ resource }) => resource.resourceType === resourceType)
  if (found === undefined) throw new Error(`No ${resourceType} copy`)
  return found
}

describe('fileCopiesOf over the DICOM importer', () => {
  it('should run the format’s hooks on the ids placing decided and stamp every record with the set’s smallest source file', async () => {
    // Arrange
    const dicom = formatRegistry.dicom
    const decoded = await Effect.runPromise(
      dicom.decode([studyFile(1), studyFile(2)], defaultFormatSettings.dicom)
    )

    // Act
    const { copies, unreadableFiles } = await Effect.runPromise(fileCopiesOf(dicom, decoded))

    // Assert
    const sourceFiles = copies.filter(
      ({ resource }) => resource.resourceType === 'DocumentReference'
    )
    const patient = copyOfType(copies, 'Patient')
    const study = copyOfType(copies, 'ImagingStudy')
    const sourceFileIds = sourceFiles.map(({ stageId }) => stageId.id)
    expect({
      unreadableFiles,
      sourceFiles: sourceFiles.map(({ resource }) =>
        resource.resourceType === 'DocumentReference'
          ? [
              resource.subject?.reference,
              resource.context?.related.map(({ reference }) => reference),
            ]
          : []
      ),
      gridfsFileIds:
        study.resource.resourceType === 'ImagingStudy'
          ? study.resource.series[0]?.instance.map(({ extension }) => extension[0]?.valueString)
          : [],
      sources: [
        ...new Set(
          copies
            .filter(({ resource }) => resource.resourceType !== 'DocumentReference')
            .map(({ resource }) => resource.meta?.source)
        ),
      ],
    }).toEqual({
      unreadableFiles: [],
      sourceFiles: sourceFiles.map(() => [
        `Patient/${patient.stageId.id}`,
        [`ImagingStudy/${study.stageId.id}`],
      ]),
      gridfsFileIds: sourceFileIds,
      sources: [`DocumentReference/${sourceFileIds.toSorted()[0]}`],
    })
  })
})
