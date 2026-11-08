import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, Option, pipe } from 'effect'

/**
 * How a resource's copies merge: the copy that arrived first, or the merge so
 * far, and a later copy, into the one resource to write in their place.
 */
type Merge = (earlier: FhirResourceWithId, later: FhirResourceWithId) => FhirResourceWithId

/**
 * What marks a resource as one copy of several a decode read: the identity
 * the copies share and how they merge.
 *
 * @remarks
 * A source can describe one thing in several responses, each knowing fields
 * the others lack. A decode keeps every copy where it found it, so the
 * reviewer can leave one out with its response, and the copies the review
 * keeps are merged after it ({@link mergeSharedCopies}). `identity` is unique
 * to one decode of one file set, so copies from two file sets never merge.
 */
interface Shared {
  readonly identity: string
  readonly merge: Merge
}

/**
 * One reviewed resource: its review key, its title, and the resource, which
 * has an id to be written under; `shared` when it is one copy of several
 * merged after review.
 */
interface Resource {
  readonly key: string
  readonly title: string
  readonly resource: FhirResourceWithId
  readonly shared?: Shared
}

interface Section {
  readonly title: string
  readonly resources: readonly Resource[]
}

interface DecodedFile {
  readonly sections: readonly Section[]
  readonly notes: readonly string[]
}

const resources = (decodedFile: { readonly sections: readonly Section[] }): readonly Resource[] =>
  decodedFile.sections.flatMap((section) => section.resources)

/**
 * `decodedFile` with `f` applied to every resource entry, sections and notes
 * kept. A section and the file come back as the same object when `f` returns
 * every entry in them as itself.
 */
const mapResources = (decodedFile: DecodedFile, f: (entry: Resource) => Resource): DecodedFile => {
  const sections = decodedFile.sections.map((section) => {
    const entries = section.resources.map(f)
    return entries.every((entry, at) => entry === section.resources[at])
      ? section
      : { ...section, resources: entries }
  })
  return sections.every((section, at) => section === decodedFile.sections[at])
    ? decodedFile
    : { ...decodedFile, sections }
}

/**
 * The merge of each shared identity's copies among `rows`: by identity, the
 * copies' resources folded in `rows`' order with their `merge`.
 */
const mergesByIdentity = (rows: readonly Resource[]): ReadonlyMap<string, FhirResourceWithId> =>
  Arr.reduce(rows, new Map<string, FhirResourceWithId>(), (merges, { resource, shared }) => {
    if (shared === undefined) return merges
    const earlier = merges.get(shared.identity)
    return merges.set(
      shared.identity,
      earlier === undefined ? resource : shared.merge(earlier, resource)
    )
  })

/**
 * `rows` with every shared copy holding the merge of its identity's copies
 * among `rows`, folded in order, so each copy reads as what its identity is
 * written as; a row that is no shared copy, or the one copy of its identity,
 * is kept as the same object.
 *
 * @remarks
 * For a reader that keeps a row per copy: the server diff, which so gives
 * every copy one verdict, and the import plan, whose last-wins rule over one
 * `Type/id` then writes the merge whichever copy it keeps.
 */
const withSharedCopiesMerged = (rows: readonly Resource[]): readonly Resource[] => {
  const merges = mergesByIdentity(rows)
  return rows.map((row) =>
    pipe(
      Option.fromNullable(row.shared),
      Option.flatMapNullable(({ identity }) => merges.get(identity)),
      Option.filter((merged) => merged !== row.resource),
      Option.match({
        onNone: () => row,
        onSome: (merged) => ({ ...row, resource: merged }),
      })
    )
  )
}

/** Whether `row` and `other` are copies of one shared identity. */
const areCopiesOfOneIdentity = (row: Resource, other: Resource): boolean =>
  row.shared !== undefined && row.shared.identity === other.shared?.identity

/**
 * `rows` with the copies that share an identity merged into one: the merge
 * of every copy of it in `rows`, folded in order, in the first copy's place,
 * and the later copies left out. A row that is no shared copy is kept as it
 * is.
 *
 * @remarks
 * What a review writes of a shared resource: pass the rows it includes, as
 * reviewed, so a copy the reviewer left out with its response contributes
 * nothing and an edit to a copy is merged in.
 */
const mergeSharedCopies = (rows: readonly Resource[]): readonly Resource[] =>
  Arr.dedupeWith(withSharedCopiesMerged(rows), areCopiesOfOneIdentity)

export { mapResources, mergeSharedCopies, resources, withSharedCopiesMerged }

export type { Merge, Resource, Section, DecodedFile, Shared }
