import { Array as Arr, Order } from 'effect'
import type { FhirResource } from 'fhir-r4/resources'
import type { DataSetManifest } from 'synthetic-data-core'

/**
 * What a load reads and in what order it writes: the picked people's files,
 * and the batch bundles their resources are written in.
 */

/** How many resources one batch bundle carries. */
const WRITE_BATCH_SIZE = 200

/**
 * The order resource types are written in: each before the types that
 * reference it, so a server that checks references on write finds every
 * target already stored. A type not listed is written last.
 *
 * @remarks
 * Patients and Practitioners are referenced by everything; the source files
 * (`DocumentReference`) name their Patient; a dispense names its request; an
 * imaging study names the request it answers; a report names its results.
 * `meta.source` is a `uri`, not a reference, so it constrains nothing.
 */
const WRITE_ORDER: readonly FhirResource['resourceType'][] = [
  'Patient',
  'Practitioner',
  'DocumentReference',
  'ServiceRequest',
  'MedicationRequest',
  'MedicationDispense',
  'Observation',
  'ImagingStudy',
  'DiagnosticReport',
]

/** A resource file path's resource type: `fhir/<ResourceType>/<id>.json`. */
const resourceTypeOfPath = (path: string): string => path.split('/')[1] ?? path

/**
 * The resource files of the people picked, each once — a file two people
 * share, such as a family account's HAR source file, is read and written
 * once — in path order.
 *
 * @param manifest - The data set's manifest
 * @param personKeys - The keys of the people picked
 */
const resourcePathsOf = (
  manifest: DataSetManifest.Type,
  personKeys: ReadonlySet<string>
): readonly string[] =>
  Arr.sort(
    Arr.dedupe(
      manifest.people
        .filter((person) => personKeys.has(person.key))
        .flatMap((person) => person.resources)
    ),
    Order.string
  )

/**
 * How many of each resource type a person's files hold, most first (ties in
 * type order).
 */
const resourceTypeCountsOf = (
  resourcePaths: readonly string[]
): readonly { readonly resourceType: string; readonly count: number }[] => {
  const counts = new Map<string, number>()
  for (const path of resourcePaths) {
    const resourceType = resourceTypeOfPath(path)
    counts.set(resourceType, (counts.get(resourceType) ?? 0) + 1)
  }
  return [...counts]
    .map(([resourceType, count]) => ({ resourceType, count }))
    .toSorted(
      (left, right) =>
        right.count - left.count || Order.string(left.resourceType, right.resourceType)
    )
}

/** Where a resource type falls in {@link WRITE_ORDER}; an unlisted type after them all. */
const writeRankOf = (resource: FhirResource): number => {
  const rank = WRITE_ORDER.indexOf(resource.resourceType)
  return rank === -1 ? WRITE_ORDER.length : rank
}

/**
 * The batch bundles a load writes, in the order it writes them: the
 * resources in {@link WRITE_ORDER} (their read order kept within a type),
 * {@link WRITE_BATCH_SIZE} to a bundle.
 */
const writeBatchesOf = (resources: readonly FhirResource[]): readonly (readonly FhirResource[])[] =>
  Arr.chunksOf(Arr.sort(resources, Order.mapInput(Order.number, writeRankOf)), WRITE_BATCH_SIZE)

export { resourcePathsOf, resourceTypeCountsOf, WRITE_BATCH_SIZE, WRITE_ORDER, writeBatchesOf }
