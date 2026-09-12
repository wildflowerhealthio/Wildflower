import { DateTime, Effect, Encoding, Option } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { Extraction, type HttpResponse } from 'http-extraction-fundamentals'
import { echoResponseKind, POISON_BODY } from 'http-extraction-fundamentals/test-helpers'
import { DEFAULT_STARTED_AT, makeCollectorHttpResponse } from '../test-helpers.ts'
import { runHandlerSync } from './collector-bridge-message-handler.test-helpers.ts'
import * as RunRecorder from './run-recorder.ts'
import * as SnifferResponseTracker from './sniffer-response-tracker.ts'

const JSON_HEADERS: HttpResponse.Headers = [['content-type', 'application/fhir+json']]

/**
 * One exchange in a generated sniff sequence: what the sniffer reports and how
 * the exchange ends.
 */
interface Exchange {
  readonly id: string
  readonly url: string
  readonly headers: HttpResponse.Headers
  readonly body: Uint8Array
  readonly ending: 'finished' | 'errored' | 'cancelled'
}

/** URL markers the `alpha` entity claims; anything else is unclaimed traffic. */
const CLAIMED_MARKER = 'alpha'
const AlphaEntity = echoResponseKind('AlphaEntity', CLAIMED_MARKER)

const recordedContentTypes = ['application/fhir+json', 'application/json', 'text/html']
const omittedContentTypes = ['text/javascript', 'text/css', 'image/png', 'font/woff2', 'video/mp4']

const exchangeArb = (index: number): fc.Arbitrary<Exchange> =>
  fc.record({
    id: fc.constant(`r${index}`),
    url: fc.constantFrom(
      `https://example.com/${CLAIMED_MARKER}/${index}`,
      `https://example.com/unclaimed/${index}`
    ),
    headers: fc
      .constantFrom(...recordedContentTypes, ...omittedContentTypes)
      .map((contentType): HttpResponse.Headers => [['content-type', contentType]]),
    // `uint8Array` rather than a string: a recording is replayed byte for byte,
    // so the generator must be able to produce a body no UTF-8 round trip
    // survives.
    body: fc.uint8Array({ maxLength: 24 }),
    ending: fc.constantFrom('finished' as const, 'errored' as const, 'cancelled' as const),
  })

const sniffSequenceArb = (maxLength = 6): fc.Arbitrary<readonly Exchange[]> =>
  fc
    .integer({ min: 1, max: maxLength })
    .chain((length) => fc.tuple(...Array.from({ length }, (_, index) => exchangeArb(index))))

/**
 * Drive a tracker with `exchanges` and return the run's recording alongside the
 * exchanges that should be in it.
 *
 * @remarks
 * The tracker is built the way the handler builds it — same `Extraction.routeTo`
 * routing — so these properties are about the seam as it is wired in
 * production, not about a recorder called directly.
 */
const runSniffSequence = (exchanges: readonly Exchange[]): readonly Extraction.Input[] => {
  const recorder = Effect.runSync(RunRecorder.make)
  const tracker = Effect.runSync(
    SnifferResponseTracker.make({
      matchResponseKind: (url, method) =>
        Option.map(Extraction.routeTo([AlphaEntity], url, method), (routed) => routed.kind),
      sendMessage: () => Effect.void,
      handleNewSniffResult: () => Effect.void,
      handleGeneratedSteps: () => Effect.void,
      recorder,
    })
  )

  for (const exchange of exchanges) {
    runHandlerSync(
      tracker.handleResponseStart({
        _tag: 'ResponseStart',
        id: exchange.id,
        url: exchange.url,
        method: 'GET',
        status: 200,
        statusText: 'OK',
        headers: exchange.headers,
      })
    )
    if (exchange.body.length > 0) {
      runHandlerSync(
        tracker.handleResponseData({
          _tag: 'ResponseData',
          id: exchange.id,
          data: Encoding.encodeBase64(exchange.body),
        })
      )
    }
    switch (exchange.ending) {
      case 'finished': {
        runHandlerSync(
          tracker.handleResponseFinished({ _tag: 'ResponseFinished', id: exchange.id })
        )
        break
      }
      case 'errored': {
        runHandlerSync(
          tracker.handleRequestError({
            _tag: 'RequestError',
            id: exchange.id,
            url: exchange.url,
            message: 'boom',
          })
        )
        break
      }
      case 'cancelled': {
        runHandlerSync(tracker.handleCancelled({ _tag: 'Cancelled', id: exchange.id }))
        break
      }
    }
  }

  return recorder.entries()
}

const contentTypeOfExchange = (exchange: Exchange): string => exchange.headers[0]?.[1] ?? ''

/** The exchanges that must end up in the recording, in settle order. */
const expectedRecorded = (exchanges: readonly Exchange[]): readonly Exchange[] =>
  exchanges.filter(
    (exchange) =>
      exchange.ending === 'finished' &&
      !omittedContentTypes.includes(contentTypeOfExchange(exchange))
  )

describe('RunRecorder', () => {
  it('records the response as an Extraction.Input, byte for byte', () => {
    const recorder = Effect.runSync(RunRecorder.make)
    const body = new Uint8Array([0xff, 0x00, 0xfe, 0x42])
    const response = makeCollectorHttpResponse({
      id: 'r1',
      url: 'https://example.com/alpha/1',
      headers: JSON_HEADERS,
      body,
    })

    Effect.runSync(recorder.record(response))

    expect(recorder.entries()).toEqual([
      {
        id: 'r1',
        url: 'https://example.com/alpha/1',
        method: Option.some('GET'),
        status: 200,
        statusText: 'OK',
        headers: JSON_HEADERS,
        startedAt: DEFAULT_STARTED_AT,
        body,
        bodyAbsent: false,
      },
    ])
  })

  it('takes startedAt from the response rather than reading a clock at record time', () => {
    const startedAt = DateTime.unsafeMake('2020-06-15T12:00:00.000Z')
    const recorder = Effect.runSync(RunRecorder.make)

    Effect.runSync(
      recorder.record(makeCollectorHttpResponse({ headers: JSON_HEADERS, startedAt, body: 'x' }))
    )

    expect(recorder.entries()[0]?.startedAt).toStrictEqual(startedAt)
  })

  it('entries() hands back a snapshot a caller cannot use to mutate the recording', () => {
    const recorder = Effect.runSync(RunRecorder.make)
    Effect.runSync(recorder.record(makeCollectorHttpResponse({ headers: JSON_HEADERS, body: 'a' })))

    const snapshot = recorder.entries()
    Effect.runSync(
      recorder.record(makeCollectorHttpResponse({ id: 'r2', headers: JSON_HEADERS, body: 'b' }))
    )

    expect(snapshot).toHaveLength(1)
    expect(recorder.entries()).toHaveLength(2)
  })

  it.each(omittedContentTypes)('drops a %s response entirely', (contentType) => {
    const recorder = Effect.runSync(RunRecorder.make)

    Effect.runSync(
      recorder.record(
        makeCollectorHttpResponse({ headers: [['content-type', contentType]], body: 'furniture' })
      )
    )

    expect(recorder.entries()).toEqual([])
  })

  it('records every non-omitted response exactly once, in the order it was recorded', () => {
    fc.assert(
      fc.property(sniffSequenceArb(), (exchanges) => {
        const recorder = Effect.runSync(RunRecorder.make)
        for (const exchange of exchanges) {
          Effect.runSync(
            recorder.record(
              makeCollectorHttpResponse({
                id: exchange.id,
                url: exchange.url,
                headers: exchange.headers,
                body: exchange.body,
              })
            )
          )
        }

        expect(recorder.entries().map((entry) => entry.id)).toEqual(
          exchanges
            .filter((exchange) => !omittedContentTypes.includes(contentTypeOfExchange(exchange)))
            .map((exchange) => exchange.id)
        )
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})

describe('RunRecorder driven by the response tracker', () => {
  it('records every settled response exactly once, in settle order', () => {
    fc.assert(
      fc.property(sniffSequenceArb(), (exchanges) => {
        const entries = runSniffSequence(exchanges)

        expect(entries.map((entry) => entry.id)).toEqual(
          expectedRecorded(exchanges).map((exchange) => exchange.id)
        )
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('records claimed and unclaimed responses alike', () => {
    const exchanges: readonly Exchange[] = [
      {
        id: 'r1',
        url: 'https://example.com/alpha/1',
        headers: JSON_HEADERS,
        body: new TextEncoder().encode('{"a":1}'),
        ending: 'finished',
      },
      {
        id: 'r2',
        url: 'https://example.com/unclaimed/2',
        headers: JSON_HEADERS,
        body: new TextEncoder().encode('{"b":2}'),
        ending: 'finished',
      },
    ]

    const entries = runSniffSequence(exchanges)

    // The unclaimed response is still cancelled at `ResponseStart` — the point
    // of the seam is that everything the page *did* deliver is in the
    // recording anyway.
    expect(entries.map((entry) => entry.url)).toEqual([
      'https://example.com/alpha/1',
      'https://example.com/unclaimed/2',
    ])
  })

  it('preserves a body that is not valid UTF-8, byte for byte', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 32 }), (body) => {
        const entries = runSniffSequence([
          {
            id: 'r1',
            url: 'https://example.com/unclaimed/1',
            headers: [['content-type', 'application/octet-stream']],
            body,
            ending: 'finished',
          },
        ])

        expect(entries).toHaveLength(1)
        expect(entries[0]?.body).toEqual(body)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('keeps the record of a response whose entity refused to parse it', () => {
    const entries = runSniffSequence([
      {
        id: 'r1',
        url: `https://example.com/${CLAIMED_MARKER}/1`,
        headers: JSON_HEADERS,
        body: new TextEncoder().encode(POISON_BODY),
        ending: 'finished',
      },
    ])

    expect(entries.map((entry) => entry.id)).toEqual(['r1'])
  })

  it('records nothing for a response that errored or was cancelled before finishing', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('errored' as const, 'cancelled' as const),
        fc.boolean(),
        (ending, claimed) => {
          const entries = runSniffSequence([
            {
              id: 'r1',
              url: `https://example.com/${claimed ? CLAIMED_MARKER : 'unclaimed'}/1`,
              headers: JSON_HEADERS,
              body: new TextEncoder().encode('partial'),
              ending,
            },
          ])

          // A truncated body replayed later would manufacture a parse failure
          // the live run never saw, so a response that never finished on the
          // wire is absent rather than partial.
          expect(entries).toEqual([])
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('leaves the run lifecycle blind to unclaimed responses it is holding', () => {
    const recorder = Effect.runSync(RunRecorder.make)
    const tracker = Effect.runSync(
      SnifferResponseTracker.make({
        matchResponseKind: (url, method) =>
          Option.map(Extraction.routeTo([AlphaEntity], url, method), (routed) => routed.kind),
        sendMessage: () => Effect.void,
        handleNewSniffResult: () => Effect.void,
        handleGeneratedSteps: () => Effect.void,
        recorder,
      })
    )

    runHandlerSync(
      tracker.handleResponseStart({
        _tag: 'ResponseStart',
        id: 'r1',
        url: 'https://example.com/unclaimed/1',
        method: 'GET',
        status: 200,
        statusText: 'OK',
        headers: JSON_HEADERS,
      })
    )

    // The recorder's shadow entry must never be mistaken for in-flight work: it
    // would hold a finished run open, and settle as a failure on the results
    // stream for traffic no entity ever wanted.
    expect(tracker.hasIncompleteSniffedRequests()).toBe(false)
  })
})
