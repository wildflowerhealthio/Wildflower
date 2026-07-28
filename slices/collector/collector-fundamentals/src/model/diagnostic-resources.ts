import { Effect } from 'effect'
import { unknownErrorToString } from 'kitchen-sink'
import type { PersistFailure } from './resource-persistence-runtime.ts'

/**
 * A descriptor's batch write: hands back the resources it could not write as
 * {@link PersistFailure} data on a `never` error channel.
 *
 * @typeParam Resources - The collector's resource type
 * @typeParam R - The write requirement the sink needs (for fhir-r4, the typed
 * FHIR client)
 */
type PersistResources<Resources, R> = (
  resources: ReadonlyArray<Resources>
) => Effect.Effect<ReadonlyArray<PersistFailure>, never, R>

/**
 * Wrap a descriptor's `persistResources` so the diagnostic resources in a batch
 * are written but their failures are logged instead of reported, keeping a
 * failed diagnostic write out of the run's success accounting.
 *
 * @typeParam Resources - The collector's resource type
 * @typeParam R - The write requirement of the wrapped sink; unchanged by the
 * wrapper
 * @param persistResources - The descriptor's real batch write; the wrapper
 * calls *this* for both partitions rather than deriving a second write
 * @param isDiagnostic - True for a resource that is a diagnostic (a provenance
 * or trace record), false for one that is the collector's primary output
 * @returns A batch write with the same signature, returning only the failures
 * of the non-diagnostic resources
 *
 * @remarks
 * A diagnostic rides in the same batch as the primary resources, and a sink
 * reports a failed write as `PersistFailure` data rather than failing — but the
 * runner folds *any* `PersistFailure` into a `partial` import summary and fires
 * the caller's error callback. Without this wrapper a failed trace write would
 * report a fully-successful import as partial. Hence: the diagnostic failures
 * are `Effect.logWarning`-ed one line each, naming the failed resource's
 * `label` and `id`, and only the primary failures are returned.
 *
 * Three properties the implementation holds to:
 *
 * - **Primary resources are written first**, so a diagnostic write can never
 *   delay or displace the primary output.
 * - **Neither partition costs a round trip it does not need.** A batch with no
 *   diagnostic resources makes exactly one call, an all-diagnostic batch makes
 *   exactly one call, and an empty batch makes none — an empty-array call per
 *   batch is a real cost at import volumes.
 * - **Order within each partition is preserved**, and no resource is dropped:
 *   the two partitions concatenated are the input, filtered by `isDiagnostic`.
 *
 * @example
 * ```ts
 * persistResources: withDiagnosticResources(
 *   persistFhirResources,
 *   (resource) => resource.resourceType === 'DocumentReference'
 * )
 * ```
 */
const withDiagnosticResources = <Resources, R>(
  persistResources: PersistResources<Resources, R>,
  isDiagnostic: (resource: Resources) => boolean
): PersistResources<Resources, R> => {
  const persistIfAny = (
    resources: ReadonlyArray<Resources>
  ): Effect.Effect<ReadonlyArray<PersistFailure>, never, R> =>
    resources.length === 0 ? Effect.succeed([]) : persistResources(resources)
  return (resources) =>
    Effect.gen(function* () {
      const primary: Resources[] = []
      const diagnostic: Resources[] = []
      for (const resource of resources) {
        if (isDiagnostic(resource)) {
          diagnostic.push(resource)
        } else {
          primary.push(resource)
        }
      }
      const primaryFailures = yield* persistIfAny(primary)
      const diagnosticFailures = yield* persistIfAny(diagnostic)
      for (const failure of diagnosticFailures) {
        yield* Effect.logWarning(
          `withDiagnosticResources: diagnostic ${failure.failed.label} ${failure.failed.id} was not written; the run is unaffected (${unknownErrorToString(failure.cause)})`
        )
      }
      return primaryFailures
    })
}

export { withDiagnosticResources }
export type { PersistResources }
