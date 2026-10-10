import { Array as Arr, Data, Effect, Schema } from 'effect'
import { unknownErrorToString } from 'kitchen-sink'

import type * as Bundle from '../data-types/resources/bundle.ts'
import { type FhirResource, FhirResourceSchema } from '../resources/index.ts'
import * as Telemetry from '../telemetry/index.ts'
import { FhirR4ResourcesHttpApiClient } from './fhir-r4-resources-http-api-client.ts'
import { describeResource, type ResourceWriteTarget } from './persist-resources.ts'

/**
 * Writing a whole decoded batch back to the FHIR store as one `POST /` batch
 * Bundle — one HTTP round trip carrying N PUT entries — with per-entry
 * failures returned as data.
 *
 * @remarks
 * The bundle counterpart of {@link persistResources}, which fans one PUT out
 * per resource. Where `persistResources` owns retries + concurrency + a
 * per-resource span (the collector's live sync path), this owns the batch as
 * one wire round trip (the importer's confirmed one-shot). Both report
 * `{@link ResourceWriteFailure}[]` on a `never` error channel — one bad entry
 * cannot fail the whole caller's run.
 *
 * The batch bundle is FHIR R4 § 3.2.5 batch semantics: **entries are
 * independent**, so a per-entry non-2xx is that entry's failure only; the rest
 * of the bundle still applies. (Transaction semantics — atomic
 * all-or-nothing — is a different bundle `type` and a different failure
 * model, and is *not* implemented here.)
 *
 * Each resource is encoded through {@link FhirResourceSchema} before it goes
 * in the bundle, since the endpoint's loose entry type encodes nothing.
 *
 * If the whole `POST /` fails (a resource that does not encode, a transport
 * error, a non-2xx on the bundle itself, or a decode error on the response
 * bundle), every entry in the
 * submitted set is reported as failed against that one cause — one bad server
 * response cannot silently drop the batch. A null-id resource is skipped
 * defensively (a PUT needs an id, mirroring {@link upsertResource}).
 *
 * Unlike {@link persistResources}, this reports the **whole** per-entry
 * outcome — every submitted resource's echoed HTTP status and any
 * OperationOutcome diagnostics, success or failure — not just the failures, so
 * a caller (the importer's results view) can show what wrote alongside what
 * did not, grouped by response code, with the server's own messages.
 * {@link persistBatchBundleOrFail} is the same write for a caller with no
 * results view: it fails with {@link BatchEntriesRejected} unless every entry
 * was accepted.
 *
 * @packageDocumentation
 */

/**
 * One issue the server reported for an entry, from its `response.outcome`
 * OperationOutcome — the human-readable reason behind a status.
 */
interface WriteIssue {
  /** `fatal` | `error` | `warning` | `information`, verbatim. */
  readonly severity: string
  /** The `IssueType` code, verbatim (`not-found`, `invariant`, …). */
  readonly code: string
  /** The best available message: `details.text`, else `diagnostics`, else empty. */
  readonly text: string
}

/**
 * One submitted resource's outcome in a batch bundle: the resource it
 * targeted, the echoed HTTP status, whether that status is a success, and any
 * diagnostics the server attached.
 *
 * @remarks
 * `status` is the server's echoed `"NNN Text"` verbatim when there was a
 * response entry, and the sentinel {@link NO_RESPONSE_STATUS} when the whole
 * bundle failed or the response was truncated — so a caller can always group
 * by `status` without a special case.
 */
interface BatchEntryOutcome {
  readonly target: ResourceWriteTarget
  readonly status: string
  readonly ok: boolean
  readonly issues: readonly WriteIssue[]
}

/** The `status` a resource gets when the server returned no entry for it. */
const NO_RESPONSE_STATUS = 'No response'

/** The issues an entry's `response.outcome` OperationOutcome carries, as {@link WriteIssue}s. */
const issuesOf = (response: Bundle.EntryResponseType | null | undefined): readonly WriteIssue[] =>
  (response?.outcome?.issue ?? []).map((issue) => ({
    severity: issue.severity,
    code: issue.code,
    text: issue.details?.text ?? issue.diagnostics ?? '',
  }))

/**
 * Build the `entry.request.url` for a resource — `Type/id`, matching the
 * per-resource `Update` endpoint. Kept alongside the sink because that is
 * where the client-side "which type goes to which url" already lives.
 */
const entryUrl = (resource: FhirResource): string => `${resource.resourceType}/${resource.id ?? ''}`

/**
 * Whether an `entry.response.status` string reports success — FHIR echoes the
 * HTTP status verbatim (`"200 OK"`, `"201 Created"`, `"404 Not Found"`), so we
 * read the leading three digits.
 */
const statusOk = (status: string): boolean => {
  const code = Number.parseInt(status, 10)
  return Number.isFinite(code) && code >= 200 && code < 300
}

/**
 * Submit a decoded batch as one FHIR `POST /` bundle, reporting every
 * submitted resource's outcome — success or failure — as data.
 *
 * @param resources - The batch to write; null-id resources are skipped
 * @returns One {@link BatchEntryOutcome} per submitted resource, in submit
 *   order: its echoed status, whether that status succeeded, and any server
 *   diagnostics. If the whole round trip failed, every resource is reported
 *   with {@link NO_RESPONSE_STATUS} and the underlying cause as an issue —
 *   never failing, so one bad batch cannot fail the caller's run
 */
const persistBatchBundle = (
  resources: ReadonlyArray<FhirResource>
): Effect.Effect<ReadonlyArray<BatchEntryOutcome>, never, FhirR4ResourcesHttpApiClient> =>
  Effect.gen(function* () {
    const writable = resources.filter((resource) => resource.id !== null)
    if (writable.length === 0) return []

    const client = yield* FhirR4ResourcesHttpApiClient
    // The endpoint carries `entry.resource: Schema.Any` (see http-api-definition/
    // bundle.ts for why the entry-body type is deliberately loose), so nothing
    // encodes an entry's resource on the way out: each is encoded here, into
    // its wire form. A decoded resource keeps every unset choice slot as
    // `null` (`effectiveDateTime: null` beside an `effectivePeriod`), which is
    // not FHIR JSON — and HFS reads such an `Observation.effective` as the null,
    // indexing no `date` for it.
    const payloadOf = (encoded: ReadonlyArray<unknown>): Bundle.BundleValue<unknown> => ({
      resourceType: 'Bundle' as const,
      type: 'batch' as const,
      id: null,
      implicitRules: null,
      language: null,
      meta: null,
      identifier: null,
      link: [],
      signature: null,
      timestamp: null,
      total: null,
      entry: Arr.zip(writable, encoded).map(([resource, wire]) => ({
        id: null,
        extension: [],
        modifierExtension: [],
        fullUrl: null,
        link: [],
        request: {
          id: null,
          extension: [],
          modifierExtension: [],
          method: 'PUT' as const,
          url: entryUrl(resource),
          ifNoneMatch: null,
          ifModifiedSince: null,
          ifMatch: null,
          ifNoneExist: null,
        },
        resource: wire,
        response: null,
        search: null,
      })),
    })

    const result = yield* Effect.forEach(writable, (resource) =>
      Schema.encode(FhirResourceSchema)(resource)
    ).pipe(
      Effect.flatMap((encoded) => client.Bundle.Submit({ payload: payloadOf(encoded) })),
      // Every entry inherits the whole-bundle failure so a submission-level
      // failure cannot silently drop the batch. `matchEffect` catches on the
      // unknown error channel — a resource that does not encode counts, as
      // does a decode error on the response bundle, a 5xx and a transport
      // failure.
      Effect.matchEffect({
        onSuccess: (response) => Effect.succeed({ _tag: 'ok' as const, response }),
        onFailure: (cause: unknown) => Effect.succeed({ _tag: 'failed' as const, cause }),
      })
    )

    if (result._tag === 'failed') {
      // The whole submission failed: attribute the one cause to every entry as
      // an error issue, under the no-response sentinel status.
      const issue: WriteIssue = {
        severity: 'error',
        code: 'exception',
        text: unknownErrorToString(result.cause),
      }
      return writable.map((resource): BatchEntryOutcome => ({
        target: describeResource(resource),
        status: NO_RESPONSE_STATUS,
        ok: false,
        issues: [issue],
      }))
    }

    // Zip each submitted entry with its response entry by position — FHIR §
    // 3.2.5.2 says a batch-response bundle contains one entry per request
    // entry, in the same order.
    const entries = result.response.entry ?? []
    const outcomes: BatchEntryOutcome[] = Arr.zip(writable, entries).map(
      ([resource, entry]): BatchEntryOutcome => {
        const status = entry.response?.status
        if (status === undefined) {
          return {
            target: describeResource(resource),
            status: NO_RESPONSE_STATUS,
            ok: false,
            issues: [],
          }
        }
        return {
          target: describeResource(resource),
          status,
          ok: statusOk(status),
          issues: issuesOf(entry.response),
        }
      }
    )
    // Backfill any resources the zip dropped (a truncated server response).
    for (let i = outcomes.length; i < writable.length; i++) {
      outcomes.push({
        target: describeResource(writable[i]),
        status: NO_RESPONSE_STATUS,
        ok: false,
        issues: [],
      })
    }
    return outcomes
  }).pipe(
    Effect.withSpan(Telemetry.Persist.Bundle.Span.Name, {
      attributes: {
        [Telemetry.Persist.Attributes.ResourceCount]: resources.length,
      },
    })
  )

/**
 * Some entries of a batch were not accepted: each one the server answered with
 * a non-2xx status, or with no status at all ({@link NO_RESPONSE_STATUS}, which
 * every entry gets when the whole round trip failed).
 */
class BatchEntriesRejected extends Data.TaggedError('BatchEntriesRejected')<{
  /** A one-line summary naming each rejected entry's target and status. */
  readonly message: string
  /** Each rejected entry's outcome, in submit order. */
  readonly rejected: Arr.NonEmptyReadonlyArray<BatchEntryOutcome>
  /** How many entries the batch submitted, accepted or not. */
  readonly submittedCount: number
}> {}

/** One rejected outcome as `Type/id (status)`, for {@link BatchEntriesRejected}'s message. */
const describeRejected = (outcome: BatchEntryOutcome): string =>
  `${outcome.target.label}/${outcome.target.id} (${outcome.status})`

/**
 * Submit a decoded batch as one FHIR `POST /` bundle, failing unless every
 * entry was accepted.
 *
 * @param resources - The batch to write, each under the id it is PUT to;
 *   null-id resources are skipped, as {@link persistBatchBundle} skips them
 * @returns An effect that succeeds with every entry's outcome when each one is
 *   a 2xx, and fails with {@link BatchEntriesRejected} otherwise
 *
 * @remarks
 * For a caller whose write is all-or-retry rather than a results view: it
 * mints its resources' ids once and submits them again on failure, so a
 * retried PUT overwrites what already landed instead of duplicating it. Batch
 * entries land independently, so a rejection does not undo the accepted
 * entries — the retry rewrites them unchanged.
 */
const persistBatchBundleOrFail = (
  resources: ReadonlyArray<FhirResource>
): Effect.Effect<
  ReadonlyArray<BatchEntryOutcome>,
  BatchEntriesRejected,
  FhirR4ResourcesHttpApiClient
> =>
  Effect.flatMap(persistBatchBundle(resources), (outcomes) =>
    Arr.match(
      outcomes.filter((outcome) => !outcome.ok),
      {
        onEmpty: () => Effect.succeed(outcomes),
        onNonEmpty: (rejected) =>
          Effect.fail(
            new BatchEntriesRejected({
              message: `${rejected.length} of ${outcomes.length} batch entries were rejected: ${rejected
                .map(describeRejected)
                .join(', ')}`,
              rejected,
              submittedCount: outcomes.length,
            })
          ),
      }
    )
  )

/**
 * One response status across a set of batch outcomes, with the outcomes that
 * resolved to it.
 */
interface StatusGroup<TOutcome extends BatchEntryOutcome> {
  /** The echoed status (`"201 Created"`, `"422 Unprocessable Entity"`, {@link NO_RESPONSE_STATUS}). */
  readonly status: string
  /** Whether this status is a success (a 2xx). */
  readonly ok: boolean
  /** The outcomes that resolved to this status, in encounter order. */
  readonly outcomes: readonly TOutcome[]
}

/** The leading numeric HTTP code of a status string, or `NaN` when it has none. */
const statusCode = (status: string): number => Number.parseInt(status, 10)

/**
 * Group batch outcomes by their response status, for a results view: failures
 * first, then by ascending HTTP code, a status with no numeric code (the
 * {@link NO_RESPONSE_STATUS} sentinel) last within its success or failure
 * band.
 *
 * @param outcomes - Every outcome to group, from one bundle or several
 * @returns One {@link StatusGroup} per distinct status, sorted for display
 */
const groupByStatus = <TOutcome extends BatchEntryOutcome>(
  outcomes: readonly TOutcome[]
): readonly StatusGroup<TOutcome>[] => {
  const groups = new Map<string, TOutcome[]>()
  for (const outcome of outcomes) {
    const bucket = groups.get(outcome.status)
    if (bucket === undefined) groups.set(outcome.status, [outcome])
    else bucket.push(outcome)
  }
  return [...groups.entries()]
    .map(([status, grouped]): StatusGroup<TOutcome> => ({
      status,
      ok: grouped[0]?.ok ?? true,
      outcomes: grouped,
    }))
    .toSorted((a, b) => {
      if (a.ok !== b.ok) return a.ok ? 1 : -1
      const codeA = statusCode(a.status)
      const codeB = statusCode(b.status)
      if (Number.isNaN(codeA)) return Number.isNaN(codeB) ? 0 : 1
      if (Number.isNaN(codeB)) return -1
      return codeA - codeB
    })
}

export {
  BatchEntriesRejected,
  type BatchEntryOutcome,
  entryUrl,
  groupByStatus,
  NO_RESPONSE_STATUS,
  persistBatchBundle,
  persistBatchBundleOrFail,
  statusOk,
  type StatusGroup,
  type WriteIssue,
}
