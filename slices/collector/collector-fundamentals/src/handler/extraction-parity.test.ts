import { Effect, Either, Encoding, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { Extraction } from 'importer-fundamentals'
import { echoEntity, makeExtractionInput, type Echo } from 'importer-fundamentals/test-helpers'
import { runHandlerSync } from './collector-bridge-message-handler.test-helpers.ts'
import * as SnifferResponseTracker from './sniffer-response-tracker.ts'

const AlphaEntity = echoEntity('AlphaEntity', 'alpha')
const BetaEntity = echoEntity('BetaEntity', 'beta')
const entityDefinitions = [AlphaEntity, BetaEntity]

/**
 * The canned exchange set both paths see: two entities, an unclaimed response,
 * a multi-byte body, and a body that is not valid UTF-8.
 *
 * This suite is THE live-vs-offline parity pin: `importer-fundamentals`'
 * `Extraction.run` and this package's `SnifferResponseTracker` must route and
 * decode a set of responses identically, and only this package can see both
 * halves (the dependency points from here to `importer-fundamentals`).
 */
const exchanges: readonly Extraction.Input[] = [
  makeExtractionInput({ id: 'r1', url: 'https://example.com/alpha/1', body: '{"a":1}' }),
  makeExtractionInput({ id: 'r2', url: 'https://example.com/beta/2', body: 'plain text — ü' }),
  makeExtractionInput({ id: 'r3', url: 'https://example.com/gamma/3', body: 'unclaimed' }),
  makeExtractionInput({
    id: 'r4',
    url: 'https://example.com/alpha/4',
    headers: [['content-type', 'application/octet-stream']],
    body: new Uint8Array([0xff, 0x00, 0xfe, 0x42]),
  }),
]

/**
 * Drive `SnifferResponseTracker` with the `ResponseStart` / `ResponseData` /
 * `ResponseFinished` sequence equivalent to {@link exchanges}, and collect the
 * resources it produced.
 *
 * @remarks
 * No `captureProvenance` is supplied — an offline run's provenance is its
 * source archive, so parity is against the tracker's *parse* output, which is
 * exactly what the hook is defined never to alter for `followUpSteps`.
 * Unclaimed responses are cancelled rather than tracked, which is the live
 * counterpart of the extraction runner's `unmatched` bucket.
 */
const resourcesViaTracker = (
  responses: readonly Extraction.Input[]
): readonly (readonly Echo[])[] => {
  const results: SnifferResponseTracker.SniffResult<Echo>[] = []
  const tracker = Effect.runSync(
    SnifferResponseTracker.make<Echo>({
      matchEntity: (url) =>
        Option.fromNullable(entityDefinitions.find((entity) => entity.isFoundAt(url))),
      sendMessage: () => Effect.void,
      handleNewSniffResult: (result) =>
        Effect.sync(() => {
          results.push(result)
        }),
      handleGeneratedSteps: () => Effect.void,
    })
  )

  for (const response of responses) {
    // The tracker's handlers declare `TransportAdapter` in R;
    // `runHandlerSync` discharges it with the stub layer.
    runHandlerSync(
      tracker.handleResponseStart({
        _tag: 'ResponseStart',
        id: response.id,
        url: response.url,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    )
    if (response.body.length > 0) {
      runHandlerSync(
        tracker.handleResponseData({
          _tag: 'ResponseData',
          id: response.id,
          data: Encoding.encodeBase64(response.body),
        })
      )
    }
    runHandlerSync(tracker.handleResponseFinished({ _tag: 'ResponseFinished', id: response.id }))
  }

  return results.map((result) =>
    Either.isRight(result) ? result.right.resources : ([] as readonly Echo[])
  )
}

/**
 * `startedAt` is the one field the two paths cannot agree on — the tracker
 * reads the clock at `ResponseStart`, extraction takes the archive's timestamp —
 * and the echo entities deliberately don't read it, so the comparison is over
 * everything else a `RemoteResponse` carries.
 */
describe('Extraction.run / SnifferResponseTracker parity', () => {
  it('produces the same resources as driving the live tracker with the equivalent events', () => {
    const viaExtraction = Effect.runSync(Extraction.run(entityDefinitions, exchanges)).batches.map(
      (batch) => batch.resources
    )

    expect(viaExtraction).toEqual(resourcesViaTracker(exchanges))
    // Guard against both sides being vacuously empty.
    expect(viaExtraction.flat()).toHaveLength(3)
  })

  it('accounts for the response the tracker cancels as unmatched', () => {
    const outcome = Effect.runSync(Extraction.run(entityDefinitions, exchanges))

    expect(outcome.unmatched).toEqual([{ id: 'r3', url: 'https://example.com/gamma/3' }])
    expect(resourcesViaTracker(exchanges)).toHaveLength(outcome.batches.length)
  })
})
