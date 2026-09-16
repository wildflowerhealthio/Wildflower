import { DateTime, Encoding } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'
import { contentTypeOf } from 'web-trace-core/capture'

import { isOmittedFromRecording } from './omitted.ts'
import { MAX_BODY_BYTES, Recording } from './recording.ts'

/**
 * A response the sniffer reports, as a test describes it before it is spread
 * into the message triple that carries it.
 */
interface Exchange {
  readonly id: string
  readonly url: string
  readonly status: number
  readonly statusText: string
  readonly contentType: string
  readonly chunks: readonly Uint8Array[]
  readonly terminal: 'finish' | 'error' | 'cancel'
}

/** One sniffer message, tied back to the exchange it belongs to. */
type Event =
  | { readonly kind: 'start'; readonly exchange: Exchange }
  | { readonly kind: 'data'; readonly exchange: Exchange; readonly chunk: Uint8Array }
  | { readonly kind: 'terminal'; readonly exchange: Exchange }

const KEPT_CONTENT_TYPES = [
  'application/json',
  'application/fhir+json',
  'text/html',
  'application/octet-stream',
] as const

const OMITTED_CONTENT_TYPES = [
  'text/css',
  'image/png',
  'video/mp4',
  'audio/mpeg',
  'font/woff2',
  'text/javascript',
  'application/javascript',
] as const

const exchangeArbitrary: fc.Arbitrary<Omit<Exchange, 'id'>> = fc.record({
  url: fc.webUrl(),
  status: fc.integer({ min: 0, max: 1000 }),
  statusText: fc.string(),
  contentType: fc.constantFrom(...KEPT_CONTENT_TYPES, ...OMITTED_CONTENT_TYPES),
  chunks: fc.array(fc.uint8Array()),
  terminal: fc.constantFrom('finish' as const, 'error' as const, 'cancel' as const),
})

/** Each exchange's own events, always in their own order. */
const eventsOf = (exchange: Exchange): readonly Event[] => [
  { kind: 'start', exchange },
  ...exchange.chunks.map((chunk) => ({ kind: 'data', exchange, chunk }) as const),
  { kind: 'terminal', exchange },
]

/**
 * Interleaves per-exchange event streams, preserving each stream's own order.
 *
 * @param streams - One ordered event list per exchange
 * @param picks - Generated numbers that choose which stream advances next
 * @returns One interleaving — what the host's single message queue delivers
 */
const interleave = (streams: readonly (readonly Event[])[], picks: readonly number[]): Event[] => {
  const remaining = streams.map((stream) => [...stream])
  const order: Event[] = []
  let pickIndex = 0
  while (remaining.some((stream) => stream.length > 0)) {
    const live = remaining.filter((stream) => stream.length > 0)
    const pick = picks[pickIndex % Math.max(picks.length, 1)] ?? 0
    pickIndex += 1
    const stream = live[pick % live.length]
    const next = stream?.shift()
    if (next !== undefined) order.push(next)
  }
  return order
}

/**
 * A whole recording session: several concurrent exchanges, and one arbitrary
 * interleaving of every message they produce.
 */
const sessionArbitrary = fc
  .tuple(fc.array(exchangeArbitrary, { minLength: 1 }), fc.array(fc.nat(), { minLength: 1 }))
  .map(([bodies, picks]) => {
    // Ids are assigned after generation so every exchange in a session is
    // distinct — an id collision would merge two unrelated streams.
    const exchanges: readonly Exchange[] = bodies.map((body, index) => ({
      ...body,
      id: `req-${index}`,
    }))
    return { exchanges, events: interleave(exchanges.map(eventsOf), picks) }
  })

/** A fixed clock: the nth message observed is the nth second of the recording. */
const observedAt = (index: number): DateTime.Utc =>
  DateTime.unsafeMake(Date.UTC(2026, 8, 13, 14, 0, index))

/** Drives every event into a recording, returning it and each Start's instant. */
const record = (
  events: readonly Event[]
): { readonly recording: Recording; readonly startedAt: ReadonlyMap<string, DateTime.Utc> } => {
  const recording = Recording.empty()
  const startedAt = new Map<string, DateTime.Utc>()
  events.forEach((event, index) => {
    const { exchange } = event
    switch (event.kind) {
      case 'start': {
        const at = observedAt(index)
        startedAt.set(exchange.id, at)
        recording.onResponseStart(
          {
            _tag: 'ResponseStart',
            id: exchange.id,
            url: exchange.url,
            method: 'GET',
            status: exchange.status,
            statusText: exchange.statusText,
            headers: [['content-type', exchange.contentType]],
          },
          at
        )
        return
      }
      case 'data': {
        recording.onResponseData({
          _tag: 'ResponseData',
          id: exchange.id,
          data: Encoding.encodeBase64(event.chunk),
        })
        return
      }
      case 'terminal': {
        if (exchange.terminal === 'finish') {
          recording.onResponseFinished({ _tag: 'ResponseFinished', id: exchange.id })
        } else if (exchange.terminal === 'error') {
          recording.onRequestError({
            _tag: 'RequestError',
            id: exchange.id,
            url: exchange.url,
            message: 'network error',
          })
        } else {
          recording.onCancelled({ _tag: 'Cancelled', id: exchange.id })
        }
      }
    }
  })
  return { recording, startedAt }
}

/**
 * The oracle: the exchanges a recording must end up holding, in the order it
 * must hold them.
 *
 * @remarks
 * Deliberately a different formulation than the subject's — it walks the
 * settled interleaving looking for terminals rather than accumulating state per
 * id — so agreement is evidence rather than a restatement.
 */
const expectedExchanges = (events: readonly Event[]): readonly Exchange[] =>
  events
    .filter((event) => event.kind === 'terminal')
    .map((event) => event.exchange)
    .filter(
      (exchange) => exchange.terminal === 'finish' && !isOmittedFromRecording(exchange.contentType)
    )

const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
  const combined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.length
  }
  return combined
}

/** The `ResponseStart` an exchange is reported by. */
const startOf = (exchange: Exchange) =>
  ({
    _tag: 'ResponseStart',
    id: exchange.id,
    url: exchange.url,
    method: 'GET',
    status: exchange.status,
    statusText: exchange.statusText,
    headers: [['content-type', exchange.contentType]] as const,
  }) as const

describe('Recording', () => {
  it('should hold nothing when nothing has happened', () => {
    // Arrange / Act
    const recording = Recording.empty()

    // Assert
    expect(recording.entries()).toEqual([])
    expect(recording.count).toBe(0)
  })

  it('should settle a kept response into one entry carrying its bytes', () => {
    // Arrange
    const at = DateTime.unsafeMake('2026-09-13T14:02:11Z')
    const recording = Recording.empty()
    const exchange: Exchange = {
      id: 'req-0',
      url: 'https://portal.example.org/api/v2/patients',
      status: 200,
      statusText: 'OK',
      contentType: 'application/json',
      chunks: [],
      terminal: 'finish',
    }

    // Act
    recording.onResponseStart(startOf(exchange), at)
    recording.onResponseData({
      _tag: 'ResponseData',
      id: 'req-0',
      data: Encoding.encodeBase64(new TextEncoder().encode('{"ok":')),
    })
    recording.onResponseData({
      _tag: 'ResponseData',
      id: 'req-0',
      data: Encoding.encodeBase64(new TextEncoder().encode('true}')),
    })
    recording.onResponseFinished({ _tag: 'ResponseFinished', id: 'req-0' })

    // Assert
    expect(recording.entries()).toEqual([
      {
        id: 'har-entry-0',
        url: 'https://portal.example.org/api/v2/patients',
        method: 'UNKNOWN',
        status: 200,
        statusText: 'OK',
        headers: [['content-type', 'application/json']],
        startedAt: at,
        body: new TextEncoder().encode('{"ok":true}'),
        bodyAbsent: false,
      },
    ])
  })

  it('should ignore a terminal for an id it never saw start', () => {
    // Arrange
    const recording = Recording.empty()

    // Act
    recording.onResponseFinished({ _tag: 'ResponseFinished', id: 'never-started' })
    recording.onCancelled({ _tag: 'Cancelled', id: 'never-started' })
    recording.onRequestError({
      _tag: 'RequestError',
      id: 'never-started',
      url: 'https://portal.example.org/x',
      message: 'gone',
    })

    // Assert
    expect(recording.count).toBe(0)
  })

  it('should ignore a second Finished for an id that already settled', () => {
    // Arrange
    const at = DateTime.unsafeMake('2026-09-13T14:02:11Z')
    const recording = Recording.empty()
    const exchange: Exchange = {
      id: 'req-0',
      url: 'https://portal.example.org/x',
      status: 200,
      statusText: 'OK',
      contentType: 'application/json',
      chunks: [],
      terminal: 'finish',
    }

    // Act
    recording.onResponseStart(startOf(exchange), at)
    recording.onResponseFinished({ _tag: 'ResponseFinished', id: 'req-0' })
    recording.onResponseFinished({ _tag: 'ResponseFinished', id: 'req-0' })

    // Assert
    expect(recording.count).toBe(1)
  })

  it('should settle a body past the cap as absent, while still counting its size', () => {
    // Arrange — two chunks whose total is one byte past the cap.
    const at = DateTime.unsafeMake('2026-09-13T14:02:11Z')
    const recording = Recording.empty()
    const exchange: Exchange = {
      id: 'req-0',
      url: 'https://portal.example.org/large-payload',
      status: 200,
      statusText: 'OK',
      contentType: 'application/json',
      chunks: [],
      terminal: 'finish',
    }
    const first = new Uint8Array(MAX_BODY_BYTES)
    const second = new Uint8Array(1)

    // Act
    recording.onResponseStart(startOf(exchange), at)
    recording.onResponseData({
      _tag: 'ResponseData',
      id: 'req-0',
      data: Encoding.encodeBase64(first),
    })
    recording.onResponseData({
      _tag: 'ResponseData',
      id: 'req-0',
      data: Encoding.encodeBase64(second),
    })
    recording.onResponseFinished({ _tag: 'ResponseFinished', id: 'req-0' })

    // Assert
    const [entry] = recording.entries()
    expect(entry?.bodyAbsent).toBe(true)
    expect(entry?.body).toEqual(new Uint8Array(0))
    // The true size, which `HttpArchive.Entry` itself cannot carry.
    expect(recording.observedBodyBytes.get('har-entry-0')).toBe(MAX_BODY_BYTES + 1)
  })

  it('should keep a body exactly at the cap', () => {
    // Arrange
    const at = DateTime.unsafeMake('2026-09-13T14:02:11Z')
    const recording = Recording.empty()
    const exchange: Exchange = {
      id: 'req-0',
      url: 'https://portal.example.org/large-payload',
      status: 200,
      statusText: 'OK',
      contentType: 'application/json',
      chunks: [],
      terminal: 'finish',
    }

    // Act
    recording.onResponseStart(startOf(exchange), at)
    recording.onResponseData({
      _tag: 'ResponseData',
      id: 'req-0',
      data: Encoding.encodeBase64(new Uint8Array(MAX_BODY_BYTES)),
    })
    recording.onResponseFinished({ _tag: 'ResponseFinished', id: 'req-0' })

    // Assert
    const [entry] = recording.entries()
    expect(entry?.bodyAbsent).toBe(false)
    expect(entry?.body.length).toBe(MAX_BODY_BYTES)
  })

  it('should settle a body whose base64 will not decode as absent rather than truncated', () => {
    // Arrange
    const at = DateTime.unsafeMake('2026-09-13T14:02:11Z')
    const recording = Recording.empty()
    const exchange: Exchange = {
      id: 'req-0',
      url: 'https://portal.example.org/favicon',
      status: 200,
      statusText: 'OK',
      contentType: 'application/octet-stream',
      chunks: [],
      terminal: 'finish',
    }

    // Act
    recording.onResponseStart(startOf(exchange), at)
    recording.onResponseData({
      _tag: 'ResponseData',
      id: 'req-0',
      data: Encoding.encodeBase64(new TextEncoder().encode('the readable half')),
    })
    recording.onResponseData({ _tag: 'ResponseData', id: 'req-0', data: 'not base64 at all!!' })
    recording.onResponseFinished({ _tag: 'ResponseFinished', id: 'req-0' })

    // Assert
    const [entry] = recording.entries()
    expect(entry?.bodyAbsent).toBe(true)
    expect(entry?.body).toEqual(new Uint8Array(0))
  })

  it('should hand back a fresh array each call, not a view of its own state', () => {
    // Arrange
    const recording = Recording.empty()

    // Act / Assert
    expect(recording.entries()).not.toBe(recording.entries())
  })

  it('should settle exactly the finished, kept responses — in settle order, bytes intact', () => {
    fc.assert(
      fc.property(sessionArbitrary, ({ events }) => {
        // Act
        const { recording, startedAt } = record(events)

        // Assert
        const expected = expectedExchanges(events)
        expect(recording.count).toBe(expected.length)
        expect(recording.entries()).toEqual(
          expected.map((exchange, index) => ({
            id: `har-entry-${index}`,
            url: exchange.url,
            method: 'UNKNOWN',
            status: exchange.status,
            statusText: exchange.statusText,
            headers: [['content-type', exchange.contentType]],
            startedAt: startedAt.get(exchange.id),
            body: concat(exchange.chunks),
            bodyAbsent: false,
          }))
        )
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('should never settle an omitted content type, however its chunks interleave', () => {
    fc.assert(
      fc.property(sessionArbitrary, ({ exchanges, events }) => {
        // Arrange
        fc.pre(exchanges.some((exchange) => isOmittedFromRecording(exchange.contentType)))

        // Act
        const { recording } = record(events)

        // Assert — nothing an entry carries came from an omitted response, and
        // the omitted chunks did not land on a neighbouring entry either (the
        // settled bytes are checked exhaustively by the settle-order property).
        for (const entry of recording.entries()) {
          expect(isOmittedFromRecording(contentTypeOf(entry.headers))).toBe(false)
        }
        expect(recording.count).toBe(expectedExchanges(events).length)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should never settle a response that errored or was cancelled', () => {
    fc.assert(
      fc.property(sessionArbitrary, ({ exchanges, events }) => {
        // Arrange
        fc.pre(exchanges.some((exchange) => exchange.terminal !== 'finish'))

        // Act
        const { recording } = record(events)

        // Assert
        const settledCount = recording.count
        const finishedKept = exchanges.filter(
          (exchange) =>
            exchange.terminal === 'finish' && !isOmittedFromRecording(exchange.contentType)
        ).length
        expect(settledCount).toBe(finishedKept)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should reassemble bytes identically for payloads that are not valid UTF-8', () => {
    fc.assert(
      fc.property(
        fc.array(fc.uint8Array({ minLength: 1 }), { minLength: 1 }),
        fc.uint8Array({ minLength: 1 }),
        (chunks, tail) => {
          // Arrange — a lone 0xFF byte makes the payload undecodable as UTF-8.
          const body = [...chunks, new Uint8Array([0xff, 0xfe]), tail]
          const at = DateTime.unsafeMake('2026-09-13T14:02:11Z')
          const recording = Recording.empty()
          const exchange: Exchange = {
            id: 'req-0',
            url: 'https://portal.example.org/blob',
            status: 200,
            statusText: 'OK',
            contentType: 'application/octet-stream',
            chunks: body,
            terminal: 'finish',
          }

          // Act
          recording.onResponseStart(startOf(exchange), at)
          for (const chunk of body) {
            recording.onResponseData({
              _tag: 'ResponseData',
              id: 'req-0',
              data: Encoding.encodeBase64(chunk),
            })
          }
          recording.onResponseFinished({ _tag: 'ResponseFinished', id: 'req-0' })

          // Assert
          expect(recording.entries()[0]?.body).toEqual(concat(body))
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
