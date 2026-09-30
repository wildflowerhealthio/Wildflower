import { DateTime, Effect, Either, Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { type FhirResource, FhirResourceSchema } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import * as DataSetManifest from './data-set-manifest.ts'
import * as DataSet from './data-set.ts'
import {
  fileSourceOf,
  hashOf,
  importRexallPerson,
  importShoppersFamily,
  rexallPersonCaseArbitrary,
  type RexallPersonCase,
  shoppersFamilyCaseArbitrary,
  type ShoppersFamilyCase,
} from './test-helpers.ts'

/**
 * Whole data sets assembled from generated records through the real
 * importers: a person's Rexall records and chest image, and a Shoppers family
 * account whose one HAR two people share.
 */

const RUNS = numRunsFor({ base: 8 })

/** Each property imports every generated case: generous, so a slow runner fits. */
const IMPORT_TIMEOUT_MILLIS = 90_000

const COMMIT = '0123456789abcdef0123456789abcdef01234567'

/** Any fixed instant: past rendering, the as-of date only reaches the manifest. */
const AS_OF = DateTime.unsafeMake('2026-09-28T00:00:00.000Z')

interface Case {
  readonly rexall: RexallPersonCase
  readonly family: ShoppersFamilyCase
}

const caseArbitrary: fc.Arbitrary<Case> = fc.record({
  rexall: rexallPersonCaseArbitrary,
  family: shoppersFamilyCaseArbitrary,
})

/** The case's three people: the Rexall patient, and two people on the family's account. */
const peopleOf = async ({ rexall, family }: Case): Promise<readonly DataSet.PersonRecords[]> => {
  const rexallPerson = await importRexallPerson(rexall)
  const { resources: familyResources } = await importShoppersFamily(family, 'family.har')
  return [
    {
      person: { key: 'rexall-person', displayName: 'Sam Okoye', summary: 'Rexall and an X-ray.' },
      resources: rexallPerson.resources,
    },
    {
      person: { key: 'account-holder', displayName: 'Riley Singh', summary: '' },
      resources: familyResources,
    },
    {
      person: { key: 'family-member', displayName: 'Avery Singh', summary: 'Shares the account.' },
      resources: familyResources,
    },
  ]
}

const assemble = (people: readonly DataSet.PersonRecords[]): readonly DataSet.File[] =>
  Either.getOrThrow(DataSet.assemble(AS_OF, COMMIT, people))

const textOf = (file: DataSet.File | undefined): string => {
  if (typeof file?.contents !== 'string') throw new Error(`${file?.path} is not text`)
  return file.contents
}

/**
 * A source file's JSON as a data set links it: every attachment a `url`, a
 * `size` and a `hash`, and no `data`.
 */
const decodeLinkedSourceFile = Schema.decodeSync(
  Schema.parseJson(
    Schema.Struct({
      content: Schema.Array(
        Schema.Struct({
          attachment: Schema.Struct({
            url: Schema.String,
            size: Schema.Number,
            hash: Schema.String,
            data: Schema.optional(Schema.Never),
          }),
        })
      ),
    })
  )
)

const labelOf = (resource: FhirResource): string => `${resource.resourceType}/${resource.id}`

describe('DataSet.assemble', () => {
  test(
    'property: every resource once, every static file its source file links to, and an index.json listing them',
    async () => {
      await fc.assert(
        fc.asyncProperty(caseArbitrary, async (generated) => {
          const people = await peopleOf(generated)
          const files = assemble(people)
          const paths = files.map((file) => file.path)

          // Paths are unique and in order.
          expect(new Set(paths).size).toBe(paths.length)
          expect(paths).toEqual(paths.toSorted())

          // Every resource any person has is written exactly once.
          const labels = new Set(people.flatMap(({ resources }) => resources.map(labelOf)))
          const resourcePaths = paths.filter((path) => path.startsWith('fhir/'))
          expect(resourcePaths).toEqual([...labels].map((label) => `fhir/${label}.json`).toSorted())

          // Resource files are pretty-printed JSON with a trailing newline, and decode as FHIR
          // once a source file's relative url is resolved.
          for (const path of resourcePaths) {
            const text = textOf(files.find((file) => file.path === path))
            const json: unknown = JSON.parse(text)
            expect(text).toBe(`${JSON.stringify(json, null, 2)}\n`)
            const resolved: unknown = JSON.parse(
              text.replace(/"url": "((?:har|dicom)\/[^"]+)"/g, '"url": "https://data.example/$1"')
            )
            expect(Either.isRight(Schema.decodeUnknownEither(FhirResourceSchema)(resolved))).toBe(
              true
            )
          }

          // Every attachment url resolves to a written static file, with its size and hash.
          const hashByPath = new Map(
            await Promise.all(
              files.flatMap(({ path, contents }) =>
                typeof contents === 'string'
                  ? []
                  : [hashOf(contents).then((hash) => [path, hash] as const)]
              )
            )
          )
          const linked = new Set<string>()
          for (const path of resourcePaths.filter((one) =>
            one.startsWith('fhir/DocumentReference/')
          )) {
            const { content } = decodeLinkedSourceFile(
              textOf(files.find((file) => file.path === path))
            )
            for (const { attachment } of content) {
              const staticFile = files.find((file) => file.path === attachment.url)
              if (!(staticFile?.contents instanceof Uint8Array)) {
                throw new Error(`${attachment.url} is not a written static file`)
              }
              expect(attachment.size).toBe(staticFile.contents.length)
              expect(attachment.hash).toBe(hashByPath.get(staticFile.path))
              linked.add(staticFile.path)
            }
          }
          const staticPaths = paths.filter(
            (path) => path.startsWith('har/') || path.startsWith('dicom/')
          )
          expect(staticPaths).toEqual([...linked].toSorted())
          expect(staticPaths).toEqual(['dicom/chest-x-ray.dcm', 'har/family.har', 'har/rexall.har'])

          // index.json decodes, and lists exactly what was written.
          expect(paths).toContain(DataSet.MANIFEST_PATH)
          const indexText = textOf(files.find((file) => file.path === DataSet.MANIFEST_PATH))
          expect(indexText.endsWith('}\n')).toBe(true)
          const manifest = Schema.decodeUnknownSync(DataSetManifest.Schema)(JSON.parse(indexText))
          expect(manifest.asOf).toEqual(AS_OF)
          expect(manifest.people.map((person) => person.key)).toEqual(
            people.map(({ person }) => person.key)
          )
          expect(manifest.generator.wildflowerCommit).toBe(COMMIT)
          expect(
            [...new Set(manifest.people.flatMap((person) => person.resources))].toSorted()
          ).toEqual(resourcePaths)
          expect(
            [...new Set(manifest.people.flatMap((person) => person.staticFiles))].toSorted()
          ).toEqual(staticPaths)
          expect(manifest.totals).toEqual({
            people: 3,
            resources: resourcePaths.length,
            staticFiles: staticPaths.length,
          })

          // Each person lists their own Patients; the family's HAR is listed under both its people.
          const [rexallEntry, holderEntry, memberEntry] = manifest.people
          expect(rexallEntry?.staticFiles).toEqual(['dicom/chest-x-ray.dcm', 'har/rexall.har'])
          expect(holderEntry?.staticFiles).toEqual(['har/family.har'])
          expect(memberEntry?.staticFiles).toEqual(['har/family.har'])
          people.forEach(({ resources }, index) => {
            expect(manifest.people[index]?.patientIds).toEqual(
              [
                ...new Set(
                  resources.flatMap((resource) =>
                    resource.resourceType === 'Patient' && resource.id !== null ? [resource.id] : []
                  )
                ),
              ].toSorted()
            )
          })
        }),
        { numRuns: RUNS }
      )
    },
    IMPORT_TIMEOUT_MILLIS
  )

  test(
    'property: the same records assemble to the same files, byte for byte',
    async () => {
      await fc.assert(
        fc.asyncProperty(caseArbitrary, async (generated) => {
          const once = assemble(await peopleOf(generated))
          const again = assemble(await peopleOf(generated))
          expect(again.map((file) => file.path)).toEqual(once.map((file) => file.path))
          again.forEach((file, index) => {
            const contents = once[index]?.contents
            expect(
              typeof file.contents === 'string' ? file.contents : Buffer.from(file.contents)
            ).toEqual(typeof contents === 'string' ? contents : Buffer.from(contents ?? []))
          })
        }),
        { numRuns: RUNS }
      )
    },
    IMPORT_TIMEOUT_MILLIS
  )

  test(
    'fails when two people’s files differ at one path',
    async () => {
      const [first, second] = fc.sample(shoppersFamilyCaseArbitrary, { numRuns: 2, seed: 13 })
      if (first === undefined || second === undefined) throw new Error('expected two samples')
      const one = await importShoppersFamily(first, 'family.har')
      const other = await importShoppersFamily(second, 'family.har')
      const result = DataSet.assemble(AS_OF, COMMIT, [
        { person: { key: 'person-1', displayName: 'One', summary: '' }, resources: one.resources },
        {
          person: { key: 'person-2', displayName: 'Two', summary: '' },
          resources: other.resources,
        },
      ])
      expect(Either.getLeft(result)).toMatchObject({
        _tag: 'Some',
        value: { _tag: 'ConflictingFiles', path: 'har/family.har' },
      })
    },
    IMPORT_TIMEOUT_MILLIS
  )

  test('fails when two people share a key', () => {
    const person = { key: 'person-1', displayName: 'One', summary: '' }
    const result = DataSet.assemble(AS_OF, COMMIT, [
      { person, resources: [] },
      { person, resources: [] },
    ])
    expect(Either.getLeft(result)).toMatchObject({ _tag: 'Some', value: { _tag: 'ParseError' } })
  })

  test('writes only index.json for people with no records', () => {
    const files = assemble([
      { person: { key: 'person-1', displayName: 'One', summary: '' }, resources: [] },
    ])
    expect(files.map((file) => file.path)).toEqual(['index.json'])
  })
})

/** What reading `path` through `source` fails with, or `undefined` when it reads. */
const readFailureOf = async (
  source: DataSet.FileSource,
  path: string
): Promise<DataSet.UnreadableFile | undefined> =>
  Option.getOrUndefined(
    Either.getLeft(await Effect.runPromise(Effect.either(DataSet.readResource(source, path))))
  )

describe('DataSet.readManifest and DataSet.readResource', () => {
  test(
    'property: every file of an assembled data set reads back as the resource the import wrote',
    async () => {
      await fc.assert(
        fc.asyncProperty(caseArbitrary, async (generated) => {
          const people = await peopleOf(generated)
          const source = fileSourceOf(assemble(people))

          const manifest = await Effect.runPromise(DataSet.readManifest(source))
          expect(manifest.people.map((person) => person.key)).toEqual(
            people.map(({ person }) => person.key)
          )
          const { resources: paths } = DataSetManifest.filesOf(
            manifest,
            new Set(manifest.people.map((person) => person.key))
          )

          // The last copy of each resource, as the layout keeps it.
          const importedByLabel = new Map(
            people.flatMap(({ resources }) => resources.map((one) => [labelOf(one), one] as const))
          )
          expect(paths).toEqual(
            [...importedByLabel.keys()].map((label) => `fhir/${label}.json`).toSorted()
          )
          const read = await Effect.runPromise(
            Effect.forEach(paths, (path) => DataSet.readResource(source, path))
          )
          for (const resource of read) {
            const imported = importedByLabel.get(labelOf(resource))
            if (imported === undefined) throw new Error(`${labelOf(resource)} was not imported`)
            expect(Schema.encodeSync(FhirResourceSchema)(resource)).toEqual(
              Schema.encodeSync(FhirResourceSchema)(imported)
            )
          }
        }),
        { numRuns: RUNS }
      )
    },
    IMPORT_TIMEOUT_MILLIS
  )

  /** One person's Rexall records and image, assembled, and the source file linking the image. */
  const rexallDataSet = async (): Promise<{
    readonly files: readonly DataSet.File[]
    readonly imageSourcePath: string
  }> => {
    const [personCase] = fc.sample(rexallPersonCaseArbitrary, { numRuns: 1, seed: 29 })
    if (personCase === undefined) throw new Error('expected a sample')
    const { resources } = await importRexallPerson(personCase)
    const files = assemble([
      { person: { key: 'person-1', displayName: 'One', summary: '' }, resources },
    ])
    const imageSource = files.find(
      (file) =>
        file.path.startsWith('fhir/DocumentReference/') &&
        typeof file.contents === 'string' &&
        file.contents.includes('"dicom/')
    )
    if (imageSource === undefined) throw new Error('expected the image source file')
    return { files, imageSourcePath: imageSource.path }
  }

  /** `files` with the file at `path` holding `contents` instead. */
  const replacing = (
    files: readonly DataSet.File[],
    path: string,
    contents: string | Uint8Array
  ): readonly DataSet.File[] =>
    files.map((file) => (file.path === path ? { path, contents } : file))

  test(
    'fails a source file whose static file is not the one its attachment describes',
    async () => {
      const { files, imageSourcePath } = await rexallDataSet()
      const image = files.find((file) => file.path.startsWith('dicom/'))
      if (!(image?.contents instanceof Uint8Array)) throw new Error('expected the image')

      // One byte changed: the size still matches, the hash does not.
      const flipped = new Uint8Array(image.contents)
      flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0xff
      expect(
        await readFailureOf(fileSourceOf(replacing(files, image.path, flipped)), imageSourcePath)
      ).toMatchObject({ _tag: 'UnreadableFile', path: image.path, reason: /SHA-256/ })

      // One byte short.
      expect(
        await readFailureOf(
          fileSourceOf(replacing(files, image.path, image.contents.subarray(1))),
          imageSourcePath
        )
      ).toMatchObject({ _tag: 'UnreadableFile', path: image.path, reason: /bytes/ })

      // Missing.
      expect(
        await readFailureOf(
          fileSourceOf(files.filter((file) => file.path !== image.path)),
          imageSourcePath
        )
      ).toMatchObject({ _tag: 'UnreadableFile', path: image.path })
    },
    IMPORT_TIMEOUT_MILLIS
  )

  test(
    'fails a resource file that holds a resource other than the one its path names',
    async () => {
      const { files } = await rexallDataSet()
      const patient = files.find((file) => file.path.startsWith('fhir/Patient/'))
      const study = files.find((file) => file.path.startsWith('fhir/ImagingStudy/'))
      if (patient === undefined || study === undefined) {
        throw new Error('expected a Patient and an ImagingStudy file')
      }
      expect(
        await readFailureOf(
          fileSourceOf(replacing(files, patient.path, study.contents)),
          patient.path
        )
      ).toMatchObject({ _tag: 'UnreadableFile', path: patient.path, reason: /ImagingStudy\// })
    },
    IMPORT_TIMEOUT_MILLIS
  )

  test('fails a resource file that is not a FHIR resource, naming the file', async () => {
    const source = fileSourceOf([{ path: 'fhir/Patient/a.json', contents: '{"resourceType":' }])
    expect(await readFailureOf(source, 'fhir/Patient/a.json')).toMatchObject({
      _tag: 'UnreadableFile',
      path: 'fhir/Patient/a.json',
    })
  })

  test('fails an index.json that is not a manifest, naming the file', async () => {
    const exit = await Effect.runPromiseExit(
      DataSet.readManifest(fileSourceOf([{ path: 'index.json', contents: '{"schemaVersion":2}' }]))
    )
    expect(exit).toMatchObject({
      _tag: 'Failure',
      cause: { error: { _tag: 'UnreadableFile', path: 'index.json' } },
    })
  })
})
