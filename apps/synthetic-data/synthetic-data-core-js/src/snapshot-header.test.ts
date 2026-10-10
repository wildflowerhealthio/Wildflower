import { Array as Arr, DateTime, Either, Order, Schema } from 'effect'
import * as fc from 'fast-check'
import { type FhirResource, FhirResourceSchema } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { asOfArbitrary } from 'synthetic-data-fundamentals/test-helpers'
import * as Entry from './snapshot-entry.ts'
import * as Header from './snapshot-header.ts'

/**
 * The header over generated members and entries: what `make` lists, and that
 * the schema reads back, through its file, exactly what it wrote — and reads
 * nothing that is not a header.
 */

const RUNS = numRunsFor({ base: 100 })

/** The least JSON each resource type decodes from, given its id. */
const MINIMAL_RESOURCES: Readonly<
  Partial<Record<FhirResource['resourceType'], Record<string, unknown>>>
> = {
  Patient: {},
  Observation: { status: 'final', code: { text: 'A test' } },
  DocumentReference: { status: 'current', content: [{ attachment: { title: 'a.har' } }] },
}

const decodeResource = Schema.decodeUnknownSync(FhirResourceSchema)

/** A resource entry of `resourceType` with `id`, as little else as it decodes with. */
const resourceEntryOf = (
  resourceType: FhirResource['resourceType'],
  id: string
): Entry.Resource => {
  const resource = decodeResource({ resourceType, id, ...MINIMAL_RESOURCES[resourceType] })
  if (resource.id === null) throw new Error('expected an id')
  return { _tag: 'Resource', resource: { ...resource, id: resource.id } }
}

const resourceEntryArbitrary: fc.Arbitrary<Entry.Resource> = fc
  .record({
    resourceType: fc.constantFrom<FhirResource['resourceType']>(
      'Patient',
      'Observation',
      'DocumentReference'
    ),
    id: fc.stringMatching(/^[A-Za-z0-9\-.]{1,64}$/),
  })
  .map(({ resourceType, id }) => resourceEntryOf(resourceType, id))

const attachmentEntryArbitrary: fc.Arbitrary<Entry.Attachment> = fc.record({
  _tag: fc.constant('Attachment' as const),
  format: fc.constantFrom(...Entry.FORMATS),
  fileName: fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,20}$/),
  bytes: fc.constant(new Uint8Array()),
})

const memberArbitrary = (key: string): fc.Arbitrary<Header.Member> =>
  fc.record({
    key: fc.constant(key),
    displayName: fc.constantFrom('Sam Okoye', 'Riley Singh', 'Avery Dubois'),
    summary: fc.constantFrom(
      '',
      'Hypertension; a statin dose doubled.',
      'Iron, and a missed fill.'
    ),
  })

const memberEntriesArbitrary = (key: string): fc.Arbitrary<Header.MemberEntries> =>
  fc.record({
    member: memberArbitrary(key),
    entries: fc
      .tuple(
        fc.array(resourceEntryArbitrary, { maxLength: 12 }),
        fc.array(attachmentEntryArbitrary, { maxLength: 3 })
      )
      .map(([resources, attachments]): readonly Entry.Any[] => [...resources, ...attachments]),
  })

/** `members` with the first member's entries also listed under every other. */
const sharingFirst = (
  members: readonly Header.MemberEntries[]
): readonly Header.MemberEntries[] => {
  const [first] = members
  if (first === undefined) return members
  return members.map((memberEntries, index) =>
    index === 0
      ? memberEntries
      : { ...memberEntries, entries: [...memberEntries.entries, ...first.entries] }
  )
}

/** Up to four members, some sharing entries, under distinct keys. */
const membersArbitrary: fc.Arbitrary<readonly Header.MemberEntries[]> = fc
  .integer({ min: 0, max: 4 })
  .chain((count) =>
    fc.tuple(
      ...Array.from({ length: count }, (_, index) => memberEntriesArbitrary(`person-${index + 1}`))
    )
  )
  .chain((members) => fc.constantFrom(members, sharingFirst(members)))

const commitArbitrary = fc.stringMatching(/^[0-9a-f]{40}$/)

const encodeFile = Schema.encodeSync(Header.FileSchema)

const decodeFile = Schema.decodeUnknownEither(Header.FileSchema)

/** A header as the JSON of its file would hold it. */
const decodeJson = (json: unknown): Either.Either<Header.Header, unknown> =>
  decodeFile({ _tag: 'Text', path: Header.PATH, text: JSON.stringify(json) })

const sorted = (values: readonly string[]): readonly string[] =>
  Arr.sort(Arr.dedupe(values), Order.string)

const resourcesOf = (entries: readonly Entry.Any[]): readonly Entry.StoredResource[] =>
  entries.flatMap((entry) => (entry._tag === 'Resource' ? [entry.resource] : []))

const attachmentPathsOf = (entries: readonly Entry.Any[]): readonly string[] =>
  entries.flatMap((entry) => (entry._tag === 'Attachment' ? [Entry.pathOf(entry)] : []))

describe('Snapshot.Header.make', () => {
  test('property: lists each member in order with their Patient ids and paths, sorted, and the distinct totals', () => {
    fc.assert(
      fc.property(asOfArbitrary, commitArbitrary, membersArbitrary, (asOf, commit, members) => {
        const header = Header.make(asOf, commit, members)
        expect(header.schemaVersion).toBe(1)
        expect(header.asOf).toEqual(asOf)
        expect(header.generator).toEqual({
          name: 'synthetic-data-core-js',
          wildflowerCommit: commit,
        })
        expect(header.people.map((listing) => listing.key)).toEqual(
          members.map(({ member }) => member.key)
        )
        members.forEach(({ member, entries }, index) => {
          const resources = resourcesOf(entries)
          expect(header.people[index]).toEqual({
            ...member,
            patientIds: sorted(
              resources.flatMap((resource) =>
                resource.resourceType === 'Patient' ? [resource.id] : []
              )
            ),
            resources: sorted(
              resources.map((resource) => `fhir/${resource.resourceType}/${resource.id}.json`)
            ),
            staticFiles: sorted(attachmentPathsOf(entries)),
          })
        })
        expect(header.totals).toEqual({
          people: members.length,
          resources: new Set(
            members.flatMap(({ entries }) =>
              entries.filter((entry) => entry._tag === 'Resource').map(Entry.pathOf)
            )
          ).size,
          staticFiles: new Set(members.flatMap(({ entries }) => attachmentPathsOf(entries))).size,
        })
      }),
      { numRuns: RUNS }
    )
  })

  test('property: the order a member’s entries come in does not change the header', () => {
    fc.assert(
      fc.property(
        asOfArbitrary,
        commitArbitrary,
        memberEntriesArbitrary('person-1'),
        (asOf, commit, memberEntries) => {
          const reversed = { ...memberEntries, entries: memberEntries.entries.toReversed() }
          expect(Header.make(asOf, commit, [reversed])).toEqual(
            Header.make(asOf, commit, [memberEntries])
          )
        }
      ),
      { numRuns: RUNS }
    )
  })
})

describe('Snapshot.Header.FileSchema', () => {
  test('property: a header reads back from its file as itself', () => {
    fc.assert(
      fc.property(asOfArbitrary, commitArbitrary, membersArbitrary, (asOf, commit, members) => {
        const header = Header.make(asOf, commit, members)
        const file = encodeFile(header)
        expect(file.path).toBe('index.json')
        expect(file.text).toBe(`${JSON.stringify(JSON.parse(file.text), null, 2)}\n`)
        expect(decodeFile(file)).toEqual(Either.right(header))
      }),
      { numRuns: RUNS }
    )
  })

  const example = (): typeof Header.Schema.Encoded =>
    Schema.encodeSync(Header.Schema)(
      Header.make(DateTime.unsafeMake('2026-09-28T00:00:00Z'), 'abc123', [
        {
          member: { key: 'person-1', displayName: 'Sam Okoye', summary: 'A story.' },
          entries: [
            resourceEntryOf('Patient', 'p-1'),
            resourceEntryOf('DocumentReference', 'd-1'),
            {
              _tag: 'Attachment',
              format: 'har',
              fileName: 'pharmacy.har',
              bytes: new Uint8Array(),
            },
          ],
        },
      ])
    )

  test('reads the example it writes', () => {
    expect(example()).toEqual({
      schemaVersion: 1,
      asOf: '2026-09-28T00:00:00.000Z',
      generator: { name: 'synthetic-data-core-js', wildflowerCommit: 'abc123' },
      people: [
        {
          key: 'person-1',
          displayName: 'Sam Okoye',
          summary: 'A story.',
          patientIds: ['p-1'],
          resources: ['fhir/DocumentReference/d-1.json', 'fhir/Patient/p-1.json'],
          staticFiles: ['har/pharmacy.har'],
        },
      ],
      totals: { people: 1, resources: 2, staticFiles: 1 },
    })
    expect(Either.isRight(decodeJson(example()))).toBe(true)
  })

  test('does not read a header anywhere but index.json', () => {
    const file = encodeFile(Schema.decodeSync(Header.Schema)(example()))
    expect(Either.isLeft(decodeFile({ ...file, path: 'fhir/index.json' }))).toBe(true)
  })

  const withMember = (edit: Record<string, unknown>): Record<string, unknown> => {
    const header = example()
    return { ...header, people: header.people.map((listing) => ({ ...listing, ...edit })) }
  }

  test.each<[string, unknown]>([
    ['another schema version', { ...example(), schemaVersion: 2 }],
    ['another generator', { ...example(), generator: { name: 'other', wildflowerCommit: 'abc' } }],
    [
      'an empty commit',
      { ...example(), generator: { name: 'synthetic-data-core-js', wildflowerCommit: '' } },
    ],
    ['an as-of that is not an instant', { ...example(), asOf: 'yesterday' }],
    ['totals that miscount', { ...example(), totals: { people: 1, resources: 3, staticFiles: 1 } }],
    ['a resource path outside fhir/', withMember({ resources: ['fhir/../index.json'] })],
    ['an attachment outside a format directory', withMember({ staticFiles: ['pdf/report.pdf'] })],
    ['an attachment climbing out', withMember({ staticFiles: ['har/../../etc/passwd'] })],
    ['a Patient id outside FHIR’s grammar', withMember({ patientIds: ['a/b'] })],
    ['an empty display name', withMember({ displayName: '' })],
    ['a key with upper case', withMember({ key: 'Person-1' })],
  ])('rejects a header with %s', (_, header) => {
    expect(Either.isLeft(decodeJson(header))).toBe(true)
  })

  test('rejects two members under one key', () => {
    const header = example()
    const [listing] = header.people
    if (listing === undefined) throw new Error('expected a member')
    const twice = {
      ...header,
      people: [listing, listing],
      totals: { people: 2, resources: 2, staticFiles: 1 },
    }
    expect(Either.isLeft(decodeJson(twice))).toBe(true)
    expect(
      Either.isRight(decodeJson({ ...twice, people: [listing, { ...listing, key: 'person-2' }] }))
    ).toBe(true)
  })
})

describe('Snapshot.Header.pathsOf', () => {
  test('property: the chosen members’ entry paths, each once, in path order, and nobody else’s', () => {
    fc.assert(
      fc.property(
        asOfArbitrary,
        commitArbitrary,
        membersArbitrary.chain((members) =>
          fc.tuple(fc.constant(members), fc.subarray(members.map(({ member }) => member.key)))
        ),
        (asOf, commit, [members, chosenKeys]) => {
          const header = Header.make(asOf, commit, members)

          const paths = Header.pathsOf(header, new Set(chosenKeys))

          const chosen = members.filter(({ member }) => chosenKeys.includes(member.key))
          expect(paths).toEqual({
            resources: sorted(
              chosen.flatMap(({ entries }) =>
                resourcesOf(entries).map((resource) =>
                  Entry.resourcePathOf(resource.resourceType, resource.id)
                )
              )
            ),
            staticFiles: sorted(chosen.flatMap(({ entries }) => attachmentPathsOf(entries))),
          })
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('selects nothing for a key the header does not list', () => {
    const header = Header.make(DateTime.unsafeMake('2026-09-28T00:00:00.000Z'), 'abc123', [
      {
        member: { key: 'person-1', displayName: 'Sam Okoye', summary: '' },
        entries: [resourceEntryOf('Patient', 'p-1')],
      },
    ])
    expect(Header.pathsOf(header, new Set(['person-2']))).toEqual({
      resources: [],
      staticFiles: [],
    })
  })
})
