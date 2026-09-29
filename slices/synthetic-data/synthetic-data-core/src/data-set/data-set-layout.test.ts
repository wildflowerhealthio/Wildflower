import { Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { DocumentReference, type FhirResource, FhirResourceSchema } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as DataSetLayout from './data-set-layout.ts'
import {
  HAR_FILE_NAME,
  hashOf,
  IMAGE_FILE_NAME,
  importRexallPerson,
  importShoppersFamily,
  rexallPersonCaseArbitrary,
  shoppersFamilyCaseArbitrary,
} from './imports.test-helpers.ts'

/**
 * The layout over real importer output: generated Rexall records and a
 * re-identified image through the HAR and DICOM importers, and generated
 * Shoppers family accounts through the HAR importer.
 */

const RUNS = numRunsFor({ base: 10 })

/** Each property imports every generated case: generous, so a slow runner fits. */
const IMPORT_TIMEOUT_MILLIS = 60_000

const layOut = (resources: readonly FhirResource[]): DataSetLayout.Files =>
  Either.getOrThrow(DataSetLayout.layOut(resources))

const layOutError = (resources: readonly FhirResource[]): unknown =>
  Either.match(DataSetLayout.layOut(resources), {
    onLeft: (error) => error,
    onRight: () => undefined,
  })

const labelOf = (resource: FhirResource): string => `${resource.resourceType}/${resource.id}`

const isDocumentReference = (resource: FhirResource): resource is DocumentReference.Type =>
  resource.resourceType === 'DocumentReference'

/** An attachment as its JSON holds it, whatever the fields present. */
const attachmentOf = (json: DataSetLayout.ResourceJson): Record<string, unknown> => {
  if (json.resourceType !== 'DocumentReference') throw new Error('expected a DocumentReference')
  const [content] = json.content
  if (content === undefined) throw new Error('expected a content entry')
  return { ...content.attachment }
}

describe('DataSetLayout.layOut', () => {
  test(
    'property: one file per resource at fhir/<Type>/<id>.json, and the HAR and image as static files the source files link to',
    async () => {
      await fc.assert(
        fc.asyncProperty(rexallPersonCaseArbitrary, async (personCase) => {
          const { resources, har, image } = await importRexallPerson(personCase)
          const files = layOut(resources)

          // Every resource exactly once, at its path, in path order.
          const expectedPaths = [
            ...new Set(resources.map((resource) => `fhir/${labelOf(resource)}.json`)),
          ].toSorted()
          expect(files.resources.map((file) => file.path)).toEqual(expectedPaths)
          for (const file of files.resources) {
            expect(Schema.is(DataSetLayout.ResourcePathSchema)(file.path)).toBe(true)
            expect(file.path).toBe(`fhir/${file.resourceType}/${file.id}.json`)
            expect(file.json.resourceType).toBe(file.resourceType)
            expect(file.json.id).toBe(file.id)
          }

          // The files the importers read, under their formats' directories.
          expect(files.staticFiles.map((file) => file.path)).toEqual([
            `dicom/${IMAGE_FILE_NAME}`,
            `har/${HAR_FILE_NAME}`,
          ])
          expect(files.staticFiles.map((file) => Buffer.from(file.bytes))).toEqual([
            Buffer.from(image),
            Buffer.from(har),
          ])
          for (const file of files.staticFiles) {
            expect(Schema.is(DataSetLayout.StaticFilePathSchema)(file.path)).toBe(true)
          }

          // Each source file links to its static file instead of carrying it.
          const sourceFiles = resources.filter(isDocumentReference)
          expect(sourceFiles).toHaveLength(2)
          const hashByPath = new Map(
            await Promise.all(
              files.staticFiles.map(async ({ path, bytes }) => [path, await hashOf(bytes)] as const)
            )
          )
          for (const sourceFile of sourceFiles) {
            const file = files.resources.find(
              ({ path }) => path === `fhir/${labelOf(sourceFile)}.json`
            )
            if (file === undefined) throw new Error(`no file for ${labelOf(sourceFile)}`)
            const attachment = attachmentOf(file.json)
            const staticFile = files.staticFiles.find(({ path }) => path === attachment['url'])
            if (staticFile === undefined)
              throw new Error(`${String(attachment['url'])} is not laid out`)
            expect(attachment).not.toHaveProperty('data')
            expect(attachment['size']).toBe(staticFile.bytes.length)
            expect(attachment['hash']).toBe(hashByPath.get(staticFile.path))
            const imported = sourceFile.content[0]?.attachment
            expect(attachment['title']).toBe(imported?.title)
            expect(attachment['contentType']).toBe(imported?.contentType)
            // Nothing but the attachment changes.
            const importedJson = Schema.encodeSync(FhirResourceSchema)(sourceFile)
            expect({ ...file.json, content: [] }).toEqual({ ...importedJson, content: [] })
          }

          // Every other resource's file is its JSON, as imported.
          for (const resource of resources.filter((one) => !isDocumentReference(one))) {
            const file = files.resources.find(
              ({ path }) => path === `fhir/${labelOf(resource)}.json`
            )
            expect(file?.json).toEqual(Schema.encodeSync(FhirResourceSchema)(resource))
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
    'property: a Shoppers import keeps the last copy of a resource it holds twice',
    async () => {
      await fc.assert(
        fc.asyncProperty(shoppersFamilyCaseArbitrary, async (familyCase) => {
          const { resources } = await importShoppersFamily(familyCase, 'family.har')
          const files = layOut(resources)

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
          expect(layOut(again)).toEqual(layOut(resources))
          expect(layOut(rotated)).toEqual(layOut(resources))
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
        new DataSetLayout.ConflictingFiles({ path: 'har/family.har' })
      )
    },
    IMPORT_TIMEOUT_MILLIS
  )

  test.each(['../rexall.har', 'nested/rexall.har', '.har', 'rexall har', '-rexall.har'])(
    'fails for a source file titled %j, which is not a file name a data set can hold',
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
    expect(layOut([report])).toEqual({
      resources: [
        {
          path: 'fhir/DocumentReference/report-1.json',
          resourceType: 'DocumentReference',
          id: 'report-1',
          json: Schema.encodeSync(FhirResourceSchema)(report),
        },
      ],
      staticFiles: [],
    })
  })
})

describe('DataSetLayout path schemas', () => {
  test.each([
    'fhir/Patient/abc.json',
    'fhir/DocumentReference/wf-0123.json',
    'fhir/Observation/a.b-c.json',
  ])('accepts the resource path %j', (path) => {
    expect(Schema.is(DataSetLayout.ResourcePathSchema)(path)).toBe(true)
  })

  test.each([
    'fhir/Patient/../index.json',
    'fhir/Patient/a/b.json',
    'fhir/patient/abc.json',
    '/fhir/Patient/abc.json',
    'fhir/Patient/abc.json/',
    `fhir/Patient/${'a'.repeat(65)}.json`,
  ])('rejects the resource path %j', (path) => {
    expect(Schema.is(DataSetLayout.ResourcePathSchema)(path)).toBe(false)
  })

  test.each(['har/family.har', 'dicom/chest-x-ray.dcm', 'dicom/IMG_0001.dcm'])(
    'accepts the static file path %j',
    (path) => {
      expect(Schema.is(DataSetLayout.StaticFilePathSchema)(path)).toBe(true)
    }
  )

  test.each(['har/../index.json', 'har/.hidden', 'pdf/report.pdf', 'har/a/b.har', 'har/', 'har'])(
    'rejects the static file path %j',
    (path) => {
      expect(Schema.is(DataSetLayout.StaticFilePathSchema)(path)).toBe(false)
    }
  )

  test('names the static file directories after the importers’ formats', () => {
    expect(DataSetLayout.STATIC_FILE_DIRECTORIES).toEqual(['har', 'dicom'])
  })
})
