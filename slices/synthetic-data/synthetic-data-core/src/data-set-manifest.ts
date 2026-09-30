import { Array as Arr, type DateTime, Order, Schema } from 'effect'

import * as DataSetLayout from './data-set-layout.ts'

/**
 * `index.json`, the manifest at a data set's root: who is in it and which
 * files are theirs — the one listing a reader has, because a static host
 * cannot list a directory.
 *
 * @remarks
 * {@link Schema} is the manifest's single definition. The emit step encodes
 * it; a reader (the synthetic data app) decodes what it fetched with it, and
 * gets paths already checked against the layout's grammar
 * (`DataSetLayout.ResourcePathSchema`, `StaticFilePathSchema`), so it never
 * fetches outside the data set.
 */

/** The manifest format's version; a change to {@link Schema}'s shape is a new one. */
const SCHEMA_VERSION = 1

/** What made the data set. */
const GENERATOR_NAME = 'synthetic-data-core'

/** A person as the data set introduces them. */
const PersonSchema = Schema.Struct({
  /** A stable lower-case handle, unique in the data set (`'person-1'`). */
  key: Schema.String.pipe(Schema.pattern(/^[a-z0-9][a-z0-9-]*$/)),
  /** The person's name, as a reader lists them. */
  displayName: Schema.NonEmptyString,
  /** A sentence or two on what their records show. */
  summary: Schema.String,
}).annotations({ identifier: 'DataSetPerson' })

/** A person and the files that are theirs. */
const PersonEntrySchema = Schema.Struct({
  ...PersonSchema.fields,
  /**
   * The ids of the person's Patient records, sorted. Usually one; a
   * Shoppers account holder also has the account's `pcid` Patient.
   */
  patientIds: Schema.Array(DataSetLayout.ResourceIdSchema),
  /** The person's resource files, in path order. */
  resources: Schema.Array(DataSetLayout.ResourcePathSchema),
  /** The files the person's records were imported from, in path order. */
  staticFiles: Schema.Array(DataSetLayout.StaticFilePathSchema),
}).annotations({ identifier: 'DataSetPersonEntry' })

/** How many people and distinct files the data set holds; a file two people share counts once. */
const TotalsSchema = Schema.Struct({
  people: Schema.NonNegativeInt,
  resources: Schema.NonNegativeInt,
  staticFiles: Schema.NonNegativeInt,
}).annotations({ identifier: 'DataSetTotals' })

const ManifestStruct = Schema.Struct({
  schemaVersion: Schema.Literal(SCHEMA_VERSION),
  /** The as-of instant every story day in the data set is dated from. */
  asOf: Schema.DateTimeUtc,
  generator: Schema.Struct({
    name: Schema.Literal(GENERATOR_NAME),
    /** The Wildflower commit the data set was generated at, as its generator states it. */
    wildflowerCommit: Schema.NonEmptyString,
  }),
  /** In the order the data set lists them. */
  people: Schema.Array(PersonEntrySchema),
  totals: TotalsSchema,
})

/** The totals a manifest's people add up to. */
const totalsOf = (
  people: typeof ManifestStruct.Type.people
): typeof ManifestStruct.Type.totals => ({
  people: people.length,
  resources: new Set(people.flatMap((person) => person.resources)).size,
  staticFiles: new Set(people.flatMap((person) => person.staticFiles)).size,
})

/** Why a manifest's people and totals disagree, or `undefined` when they agree. */
const inconsistencyOf = (manifest: typeof ManifestStruct.Type): string | undefined => {
  const keys = manifest.people.map((person) => person.key)
  const repeatedKey = keys.find((key, index) => keys.indexOf(key) !== index)
  if (repeatedKey !== undefined) return `The person key ${repeatedKey} is listed twice.`
  const totals = totalsOf(manifest.people)
  const { people, resources, staticFiles } = manifest.totals
  return totals.people === people &&
    totals.resources === resources &&
    totals.staticFiles === staticFiles
    ? undefined
    : `The totals ${JSON.stringify(manifest.totals)} are not the people's ${JSON.stringify(totals)}.`
}

/** `index.json`: each person's key, name, summary, Patient ids and files, and the totals. */
const ManifestSchema = ManifestStruct.pipe(Schema.filter(inconsistencyOf)).annotations({
  identifier: 'DataSetManifest',
  description: "A synthetic data set's index.json: its people and the files that are theirs.",
})

/** A decoded manifest. */
type Type = typeof ManifestSchema.Type

/** A person as the data set introduces them. */
type Person = typeof PersonSchema.Type

/**
 * A person and their records, laid out (`DataSetLayout.layOut`): what the
 * manifest reads of each file.
 */
interface PersonFiles {
  readonly person: Person
  readonly resources: readonly Pick<DataSetLayout.ResourceFile, 'path' | 'resourceType' | 'id'>[]
  readonly staticFiles: readonly Pick<DataSetLayout.StaticFile, 'path'>[]
}

/** Each string once, in code-unit order, so the order is the same in every runtime and locale. */
const sortedDistinct = (values: readonly string[]): readonly string[] =>
  Arr.sort(Arr.dedupe(values), Order.string)

/**
 * The manifest of a data set's people, each with the ids of their Patient
 * resources and the paths of their files, each list sorted and listing a
 * value once; people stay in the order given.
 *
 * @param asOf - The as-of instant the data set was rendered for
 * @param wildflowerCommit - The Wildflower commit it was generated at
 * @param people - Each person's laid-out records (`DataSetLayout.layOut`)
 */
const manifestOf = (
  asOf: DateTime.Utc,
  wildflowerCommit: string,
  people: readonly PersonFiles[]
): Type => {
  const entries = people.map(({ person, resources, staticFiles }) => ({
    ...person,
    patientIds: sortedDistinct(
      resources
        .filter((resource) => resource.resourceType === 'Patient')
        .map((resource) => resource.id)
    ),
    resources: sortedDistinct(resources.map((resource) => resource.path)),
    staticFiles: sortedDistinct(staticFiles.map((staticFile) => staticFile.path)),
  }))
  return {
    schemaVersion: SCHEMA_VERSION,
    asOf,
    generator: { name: GENERATOR_NAME, wildflowerCommit },
    people: entries,
    totals: totalsOf(entries),
  }
}

/** The files a reader loads for some of a data set's people. */
interface FilePaths {
  /** Resource file paths, each once, in path order. */
  readonly resources: readonly string[]
  /** Static file paths, each once, in path order. */
  readonly staticFiles: readonly string[]
}

/**
 * The files of the people `personKeys` names: a file two of them share (a
 * family account's HAR, its Patient) is listed once.
 *
 * @param manifest - A decoded manifest
 * @param personKeys - The keys of the people to load; a key the manifest does
 *   not list selects nothing
 */
const filesOf = (manifest: Type, personKeys: ReadonlySet<string>): FilePaths => {
  const people = manifest.people.filter((person) => personKeys.has(person.key))
  return {
    resources: sortedDistinct(people.flatMap((person) => person.resources)),
    staticFiles: sortedDistinct(people.flatMap((person) => person.staticFiles)),
  }
}

export {
  filesOf,
  GENERATOR_NAME,
  manifestOf,
  ManifestSchema as Schema,
  PersonEntrySchema,
  PersonSchema,
  SCHEMA_VERSION,
}
export type { FilePaths, Person, PersonFiles, Type }
