import { Array as Arr, DateTime, Either, Order, Schema } from 'effect'
import * as fc from 'fast-check'
import type { FhirResource } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { asOfArbitrary } from 'synthetic-data-fundamentals/test-helpers'
import * as DataSetLayout from './data-set-layout.ts'
import * as DataSetManifest from './data-set-manifest.ts'

/**
 * The manifest over generated people and paths: what `manifestOf` lists, and
 * that the schema reads back, through JSON text, exactly what it wrote — and
 * reads nothing that is not a manifest.
 */

const RUNS = numRunsFor({ base: 100 })

const RESOURCE_TYPES: readonly FhirResource['resourceType'][] = [
  'Patient',
  'Observation',
  'MedicationRequest',
  'MedicationDispense',
  'DocumentReference',
  'ImagingStudy',
]

const resourceFileArbitrary = fc
  .record({
    resourceType: fc.constantFrom(...RESOURCE_TYPES),
    id: fc.stringMatching(/^[A-Za-z0-9\-.]{1,64}$/),
  })
  .map(({ resourceType, id }) => ({
    path: DataSetLayout.resourcePathOf(resourceType, id),
    resourceType,
    id,
  }))

const staticFileArbitrary = fc
  .record({
    directory: fc.constantFrom(...DataSetLayout.STATIC_FILE_DIRECTORIES),
    fileName: fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,20}$/),
  })
  .map(({ directory, fileName }) => ({
    path: DataSetLayout.staticFilePathOf(directory, fileName),
  }))

const personArbitrary = (key: string): fc.Arbitrary<DataSetManifest.Person> =>
  fc.record({
    key: fc.constant(key),
    displayName: fc.constantFrom('Sam Okoye', 'Riley Singh', 'Avery Dubois'),
    summary: fc.constantFrom(
      '',
      'Hypertension; a statin dose doubled.',
      'Iron, and a missed fill.'
    ),
  })

const personFilesArbitrary = (key: string): fc.Arbitrary<DataSetManifest.PersonFiles> =>
  fc.record({
    person: personArbitrary(key),
    resources: fc.array(resourceFileArbitrary, { maxLength: 12 }),
    staticFiles: fc.array(staticFileArbitrary, { maxLength: 3 }),
  })

/** `people` with the first person's files also listed under every other. */
const sharingFirst = (
  people: readonly DataSetManifest.PersonFiles[]
): readonly DataSetManifest.PersonFiles[] => {
  const [first] = people
  if (first === undefined) return people
  return people.map((person, index) =>
    index === 0
      ? person
      : {
          ...person,
          resources: [...person.resources, ...first.resources],
          staticFiles: [...person.staticFiles, ...first.staticFiles],
        }
  )
}

/** Up to four people, some sharing files, under distinct keys. */
const peopleArbitrary: fc.Arbitrary<readonly DataSetManifest.PersonFiles[]> = fc
  .integer({ min: 0, max: 4 })
  .chain((count) =>
    fc.tuple(
      ...Array.from({ length: count }, (_, index) => personFilesArbitrary(`person-${index + 1}`))
    )
  )
  .chain((people) => fc.constantFrom(people, sharingFirst(people)))

const commitArbitrary = fc.stringMatching(/^[0-9a-f]{40}$/)

const encodeJson = (manifest: DataSetManifest.Type): string =>
  JSON.stringify(Schema.encodeSync(DataSetManifest.Schema)(manifest))

const decodeJson = Schema.decodeEither(Schema.parseJson(DataSetManifest.Schema))

const sorted = (values: readonly string[]): readonly string[] =>
  Arr.sort(Arr.dedupe(values), Order.string)

describe('DataSetManifest.manifestOf', () => {
  test('property: lists each person in order with their Patient ids and paths, sorted, and the distinct totals', () => {
    fc.assert(
      fc.property(asOfArbitrary, commitArbitrary, peopleArbitrary, (asOf, commit, people) => {
        const manifest = DataSetManifest.manifestOf(asOf, commit, people)
        expect(manifest.schemaVersion).toBe(1)
        expect(manifest.asOf).toEqual(asOf)
        expect(manifest.generator).toEqual({
          name: 'synthetic-data-core',
          wildflowerCommit: commit,
        })
        expect(manifest.people.map((entry) => entry.key)).toEqual(
          people.map(({ person }) => person.key)
        )
        people.forEach(({ person, resources, staticFiles }, index) => {
          expect(manifest.people[index]).toEqual({
            ...person,
            patientIds: sorted(
              resources.flatMap((file) => (file.resourceType === 'Patient' ? [file.id] : []))
            ),
            resources: sorted(resources.map((file) => file.path)),
            staticFiles: sorted(staticFiles.map((file) => file.path)),
          })
        })
        expect(manifest.totals).toEqual({
          people: people.length,
          resources: new Set(people.flatMap(({ resources }) => resources.map(({ path }) => path)))
            .size,
          staticFiles: new Set(
            people.flatMap(({ staticFiles }) => staticFiles.map(({ path }) => path))
          ).size,
        })
      }),
      { numRuns: RUNS }
    )
  })

  test('property: the order a person’s files come in does not change the manifest', () => {
    fc.assert(
      fc.property(
        asOfArbitrary,
        commitArbitrary,
        personFilesArbitrary('person-1'),
        (asOf, commit, personFiles) => {
          const reversed = {
            ...personFiles,
            resources: personFiles.resources.toReversed(),
            staticFiles: personFiles.staticFiles.toReversed(),
          }
          expect(DataSetManifest.manifestOf(asOf, commit, [reversed])).toEqual(
            DataSetManifest.manifestOf(asOf, commit, [personFiles])
          )
        }
      ),
      { numRuns: RUNS }
    )
  })
})

describe('DataSetManifest.Schema', () => {
  test('property: a manifest reads back from its JSON text as itself', () => {
    fc.assert(
      fc.property(asOfArbitrary, commitArbitrary, peopleArbitrary, (asOf, commit, people) => {
        const manifest = DataSetManifest.manifestOf(asOf, commit, people)
        expect(decodeJson(encodeJson(manifest))).toEqual(Either.right(manifest))
      }),
      { numRuns: RUNS }
    )
  })

  const example = (): typeof DataSetManifest.Schema.Encoded =>
    Schema.encodeSync(DataSetManifest.Schema)(
      DataSetManifest.manifestOf(DateTime.unsafeMake('2026-09-28T00:00:00Z'), 'abc123', [
        {
          person: { key: 'person-1', displayName: 'Sam Okoye', summary: 'A story.' },
          resources: [
            { path: 'fhir/Patient/p-1.json', resourceType: 'Patient', id: 'p-1' },
            {
              path: 'fhir/DocumentReference/d-1.json',
              resourceType: 'DocumentReference',
              id: 'd-1',
            },
          ],
          staticFiles: [{ path: 'har/pharmacy.har' }],
        },
      ])
    )

  test('reads the example it writes', () => {
    expect(example()).toEqual({
      schemaVersion: 1,
      asOf: '2026-09-28T00:00:00.000Z',
      generator: { name: 'synthetic-data-core', wildflowerCommit: 'abc123' },
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
    expect(Either.isRight(decodeJson(JSON.stringify(example())))).toBe(true)
  })

  const withPerson = (edit: Record<string, unknown>): Record<string, unknown> => {
    const manifest = example()
    return { ...manifest, people: manifest.people.map((person) => ({ ...person, ...edit })) }
  }

  test.each<[string, unknown]>([
    ['another schema version', { ...example(), schemaVersion: 2 }],
    ['another generator', { ...example(), generator: { name: 'other', wildflowerCommit: 'abc' } }],
    [
      'an empty commit',
      { ...example(), generator: { name: 'synthetic-data-core', wildflowerCommit: '' } },
    ],
    ['an as-of that is not an instant', { ...example(), asOf: 'yesterday' }],
    ['totals that miscount', { ...example(), totals: { people: 1, resources: 3, staticFiles: 1 } }],
    ['a resource path outside fhir/', withPerson({ resources: ['fhir/../index.json'] })],
    ['a static file outside a format directory', withPerson({ staticFiles: ['pdf/report.pdf'] })],
    ['a static file climbing out', withPerson({ staticFiles: ['har/../../etc/passwd'] })],
    ['a Patient id outside FHIR’s grammar', withPerson({ patientIds: ['a/b'] })],
    ['an empty display name', withPerson({ displayName: '' })],
    ['a key with upper case', withPerson({ key: 'Person-1' })],
  ])('rejects a manifest with %s', (_, manifest) => {
    expect(Either.isLeft(decodeJson(JSON.stringify(manifest)))).toBe(true)
  })

  test('rejects two people under one key', () => {
    const manifest = example()
    const [person] = manifest.people
    if (person === undefined) throw new Error('expected a person')
    const twice = {
      ...manifest,
      people: [person, person],
      totals: { people: 2, resources: 2, staticFiles: 1 },
    }
    expect(Either.isLeft(decodeJson(JSON.stringify(twice)))).toBe(true)
    expect(
      Either.isRight(
        decodeJson(JSON.stringify({ ...twice, people: [person, { ...person, key: 'person-2' }] }))
      )
    ).toBe(true)
  })
})

describe('DataSetManifest.filesOf', () => {
  test('property: the chosen people’s files, each once, in path order, and nobody else’s', () => {
    fc.assert(
      fc.property(
        asOfArbitrary,
        commitArbitrary,
        peopleArbitrary.chain((people) =>
          fc.tuple(fc.constant(people), fc.subarray(people.map(({ person }) => person.key)))
        ),
        (asOf, commit, [people, chosenKeys]) => {
          const manifest = DataSetManifest.manifestOf(asOf, commit, people)

          const files = DataSetManifest.filesOf(manifest, new Set(chosenKeys))

          const chosen = people.filter(({ person }) => chosenKeys.includes(person.key))
          expect(files).toEqual({
            resources: sorted(chosen.flatMap(({ resources }) => resources.map(({ path }) => path))),
            staticFiles: sorted(
              chosen.flatMap(({ staticFiles }) => staticFiles.map(({ path }) => path))
            ),
          })
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('selects nothing for a key the manifest does not list', () => {
    const manifest = DataSetManifest.manifestOf(
      DateTime.unsafeMake('2026-09-28T00:00:00.000Z'),
      'abc123',
      [
        {
          person: { key: 'person-1', displayName: 'Sam Okoye', summary: '' },
          resources: [{ path: 'fhir/Patient/p-1.json', resourceType: 'Patient', id: 'p-1' }],
          staticFiles: [],
        },
      ]
    )
    expect(DataSetManifest.filesOf(manifest, new Set(['person-2']))).toEqual({
      resources: [],
      staticFiles: [],
    })
  })
})
