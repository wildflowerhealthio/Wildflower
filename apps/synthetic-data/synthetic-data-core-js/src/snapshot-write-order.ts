import { Array as Arr, Option, Schema } from 'effect'

import * as Entry from './snapshot-entry.ts'

/**
 * The order a snapshot's resources are written to a FHIR server in: batch
 * bundles, each resource in a later bundle than every resource it references,
 * so a server that checks a reference's target on write finds it already
 * stored.
 *
 * @remarks
 * The order is read off the references themselves rather than a list of
 * resource types, because a snapshot's own references cross types both ways:
 * a DICOM source file's `DocumentReference` references the `ImagingStudy`
 * read from it, which references the `ServiceRequest` behind it, while a
 * HAR's `DocumentReference` references nothing. `meta.source` is a URI, not a
 * reference, so it orders nothing.
 */

/** The most entries a batch bundle carries. */
const MAX_BUNDLE_ENTRIES = 200

const ResourceTypeSchema = Schema.String.pipe(Schema.pattern(/^[A-Z][A-Za-z]*$/))

/**
 * FHIR R4's relative-reference grammar, `<ResourceType>/<id>`: a resource
 * type name, `/`, and a logical id in {@link Entry.ResourceIdSchema}'s
 * grammar. A contained `#id`, a `urn:uuid:` and an absolute URL are not
 * relative references.
 */
const RelativeReferenceSchema = Schema.TemplateLiteralParser(
  ResourceTypeSchema,
  '/',
  Entry.ResourceIdSchema
).annotations({ identifier: 'SnapshotRelativeReference' })

/**
 * A version-specific relative reference, `<ResourceType>/<id>/_history/<vid>`,
 * the version id in the same grammar as a logical id.
 */
const VersionedRelativeReferenceSchema = Schema.TemplateLiteralParser(
  ResourceTypeSchema,
  '/',
  Entry.ResourceIdSchema,
  '/_history/',
  Entry.ResourceIdSchema
).annotations({ identifier: 'SnapshotVersionedRelativeReference' })

const decodeRelativeReference = Schema.decodeUnknownOption(RelativeReferenceSchema)

const decodeVersionedRelativeReference = Schema.decodeUnknownOption(
  VersionedRelativeReferenceSchema
)

/**
 * The `<ResourceType>/<id>` a reference names, a versioned one's version
 * dropped; none for a reference that is not relative.
 */
const resourceNamedBy = (reference: string): Option.Option<string> =>
  decodeRelativeReference(reference).pipe(
    Option.orElse(() => decodeVersionedRelativeReference(reference)),
    Option.map(([resourceType, , id]) => `${resourceType}/${id}`)
  )

/** The most resources one bundle carries: a whole number, at least one. */
const MaxEntriesSchema = Schema.Int.pipe(Schema.positive()).annotations({
  identifier: 'SnapshotBundleMaxEntries',
})

const decodeMaxEntries = Schema.decodeUnknownSync(MaxEntriesSchema)

/** `<ResourceType>/<id>`: the relative reference naming `resource`. */
const referenceTo = (resource: Entry.StoredResource): string =>
  `${resource.resourceType}/${resource.id}`

/** Whether `value` is a plain object a decoded resource is built of, not a `URL` or a date. */
const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Every relative reference under `value`, added to `found`. */
const collectReferences = (value: unknown, found: Set<string>): void => {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, found)
    return
  }
  if (!isPlainObject(value)) return
  for (const [key, field] of Object.entries(value)) {
    if (key === 'reference' && typeof field === 'string') {
      const named = resourceNamedBy(field)
      if (Option.isSome(named)) found.add(named.value)
    } else {
      collectReferences(field, found)
    }
  }
}

/**
 * The resources `resource` references by relative reference, each as
 * `<ResourceType>/<id>` (`Patient/abc`, also for `Patient/abc/_history/2`),
 * itself excluded — a contained `#id`, a `urn:uuid:` or an absolute URL names
 * nothing a snapshot holds.
 */
const referencesOf = (resource: Entry.StoredResource): ReadonlySet<string> => {
  const found = new Set<string>()
  collectReferences(resource, found)
  found.delete(referenceTo(resource))
  return found
}

/**
 * The resources in rounds: the first holds every resource that references
 * nothing among `resources`, and each later one every resource whose
 * references are all in earlier rounds. A reference to a resource outside
 * `resources` orders nothing. Resources that reference each other in a
 * cycle, and whatever references them, share a last round.
 */
const roundsOf = (
  resources: readonly Entry.StoredResource[]
): readonly (readonly Entry.StoredResource[])[] => {
  const present = new Set(resources.map(referenceTo))
  const referencesByResource = new Map(
    resources.map((resource) => [
      resource,
      [...referencesOf(resource)].filter((reference) => present.has(reference)),
    ])
  )
  const written = new Set<string>()
  const rounds: (readonly Entry.StoredResource[])[] = []
  let remaining = resources
  while (remaining.length > 0) {
    const [waiting, ready] = Arr.partition(remaining, (resource) =>
      (referencesByResource.get(resource) ?? []).every((reference) => written.has(reference))
    )
    const round = ready.length > 0 ? ready : waiting
    rounds.push(round)
    for (const resource of round) written.add(referenceTo(resource))
    remaining = ready.length > 0 ? waiting : []
  }
  return rounds
}

/**
 * `resources` as the batch bundles to write, in order: each resource in a
 * later bundle than every resource among `resources` it references, but
 * resources in a reference cycle, and whatever references them, in the last
 * bundles; and no bundle over `maxEntries`.
 *
 * @param resources - The resources to write, each `<ResourceType>/<id>`
 *   once, as `Reader.readResource` gives them
 * @param maxEntries - The most resources one bundle carries: a whole number,
 *   at least one
 * @returns The bundles, each keeping `resources`' order; none is empty
 * @throws A `ParseError` for a `maxEntries` that is not a whole number of at
 *   least one
 */
const bundlesOf = (
  resources: readonly Entry.StoredResource[],
  maxEntries: number = MAX_BUNDLE_ENTRIES
): readonly (readonly Entry.StoredResource[])[] => {
  const checkedMaxEntries = decodeMaxEntries(maxEntries)
  return roundsOf(resources).flatMap((round) => Arr.chunksOf(round, checkedMaxEntries))
}

export { bundlesOf, MAX_BUNDLE_ENTRIES, referencesOf }
