import { FhirReadFailed, FhirRecords, FhirWriteFailed } from '@wildflowerhealthio/assistant-core-js'
import {
  type FhirRequestError,
  type RunSmart,
  SmartClient,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import type { ResourceWrite } from '@wildflowerhealthio/fhir-r4/clients'
import { Effect, Either, Layer, Match } from 'effect'

/** Why `failure`, a `SmartClient` request's, failed, as the tools read it. */
const fhirReadFailedOf = (failure: FhirRequestError): FhirReadFailed =>
  new FhirReadFailed({
    failure: Match.value(failure).pipe(
      Match.tag('FhirHttpError', ({ status, outcomeText }) => ({
        kind: 'error-status' as const,
        status,
        outcomeText,
      })),
      Match.tag('FhirRequestDropped', () => ({ kind: 'unreachable' as const })),
      Match.tag('FhirResponseNotJson', () => ({ kind: 'not-json' as const })),
      Match.exhaustive
    ),
  })

/**
 * `use` of the page's `SmartClient`, run with `runSmart`, its failure handed
 * back as a value of `failedOf`. Interrupting it aborts the request.
 */
const throughSmartClient = <A, E, F>(
  runSmart: RunSmart,
  use: (client: typeof SmartClient.Service) => Effect.Effect<A, E>,
  failedOf: (failure: E) => F
): Effect.Effect<A, F> =>
  Effect.promise((signal) =>
    runSmart(Effect.either(Effect.flatMap(SmartClient, use)), { signal })
  ).pipe(
    Effect.flatMap(
      Either.match({
        onLeft: (failure) => Effect.fail(failedOf(failure)),
        onRight: Effect.succeed,
      })
    )
  )

/** Why a `SmartClient` write failed, as the tools read it: `fhir-r4`'s own reason. */
const fhirWriteFailedOf = ({ failure }: ResourceWrite.Failed): FhirWriteFailed =>
  new FhirWriteFailed({ failure })

/**
 * The FHIR server at `fhirBaseUrl` as the chat's tools read and write it:
 * each read a `SmartClient` request and each write its `create` or `update`,
 * run with `runSmart`, the runtime the page's SMART handshake built, so each
 * carries the connection's token.
 *
 * @remarks
 * Interrupting a read or a write aborts its request. A request failure comes
 * back as a {@link FhirReadFailed} or {@link FhirWriteFailed}; a defect in
 * the runtime stays one.
 */
const fhirRecordsLayerFor = (fhirBaseUrl: string, runSmart: RunSmart): Layer.Layer<FhirRecords> =>
  Layer.succeed(FhirRecords, {
    fhirBaseUrl,
    read: (path) =>
      throughSmartClient(runSmart, (client) => client.request(path), fhirReadFailedOf),
    create: (args) =>
      throughSmartClient(runSmart, (client) => client.create(args), fhirWriteFailedOf),
    update: (args) =>
      throughSmartClient(runSmart, (client) => client.update(args), fhirWriteFailedOf),
  })

export { fhirRecordsLayerFor }
