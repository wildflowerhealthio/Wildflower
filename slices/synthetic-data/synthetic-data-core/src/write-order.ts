import { Array as Arr } from 'effect'
import type { FhirResource } from 'fhir-r4/resources'

/**
 * The order a data set's resources are written to a FHIR server in: batch
 * bundles, each resource in a later bundle than every resource it references,
 * so a server that checks a reference's target on write finds it already
 * stored.
 *
 * @remarks
 * The order is read off the references themselves rather than a list of
 * resource types, because the data set's own references cross types both
 * ways: a DICOM source file's `DocumentReference` references the
 * `ImagingStudy` read from it, which references the `ServiceRequest` behind
 * it, while a HAR's `DocumentReference` references nothing. `meta.source`
 * is a URI, not a reference, so it orders nothing.
 */

/** The most entries a batch bundle carries. */
const MAX_BUNDLE_ENTRIES = 200

/** FHIR R4's relative-reference grammar: a resource type, `/`, and a logical id. */
const RELATIVE_REFERENCE = /^[A-Z][A-Za-z]*\/[A-Za-z0-9\-.]{1,64}$/

/** `<ResourceType>/<id>`, as a relative reference names a resource. */
const referenceOf = (resource: FhirResource): string =>
  `${resource.resourceType}/${resource.id ?? ''}`

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
      if (RELATIVE_REFERENCE.test(field)) found.add(field)
    } else {
      collectReferences(field, found)
    }
  }
}

/**
 * The resources `resource` references by relative reference
 * (`Patient/abc`), itself excluded — a contained `#id`, a `urn:uuid:` or an
 * absolute URL names nothing a data set writes.
 */
const referencesOf = (resource: FhirResource): ReadonlySet<string> => {
  const found = new Set<string>()
  collectReferences(resource, found)
  found.delete(referenceOf(resource))
  return found
}

/**
 * The resources in rounds: the first holds every resource that references
 * nothing among `resources`, and each later one every resource whose
 * references are all in earlier rounds. A reference to a resource outside
 * `resources` orders nothing. Resources that reference each other in a
 * cycle, and whatever references them, share a last round.
 */
const roundsOf = (resources: readonly FhirResource[]): readonly (readonly FhirResource[])[] => {
  const present = new Set(resources.map(referenceOf))
  const referencesByResource = new Map(
    resources.map((resource) => [
      resource,
      [...referencesOf(resource)].filter((reference) => present.has(reference)),
    ])
  )
  const written = new Set<string>()
  const rounds: (readonly FhirResource[])[] = []
  let remaining = resources
  while (remaining.length > 0) {
    const [waiting, ready] = Arr.partition(remaining, (resource) =>
      (referencesByResource.get(resource) ?? []).every((reference) => written.has(reference))
    )
    const round = ready.length > 0 ? ready : waiting
    rounds.push(round)
    for (const resource of round) written.add(referenceOf(resource))
    remaining = ready.length > 0 ? waiting : []
  }
  return rounds
}

/**
 * `resources` as the batch bundles to write, in order: each resource in a
 * later bundle than every resource among `resources` it references, and no
 * bundle over `maxEntries`.
 *
 * @param resources - The resources to write, each `<ResourceType>/<id>` once
 * @param maxEntries - The most resources one bundle carries
 * @returns The bundles, each keeping `resources`' order; none is empty
 */
const bundlesOf = (
  resources: readonly FhirResource[],
  maxEntries: number = MAX_BUNDLE_ENTRIES
): readonly (readonly FhirResource[])[] =>
  roundsOf(resources).flatMap((round) => Arr.chunksOf(round, maxEntries))

export { bundlesOf, MAX_BUNDLE_ENTRIES, referencesOf }
