import type { CollectorDescriptor } from 'collector-fundamentals/model'
import * as Telemetry from 'collector-fundamentals/telemetry'
import { Array as Arr, Effect, Schedule } from 'effect'
import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { UnsupportedFhirResourceTypeError, upsertResource } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'

/**
 * The web-trace collector's persist sink: the descriptor's `persistResources`.
 *
 * @remarks
 * A **verbatim copy** of `rexall-be-well-collector/src/persist.ts` (itself a copy
 * of `fhir-r4-client-collector`'s). All three write to the same on-device FHIR R4
 * store through the same {@link upsertResource} dispatch, so the sink is
 * identical; slice layering forbids a `*-client-collector` importing another, so
 * it is duplicated rather than shared. Read that file for the rationale behind
 * the retry schedule, the per-resource span, and the concurrency bound — and
 * change all three together.
 *
 * What is specific here: the resource id is `web-trace-core`'s deterministic
 * `{sessionId}-{requestId}`, so a retried write replaces the exchange it already
 * wrote rather than duplicating it.
 *
 * @packageDocumentation
 */

/** Max concurrent resource PUTs within a single batch. See the sibling sink for why it is bounded. */
const WRITE_CONCURRENCY = 8

/**
 * Describe a FHIR resource for the write span and the runner's `partial` failure
 * summary, so the runner never inspects a resource's fields itself. The sentinel
 * id covers the null-id case {@link upsertResource} skips.
 */
const describeResource = (resource: FhirResource): CollectorDescriptor.FailedResource => ({
  label: resource.resourceType,
  id: resource.id ?? '<no-id>',
})

/**
 * Persist a recorded batch, returning only the resources that could not be
 * written. Each resource is retried and spanned independently and the batch
 * Effect never fails, so one bad exchange cannot lose a session.
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
          Effect.logError(
            `web-trace persist: upsert failed for ${failed.label}/${failed.id}`,
            cause
          )
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
