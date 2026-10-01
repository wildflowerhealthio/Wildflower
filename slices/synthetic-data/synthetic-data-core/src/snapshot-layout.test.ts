import { Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { DocumentReference, type FhirResource, FhirResourceSchema } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import {
  HAR_FILE_NAME,
  hashOf,
  IMAGE_FILE_NAME,
  importRexallPerson,
  importShoppersFamily,
  rexallPersonCaseArbitrary,
  shoppersFamilyCaseArbitrary,
} from './imports.test-helpers.ts'
import * as Entry from './snapshot-entry.ts'
import * as Layout from './snapshot-layout.ts'

/**
 * The layout over real importer output: generated Rexall records and a
 * re-identified image through the HAR and DICOM importers, and generated
 * Shoppers family accounts through the HAR importer.
 */

const RUNS = numRunsFor({ base: 10 })

/** Each property imports every generated case: generous, so a slow runner fits. */
const IMPORT_TIMEOUT_MILLIS = 60_000

type ResourceJson = Schema.Schema.Encoded<typeof FhirResourceSchema>

const decodeResourceJson = Schema.decodeUnknownSync(Schema.encodedSchema(FhirResourceSchema))

const encodeFile = Schema.encodeSync(Entry.FileSchema)

const decodeFile = Schema.decodeUnknownSync(Entry.FileSchema)

const layOut = (resources: readonly FhirResource[]): readonly Entry.Any[] =>
  Either.getOrThrow(Layout.layOut(resources))

const layOutError = (resources: readonly FhirResource[]): unknown =>
  Either.match(Layout.layOut(resources), {
    onLeft: (error) => error,
    onRight: () => undefined,
  })

/** A laid-out resource: its entry, and the JSON its file holds. */
interface ResourceFile {
  readonly path: string
  readonly entry: Entry.Resource
  readonly json: ResourceJson
}

/** A laid-out attachment: its entry, and its path. */
interface AttachmentFile {
  readonly path: string
  readonly entry: Entry.Attachment
}

/** Entries as their files would be read: each resource's JSON, and each attachment. */
const filesOf = (
  entries: readonly Entry.Any[]
): {
  readonly resources: readonly ResourceFile[]
  readonly attachments: readonly AttachmentFile[]
} => ({
  resources: entries.flatMap((entry) => {
    if (entry._tag !== 'Resource') return []
    const file = encodeFile(entry)
    if (file._tag !== 'Text') throw new Error(`${file.path} is not text`)
    return [{ path: file.path, entry, json: decodeResourceJson(JSON.parse(file.text)) }]
  }),
  attachments: entries.flatMap((entry) =>
    entry._tag === 'Attachment' ? [{ path: Entry.pathOf(entry), entry }] : []
  ),
})

/** Every file the entries are written as, by path, comparable with `toEqual`. */
const writtenOf = (entries: readonly Entry.Any[]): readonly (readonly [string, unknown])[] =>
  entries.map((entry) => {
    const file = encodeFile(entry)
    return [file.path, file._tag === 'Text' ? file.text : Buffer.from(file.bytes)] as const
  })

const labelOf = (resource: FhirResource): string => `${resource.resourceType}/${resource.id}`

const isDocumentReference = (resource: FhirResource): resource is DocumentReference.Type =>
  resource.resourceType === 'DocumentReference'

/** An attachment as its JSON holds it, whatever the fields present. */
const attachmentOf = (json: ResourceJson): Record<string, unknown> => {
  if (json.resourceType !== 'DocumentReference') throw new Error('expected a DocumentReference')
  const [content] = json.content
  if (content === undefined) throw new Error('expected a content entry')
  return { ...content.attachment }
}

describe('Snapshot.Layout.layOut', () => {
  test(
    'property: one entry per resource at fhir/<Type>/<id>.json, and the HAR and image as attachments the source files link to',
    async () => {
      await fc.assert(
        fc.asyncProperty(rexallPersonCaseArbitrary, async (personCase) => {
          const { resources, har, image } = await importRexallPerson(personCase)
          const entries = layOut(resources)
          const files = filesOf(entries)

          // Entries are in path order.
          const paths = entries.map(Entry.pathOf)
          expect(paths).toEqual(paths.toSorted())

          // Every resource exactly once, at its path.
          const expectedPaths = [
            ...new Set(resources.map((resource) => `fhir/${labelOf(resource)}.json`)),
          ].toSorted()
          expect(files.resources.map((file) => file.path)).toEqual(expectedPaths)
          for (const { path, entry, json } of files.resources) {
            expect(Schema.is(Entry.ResourcePathSchema)(path)).toBe(true)
            expect(path).toBe(`fhir/${labelOf(entry.resource)}.json`)
            expect(json.resourceType).toBe(entry.resource.resourceType)
            expect(json.id).toBe(entry.resource.id)
          }

          // The files the importers read, under their formats' directories.
          expect(files.attachments.map((file) => file.path)).toEqual([
            `dicom/${IMAGE_FILE_NAME}`,
            `har/${HAR_FILE_NAME}`,
          ])
          expect(files.attachments.map((file) => Buffer.from(file.entry.bytes))).toEqual([
            Buffer.from(image),
            Buffer.from(har),
          ])
          for (const file of files.attachments) {
            expect(Schema.is(Entry.AttachmentPathSchema)(file.path)).toBe(true)
          }

          // Each source file links to its attachment instead of carrying it.
          const sourceFiles = resources.filter(isDocumentReference)
          expect(sourceFiles).toHaveLength(2)
          const hashByPath = new Map(
            await Promise.all(
              files.attachments.map(
                async ({ path, entry }) => [path, await hashOf(entry.bytes)] as const
              )
            )
          )
          for (const sourceFile of sourceFiles) {
            const file = files.resources.find(
              ({ path }) => path === `fhir/${labelOf(sourceFile)}.json`
            )
            if (file === undefined) throw new Error(`no file for ${labelOf(sourceFile)}`)
            const attachment = attachmentOf(file.json)
            expect(file.entry.attachmentPath).toBe(attachment['url'])
            const linked = files.attachments.find(({ path }) => path === attachment['url'])
            if (linked === undefined)
              throw new Error(`${String(attachment['url'])} is not laid out`)
            expect(attachment).not.toHaveProperty('data')
            expect(attachment['size']).toBe(linked.entry.bytes.length)
            expect(attachment['hash']).toBe(hashByPath.get(linked.path))
            const imported = sourceFile.content[0]?.attachment
            expect(attachment['title']).toBe(imported?.title)
            expect(attachment['contentType']).toBe(imported?.contentType)
            // Nothing but the attachment changes.
            const importedJson = Schema.encodeSync(FhirResourceSchema)(sourceFile)
            expect({ ...file.json, content: [] }).toEqual({ ...importedJson, content: [] })
          }

          // Every other resource's file is its JSON, as imported, and links nothing.
          for (const resource of resources.filter((one) => !isDocumentReference(one))) {
            const file = files.resources.find(
              ({ path }) => path === `fhir/${labelOf(resource)}.json`
            )
            expect(file?.json).toEqual(Schema.encodeSync(FhirResourceSchema)(resource))
            expect(file?.entry.attachmentPath).toBeUndefined()
          }

          // Every meta.source names a laid-out source file.
          const sources = files.resources.flatMap(({ json }) =>
            json.meta?.source === undefined ? [] : [json.meta.source]
          )
          expect(sources.length).toBeGreaterThan(0)
          for (const source of sources) {
            expect(files.resources.map(({ path }) => path)).toContain(`fhir/${source}.json`)
          }
        }),
        { numRuns: RUNS }
      )
    },
    IMPORT_TIMEOUT_MILLIS
  )

  test(
    'property: a reader decoding the files gets the import back, each source file carrying its attachment inline again',
    async () => {
      await fc.assert(
        fc.asyncProperty(rexallPersonCaseArbitrary, async (personCase) => {
          const { resources } = await importRexallPerson(personCase)
          // What a reader has: each file, its text parsed and printed again, decoded.
          const read = layOut(resources).map((entry) => {
            const file = encodeFile(entry)
            return decodeFile(
              file._tag === 'Text'
                ? { ...file, text: `${JSON.stringify(JSON.parse(file.text), null, 2)}\n` }
                : file
            )
          })
          const bytesByPath = new Map(
            read.flatMap((entry) =>
              entry._tag === 'Attachment' ? [[Entry.pathOf(entry), entry.bytes] as const] : []
            )
          )

          const importedByPath = new Map(
            resources.map((resource) => [`fhir/${labelOf(resource)}.json`, resource])
          )
          const readResources = read.flatMap((entry) => (entry._tag === 'Resource' ? [entry] : []))
          for (const entry of readResources) {
            const { attachmentPath } = entry
            const resource =
              attachmentPath === undefined
                ? entry.resource
                : Entry.withAttachmentData(
                    entry,
                    bytesByPath.get(attachmentPath) ?? new Uint8Array()
                  )
            if (attachmentPath !== undefined) expect(bytesByPath.has(attachmentPath)).toBe(true)
            const imported = importedByPath.get(Entry.pathOf(entry))
            if (imported === undefined) throw new Error(`${Entry.pathOf(entry)} was not imported`)
            expect(Schema.encodeSync(FhirResourceSchema)(resource)).toEqual(
              Schema.encodeSync(FhirResourceSchema)(imported)
            )
          }
          // Only the source files link to an attachment.
          expect(
            readResources.filter(({ attachmentPath }) => attachmentPath !== undefined)
          ).toHaveLength(bytesByPath.size)
        }),
        { numRuns: RUNS }
      )
    },
    IMPORT_TIMEOUT_MILLIS
  )

  test(
    'property: a resource imported twice keeps its last copy',
    async () => {
      await fc.assert(
        fc.asyncProperty(shoppersFamilyCaseArbitrary, async (familyCase) => {
          // The same family from two picked files: each copy names its own source file.
          const { resources: first } = await importShoppersFamily(familyCase, 'family.har')
          const { resources: again } = await importShoppersFamily(familyCase, 'again.har')
          const resources = [...first, ...again]
          const files = filesOf(layOut(resources))

          const lastByLabel = new Map(resources.map((resource) => [labelOf(resource), resource]))
          expect(files.resources.map((file) => file.path)).toEqual(
            [...lastByLabel.keys()].map((label) => `fhir/${label}.json`).toSorted()
          )
          for (const [label, resource] of lastByLabel) {
            if (isDocumentReference(resource)) continue
            const file = files.resources.find(({ path }) => path === `fhir/${label}.json`)
            expect(file?.json).toEqual(Schema.encodeSync(FhirResourceSchema)(resource))
          }
        }),
        { numRuns: RUNS }
      )
    },
    IMPORT_TIMEOUT_MILLIS
  )

  test(
    'property: laying out is deterministic and ignores the order of distinct resources',
    async () => {
      await fc.assert(
        fc.asyncProperty(rexallPersonCaseArbitrary, fc.nat(), async (personCase, rotation) => {
          const { resources } = await importRexallPerson(personCase)
          const { resources: again } = await importRexallPerson(personCase)
          const shift = rotation % resources.length
          const rotated = [...resources.slice(shift), ...resources.slice(0, shift)]
          expect(writtenOf(layOut(again))).toEqual(writtenOf(layOut(resources)))
          expect(writtenOf(layOut(rotated))).toEqual(writtenOf(layOut(resources)))
        }),
        { numRuns: RUNS }
      )
    },
    IMPORT_TIMEOUT_MILLIS
  )

  test(
    'fails for a resource whose meta.source is not laid out with it',
    async () => {
      const [personCase] = fc.sample(rexallPersonCaseArbitrary, { numRuns: 1, seed: 7 })
      if (personCase === undefined) throw new Error('expected a sample')
      const { resources } = await importRexallPerson(personCase)
      const withoutHar = resources.filter(
        (resource) =>
          !(
            isDocumentReference(resource) && resource.content[0]?.attachment.title === HAR_FILE_NAME
          )
      )
      expect(layOutError(withoutHar)).toMatchObject({ _tag: 'UnplaceableResource' })
    },
    IMPORT_TIMEOUT_MILLIS
  )

  test(
    'fails for two different source files at one path',
    async () => {
      const [first, second] = fc.sample(shoppersFamilyCaseArbitrary, { numRuns: 2, seed: 11 })
      if (first === undefined || second === undefined) throw new Error('expected two samples')
      const one = await importShoppersFamily(first, 'family.har')
      const other = await importShoppersFamily(second, 'family.har')
      expect(layOutError([...one.resources, ...other.resources])).toEqual(
        new Layout.ConflictingFiles({ path: 'har/family.har' })
      )
    },
    IMPORT_TIMEOUT_MILLIS
  )

  test.each(['../rexall.har', 'nested/rexall.har', '.har', 'rexall har', '-rexall.har'])(
    'fails for a source file titled %j, which is not a file name a snapshot can hold',
    async (title) => {
      const [personCase] = fc.sample(rexallPersonCaseArbitrary, { numRuns: 1, seed: 5 })
      if (personCase === undefined) throw new Error('expected a sample')
      const { resources } = await importRexallPerson(personCase)
      const retitled = resources.map((resource) =>
        isDocumentReference(resource)
          ? {
              ...resource,
              content: resource.content.map((content) => ({
                ...content,
                attachment: { ...content.attachment, title },
              })),
            }
          : resource
      )
      expect(layOutError(retitled)).toMatchObject({ _tag: 'UnplaceableResource' })
    },
    IMPORT_TIMEOUT_MILLIS
  )

  test('fails for a resource with no id', () => {
    const patient = Schema.decodeUnknownSync(FhirResourceSchema)({ resourceType: 'Patient' })
    expect(layOutError([patient])).toMatchObject({
      _tag: 'UnplaceableResource',
      resource: 'Patient/<no id>',
    })
  })

  test('leaves a DocumentReference that is not a source file as it is, data and all', () => {
    const report = Schema.decodeUnknownSync(DocumentReference.Schema)({
      resourceType: 'DocumentReference',
      id: 'report-1',
      status: 'current',
      type: { coding: [{ system: 'http://loinc.org', code: '11502-2' }] },
      content: [
        { attachment: { contentType: 'text/plain', data: 'aGVsbG8=', title: 'report.txt' } },
      ],
    })
    const entries = layOut([report])
    expect(entries).toEqual([{ _tag: 'Resource', resource: report }])
    expect(filesOf(entries).resources.map(({ path, json }) => ({ path, json }))).toEqual([
      {
        path: 'fhir/DocumentReference/report-1.json',
        json: Schema.encodeSync(FhirResourceSchema)(report),
      },
    ])
  })
})

describe('Snapshot.Layout.merge', () => {
  const patient = (id: string, gender: string): Entry.Any => {
    const resource = Schema.decodeUnknownSync(FhirResourceSchema)({
      resourceType: 'Patient',
      id,
      gender,
    })
    if (resource.id === null) throw new Error('expected an id')
    return { _tag: 'Resource', resource: { ...resource, id: resource.id } }
  }

  test('keeps an entry two lists share once, in path order', () => {
    const merged = Either.getOrThrow(
      Layout.merge([[patient('b', 'male'), patient('a', 'female')], [patient('a', 'female')]])
    )
    expect(merged.map(Entry.pathOf)).toEqual(['fhir/Patient/a.json', 'fhir/Patient/b.json'])
  })

  test('fails for two entries at one path written as different files', () => {
    expect(
      Either.getLeft(Layout.merge([[patient('a', 'female')], [patient('a', 'male')]]))
    ).toMatchObject({
      _tag: 'Some',
      value: { _tag: 'ConflictingFiles', path: 'fhir/Patient/a.json' },
    })
  })
})
