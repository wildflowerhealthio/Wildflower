import { Array as Arr, Effect, Schedule } from 'effect'

import type { FhirResource } from '../resources/index.ts'
import type { FhirR4ResourcesHttpApiClient } from './fhir-r4-resources-http-api-client.ts'
import { UnsupportedFhirResourceTypeError, upsertResource } from './upsert-resource.ts'

/**
 * Writing a whole decoded batch back to the on-device FHIR R4 store: the batch
 * counterpart of {@link upsertResource}, which writes one resource.
 *
 * @remarks
 * Every consumer that writes a batch wants the same four things around the
 * write — bounded retries, a per-resource span, bounded concurrency, and
 * failure-as-data — so they live here once rather than being re-derived per
 * caller. This module was three byte-identical copies (one per
 * `*-client-collector`) before it was consolidated; they differed only in a log
 * prefix.
 *
 * It stays free of collector vocabulary: span names and the log label are
 * *supplied* by the caller ({@link PersistOptions}) rather than imported, because
 * `fhir-r4` sits below the collector slice and must not name it. The failure
 * record is likewise declared here and is structurally compatible with the
 * collector's `PersistFailure` — each descriptor's `CollectorDescriptor.make`
 * call is where the two are checked against each other, so a drift between them
 * is a compile error at every call site rather than a silent divergence.
 *
 * @packageDocumentation
 */

/**
 * Identity of one resource in a write span and in a failure record: its FHIR
 * `resourceType` as `label`, plus the logical `id` the write targets.
 *
 * @remarks
 * Not a discriminant — nothing switches on `label`; it only names the resource
 * in telemetry and in a caller's failure summary, so a caller can surface a
 * failed write without inspecting the resource itself.
 */
interface ResourceWriteTarget {
  readonly label: string
  readonly id: string
}

/**
 * One resource the batch could not write after its retries, paired with the
 * underlying `cause`.
 *
 * @remarks
 * Returned **as data** on a `never` error channel, so one bad resource cannot
 * fail a whole batch. Structurally the collector slice's `PersistFailure`.
 */
interface ResourceWriteFailure {
  readonly failed: ResourceWriteTarget
  readonly cause: unknown
}

/**
 * What a caller supplies so the batch reports itself in that caller's own
 * vocabulary.
 *
 * @remarks
 * All three are caller-owned on purpose: `fhir-r4` cannot import the collector
 * telemetry catalog that defines these span names, and hardcoding them here
 * would put collector vocabulary in the EMR slice.
 */
interface PersistOptions {
  /** Span name for one resource's write, e.g. the collector's `collector.importing.update`. */
  readonly spanName: string
  /** Attribute key the resource's kind label is recorded under on that span. */
  readonly kindAttributeKey: string
  /** Prefix for the retries-exhausted log line, e.g. `'rexall persist'`. */
  readonly logLabel: string
}

/**
 * Max concurrent resource PUTs within a single batch.
 *
 * @remarks
 * *Unbounded* concurrency fired hundreds of simultaneous upserts that stalled
 * the collector's inline-awaited drive loop, so its `Sync` span never ended and
 * never flushed. The stall was a property of unboundedness, not of parallelism
 * per se, so this stays a small fixed bound — enough to reclaim throughput over
 * a serial `1`, far below the "hundreds in flight" that triggered the stall.
 */
const WRITE_CONCURRENCY = 8

/**
 * Describe a resource for its write span and a caller's failure summary.
 *
 * @param resource - The resource about to be written
 * @returns Its `resourceType` and logical id, with a sentinel for the null-id
 *   case {@link upsertResource} skips
 */
const describeResource = (resource: FhirResource): ResourceWriteTarget => ({
  label: resource.resourceType,
  id: resource.id ?? '<no-id>',
})

/**
 * Build a batch write over the typed FHIR R4 client.
 *
 * @param options - The caller's span names and log label
 * @returns A function that writes a batch and returns only what it could not
 *   write — never failing, so one bad resource cannot fail the batch
 *
 * @remarks
 * "Which resource type goes to which endpoint" is {@link upsertResource}. What
 * this owns is everything *around* the write:
 *
 * - **retries**: bounded exponential backoff (3 retries, 250 ms → 1 s). Each
 *   attempt is its own OTel HTTP span, so the attempt count reads straight off
 *   the trace. `Schedule.intersect` enforces both "stop after N" *and*
 *   "exponential" — `either` would stop on whichever fired first. A permanent
 *   {@link UnsupportedFhirResourceTypeError} is *not* retried; it is recorded on
 *   the first attempt rather than backed off pointlessly.
 * - **per-resource span**: `options.spanName`, tagged with the resource's kind.
 * - **concurrency**: {@link WRITE_CONCURRENCY} PUTs in flight per batch.
 * - **failure accounting**: a resource still failing after its retries becomes
 *   one {@link ResourceWriteFailure} carrying the real cause.
 *
 * The write is a PUT on the resource's own id, so retries are idempotent — a
 * retried write replaces the resource it already wrote rather than duplicating
 * it. The client requirement stays in `R` for app wiring to provide.
 */
const makePersistResources =
  (
    options: PersistOptions
  ): ((
    resources: ReadonlyArray<FhirResource>
  ) => Effect.Effect<ReadonlyArray<ResourceWriteFailure>, never, FhirR4ResourcesHttpApiClient>) =>
  (resources) =>
    Effect.forEach(
      resources,
      (resource) => {
        const failed = describeResource(resource)
        return upsertResource(resource).pipe(
          Effect.retry({
            schedule: Schedule.exponential('250 millis').pipe(
              Schedule.intersect(Schedule.recurs(3))
            ),
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
              `${options.logLabel}: upsert failed for ${failed.label}/${failed.id}`,
              cause
            )
          ),
          Effect.withSpan(options.spanName, {
            attributes: { [options.kindAttributeKey]: failed.label },
          }),
          Effect.matchEffect({
            onSuccess: () => Effect.succeedNone,
            onFailure: (cause) => Effect.succeedSome<ResourceWriteFailure>({ failed, cause }),
          })
        )
      },
      { concurrency: WRITE_CONCURRENCY }
    ).pipe(Effect.map(Arr.getSomes))

export {
  describeResource,
  makePersistResources,
  type PersistOptions,
  type ResourceWriteFailure,
  type ResourceWriteTarget,
  WRITE_CONCURRENCY,
}
