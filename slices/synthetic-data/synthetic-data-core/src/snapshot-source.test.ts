import { DateTime, Effect, Either, Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { type FhirResource, FhirResourceSchema } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import type * as SnapshotFile from './snapshot-file.ts'
import * as Snapshot from './snapshot.ts'
import {
  importRexallPerson,
  importShoppersFamily,
  rexallPersonCaseArbitrary,
  type RexallPersonCase,
  shoppersFamilyCaseArbitrary,
  type ShoppersFamilyCase,
  sourceOf,
} from './test-helpers.ts'

/**
 * Reading a snapshot back through a `Source`: every file of a snapshot
 * assembled from real importer output reads back as the resource the import
 * wrote, and a file that is not what the snapshot wrote fails, naming itself.
 */

const RUNS = numRunsFor({ base: 8 })

/** Each property imports every generated case: generous, so a slow runner fits. */
const IMPORT_TIMEOUT_MILLIS = 90_000

const AS_OF = DateTime.unsafeMake('2026-09-28T00:00:00.000Z')

const COMMIT = '0123456789abcdef0123456789abcdef01234567'

interface Case {
  readonly rexall: RexallPersonCase
  readonly family: ShoppersFamilyCase
}

const caseArbitrary: fc.Arbitrary<Case> = fc.record({
  rexall: rexallPersonCaseArbitrary,
  family: shoppersFamilyCaseArbitrary,
})

/** The case's members: the Rexall patient, and two people on the family's account. */
const membersOf = async ({ rexall, family }: Case): Promise<readonly Snapshot.MemberRecords[]> => {
  const { resources: rexallResources } = await importRexallPerson(rexall)
  const { resources: familyResources } = await importShoppersFamily(family, 'family.har')
  return [
    {
      member: { key: 'rexall-person', displayName: 'Sam Okoye', summary: '' },
      resources: rexallResources,
    },
    {
      member: { key: 'account-holder', displayName: 'Riley Singh', summary: '' },
      resources: familyResources,
    },
    {
      member: { key: 'family-member', displayName: 'Avery Singh', summary: '' },
      resources: familyResources,
    },
  ]
}

/** The files of the members' snapshot. */
const filesOf = (members: readonly Snapshot.MemberRecords[]): readonly SnapshotFile.Any[] =>
  Either.getOrThrow(
    Either.flatMap(Snapshot.assemble(AS_OF, COMMIT, members), (snapshot) =>
      Snapshot.filesOf(snapshot)
    )
  )

const labelOf = (resource: FhirResource): string => `${resource.resourceType}/${resource.id}`

const encodeResource = Schema.encodeSync(FhirResourceSchema)

/** What reading `path` through `source` fails with, or `undefined` when it reads. */
const readFailureOf = async (
  source: Snapshot.Source.Source,
  path: string
): Promise<Snapshot.Source.UnreadableFile | undefined> =>
  Option.getOrUndefined(
    Either.getLeft(
      await Effect.runPromise(Effect.either(Snapshot.Source.readResource(source, path)))
    )
  )

const textOf = (file: SnapshotFile.Any | undefined): string => {
  if (file?._tag !== 'Text') throw new Error(`${file?.path} is not text`)
  return file.text
}

/** One person's Rexall records and image, as a snapshot's files, and the image's source file. */
const rexallSnapshot = async (): Promise<{
  readonly files: readonly SnapshotFile.Any[]
  readonly imageSourceFile: SnapshotFile.Text
  readonly image: SnapshotFile.Bytes
}> => {
  const [personCase] = fc.sample(rexallPersonCaseArbitrary, { numRuns: 1, seed: 29 })
  if (personCase === undefined) throw new Error('expected a sample')
  const { resources } = await importRexallPerson(personCase)
  const files = filesOf([
    { member: { key: 'person-1', displayName: 'One', summary: '' }, resources },
  ])
  const imageSourceFile = files.find(
    (file): file is SnapshotFile.Text =>
      file._tag === 'Text' &&
      file.path.startsWith('fhir/DocumentReference/') &&
      file.text.includes('"dicom/')
  )
  const image = files.find(
    (file): file is SnapshotFile.Bytes => file._tag === 'Bytes' && file.path.startsWith('dicom/')
  )
  if (imageSourceFile === undefined || image === undefined) {
    throw new Error('expected the image and its source file')
  }
  return { files, imageSourceFile, image }
}

/** `files` with the file at `file.path` replaced by `file`. */
const replacing = (
  files: readonly SnapshotFile.Any[],
  file: SnapshotFile.Any
): readonly SnapshotFile.Any[] => files.map((one) => (one.path === file.path ? file : one))

const JsonObjectSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown })

/** A source file's JSON: its one attachment, and whatever else it holds. */
const decodeSourceFileJson = Schema.decodeUnknownSync(
  Schema.parseJson(
    Schema.Struct(
      {
        content: Schema.Tuple(Schema.Struct({ attachment: JsonObjectSchema }, JsonObjectSchema)),
      },
      JsonObjectSchema
    )
  )
)

/** A source file's text with its one attachment's JSON edited. */
const withEditedAttachment = (
  text: string,
  edit: (attachment: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>
): string => {
  const json = decodeSourceFileJson(text)
  const [content] = json.content
  return `${JSON.stringify(
    { ...json, content: [{ ...content, attachment: edit(content.attachment) }] },
    null,
    2
  )}\n`
}

describe('Snapshot.Source.readHeader and Snapshot.Source.readResource', () => {
  test(
    'property: every resource of an assembled snapshot reads back as the resource the import wrote',
    async () => {
      await fc.assert(
        fc.asyncProperty(caseArbitrary, async (generated) => {
          const members = await membersOf(generated)
          const source = sourceOf(filesOf(members))

          const header = await Effect.runPromise(Snapshot.Source.readHeader(source))
          expect(header.people.map((member) => member.key)).toEqual(
            members.map(({ member }) => member.key)
          )
          const { resources: paths } = Snapshot.Header.pathsOf(
            header,
            new Set(header.people.map((member) => member.key))
          )

          // The last copy of each resource, as the layout keeps it.
          const importedByLabel = new Map(
            members.flatMap(({ resources }) => resources.map((one) => [labelOf(one), one] as const))
          )
          expect(paths).toEqual(
            [...importedByLabel.keys()].map((label) => `fhir/${label}.json`).toSorted()
          )
          const read = await Effect.runPromise(
            Effect.forEach(paths, (path) => Snapshot.Source.readResource(source, path))
          )
          for (const resource of read) {
            const imported = importedByLabel.get(labelOf(resource))
            if (imported === undefined) throw new Error(`${labelOf(resource)} was not imported`)
            expect(encodeResource(resource)).toEqual(encodeResource(imported))
          }
        }),
        { numRuns: RUNS }
      )
    },
    IMPORT_TIMEOUT_MILLIS
  )

  test(
    'fails a source file whose linked file is not the one its attachment describes',
    async () => {
      const { files, imageSourceFile, image } = await rexallSnapshot()

      // One byte changed: the size still matches, the hash does not.
      const flipped = new Uint8Array(image.bytes)
      flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0xff
      expect(
        await readFailureOf(
          sourceOf(replacing(files, { ...image, bytes: flipped })),
          imageSourceFile.path
        )
      ).toMatchObject({ _tag: 'UnreadableFile', path: image.path, reason: /SHA-256/ })

      // One byte short.
      expect(
        await readFailureOf(
          sourceOf(replacing(files, { ...image, bytes: image.bytes.subarray(1) })),
          imageSourceFile.path
        )
      ).toMatchObject({ _tag: 'UnreadableFile', path: image.path, reason: /bytes/ })

      // Missing.
      expect(
        await readFailureOf(
          sourceOf(files.filter((file) => file.path !== image.path)),
          imageSourceFile.path
        )
      ).toMatchObject({ _tag: 'UnreadableFile', path: image.path })
    },
    IMPORT_TIMEOUT_MILLIS
  )

  test(
    'fails a source file that does not link its file where the snapshot puts it',
    async () => {
      const { files, imageSourceFile, image } = await rexallSnapshot()
      const withAttachment = async (
        edit: (attachment: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>
      ): Promise<Snapshot.Source.UnreadableFile | undefined> =>
        readFailureOf(
          sourceOf(
            replacing(files, {
              ...imageSourceFile,
              text: withEditedAttachment(imageSourceFile.text, edit),
            })
          ),
          imageSourceFile.path
        )

      // No url: it would otherwise read as an ordinary document with no data.
      expect(await withAttachment(({ url: _url, ...attachment }) => attachment)).toMatchObject({
        _tag: 'UnreadableFile',
        path: imageSourceFile.path,
        reason: /links no file/,
      })

      // A url outside the snapshot.
      expect(
        await withAttachment((attachment) => ({
          ...attachment,
          url: 'https://example.com/chest-x-ray.dcm',
        }))
      ).toMatchObject({
        _tag: 'UnreadableFile',
        path: imageSourceFile.path,
        reason: /links no file/,
      })

      // Another file of the snapshot, under the other format.
      const elsewhere = image.path.replace(/^dicom\//, 'har/')
      expect(
        await withAttachment((attachment) => ({ ...attachment, url: elsewhere }))
      ).toMatchObject({
        _tag: 'UnreadableFile',
        path: imageSourceFile.path,
        reason: new RegExp(`links ${elsewhere}, not ${image.path}`),
      })

      // No title to name its file by.
      expect(await withAttachment(({ title: _title, ...attachment }) => attachment)).toMatchObject({
        _tag: 'UnreadableFile',
        path: imageSourceFile.path,
        reason: /no one attachment titled for a file/,
      })
    },
    IMPORT_TIMEOUT_MILLIS
  )

  test(
    'fails a resource file that holds a resource other than the one its path names',
    async () => {
      const { files } = await rexallSnapshot()
      const patient = files.find((file) => file.path.startsWith('fhir/Patient/'))
      const study = files.find((file) => file.path.startsWith('fhir/ImagingStudy/'))
      if (patient === undefined || study === undefined) {
        throw new Error('expected a Patient and an ImagingStudy file')
      }
      expect(
        await readFailureOf(
          sourceOf(replacing(files, { _tag: 'Text', path: patient.path, text: textOf(study) })),
          patient.path
        )
      ).toMatchObject({ _tag: 'UnreadableFile', path: patient.path, reason: /ImagingStudy\// })
    },
    IMPORT_TIMEOUT_MILLIS
  )

  test('reads a DocumentReference that is not a source file as it is, data and all', async () => {
    const path = 'fhir/DocumentReference/note-1.json'
    const json = {
      resourceType: 'DocumentReference',
      id: 'note-1',
      status: 'current',
      content: [{ attachment: { contentType: 'text/plain', data: 'aGk=' } }],
    }
    const source = sourceOf([{ _tag: 'Text', path, text: JSON.stringify(json) }])
    const resource = await Effect.runPromise(Snapshot.Source.readResource(source, path))
    expect(resource).toMatchObject({ content: [{ attachment: { data: 'aGk=' } }] })
  })

  test('fails a DocumentReference that is not a source file but links a file, fetching no file', async () => {
    const path = 'fhir/DocumentReference/note-1.json'
    const json = {
      resourceType: 'DocumentReference',
      id: 'note-1',
      status: 'current',
      content: [{ attachment: { contentType: 'text/plain', url: 'har/note.har', size: 2 } }],
    }
    const files = sourceOf([
      { _tag: 'Text', path, text: JSON.stringify(json) },
      { _tag: 'Bytes', path: 'har/note.har', bytes: new TextEncoder().encode('hi') },
    ])
    const fetchedBytes: string[] = []
    const source: Snapshot.Source.Source = {
      text: files.text,
      bytes: (bytesPath) => {
        fetchedBytes.push(bytesPath)
        return files.bytes(bytesPath)
      },
    }
    expect(await readFailureOf(source, path)).toMatchObject({
      _tag: 'UnreadableFile',
      path,
      reason: /not a har or dicom source file, and links har\/note\.har/,
    })
    expect(fetchedBytes).toEqual([])
  })

  test('fails a resource file that is not a FHIR resource, naming the file', async () => {
    const path = 'fhir/Patient/a.json'
    const source = sourceOf([{ _tag: 'Text', path, text: '{"resourceType":' }])
    expect(await readFailureOf(source, path)).toMatchObject({ _tag: 'UnreadableFile', path })
  })

  test('fetches nothing at a path outside the resource path grammar', async () => {
    const fetched: string[] = []
    const fetching = (path: string): Effect.Effect<never, Snapshot.Source.UnreadableFile> => {
      fetched.push(path)
      return Effect.fail(new Snapshot.Source.UnreadableFile({ path, reason: 'Not found.' }))
    }
    const source: Snapshot.Source.Source = { text: fetching, bytes: fetching }
    const paths = [
      '../secret.json',
      'fhir/Patient/../../index.json',
      'fhir/patient/a.json',
      'har/a.har',
      'index.json',
    ]
    const failures = await Promise.all(paths.map(async (path) => readFailureOf(source, path)))
    expect(failures).toMatchObject(paths.map((path) => ({ _tag: 'UnreadableFile', path })))
    expect(fetched).toEqual([])
  })

  test('fails an index.json that is not a header, naming the file', async () => {
    const exit = await Effect.runPromiseExit(
      Snapshot.Source.readHeader(
        sourceOf([{ _tag: 'Text', path: 'index.json', text: '{"schemaVersion":2}' }])
      )
    )
    expect(exit).toMatchObject({
      _tag: 'Failure',
      cause: { error: { _tag: 'UnreadableFile', path: 'index.json' } },
    })
  })

  test('fails a missing index.json, naming the file', async () => {
    const exit = await Effect.runPromiseExit(Snapshot.Source.readHeader(sourceOf([])))
    expect(exit).toMatchObject({
      _tag: 'Failure',
      cause: { error: { _tag: 'UnreadableFile', path: 'index.json' } },
    })
  })
})
