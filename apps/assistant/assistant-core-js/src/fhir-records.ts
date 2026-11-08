import type { ResourceWrite } from '@wildflowerhealthio/fhir-r4/clients'
import { Context, Data, type Effect, type Option } from 'effect'

/** Why a read of the FHIR server failed. */
type FhirReadFailure =
  /** The server answered with an error status, and what its `OperationOutcome` said, if it sent one. */
  | {
      readonly kind: 'error-status'
      readonly status: number
      readonly outcomeText: Option.Option<string>
    }
  /** No answer arrived: the request was blocked, the connection dropped, or the server is down. */
  | { readonly kind: 'unreachable' }
  /** The server answered with a success status and a body that is not JSON. */
  | { readonly kind: 'not-json' }

/**
 * A read of the FHIR server that failed, and why, for the agent's tool
 * result. It is a value, never thrown, logged or reported: an
 * `OperationOutcome`'s text can quote the record.
 */
class FhirReadFailed extends Data.TaggedClass('FhirReadFailed')<{
  readonly failure: FhirReadFailure
}> {}

/**
 * A write to the FHIR server that failed, and why (`fhir-r4`'s
 * `ResourceWrite.Failure`: a stale version, an error status, no answer, or
 * an answer that couldn't be read), for the agent's tool result. A value,
 * never thrown, logged or reported, as {@link FhirReadFailed} is.
 */
class FhirWriteFailed extends Data.TaggedClass('FhirWriteFailed')<{
  readonly failure: ResourceWrite.Failure
}> {}

/**
 * The FHIR server the chat reads and writes, as the app reaches it: its base
 * URL, one GET of a path under it read as JSON, and `fhir-r4`'s
 * `ResourceWrite` create and version-checked update. The app provides it over its
 * SMART connection (`assistant-react`'s `fhirRecordsLayerFor`); a test
 * provides a stand-in with `Layer.succeed`.
 *
 * @remarks
 * Every path the tools read is relative to `fhirBaseUrl`, with no leading slash
 * (`Observation?patient=p1&_count=20`, `Patient/p1`, `metadata`); a search's
 * `next` link is turned back into one only when it points under `fhirBaseUrl`.
 */
class FhirRecords extends Context.Tag('assistant-core-js/FhirRecords')<
  FhirRecords,
  {
    /** The FHIR server's base URL, no trailing slash. */
    readonly fhirBaseUrl: string
    /** GET `path` under {@link fhirBaseUrl} and read the answer as JSON. */
    readonly read: (path: string) => Effect.Effect<unknown, FhirReadFailed>
    /** POST `resource` to its type, the server choosing its id; succeed with the stored record. */
    readonly create: (args: {
      readonly resource: ResourceWrite.ResourceJson
    }) => Effect.Effect<ResourceWrite.Written, FhirWriteFailed>
    /**
     * PUT `resource` to its type and id with `If-Match: W/"<versionId>"`;
     * succeed with the stored record.
     */
    readonly update: (args: {
      readonly resource: ResourceWrite.ResourceJson & { readonly id: string }
      readonly versionId: string
    }) => Effect.Effect<ResourceWrite.Written, FhirWriteFailed>
  }
>() {}

export { FhirReadFailed, FhirRecords, FhirWriteFailed }
export type { FhirReadFailure }
