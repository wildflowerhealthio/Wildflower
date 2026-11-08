import { FhirReadFailed, FhirRecords } from '@wildflowerhealthio/assistant-core-js'
import {
  type FhirRequestError,
  type RunSmart,
  SmartClient,
} from '@wildflowerhealthio/fhir-r4-react/smart'
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
 * The FHIR server at `fhirBase` as the chat's tools read it: each read a
 * `SmartClient` request run with `runSmart`, the runtime the page's SMART
 * handshake built, so it carries the connection's token.
 *
 * @remarks
 * Interrupting a read aborts its request. A request failure comes back as a
 * {@link FhirReadFailed}; a defect in the runtime stays one.
 */
const fhirRecordsLayerFor = (fhirBase: string, runSmart: RunSmart): Layer.Layer<FhirRecords> =>
  Layer.succeed(FhirRecords, {
    fhirBase,
    read: (path) =>
      Effect.promise((signal) =>
        runSmart(Effect.either(Effect.flatMap(SmartClient, (client) => client.request(path))), {
          signal,
        })
      ).pipe(
        Effect.flatMap(
          Either.match({
            onLeft: (failure) => Effect.fail(fhirReadFailedOf(failure)),
            onRight: Effect.succeed,
          })
        )
      ),
  })

export { fhirRecordsLayerFor }
