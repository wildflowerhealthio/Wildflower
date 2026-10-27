import { unknownErrorToString } from '@wildflowerhealthio/kitchen-sink'
import { Array as Arr, Data, Effect, Schema } from 'effect'

import type * as Bundle from '../data-types/resources/bundle.ts'
import { type FhirResource, FhirResourceSchema } from '../resources/index.ts'
import * as Telemetry from '../telemetry/index.ts'
import { FhirR4ResourcesHttpApiClient } from './fhir-r4-resources-http-api-client.ts'
import { describeResource, type ResourceWriteTarget } from './persist-resources.ts'

/**
 * Writing a whole decoded batch back to the FHIR store as one `POST /`
 * Bundle — one HTTP round trip carrying N PUT entries — with per-entry
 * failures returned as data: as a `batch` ({@link persistBatchBundle}), whose
 * entries land independently, or as a `transaction`
 * ({@link persistTransactionBundle}), whose entries land together or not at
 * all.
 *
 * @remarks
 * The bundle counterpart of {@link persistResources}, which fans one PUT out
 * per resource. Where `persistResources` owns retries + concurrency + a
 * per-resource span, this owns the batch as one wire round trip (the
 * importer's confirmed one-shot). Both report
 * `{@link ResourceWriteFailure}[]` on a `never` error channel — one bad entry
 * cannot fail the whole caller's run.
 *
 * A batch Bundle is FHIR R4 § 3.2.5 batch semantics: **entries are
 * independent**, so a per-entry non-2xx is that entry's failure only; the rest
 * of the bundle still applies. A transaction Bundle is § 3.2.6 transaction
 * semantics: the server applies **every entry or none**, answering a
 * `transaction-response` of 2xx entries, or refusing the whole Bundle with an
 * OperationOutcome, which the whole-submission failure below reports against
 * every entry. The Wildflower server (HFS on SQLite) runs a transaction
 * atomically; `fhir-r4-rust`'s `batch_bundle_at_base` tests pin it.
 *
 * Each resource is encoded through {@link FhirResourceSchema} before it goes
 * in the bundle, since the endpoint's loose entry type encodes nothing.
 *
 * If the whole `POST /` fails (a resource that does not encode, a transport
 * error, a non-2xx on the bundle itself, or a decode error on the response
 * bundle), every entry in the
 * submitted set is reported as failed against that one cause — one bad server
 * response cannot silently drop the batch. The bundle carries one entry per
 * `Type/id`, and a resource with no id is never submitted (a PUT needs an id,
 * mirroring {@link upsertResource}); the outcomes come back one per resource
 * handed in, at its position, whatever was submitted for it.
 *
 * Unlike {@link persistResources}, this reports the **whole** per-entry
 * outcome — every resource's echoed HTTP status and any
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
 * One resource's outcome in a batch bundle: the resource it targeted, the
 * echoed HTTP status, whether that status is a success, and any diagnostics
 * the server attached.
 *
 * @remarks
 * `status` is the server's echoed `"NNN Text"` verbatim when there was a
 * response entry, the sentinel {@link NO_RESPONSE_STATUS} when the whole
 * bundle failed or the response was truncated, and the sentinel
 * {@link NOT_SUBMITTED_STATUS} for a resource with no id — so a caller can
 * always group by `status` without a special case.
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

/** The two `Bundle.type`s a submission of PUT entries is sent as. */
type BundleWriteType = 'batch' | 'transaction'

/**
 * The `status` a resource gets when it was never submitted: it has no id, and
 * a PUT needs one.
 */
const NOT_SUBMITTED_STATUS = 'Not submitted'

/** The outcome of a resource with no id: never submitted, so never written. */
const notSubmitted = (resource: FhirResource): BatchEntryOutcome => ({
  target: describeResource(resource),
  status: NOT_SUBMITTED_STATUS,
  ok: false,
  issues: [
    { severity: 'error', code: 'required', text: 'The resource has no id to be written under.' },
  ],
})

/**
 * The outcome of a submitted `resource` from its entry's `response`: the
 * echoed status and its issues, or {@link NO_RESPONSE_STATUS} when the
 * response bundle holds no entry or no status for it (a truncated response).
 */
const answeredOutcome = (
  resource: FhirResource,
  response: Bundle.EntryResponseType | null | undefined
): BatchEntryOutcome =>
  response === null || response === undefined
    ? { target: describeResource(resource), status: NO_RESPONSE_STATUS, ok: false, issues: [] }
    : {
        target: describeResource(resource),
        status: response.status,
        ok: statusOk(response.status),
        issues: issuesOf(response),
      }

/**
 * The resources a bundle submits for `resources`: one per `Type/id`, the last
 * occurrence's, in the order each `Type/id` first appears, and none without an
 * id.
 */
const submittedOnce = (resources: ReadonlyArray<FhirResource>): readonly FhirResource[] => [
  ...new Map(
    resources
      .filter((resource) => resource.id !== null)
      .map((resource) => [entryUrl(resource), resource] as const)
  ).values(),
]

/**
 * Submit a decoded batch as one FHIR `POST /` Bundle of `bundleType`,
 * reporting every resource's outcome — success or failure — as data: what
 * {@link persistBatchBundle} and {@link persistTransactionBundle} are.
 *
 * @param bundleType - `batch` or `transaction`
 * @param resources - The batch to write
 * @returns One {@link BatchEntryOutcome} per resource of `resources`, at its
 *   position: its echoed status, whether that status succeeded, and any server
 *   diagnostics. If the whole round trip failed (a refused transaction among
 *   the ways), every submitted resource is reported with
 *   {@link NO_RESPONSE_STATUS} and the underlying cause as an issue — never
 *   failing, so one bad batch cannot fail the caller's run
 *
 * @remarks
 * The bundle carries **one entry per `Type/id`**: when `resources` names one
 * twice (two overlapping exports of the same record), the last occurrence is
 * submitted, as a server applying both PUTs in turn would leave it, and each
 * position gets that entry's outcome. A transaction must, since FHIR R4
 * § 3.2.6 refuses one whose entries overlap. A resource with no id cannot be
 * PUT, so it is never submitted, and its position reports
 * {@link NOT_SUBMITTED_STATUS}, not ok, with the reason as its issue. The
 * outcomes are aligned with the input, so a caller handing in several
 * groups' resources splits them back by each group's length.
 */
const persistBundle = (
  bundleType: BundleWriteType,
  resources: ReadonlyArray<FhirResource>
): Effect.Effect<ReadonlyArray<BatchEntryOutcome>, never, FhirR4ResourcesHttpApiClient> =>
  Effect.gen(function* () {
    const submitted = submittedOnce(resources)
    if (submitted.length === 0) return resources.map(notSubmitted)

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
      type: bundleType,
      id: null,
      implicitRules: null,
      language: null,
      meta: null,
      identifier: null,
      link: [],
      signature: null,
      timestamp: null,
      total: null,
      entry: Arr.zip(submitted, encoded).map(([resource, wire]) => ({
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

    const result = yield* Effect.forEach(submitted, (resource) =>
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
      return resources.map((resource): BatchEntryOutcome =>
        resource.id === null
          ? notSubmitted(resource)
          : {
              target: describeResource(resource),
              status: NO_RESPONSE_STATUS,
              ok: false,
              issues: [issue],
            }
      )
    }

    // Pair each submitted entry with its response entry by position — FHIR §
    // 3.2.5.2 says a batch-response bundle contains one entry per request
    // entry, in the same order — then hand each input position the response
    // for its `Type/id`.
    const responseByUrl = new Map(
      Arr.zip(submitted, result.response.entry ?? []).map(
        ([resource, entry]) => [entryUrl(resource), entry.response] as const
      )
    )
    return resources.map((resource) =>
      resource.id === null
        ? notSubmitted(resource)
        : answeredOutcome(resource, responseByUrl.get(entryUrl(resource)))
    )
  }).pipe(
    Effect.withSpan(Telemetry.Persist.Bundle.Span.Name, {
      attributes: {
        [Telemetry.Persist.Attributes.ResourceCount]: resources.length,
        [Telemetry.Persist.Attributes.BundleType]: bundleType,
      },
    })
  )

/**
 * Submit a decoded batch as one FHIR `POST /` `batch` Bundle: every entry
 * lands on its own, and each reports its own outcome.
 *
 * @param resources - The batch to write
 * @returns Every resource's outcome, at its position, as {@link persistBundle}
 *   gives it
 */
const persistBatchBundle = (
  resources: ReadonlyArray<FhirResource>
): Effect.Effect<ReadonlyArray<BatchEntryOutcome>, never, FhirR4ResourcesHttpApiClient> =>
  persistBundle('batch', resources)

/**
 * Submit a decoded batch as one FHIR `POST /` `transaction` Bundle: every
 * entry lands or none does, so resources that reference each other are
 * written as one unit.
 *
 * @param resources - The batch to write
 * @returns Every resource's outcome, at its position, as {@link persistBundle} gives
 *   it: all 2xx when the transaction landed, every one failed with the
 *   server's refusal when it did not
 */
const persistTransactionBundle = (
  resources: ReadonlyArray<FhirResource>
): Effect.Effect<ReadonlyArray<BatchEntryOutcome>, never, FhirR4ResourcesHttpApiClient> =>
  persistBundle('transaction', resources)

/**
 * Some entries of a batch were not accepted: each one the server answered with
 * a non-2xx status, or with no status at all ({@link NO_RESPONSE_STATUS}, which
 * every entry gets when the whole round trip failed), and each resource with
 * no id ({@link NOT_SUBMITTED_STATUS}).
 */
class BatchEntriesRejected extends Data.TaggedError('BatchEntriesRejected')<{
  /** A one-line summary naming each rejected entry's target and status. */
  readonly message: string
  /** Each rejected resource's outcome, in the order handed in. */
  readonly rejected: Arr.NonEmptyReadonlyArray<BatchEntryOutcome>
  /** How many resources the batch was handed, accepted or not. */
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
 *   a resource with no id is rejected as {@link NOT_SUBMITTED_STATUS}
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
  NOT_SUBMITTED_STATUS,
  persistBatchBundle,
  persistBatchBundleOrFail,
  persistTransactionBundle,
  statusOk,
  type StatusGroup,
  type WriteIssue,
}
