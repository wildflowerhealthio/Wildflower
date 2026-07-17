import type { CollectorDescriptor } from 'collector-fundamentals/model'
import * as Telemetry from 'collector-fundamentals/telemetry'
import { Array as Arr, Effect, Schedule } from 'effect'
import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { UnsupportedFhirResourceTypeError, upsertResource } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'

/**
 * The FHIR R4 collector's persist sink: the descriptor's `persistResources`.
 * Writes a decoded batch back to the typed `FhirR4ResourcesHttpApiClient` and
 * hands back the resources it could not write as {@link PersistFailure} data.
 *
 * "Which resource type goes to which endpoint" is `fhir-r4`'s reusable
 * {@link upsertResource} (the `switch` that used to live inline here, now
 * shared by every FHIR-targeting collector). This sink owns everything
 * *around* the write:
 * - **retries**: bounded exponential backoff (3 retries, 250ms → 1s). Each
 *   attempt is its own OTel HTTP span, so the attempt count reads straight off
 *   the trace. `Schedule.intersect` enforces both "stop after N" *and*
 *   "exponential" (`either` would stop on whichever fired first). A permanent
 *   `UnsupportedFhirResourceTypeError` is *not* retried — it is recorded on the
 *   first attempt rather than backed off pointlessly.
 * - **per-resource span**: `collector.importing.update`, tagged with the
 *   resource's kind label so a trace names what was written.
 * - **concurrency**: {@link WRITE_CONCURRENCY} PUTs in flight per batch.
 * - **failure accounting**: a resource still failing after its retries becomes
 *   one {@link PersistFailure} carrying the real cause; the batch Effect itself
 *   never fails, so one bad resource cannot fail the whole run.
 *
 * The write requirement {@link FhirR4ResourcesHttpApiClient} bubbles up as the
 * descriptor's `R`; app wiring provides the client layer, so the collector
 * slice never self-provides it.
 */

/**
 * Max concurrent resource PUTs within a single batch. *Unbounded* concurrency
 * fired hundreds of simultaneous upserts that stalled the inline-awaited drive
 * loop, so the `Sync` span never ended and never flushed. The stall was a
 * property of unboundedness, not of parallelism per se, so this stays a small
 * fixed bound — enough to reclaim throughput over a serial `1`, far below the
 * "hundreds in flight" that triggered the stall. Revisit if the drive loop is
 * reworked to not await batches inline.
 */
const WRITE_CONCURRENCY = 8

/**
 * Describe a FHIR resource for the write span and the runner's `partial`
 * failure summary — `label` is the FHIR `resourceType`, `id` its logical id
 * (falling back to a sentinel for the null-id case that {@link upsertResource}
 * skips), so the runner never has to inspect a resource's fields itself.
 */
const describeResource = (resource: FhirResource): CollectorDescriptor.FailedResource => ({
  label: resource.resourceType,
  id: resource.id ?? '<no-id>',
})

/**
 * Persist a decoded batch, returning only the resources that could not be
 * written. Each resource is retried and spanned independently; a success
 * contributes no failure, a retry-exhausted resource contributes one
 * {@link PersistFailure} with its cause. `Arr.getSomes` then drops the
 * successes, leaving the failed subset for the runner to fold into the summary.
 */
const persistResources = (
  resources: ReadonlyArray<FhirResource>
): Effect.Effect<
  ReadonlyArray<CollectorDescriptor.PersistFailure>,
  never,
  FhirR4ResourcesHttpApiClient
> =>
  Effect.forEach(
    resources,
    (resource) => {
      const failed = describeResource(resource)
      return upsertResource(resource).pipe(
        Effect.retry({
          schedule: Schedule.exponential('250 millis').pipe(Schedule.intersect(Schedule.recurs(3))),
          // Don't retry a permanent structural failure — an unsupported
          // `resourceType` never becomes supported, so backing off 3× just
          // delays recording it (~1.75s). Transient write errors still retry.
          while: (cause) => !(cause instanceof UnsupportedFhirResourceTypeError),
        }),
        // Log once, *after* the retries are exhausted — placing `tapError`
        // before `retry` would re-log on every failed attempt (up to 4× per
        // resource). Each attempt is still its own HTTP span on the trace.
        Effect.tapError((cause) =>
          Effect.logError(`fhir-r4 persist: upsert failed for ${failed.label}/${failed.id}`, cause)
        ),
        Effect.withSpan(Telemetry.Importing.Update.Span.Name, {
          attributes: { [Telemetry.Importing.Update.Span.Attributes.Kind]: failed.label },
        }),
        Effect.matchEffect({
          onSuccess: () => Effect.succeedNone,
          onFailure: (cause) =>
            Effect.succeedSome<CollectorDescriptor.PersistFailure>({ failed, cause }),
        })
      )
    },
    { concurrency: WRITE_CONCURRENCY }
  ).pipe(Effect.map(Arr.getSomes))

export { describeResource, persistResources, WRITE_CONCURRENCY }
