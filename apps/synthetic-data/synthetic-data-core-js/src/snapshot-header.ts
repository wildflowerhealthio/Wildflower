import { Array as Arr, type DateTime, Order, Schema } from 'effect'

import * as Entry from './snapshot-entry.ts'
import * as SnapshotFile from './snapshot-file.ts'

/**
 * A snapshot's header: when it was taken and by what, who its members are and
 * which entries are theirs, and its totals — the one listing a reader has,
 * because a static host cannot list a directory. Its file is `index.json`, at
 * the snapshot's root.
 *
 * @remarks
 * {@link Schema} is the header's single definition. The step that publishes a
 * snapshot encodes it ({@link FileSchema}); a reader decodes what it fetched
 * with it, and gets paths already checked against the entries' grammar
 * (`Entry.ResourcePathSchema`, `AttachmentPathSchema`), so it never fetches
 * outside the snapshot.
 */

/** Where the header's file sits: the snapshot's root. */
const PATH = 'index.json'

/** The header format's version; a change to {@link Schema}'s shape is a new one. */
const SCHEMA_VERSION = 1

/** What made the snapshot. */
const GENERATOR_NAME = 'synthetic-data-core-js'

/** A member of the snapshot: a person whose records are in it, as it introduces them. */
const MemberSchema = Schema.Struct({
  /** A stable lower-case handle, unique in the snapshot (`'person-1'`). */
  key: Schema.String.pipe(Schema.pattern(/^[a-z0-9][a-z0-9-]*$/)),
  /** The person's name, as a reader lists them. */
  displayName: Schema.NonEmptyString,
  /** A sentence or two on what their records show. */
  summary: Schema.String,
}).annotations({ identifier: 'SnapshotMember' })

/** A member and the entries that are theirs, as the header lists them. */
const MemberListingSchema = Schema.Struct({
  ...MemberSchema.fields,
  /**
   * The ids of the member's Patient records, sorted. Usually one; a
   * Shoppers account holder also has the account's `pcid` Patient.
   */
  patientIds: Schema.Array(Entry.ResourceIdSchema),
  /** The paths of the member's resources, in path order. */
  resources: Schema.Array(Entry.ResourcePathSchema),
  /** The paths of the files the member's records were imported from, in path order. */
  staticFiles: Schema.Array(Entry.AttachmentPathSchema),
}).annotations({ identifier: 'SnapshotMemberListing' })

/** How many members and distinct entries the snapshot holds; an entry two members share counts once. */
const TotalsSchema = Schema.Struct({
  people: Schema.NonNegativeInt,
  resources: Schema.NonNegativeInt,
  staticFiles: Schema.NonNegativeInt,
}).annotations({ identifier: 'SnapshotTotals' })

const HeaderStruct = Schema.Struct({
  schemaVersion: Schema.Literal(SCHEMA_VERSION),
  /** The as-of instant every story day in the snapshot is dated from. */
  asOf: Schema.DateTimeUtc,
  generator: Schema.Struct({
    name: Schema.Literal(GENERATOR_NAME),
    /** The Wildflower commit the snapshot was generated at, as its generator states it. */
    wildflowerCommit: Schema.NonEmptyString,
  }),
  /** The members, in the order the snapshot lists them. */
  people: Schema.Array(MemberListingSchema),
  totals: TotalsSchema,
})

/** The totals a header's members add up to. */
const totalsOf = (people: typeof HeaderStruct.Type.people): typeof HeaderStruct.Type.totals => ({
  people: people.length,
  resources: new Set(people.flatMap((member) => member.resources)).size,
  staticFiles: new Set(people.flatMap((member) => member.staticFiles)).size,
})

/** Why a header's members and totals disagree, or `undefined` when they agree. */
const inconsistencyOf = (header: typeof HeaderStruct.Type): string | undefined => {
  const keys = header.people.map((member) => member.key)
  const repeatedKey = keys.find((key, index) => keys.indexOf(key) !== index)
  if (repeatedKey !== undefined) return `The member key ${repeatedKey} is listed twice.`
  const totals = totalsOf(header.people)
  const { people, resources, staticFiles } = header.totals
  return totals.people === people &&
    totals.resources === resources &&
    totals.staticFiles === staticFiles
    ? undefined
    : `The totals ${JSON.stringify(header.totals)} are not the members' ${JSON.stringify(totals)}.`
}

/** The header: each member's key, name, summary, Patient ids and entries, and the totals. */
const HeaderSchema = HeaderStruct.pipe(Schema.filter(inconsistencyOf)).annotations({
  identifier: 'SnapshotHeader',
  description:
    "A synthetic data snapshot's index.json: its members and the entries that are theirs.",
})

/** A snapshot's header. */
type Header = typeof HeaderSchema.Type

/** A member of the snapshot, as it introduces them. */
type Member = typeof MemberSchema.Type

/** A member and the entries that are theirs, as the header lists them. */
type MemberListing = typeof MemberListingSchema.Type

/** A member and their records, laid out as entries (`Snapshot.Layout.layOut`). */
interface MemberEntries {
  readonly member: Member
  readonly entries: readonly Entry.Any[]
}

/** The header's file: its JSON at {@link PATH}. */
const HeaderTextSchema = Schema.TaggedStruct('Text', {
  path: Schema.String.pipe(Schema.filter((path) => path === PATH || `The header is ${PATH}.`)),
  text: SnapshotFile.jsonTextOf(HeaderSchema),
})

/**
 * A {@link Header} ⇄ its file: `index.json`, the JSON {@link Schema} encodes
 * it to, two-space indented with a trailing newline.
 */
const FileSchema: Schema.Schema<Header, SnapshotFile.Text> = Schema.transform(
  HeaderTextSchema,
  Schema.typeSchema(HeaderSchema),
  {
    strict: true,
    decode: (file) => file.text,
    encode: (header) => ({ _tag: 'Text', path: PATH, text: header }) as const,
  }
)

/** Each string once, in code-unit order, so the order is the same in every runtime and locale. */
const sortedDistinct = (values: readonly string[]): readonly string[] =>
  Arr.sort(Arr.dedupe(values), Order.string)

/** A member's listing: their Patient ids and entry paths, each sorted and distinct. */
const listingOf = ({ member, entries }: MemberEntries): MemberListing => {
  const resources = entries.flatMap((entry) => (entry._tag === 'Resource' ? [entry.resource] : []))
  return {
    ...member,
    patientIds: sortedDistinct(
      resources.flatMap((resource) => (resource.resourceType === 'Patient' ? [resource.id] : []))
    ),
    resources: sortedDistinct(
      resources.map((resource) => Entry.resourcePathOf(resource.resourceType, resource.id))
    ),
    staticFiles: sortedDistinct(
      entries.flatMap((entry) => (entry._tag === 'Attachment' ? [Entry.pathOf(entry)] : []))
    ),
  }
}

/**
 * The header of a snapshot's members, each with the ids of their Patient
 * resources and the paths of their entries, each list sorted and listing a
 * value once; members stay in the order given.
 *
 * @param asOf - The as-of instant the snapshot was rendered for
 * @param wildflowerCommit - The Wildflower commit it was generated at
 * @param members - Each member's laid-out entries
 */
const make = (
  asOf: DateTime.Utc,
  wildflowerCommit: string,
  members: readonly MemberEntries[]
): Header => {
  const people = members.map(listingOf)
  return {
    schemaVersion: SCHEMA_VERSION,
    asOf,
    generator: { name: GENERATOR_NAME, wildflowerCommit },
    people,
    totals: totalsOf(people),
  }
}

/** The paths of the entries a reader loads for some of a snapshot's members. */
interface MemberPaths {
  /** Resource paths, each once, in path order. */
  readonly resources: readonly string[]
  /** Attachment paths, each once, in path order. */
  readonly staticFiles: readonly string[]
}

/**
 * The paths of the entries of the members `memberKeys` names: an entry two of
 * them share (a family account's HAR, its Patient) is listed once.
 *
 * @param header - A decoded header
 * @param memberKeys - The keys of the members to load; a key the header does
 *   not list selects nothing
 */
const pathsOf = (header: Header, memberKeys: ReadonlySet<string>): MemberPaths => {
  const members = header.people.filter((member) => memberKeys.has(member.key))
  return {
    resources: sortedDistinct(members.flatMap((member) => member.resources)),
    staticFiles: sortedDistinct(members.flatMap((member) => member.staticFiles)),
  }
}

export {
  FileSchema,
  GENERATOR_NAME,
  make,
  MemberListingSchema,
  MemberSchema,
  PATH,
  pathsOf,
  HeaderSchema as Schema,
  SCHEMA_VERSION,
}
export type { Header, Member, MemberEntries, MemberListing, MemberPaths }
