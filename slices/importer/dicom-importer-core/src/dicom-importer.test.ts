import { withMandatoryId } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  type FhirResourceWithId,
  ImagingStudy,
  Patient,
} from '@wildflowerhealthio/fhir-r4/resources'
import { type FileImporter, PickedFile } from '@wildflowerhealthio/importer-fundamentals'
import { Cause, DateTime, Effect, Exit, Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { sopInstanceIdentifier } from './decode.ts'
import { addGridfsFileIds, dicomImporter, GRIDFS_FILE_ID_EXTENSION_URL } from './dicom-importer.ts'
import { defaultDicomSettings } from './settings.ts'
import {
  DICOM_SOURCE_FILE_CODE,
  DICOM_SOURCE_FILE_CONTENT_TYPE,
  DICOM_SYSTEM,
} from './source-system.ts'

/**
 * The source file this format's importer mints for a picked file — the schema
 * driven under `dicomImporter`'s own format constants, which is the same
 * context its batch `decode` mints under.
 */
const mint = (bytes: Uint8Array, fileName = 'scan.dcm'): Promise<PickedFile.SourceFile> =>
  Effect.runPromise(
    Schema.encode(PickedFile.FromDocumentReference)({
      id: `0:${fileName}`,
      fileName,
      bytes,
    }).pipe(Effect.provideService(PickedFile.Format, dicomImporter.sourceFileFormat))
  )

describe('DICOM source file coding', () => {
  it('carries the DICOM coding on type and category, and application/dicom content', async () => {
    const resource = await mint(new Uint8Array([0x00, 0x01, 0x02]))

    expect(resource.type?.coding[0]?.system?.toString()).toBe(DICOM_SYSTEM)
    expect(resource.type?.coding[0]?.code).toBe(DICOM_SOURCE_FILE_CODE)
    expect(resource.category[0]?.coding[0]?.system?.toString()).toBe(DICOM_SYSTEM)
    expect(resource.category[0]?.coding[0]?.code).toBe(DICOM_SOURCE_FILE_CODE)
    expect(resource.content[0]?.attachment?.contentType).toBe(DICOM_SOURCE_FILE_CONTENT_TYPE)
    expect(resource.description).toBe('DICOM image: scan.dcm')
    expect(PickedFile.isSourceFile(dicomImporter.sourceFileFormat)(resource)).toBe(true)
  })

  it('exposes the category search token in system|code form', () => {
    expect(PickedFile.categoryToken(dicomImporter.sourceFileFormat)).toBe(
      `${DICOM_SYSTEM}|${DICOM_SOURCE_FILE_CODE}`
    )
  })

  it('mints a resource that reads back as its own source file, bytes and name recovered', async () => {
    const bytes = new Uint8Array(132)
    bytes.set([0x44, 0x49, 0x43, 0x4d], 128)
    const resource = await mint(bytes, 'my-scan.dcm')

    const back = await Effect.runPromise(
      Schema.decode(PickedFile.FromDocumentReference)(resource).pipe(
        Effect.provideService(PickedFile.Format, dicomImporter.sourceFileFormat)
      )
    )
    expect(back.fileName).toBe('my-scan.dcm')
    expect(back.bytes).toEqual(bytes)
  })
})

describe('dicomImporter', () => {
  it('has the dicom format tag', () => {
    expect(dicomImporter.format).toBe('dicom')
  })

  it('detects a file with DICM magic bytes at offset 128', () => {
    const bytes = new Uint8Array(132)
    bytes.set([0x44, 0x49, 0x43, 0x4d], 128)
    expect(dicomImporter.detect(bytes, 'unknown')).toBe(true)
  })

  it('detects a file by .dcm extension', () => {
    expect(dicomImporter.detect(new Uint8Array(), 'scan.dcm')).toBe(true)
    expect(dicomImporter.detect(new Uint8Array(), 'Scan.DCM')).toBe(true)
  })

  it('does not claim a non-DICOM file', () => {
    const json = new TextEncoder().encode('{"log":{"version":"1.2"}}')
    expect(dicomImporter.detect(json, 'capture.har')).toBe(false)
  })

  it('defaultSettings carries a time zone the runtime can resolve', () => {
    expect(dicomImporter.defaultSettings).toEqual(defaultDicomSettings)
    expect(Object.keys(dicomImporter.defaultSettings)).toEqual(['timeZone'])
    expect(Option.isSome(DateTime.zoneMakeNamed(defaultDicomSettings.timeZone))).toBe(true)
  })

  describe('decode', () => {
    it('collects an unreadable file for bytes that are not DICOM', async () => {
      const result = await Effect.runPromise(
        dicomImporter.decode(
          [
            {
              id: '0:sample.dcm',
              fileName: 'sample.dcm',
              bytes: new TextEncoder().encode('not a dicom file'),
            },
          ],
          defaultDicomSettings
        )
      )
      expect(result.fileSets).toHaveLength(0)
      expect(result.unreadableFiles).toHaveLength(1)
    })
  })
})

/** An `ImagingStudy` of one series whose instances carry `instances`' uids and extensions. */
const studyOf = (
  instances: readonly { readonly uid: string; readonly extension?: readonly object[] }[]
): FhirResourceWithId =>
  Schema.decodeUnknownSync(withMandatoryId(ImagingStudy.Schema))({
    resourceType: 'ImagingStudy',
    id: 'study',
    status: 'available',
    subject: { reference: 'Patient/p' },
    series: [
      {
        uid: 'S1',
        modality: { system: 'http://dicom.nema.org/resources/ontology/DCM', code: 'CT' },
        instance: instances.map(({ uid, extension = [] }) => ({
          uid,
          sopClass: { system: 'urn:dicom:uid', code: '1.2.840.10008.5.1.4.1.1.2' },
          extension,
        })),
      },
    ],
  })

/** A picked file and its source file, stored under `id`, identifying itself as the instance `uid`. */
const pickedSourceFile = async (
  id: string,
  uid: string
): Promise<FileImporter.PickedSourceFile> => {
  const pickedFile = { id: `0:${id}.dcm`, fileName: `${id}.dcm`, bytes: new Uint8Array([1]) }
  const sourceFile = await mint(pickedFile.bytes, pickedFile.fileName)
  return {
    pickedFile,
    sourceFile: { ...sourceFile, id, masterIdentifier: sopInstanceIdentifier(uid) },
  }
}

/** Each instance's uid beside its `gridfsFileId`. */
const gridfsFileIdsOf = (resource: FhirResourceWithId): readonly (readonly unknown[])[] =>
  resource.resourceType === 'ImagingStudy'
    ? resource.series.flatMap((series) =>
        series.instance.map((instance) => [
          instance.uid,
          instance.extension
            .filter((extension) => extension.url === GRIDFS_FILE_ID_EXTENSION_URL)
            .map((extension) => extension.valueString),
        ])
      )
    : []

describe('addGridfsFileIds', () => {
  it('names on each instance the source file that identifies itself as its uid', async () => {
    const sourceFiles = [
      await pickedSourceFile('doc-b', 'I2'),
      await pickedSourceFile('doc-a', 'I1'),
    ]
    const linked = await Effect.runPromise(
      addGridfsFileIds(studyOf([{ uid: 'I1' }, { uid: 'I2' }]), sourceFiles)
    )
    expect(gridfsFileIdsOf(linked)).toEqual([
      ['I1', ['doc-a']],
      ['I2', ['doc-b']],
    ])
  })

  it('replaces a gridfsFileId already there and keeps every other extension', async () => {
    const other = { url: 'https://example.test/other', valueString: 'kept' }
    const linked = await Effect.runPromise(
      addGridfsFileIds(
        studyOf([
          {
            uid: 'I1',
            extension: [other, { url: GRIDFS_FILE_ID_EXTENSION_URL, valueString: 'stale' }],
          },
        ]),
        [await pickedSourceFile('doc-a', 'I1')]
      )
    )
    expect(gridfsFileIdsOf(linked)).toEqual([['I1', ['doc-a']]])
    expect(
      linked.resourceType === 'ImagingStudy' &&
        linked.series[0]?.instance[0]?.extension.map((extension) => extension.url)
    ).toEqual([other.url, GRIDFS_FILE_ID_EXTENSION_URL])
  })

  it('names the smallest source file id when two files carry the same uid', async () => {
    const sourceFiles = [
      await pickedSourceFile('doc-b', 'I1'),
      await pickedSourceFile('doc-a', 'I1'),
    ]
    const linked = await Effect.runPromise(addGridfsFileIds(studyOf([{ uid: 'I1' }]), sourceFiles))
    expect(gridfsFileIdsOf(linked)).toEqual([['I1', ['doc-a']]])
  })

  it('dies on an instance no source file identifies itself as', async () => {
    const exit = await Effect.runPromiseExit(
      addGridfsFileIds(studyOf([{ uid: 'I9' }]), [await pickedSourceFile('doc-a', 'I1')])
    )
    expect(Exit.isFailure(exit) && Cause.isDie(exit.cause)).toBe(true)
  })

  it('keeps any other resource as it is', async () => {
    const patient = Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))({
      resourceType: 'Patient',
      id: 'p',
    })
    expect(await Effect.runPromise(addGridfsFileIds(patient, []))).toBe(patient)
  })
})
