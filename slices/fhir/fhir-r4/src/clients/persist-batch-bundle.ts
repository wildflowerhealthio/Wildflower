import type { HttpClientError } from '@effect/platform'
import { unknownErrorToString } from '@wildflowerhealthio/kitchen-sink'
import { Array as Arr, Data, Effect, Option, Schema } from 'effect'

import * as Bundle from '../data-types/resources/bundle.ts'
import { FhirResourceSchema, type FhirResourceWithId } from '../resources/index.ts'
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
 * error status and an OperationOutcome. The Wildflower server (HFS on SQLite)
 * runs a transaction atomically; `fhir-r4-rust`'s `batch_bundle_at_base`
 * tests pin it.
 *
 * Each resource is encoded through {@link FhirResourceSchema} before it goes
 * in the bundle, since the endpoint's loose entry type encodes nothing.
 *
 * Every entry is reported with what the server said. A response bundle gives
 * each entry its own echoed status and issues. An error answer to the whole
 * `POST /` (a refused transaction, a proxy's `502`, an auth layer's `401`)
 * gives every entry that answer's status, as `"NNN Text"`, and its body's
 * issues: an OperationOutcome's, or one issue carrying the body as text.
 * When the server said nothing readable, every entry is failed under
 * {@link NO_RESPONSE_STATUS}: a resource that does not encode, a request that
 * never reached the server, a `2xx` whose body is not a response bundle. One
 * bad server response cannot silently drop the batch.
 *
 * Every resource handed in has an id (`FhirResourceWithId`), which its entry
 * is PUT to; the bundle carries one entry per `Type/id`, and the outcomes come
 * back one per resource handed in, at its position.
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
 * response entry, and the HTTP status of the server's answer, as `"NNN Text"`,
 * when it answered the whole bundle with an error. It is the sentinel
 * {@link NO_RESPONSE_STATUS} when the server said nothing readable: the round
 * trip got no answer, a `2xx` answer could not be read, or the response
 * bundle holds no entry for the resource. A caller can always group by `status`
 * without a special case.
 */
interface BatchEntryOutcome {
  readonly target: ResourceWriteTarget
  readonly status: string
  readonly ok: boolean
  readonly issues: readonly WriteIssue[]
}

/**
 * The `status` a resource gets when the server said nothing readable for it:
 * the request never got an answer, a resource failed to encode before leaving
 * the client, or a `2xx` answer's body could not be read as a response bundle
 * (or held no entry for the resource).
 */
const NO_RESPONSE_STATUS = 'No response'

/**
 * The standard reason phrase of each HTTP status a FHIR server, or a proxy or
 * auth layer in front of one, can plausibly answer a `POST /` with.
 */
const REASON_PHRASES: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  412: 'Precondition Failed',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
}

/**
 * HTTP status `code` as `"NNN Text"`, the form an entry's `response.status`
 * takes, or the bare number when it has no phrase in {@link REASON_PHRASES}.
 */
const statusLine = (code: number): string => {
  const phrase = REASON_PHRASES[code]
  return phrase === undefined ? `${code}` : `${code} ${phrase}`
}

/** The issues an OperationOutcome carries, as {@link WriteIssue}s. */
const issuesOf = (outcome: Bundle.OperationOutcomeType | null | undefined): readonly WriteIssue[] =>
  (outcome?.issue ?? []).map((issue) => ({
    severity: issue.severity,
    code: issue.code,
    text: issue.details?.text ?? issue.diagnostics ?? '',
  }))

/**
 * Build the `entry.request.url` for a resource — `Type/id`, matching the
 * per-resource `Update` endpoint. Kept alongside the sink because that is
 * where the client-side "which type goes to which url" already lives.
 */
const entryUrl = (resource: FhirResourceWithId): string => `${resource.resourceType}/${resource.id}`

/**
 * Whether an `entry.response.status` string reports success — FHIR echoes the
 * HTTP status verbatim (`"200 OK"`, `"201 Created"`, `"404 Not Found"`), so we
 * read the leading three digits.
 */
const statusOk = (status: string): boolean => successCode(Number.parseInt(status, 10))

/** Whether HTTP status `code` is a success, a `2xx`. */
const successCode = (code: number): boolean => code >= 200 && code < 300

/** The two `Bundle.type`s a submission of PUT entries is sent as. */
type BundleWriteType = 'batch' | 'transaction'

/** A whole-bundle failure every submitted resource is reported under. */
interface BundleFailure {
  readonly _tag: 'failed'
  readonly status: string
  readonly issues: readonly WriteIssue[]
}

/** A response body read as an OperationOutcome, when it is one. */
const decodeOperationOutcome = Schema.decodeUnknownOption(
  Schema.parseJson(Bundle.OperationOutcomeSchema)
)

/**
 * The server's error answer at HTTP status `code` with `body`: its status,
 * and the body's OperationOutcome's issues when it is one, else one issue
 * whose text is the body (empty when there was none, or it could not be
 * read).
 */
const answeredWithError = (code: number, body: string): BundleFailure => ({
  _tag: 'failed',
  status: statusLine(code),
  issues: decodeOperationOutcome(body).pipe(
    Option.map(issuesOf),
    Option.getOrElse((): readonly WriteIssue[] => [
      { severity: 'error', code: 'exception', text: body },
    ])
  ),
})

/** A round trip with no status to report, failed under {@link NO_RESPONSE_STATUS} with `cause`. */
const unanswered = (cause: unknown): BundleFailure => ({
  _tag: 'failed',
  status: NO_RESPONSE_STATUS,
  issues: [{ severity: 'error', code: 'exception', text: unknownErrorToString(cause) }],
})

/**
 * The failure a {@link HttpClientError.ResponseError} reports: an error
 * answer to the whole bundle, a refusal included, under its status and its
 * body.
 */
const responseErrorFailure = (
  error: HttpClientError.ResponseError
): Effect.Effect<BundleFailure> =>
  // A `2xx` here is an answer the client could not decode: the server took
  // the bundle, but which entries it wrote is unknown. Its own status would
  // read as a success to `statusOk` and mark every entry written, so it is
  // the sentinel instead.
  successCode(error.response.status)
    ? Effect.succeed(unanswered(error))
    : error.response.text.pipe(
        Effect.orElseSucceed(() => ''),
        Effect.map((body) => answeredWithError(error.response.status, body))
      )

/**
 * The outcome of a submitted `resource` from its entry's `response`: the
 * echoed status and its issues, or {@link NO_RESPONSE_STATUS} when the
 * response bundle holds no entry or no status for it (a truncated response).
 */
const answeredOutcome = (
  resource: FhirResourceWithId,
  response: Bundle.EntryResponseType | null | undefined
): BatchEntryOutcome =>
  response === null || response === undefined
    ? { target: describeResource(resource), status: NO_RESPONSE_STATUS, ok: false, issues: [] }
    : {
        target: describeResource(resource),
        status: response.status,
        ok: statusOk(response.status),
        issues: issuesOf(response.outcome),
      }

/**
 * The resources a bundle submits for `resources`: one per `Type/id`, the last
 * occurrence's, in the order each `Type/id` first appears.
 */
const submittedOnce = (
  resources: ReadonlyArray<FhirResourceWithId>
): readonly FhirResourceWithId[] => [
  ...new Map(resources.map((resource) => [entryUrl(resource), resource] as const)).values(),
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
 *   diagnostics. An error answer to the whole bundle gives every submitted
 *   resource that answer's status and its body's issues; a round trip with
 *   nothing readable gives it {@link NO_RESPONSE_STATUS} and the underlying
 *   cause as an issue — never failing, so one bad batch cannot fail the
 *   caller's run
 *
 * @remarks
 * The bundle carries **one entry per `Type/id`**: when `resources` names one
 * twice (two overlapping exports of the same record), the last occurrence is
 * submitted, as a server applying both PUTs in turn would leave it, and each
 * position gets that entry's outcome. A transaction must, since FHIR R4
 * § 3.2.6 refuses one whose entries overlap. The outcomes are aligned with
 * the input, so a caller handing in several groups' resources splits them back
 * by each group's length.
 */
const persistBundle = (
  bundleType: BundleWriteType,
  resources: ReadonlyArray<FhirResourceWithId>
): Effect.Effect<ReadonlyArray<BatchEntryOutcome>, never, FhirR4ResourcesHttpApiClient> =>
  Effect.gen(function* () {
    const submitted = submittedOnce(resources)
    if (submitted.length === 0) return []

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
      Effect.map((response) => ({ _tag: 'answered' as const, response })),
      // The client reads a declared 400 as its typed error with the body, and
      // a declared 403 or 503 without one.
      Effect.catchTags({
        BundleBadRequest: (badRequest) => Effect.succeed(answeredWithError(400, badRequest.body)),
        Forbidden: () => Effect.succeed(answeredWithError(403, '')),
        ServiceUnavailable: () => Effect.succeed(answeredWithError(503, '')),
      }),
      // Every other non-2xx: the server's own answer for the bundle, whose
      // status and issues are every entry's.
      Effect.catchTag('ResponseError', responseErrorFailure),
      // Every entry inherits any other whole-bundle failure, so it cannot
      // silently drop the batch: a resource that does not encode, a request
      // that got no answer, and an answer whose body did not decode, each
      // under the no-response sentinel.
      Effect.catchAll((cause: unknown) => Effect.succeed(unanswered(cause)))
    )

    if (result._tag === 'failed') {
      return resources.map((resource): BatchEntryOutcome => ({
        target: describeResource(resource),
        status: result.status,
        ok: false,
        issues: result.issues,
      }))
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
      answeredOutcome(resource, responseByUrl.get(entryUrl(resource)))
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
  resources: ReadonlyArray<FhirResourceWithId>
): Effect.Effect<ReadonlyArray<BatchEntryOutcome>, never, FhirR4ResourcesHttpApiClient> =>
  persistBundle('batch', resources)

/**
 * Submit a decoded batch as one FHIR `POST /` `transaction` Bundle: every
 * entry lands or none does, so resources that reference each other are
 * written as one unit.
 *
 * @param resources - The batch to write
 * @returns Every resource's outcome, at its position, as {@link persistBundle}
 *   gives it: all 2xx when the transaction landed, every one failed under the
 *   server's refusal, its status and its issues, when it did not
 */
const persistTransactionBundle = (
  resources: ReadonlyArray<FhirResourceWithId>
): Effect.Effect<ReadonlyArray<BatchEntryOutcome>, never, FhirR4ResourcesHttpApiClient> =>
  persistBundle('transaction', resources)

/**
 * Some entries of a batch were not accepted: each one the server answered with
 * a non-2xx status (the status of its answer to the whole bundle, for every
 * entry, when it refused it), or with nothing readable
 * ({@link NO_RESPONSE_STATUS}, which every entry gets when the round trip
 * got no readable answer).
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
 * @param resources - The batch to write, each under the id it is PUT to
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
  resources: ReadonlyArray<FhirResourceWithId>
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
  persistTransactionBundle,
  statusOk,
  type StatusGroup,
  type WriteIssue,
}
