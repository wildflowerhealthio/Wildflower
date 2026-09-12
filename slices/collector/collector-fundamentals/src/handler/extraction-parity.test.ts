import { Effect, Either, Encoding, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { Extraction, type HttpResponseKind, Specificity } from 'http-extraction-fundamentals'
import {
  echoResponseKind,
  makeExtractionInput,
  runExtraction,
  type Echo,
} from 'http-extraction-fundamentals/test-helpers'
import { runHandlerSync } from './collector-bridge-message-handler.test-helpers.ts'
import * as RunRecorder from './run-recorder.ts'
import * as SnifferResponseTracker from './sniffer-response-tracker.ts'

const AlphaEntity = echoResponseKind('AlphaEntity', 'alpha')
const BetaEntity = echoResponseKind('BetaEntity', 'beta')
const responseKinds = [AlphaEntity, BetaEntity]

/**
 * The canned exchange set both paths see: two entities, an unclaimed response,
 * a multi-byte body, and a body that is not valid UTF-8.
 *
 * This suite is THE live-vs-offline parity pin: `http-extraction-fundamentals`'
 * `runExtraction` (the archive-runner reference model in its test-helpers) and
 * this package's `SnifferResponseTracker` must route and decode a set of
 * responses identically, and only this package can see both halves (the
 * dependency points from here to `http-extraction-fundamentals`).
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
  responses: readonly Extraction.Input[],
  kinds: readonly HttpResponseKind.HttpResponseKind<Echo>[] = responseKinds,
  recorder?: RunRecorder.RunRecorder
): readonly (readonly Echo[])[] => {
  const results: SnifferResponseTracker.SniffResult<Echo>[] = []
  const tracker = Effect.runSync(
    SnifferResponseTracker.make<Echo>({
      // Route through the same `Extraction.routeTo` the archive runner uses, so
      // live and archive routing are one function.
      matchResponseKind: (url, method) =>
        Option.map(Extraction.routeTo(kinds, url, method), (r) => r.kind),
      sendMessage: () => Effect.void,
      handleNewSniffResult: (result) =>
        Effect.sync(() => {
          results.push(result)
        }),
      handleGeneratedSteps: () => Effect.void,
      recorder,
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
        method: 'GET',
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
 * everything else a `CollectorHttpResponse` carries.
 */
describe('runExtraction / SnifferResponseTracker parity', () => {
  it('produces the same resources as driving the live tracker with the equivalent events', () => {
    const viaExtraction = Effect.runSync(runExtraction(responseKinds, exchanges)).batches.map(
      (batch) => batch.resources
    )

    expect(viaExtraction).toEqual(resourcesViaTracker(exchanges))
    // Guard against both sides being vacuously empty.
    expect(viaExtraction.flat()).toHaveLength(3)
  })

  it('accounts for the response the tracker cancels as unmatched', () => {
    const outcome = Effect.runSync(runExtraction(responseKinds, exchanges))

    expect(outcome.unmatched).toEqual([{ id: 'r3', url: 'https://example.com/gamma/3' }])
    expect(resourcesViaTracker(exchanges)).toHaveLength(outcome.batches.length)
  })

  it('routes a specificity overlap to the same winner live and in an archive', () => {
    // Two kinds both claim `/alpha/…`, at different specificities. Highest wins
    // in both paths, whatever the list order — the tie is broken by specificity,
    // not by which loop walks the list.
    const broad = echoResponseKind('BroadEntity', 'alpha', Specificity.PROTOCOL)
    const narrow = echoResponseKind('NarrowEntity', 'alpha', Specificity.PORTAL)
    const overlapping = [broad, narrow]
    const overlap = [
      makeExtractionInput({ id: 'o1', url: 'https://example.com/alpha/1', body: '{"a":1}' }),
    ]

    const viaExtraction = Effect.runSync(runExtraction(overlapping, overlap))
    expect(viaExtraction.batches.map((batch) => batch.responseKindName)).toEqual(['NarrowEntity'])
    expect(viaExtraction.batches.map((batch) => batch.resources)).toEqual(
      resourcesViaTracker(overlap, overlapping)
    )
  })
})

/**
 * The round trip the whole recording epic rests on: what the recorder wrote
 * down during a live run, replayed offline, must produce the resources the
 * live run produced. Record now, extract later, same result.
 *
 * @remarks
 * This is stronger than the parity above it. That one pins *two
 * implementations against one input set* — the archive runner and the live
 * tracker read the same `exchanges` fixture. This one closes the loop: the
 * input set for the offline half is no longer a fixture a test wrote, it is
 * the recorder's own output from the live half. If the recorder loses a
 * response, mangles a body, or reorders anything, the fixture on the left and
 * the recording on the right stop agreeing and this fails — which is exactly
 * the failure a run that uploaded a useless HAR would have shipped silently.
 */
describe('RunRecorder / runExtraction parity', () => {
  it("produces the same resources from the recorder's entries as the live run produced", () => {
    const recorder = Effect.runSync(RunRecorder.make)
    const viaTracker = resourcesViaTracker(exchanges, responseKinds, recorder)

    const viaRecording = Effect.runSync(
      runExtraction(responseKinds, recorder.entries())
    ).batches.map((batch) => batch.resources)

    expect(viaRecording).toEqual(viaTracker)
    expect(viaRecording.flat()).toHaveLength(3)
  })

  it('records the unclaimed response the live run threw away', () => {
    const recorder = Effect.runSync(RunRecorder.make)
    resourcesViaTracker(exchanges, responseKinds, recorder)

    // `r3` is the one response no entity claims — cancelled and gone from the
    // live run's output, present in the recording. Replaying the recording
    // therefore accounts for it as `unmatched` rather than losing it, which is
    // the whole reason the recorder sits beside routing instead of after it.
    expect(recorder.entries().map((entry) => entry.id)).toEqual(['r1', 'r2', 'r3', 'r4'])
    expect(Effect.runSync(runExtraction(responseKinds, recorder.entries())).unmatched).toEqual([
      { id: 'r3', url: 'https://example.com/gamma/3' },
    ])
  })

  it('preserves the non-UTF-8 body through the recording', () => {
    const recorder = Effect.runSync(RunRecorder.make)
    resourcesViaTracker(exchanges, responseKinds, recorder)

    // `r4`'s body is not valid UTF-8. A recorder that read `text()` would hand
    // the offline run a body peppered with U+FFFD, and the two halves above
    // would agree only because the echo entity re-encodes the same damage.
    expect(recorder.entries().find((entry) => entry.id === 'r4')?.body).toEqual(
      new Uint8Array([0xff, 0x00, 0xfe, 0x42])
    )
  })
})
