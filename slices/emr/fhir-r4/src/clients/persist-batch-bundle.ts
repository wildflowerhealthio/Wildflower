import { Array as Arr, Effect } from 'effect'

import type * as Bundle from '../data-types/resources/bundle.ts'
import type { FhirResource } from '../resources/index.ts'
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
 * If the whole `POST /` fails (a transport error, a non-2xx on the bundle
 * itself, or a decode error on the response bundle), every entry in the
 * submitted set is reported as failed against that one cause — one bad server
 * response cannot silently drop the batch. A null-id resource is skipped
 * defensively (a PUT needs an id, mirroring {@link upsertResource}).
 *
 * Unlike {@link persistResources}, this reports the **whole** per-entry
 * outcome — every submitted resource's echoed HTTP status and any
 * OperationOutcome diagnostics, success or failure — not just the failures, so
 * a caller (the importer's results view) can show what wrote alongside what
 * did not, grouped by response code, with the server's own messages.
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

/** A cause rendered for a diagnostic message — an `Error`'s message, else its string form. */
const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

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
    // bundle.ts for why the entry-body type is deliberately loose). The
    // resources spread into `resource` at runtime are the typed `FhirResource`s
    // the caller handed in; they encode through their own schemas at wire time.
    const payload: Bundle.BundleValue<unknown> = {
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
      entry: writable.map((resource) => ({
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
        resource,
        response: null,
        search: null,
      })),
    }

    const result = yield* client.Bundle.Submit({ payload }).pipe(
      // Every entry inherits the whole-bundle failure so a submission-level
      // failure cannot silently drop the batch. `matchEffect` catches on the
      // unknown error channel — a decode error on the response bundle counts,
      // as does a 5xx and a transport failure.
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
        text: messageOf(result.cause),
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
    return Arr.zip(writable, result.response.entry ?? []).map(
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
  }).pipe(
    Effect.withSpan(Telemetry.Persist.Bundle.Span.Name, {
      attributes: {
        [Telemetry.Persist.Attributes.ResourceCount]: resources.length,
      },
    })
  )

export {
  type BatchEntryOutcome,
  entryUrl,
  NO_RESPONSE_STATUS,
  persistBatchBundle,
  statusOk,
  type WriteIssue,
}
