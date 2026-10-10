import { DateTime, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { type FhirResource, FhirResourceSchema } from 'fhir-r4/resources'
import { harImporter } from 'har-importer-core'
import { MetaSource } from 'importer-fundamentals'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import type * as SnapshotFile from './snapshot-file.ts'
import * as Snapshot from './snapshot.ts'
import {
  hashOf,
  importRexallPerson,
  importShoppersFamily,
  rexallPersonCaseArbitrary,
  type RexallPersonCase,
  shoppersFamilyCaseArbitrary,
  type ShoppersFamilyCase,
} from './test-helpers.ts'

/**
 * Whole snapshots assembled from generated records through the real
 * importers: a person's Rexall records and chest image, and a Shoppers family
 * account whose one HAR two members share.
 */

const RUNS = numRunsFor({ base: 8 })

/** Each property imports every generated case: generous, so a slow runner fits. */
const IMPORT_TIMEOUT_MILLIS = 90_000

const COMMIT = '0123456789abcdef0123456789abcdef01234567'

/** Any fixed instant: past rendering, the as-of date only reaches the header. */
const AS_OF = DateTime.unsafeMake('2026-09-28T00:00:00.000Z')

interface Case {
  readonly rexall: RexallPersonCase
  readonly family: ShoppersFamilyCase
}

const caseArbitrary: fc.Arbitrary<Case> = fc.record({
  rexall: rexallPersonCaseArbitrary,
  family: shoppersFamilyCaseArbitrary,
})

/** The case's three members: the Rexall patient, and two people on the family's account. */
const membersOf = async ({ rexall, family }: Case): Promise<readonly Snapshot.MemberRecords[]> => {
  const rexallPerson = await importRexallPerson(rexall)
  const { resources: familyResources } = await importShoppersFamily(family, 'family.har')
  return [
    {
      member: { key: 'rexall-person', displayName: 'Sam Okoye', summary: 'Rexall and an X-ray.' },
      resources: rexallPerson.resources,
    },
    {
      member: { key: 'account-holder', displayName: 'Riley Singh', summary: '' },
      resources: familyResources,
    },
    {
      member: { key: 'family-member', displayName: 'Avery Singh', summary: 'Shares the account.' },
      resources: familyResources,
    },
  ]
}

const assemble = (members: readonly Snapshot.MemberRecords[]): Snapshot.Snapshot =>
  Either.getOrThrow(Snapshot.assemble(AS_OF, COMMIT, members))

const filesOf = (snapshot: Snapshot.Snapshot): readonly SnapshotFile.Any[] =>
  Either.getOrThrow(Snapshot.filesOf(snapshot))

const textOf = (file: SnapshotFile.Any | undefined): string => {
  if (file?._tag !== 'Text') throw new Error(`${file?.path} is not text`)
  return file.text
}

/** A file's contents, comparable with `toEqual`. */
const contentsOf = (file: SnapshotFile.Any | undefined): unknown =>
  file?._tag === 'Bytes' ? Buffer.from(file.bytes) : file?.text

/**
 * A source file's JSON as a snapshot links it: every attachment a `url`, a
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

/**
 * The published wire format, pinned: what the live site and the data repo read.
 * A change here is a format change, not a refactor.
 */
const GOLDEN_SOURCE_FILE = `{
  "id": "source-1",
  "contained": [],
  "extension": [],
  "modifierExtension": [],
  "identifier": [],
  "status": "current",
  "category": [
    {
      "extension": [],
      "coding": [
        {
          "extension": [],
          "code": "har-archive",
          "system": "https://wildflowerhealth.io/fhir/CodeSystem/web-trace"
        }
      ]
    }
  ],
  "author": [],
  "relatesTo": [],
  "securityLabel": [],
  "content": [
    {
      "extension": [],
      "modifierExtension": [],
      "attachment": {
        "extension": [],
        "contentType": "application/json",
        "url": "har/pharmacy.har",
        "size": 2,
        "title": "pharmacy.har"
      }
    }
  ],
  "resourceType": "DocumentReference"
}
`

const GOLDEN_INDEX = `{
  "schemaVersion": 1,
  "asOf": "2026-09-28T00:00:00.000Z",
  "generator": {
    "name": "synthetic-data-core-js",
    "wildflowerCommit": "0123456789abcdef0123456789abcdef01234567"
  },
  "people": [
    {
      "key": "person-1",
      "displayName": "Sam Okoye",
      "summary": "A story.",
      "patientIds": [
        "p-1"
      ],
      "resources": [
        "fhir/DocumentReference/source-1.json",
        "fhir/Patient/p-1.json"
      ],
      "staticFiles": [
        "har/pharmacy.har"
      ]
    }
  ],
  "totals": {
    "people": 1,
    "resources": 2,
    "staticFiles": 1
  }
}
`

const labelOf = (resource: FhirResource): string => `${resource.resourceType}/${resource.id}`

describe('Snapshot.assemble', () => {
  test(
    'property: every resource once, every attachment its source file links to, and an index.json listing them',
    async () => {
      await fc.assert(
        fc.asyncProperty(caseArbitrary, async (generated) => {
          const members = await membersOf(generated)
          const snapshot = assemble(members)
          const files = filesOf(snapshot)
          const paths = files.map((file) => file.path)

          // The snapshot holds every entry once, in path order, and its files are its entries
          // and index.json.
          const entryPaths = snapshot.entries.map(Snapshot.Entry.pathOf)
          expect(entryPaths).toEqual(entryPaths.toSorted())
          expect(paths).toEqual([...entryPaths, Snapshot.Header.PATH].toSorted())

          // Paths are unique and in order.
          expect(new Set(paths).size).toBe(paths.length)
          expect(paths).toEqual(paths.toSorted())

          // Every resource any member has is written exactly once.
          const labels = new Set(members.flatMap(({ resources }) => resources.map(labelOf)))
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

          // Every attachment url resolves to a written attachment, with its size and hash.
          const hashByPath = new Map(
            await Promise.all(
              files.flatMap((file) =>
                file._tag === 'Text'
                  ? []
                  : [hashOf(file.bytes).then((hash) => [file.path, hash] as const)]
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
              const linkedFile = files.find((file) => file.path === attachment.url)
              if (linkedFile?._tag !== 'Bytes') {
                throw new Error(`${attachment.url} is not a written attachment`)
              }
              expect(attachment.size).toBe(linkedFile.bytes.length)
              expect(attachment.hash).toBe(hashByPath.get(linkedFile.path))
              linked.add(linkedFile.path)
            }
          }
          const attachmentPaths = paths.filter(
            (path) => path.startsWith('har/') || path.startsWith('dicom/')
          )
          expect(attachmentPaths).toEqual([...linked].toSorted())
          expect(attachmentPaths).toEqual([
            'dicom/chest-x-ray.dcm',
            'har/family.har',
            'har/rexall.har',
          ])

          // index.json decodes as the snapshot's header, and lists exactly what was written.
          const indexFile = files.find((file) => file.path === Snapshot.Header.PATH)
          expect(textOf(indexFile).endsWith('}\n')).toBe(true)
          const header = Schema.decodeUnknownSync(Snapshot.Header.FileSchema)(indexFile)
          expect(header).toEqual(snapshot.header)
          expect(header.asOf).toEqual(AS_OF)
          expect(header.people.map((listing) => listing.key)).toEqual(
            members.map(({ member }) => member.key)
          )
          expect(header.generator.wildflowerCommit).toBe(COMMIT)
          expect(
            [...new Set(header.people.flatMap((listing) => listing.resources))].toSorted()
          ).toEqual(resourcePaths)
          expect(
            [...new Set(header.people.flatMap((listing) => listing.staticFiles))].toSorted()
          ).toEqual(attachmentPaths)
          expect(header.totals).toEqual({
            people: 3,
            resources: resourcePaths.length,
            staticFiles: attachmentPaths.length,
          })

          // Each member lists their own Patients; the family's HAR is listed under both its members.
          const [rexallListing, holderListing, familyMemberListing] = header.people
          expect(rexallListing?.staticFiles).toEqual(['dicom/chest-x-ray.dcm', 'har/rexall.har'])
          expect(holderListing?.staticFiles).toEqual(['har/family.har'])
          expect(familyMemberListing?.staticFiles).toEqual(['har/family.har'])
          members.forEach(({ resources }, index) => {
            expect(header.people[index]?.patientIds).toEqual(
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
          const once = filesOf(assemble(await membersOf(generated)))
          const again = filesOf(assemble(await membersOf(generated)))
          expect(again.map((file) => file.path)).toEqual(once.map((file) => file.path))
          again.forEach((file, index) => {
            expect(contentsOf(file)).toEqual(contentsOf(once[index]))
          })
        }),
        { numRuns: RUNS }
      )
    },
    IMPORT_TIMEOUT_MILLIS
  )

  test(
    'fails when two members’ entries differ at one path',
    async () => {
      const [first, second] = fc.sample(shoppersFamilyCaseArbitrary, { numRuns: 2, seed: 13 })
      if (first === undefined || second === undefined) throw new Error('expected two samples')
      const one = await importShoppersFamily(first, 'family.har')
      const other = await importShoppersFamily(second, 'family.har')
      const result = Snapshot.assemble(AS_OF, COMMIT, [
        { member: { key: 'person-1', displayName: 'One', summary: '' }, resources: one.resources },
        {
          member: { key: 'person-2', displayName: 'Two', summary: '' },
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

  test('fails when two members share a key', () => {
    const member = { key: 'person-1', displayName: 'One', summary: '' }
    const result = Snapshot.assemble(AS_OF, COMMIT, [
      { member, resources: [] },
      { member, resources: [] },
    ])
    expect(Either.getLeft(result)).toMatchObject({ _tag: 'Some', value: { _tag: 'ParseError' } })
  })

  test('writes the published files byte for byte: key order, indentation and the linked url', () => {
    const { system, code } = harImporter.sourceFileFormat.coding
    const decodeResource = Schema.decodeUnknownSync(FhirResourceSchema)
    const sourceFile = decodeResource({
      resourceType: 'DocumentReference',
      id: 'source-1',
      status: 'current',
      category: [{ coding: [{ system, code }] }],
      content: [
        {
          attachment: {
            contentType: 'application/json',
            data: 'aGk=',
            size: 2,
            title: 'pharmacy.har',
          },
        },
      ],
    })
    const patient = decodeResource({
      resourceType: 'Patient',
      id: 'p-1',
      meta: { source: MetaSource.makeReference('source-1') },
    })
    const files = filesOf(
      assemble([
        {
          member: { key: 'person-1', displayName: 'Sam Okoye', summary: 'A story.' },
          resources: [patient, sourceFile],
        },
      ])
    )
    expect(files.map((file) => file.path)).toEqual([
      'fhir/DocumentReference/source-1.json',
      'fhir/Patient/p-1.json',
      'har/pharmacy.har',
      'index.json',
    ])
    expect(textOf(files[0])).toBe(GOLDEN_SOURCE_FILE)
    expect(contentsOf(files[2])).toEqual(Buffer.from('hi'))
    expect(textOf(files[3])).toBe(GOLDEN_INDEX)
  })

  test('writes only index.json for members with no records', () => {
    const snapshot = assemble([
      { member: { key: 'person-1', displayName: 'One', summary: '' }, resources: [] },
    ])
    expect(snapshot.entries).toEqual([])
    expect(filesOf(snapshot).map((file) => file.path)).toEqual(['index.json'])
  })
})
