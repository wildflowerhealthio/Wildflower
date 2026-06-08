import { type SnifferHandlers } from 'browser-sniffer-core/bridge'
import * as Telemetry from 'browser-sniffer-core/telemetry'
import { Clock, Context, Effect, Tracer } from 'effect'
import { makeSnifferTelemetry } from './sniffer-telemetry.ts'

// A span the controller opened, recording everything the controller does to
// it. `endCount` is the assertion linchpin: every span must end exactly once,
// so a value of 0 is a leak and a value > 1 is a double-end (which in real
// OTel overwrites the first status/duration).
interface RecordedSpan {
  readonly name: string
  endCount: number
  readonly attributes: Map<string, unknown>
  readonly events: Array<{ readonly name: string }>
}

/**
 * Recording fake {@link Tracer}. Every `span(...)` the controller drives
 * through `Effect.makeSpan` lands a {@link RecordedSpan} on `spans` and
 * returns a minimal `Tracer.Span` whose `.end()` bumps that record's
 * `endCount`. No real timers, no exporter — the test asserts purely on the
 * recorded end counts and attributes. The returned span's `attribute` /
 * `event` write straight onto the same `RecordedSpan`, so a closure ties the
 * span the controller holds to the record the test inspects.
 */
const makeRecordingTracer = (): { tracer: Tracer.Tracer; spans: RecordedSpan[] } => {
  const spans: RecordedSpan[] = []
  let nextId = 0
  const tracer = Tracer.make({
    span: (name, parent) => {
      const record: RecordedSpan = {
        name,
        endCount: 0,
        attributes: new Map(),
        events: [],
      }
      spans.push(record)
      const span: Tracer.Span = {
        _tag: 'Span',
        name,
        spanId: `span-${nextId++}`,
        traceId: 'trace',
        parent,
        // The controller passes opened spans back as `parent` by reference; the
        // fake never reads `context`, so an empty one satisfies the interface.
        context: Context.empty(),
        status: { _tag: 'Started', startTime: 0n },
        attributes: record.attributes,
        links: [],
        sampled: true,
        kind: 'internal',
        end: () => {
          record.endCount += 1
        },
        attribute: (key, value) => {
          record.attributes.set(key, value)
        },
        event: (eventName) => {
          record.events.push({ name: eventName })
        },
        addLinks: () => {},
      }
      return span
    },
    context: (f) => f(),
  })
  return { tracer, spans }
}

// No-op consumer handlers: the controller's `wrap` delegates to these after
// driving the span tree. The test only cares about span lifecycle, so these
// just succeed.
const NOOP_HANDLERS: SnifferHandlers = {
  ResponseStart: () => Effect.void,
  ResponseData: () => Effect.void,
  ResponseFinished: () => Effect.void,
  RequestError: () => Effect.void,
  Cancelled: () => Effect.void,
  PageLoaded: () => Effect.void,
}

// Message builders — minimal valid decoded payloads for each handler.
const pageLoaded = (url: string, pageContentId: string) =>
  ({ _tag: 'PageLoaded', url, pageContentId }) as const
const responseStart = (id: string, url = `https://e/${id}`) =>
  ({ _tag: 'ResponseStart', id, url, status: 200, statusText: 'OK', headers: [] }) as const
const responseFinished = (id: string) => ({ _tag: 'ResponseFinished', id }) as const
const requestError = (id: string) =>
  ({ _tag: 'RequestError', id, url: `https://e/${id}`, message: 'boom' }) as const
const cancelled = (id: string) => ({ _tag: 'Cancelled', id }) as const

// Run an Effect that drives the span tree, with the recording tracer injected
// via `Effect.withTracer` (so `Effect.makeSpan` resolves our fake, not the
// runtime default). Deterministic — no real clock or timers are awaited.
const drive = (tracer: Tracer.Tracer, effect: Effect.Effect<void>): Promise<void> =>
  Effect.runPromise(Effect.withTracer(effect, tracer))

const named = (spans: RecordedSpan[], name: string): RecordedSpan[] =>
  spans.filter((s) => s.name === name)

describe('makeSnifferTelemetry — every span ends exactly once', () => {
  it('ends session, initial-load, page, and in-flight response spans exactly once on dispose', async () => {
    const { tracer, spans } = makeRecordingTracer()
    const telemetry = makeSnifferTelemetry()
    const handlers = telemetry.wrap(NOOP_HANDLERS)

    await drive(
      tracer,
      Effect.gen(function* () {
        yield* telemetry.start
        // A page settles (ends the initial-load span, opens a page span).
        yield* handlers.PageLoaded(pageLoaded('https://p/1', 'pc1'))
        // Two requests open under that page and never settle.
        yield* handlers.ResponseStart(responseStart('r1'))
        yield* handlers.ResponseStart(responseStart('r2'))
        // Unmount with both still in flight.
        yield* telemetry.dispose
      })
    )

    // Every opened span ended exactly once.
    for (const s of spans) expect(s.endCount).toBe(1)

    // The expected tree opened: session, initial-load, one page, two responses.
    expect(named(spans, Telemetry.Sniffing.Session.Span.Name).length).toBe(1)
    expect(named(spans, Telemetry.Sniffing.InitialLoad.Span.Name).length).toBe(1)
    expect(named(spans, Telemetry.Sniffing.Page.Span.Name).length).toBe(1)
    expect(named(spans, Telemetry.Sniffing.Response.Span.Name).length).toBe(2)

    // In-flight response spans end marked Aborted on dispose.
    for (const r of named(spans, Telemetry.Sniffing.Response.Span.Name)) {
      expect(r.attributes.get(Telemetry.Sniffing.Attributes.Outcome)).toBe(
        Telemetry.Sniffing.Outcomes.Aborted
      )
    }
  })

  it('ends a naturally-settled response span once, and does not re-end it on dispose', async () => {
    const { tracer, spans } = makeRecordingTracer()
    const telemetry = makeSnifferTelemetry()
    const handlers = telemetry.wrap(NOOP_HANDLERS)

    await drive(
      tracer,
      Effect.gen(function* () {
        yield* telemetry.start
        yield* handlers.PageLoaded(pageLoaded('https://p/1', 'pc1'))
        yield* handlers.ResponseStart(responseStart('r1'))
        // r1 finishes naturally before unmount.
        yield* handlers.ResponseFinished(responseFinished('r1'))
        yield* telemetry.dispose
      })
    )

    for (const s of spans) expect(s.endCount).toBe(1)
    const response = named(spans, Telemetry.Sniffing.Response.Span.Name)
    expect(response.length).toBe(1)
    // Settled naturally → Finished, not Aborted.
    expect(response[0]?.attributes.get(Telemetry.Sniffing.Attributes.Outcome)).toBe(
      Telemetry.Sniffing.Outcomes.Finished
    )
  })

  it('rotates multiple pages, ending each page span exactly once', async () => {
    const { tracer, spans } = makeRecordingTracer()
    const telemetry = makeSnifferTelemetry()
    const handlers = telemetry.wrap(NOOP_HANDLERS)

    await drive(
      tracer,
      Effect.gen(function* () {
        yield* telemetry.start
        yield* handlers.PageLoaded(pageLoaded('https://p/1', 'pc1'))
        yield* handlers.PageLoaded(pageLoaded('https://p/2', 'pc2'))
        yield* handlers.PageLoaded(pageLoaded('https://p/3', 'pc3'))
        yield* telemetry.dispose
      })
    )

    for (const s of spans) expect(s.endCount).toBe(1)
    expect(named(spans, Telemetry.Sniffing.Page.Span.Name).length).toBe(3)
  })
})

describe('makeSnifferTelemetry — duplicate / out-of-order terminal events', () => {
  it('does not double-end a response span when a terminal event arrives twice', async () => {
    const { tracer, spans } = makeRecordingTracer()
    const telemetry = makeSnifferTelemetry()
    const handlers = telemetry.wrap(NOOP_HANDLERS)

    await drive(
      tracer,
      Effect.gen(function* () {
        yield* telemetry.start
        yield* handlers.PageLoaded(pageLoaded('https://p/1', 'pc1'))
        yield* handlers.ResponseStart(responseStart('r1'))
        // Same terminal id arrives twice (page replays it); the second is a
        // no-op because the id was deleted on the first.
        yield* handlers.ResponseFinished(responseFinished('r1'))
        yield* handlers.ResponseFinished(responseFinished('r1'))
        // And a different terminal flavour for the same id, out of order.
        yield* handlers.Cancelled(cancelled('r1'))
        yield* telemetry.dispose
      })
    )

    for (const s of spans) expect(s.endCount).toBe(1)
    expect(named(spans, Telemetry.Sniffing.Response.Span.Name).length).toBe(1)
  })

  it('does not re-end an aborted response span when a late terminal event arrives after dispose', async () => {
    // dispose aborts the in-flight r1 and forgets the id; a late terminal
    // event for r1 then finds no entry and is a no-op. Covers the sequential
    // ordering the cooperative scheduler actually produces.
    const { tracer, spans } = makeRecordingTracer()
    const telemetry = makeSnifferTelemetry()
    const handlers = telemetry.wrap(NOOP_HANDLERS)

    await drive(
      tracer,
      Effect.gen(function* () {
        yield* telemetry.start
        yield* handlers.PageLoaded(pageLoaded('https://p/1', 'pc1'))
        yield* handlers.ResponseStart(responseStart('r1'))
        // dispose ends the in-flight r1 (Aborted)...
        yield* telemetry.dispose
        // ...then a late terminal event for r1 arrives (the handler already
        // forgot the id, so this is a no-op and must not re-end the span).
        yield* handlers.RequestError(requestError('r1'))
        yield* handlers.ResponseFinished(responseFinished('r1'))
      })
    )

    for (const s of spans) expect(s.endCount).toBe(1)
  })

  it('is idempotent across a re-entrant / repeated dispose', async () => {
    const { tracer, spans } = makeRecordingTracer()
    const telemetry = makeSnifferTelemetry()
    const handlers = telemetry.wrap(NOOP_HANDLERS)

    await drive(
      tracer,
      Effect.gen(function* () {
        yield* telemetry.start
        yield* handlers.PageLoaded(pageLoaded('https://p/1', 'pc1'))
        yield* handlers.ResponseStart(responseStart('r1'))
        yield* telemetry.dispose
        // A second dispose (React StrictMode double-cleanup, or a stray fork)
        // must not re-end anything.
        yield* telemetry.dispose
      })
    )

    for (const s of spans) expect(s.endCount).toBe(1)
  })

  it('the endSpan guard prevents a double-end when dispose preempts a terminal handler mid-flight', async () => {
    // The true preemptive race the `endSpan` guard exists for, made
    // deterministic: `endResponse` captures the response entry, then reads
    // `Clock.currentTimeNanos` (a yield point) before calling `.end()`. A fake
    // clock fires `dispose` *during* that read — so dispose ends + forgets the
    // span while the terminal handler is suspended holding the stale entry.
    // When the handler resumes it ends the same span a second time. Only the
    // `endSpan` WeakSet guard (not the id-bookkeeping, which dispose already
    // cleared) can keep the count at 1. No real timers: the interleave is
    // driven entirely by the clock-read side effect.
    const { tracer, spans } = makeRecordingTracer()
    const telemetry = makeSnifferTelemetry()
    const handlers = telemetry.wrap(NOOP_HANDLERS)

    // `armed` is flipped on just before the racing terminal handler runs, so
    // only the `Clock.currentTimeNanos` read *inside* that handler's
    // `endResponse` fires dispose — not the earlier read in `rotatePage`, nor
    // dispose's own reads (one-shot via `disarm`). The base clock supplies the
    // unchanged members (its methods live on the prototype, so they're
    // delegated explicitly rather than spread).
    const base = Clock.make()
    let tick = 0n
    let armed = false
    let preempted = false
    const racingClock: Clock.Clock = {
      [Clock.ClockTypeId]: Clock.ClockTypeId,
      unsafeCurrentTimeMillis: () => base.unsafeCurrentTimeMillis(),
      unsafeCurrentTimeNanos: () => base.unsafeCurrentTimeNanos(),
      currentTimeMillis: base.currentTimeMillis,
      sleep: (duration) => base.sleep(duration),
      currentTimeNanos: Effect.suspend(() => {
        const fireDispose = armed
        armed = false
        const time = tick++
        if (fireDispose) preempted = true
        return fireDispose ? Effect.as(telemetry.dispose, time) : Effect.succeed(time)
      }),
    }

    await Effect.runPromise(
      Effect.withTracer(
        Effect.gen(function* () {
          yield* telemetry.start
          yield* handlers.PageLoaded(pageLoaded('https://p/1', 'pc1'))
          yield* handlers.ResponseStart(responseStart('r1'))
          // Arm the clock so the next read — the one inside this terminal
          // handler's `endResponse`, between capturing the entry and ending
          // the span — fires dispose, reproducing the preemptive race.
          armed = true
          yield* handlers.ResponseFinished(responseFinished('r1'))
        }).pipe(Effect.withClock(racingClock)),
        tracer
      )
    )

    // dispose fired mid-handler (the interleave actually happened), and the
    // `endSpan` guard kept every span — the doubly-reached response span
    // included — at exactly one `.end()`. (Which side wins the Outcome
    // *attribute* write is a separate, benign race; the guard is only
    // responsible for the end count, which is what corrupts on a real
    // double-end.)
    expect(preempted).toBe(true)
    const response = named(spans, Telemetry.Sniffing.Response.Span.Name)
    expect(response.length).toBe(1)
    for (const s of spans) expect(s.endCount).toBe(1)
  })
})

describe('makeSnifferTelemetry — fast-unmount race', () => {
  it('opens no spans when dispose runs before start (gate already closed)', async () => {
    const { tracer, spans } = makeRecordingTracer()
    const telemetry = makeSnifferTelemetry()

    await drive(
      tracer,
      Effect.gen(function* () {
        // Unmount wins the race: dispose runs before start.
        yield* telemetry.dispose
        yield* telemetry.start
      })
    )

    // start saw the closed gate and opened nothing — no leak, no spans at all.
    expect(spans.length).toBe(0)
  })

  it('does not leak a span when dispose interleaves between start and its first span', async () => {
    // Drive dispose and start "concurrently": fork start, let it run up to its
    // span creation, then dispose. Whatever spans start opens must be ended.
    const { tracer, spans } = makeRecordingTracer()
    const telemetry = makeSnifferTelemetry()

    await drive(
      tracer,
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(telemetry.start)
        // Let the forked start make progress (it may open its spans), then
        // dispose, then make sure start has fully settled.
        yield* Effect.yieldNow()
        yield* telemetry.dispose
        yield* fiber.await
      })
    )

    // Either start opened the pair (then they're ended by dispose or by start's
    // own mid-flight re-check) or it opened nothing. No span may be left open.
    for (const s of spans) expect(s.endCount).toBe(1)
  })

  it('ends spans exactly once when start fully wins, then a normal dispose follows', async () => {
    // Control case for the race tests: the happy path still ends each span once.
    const { tracer, spans } = makeRecordingTracer()
    const telemetry = makeSnifferTelemetry()

    await drive(
      tracer,
      Effect.gen(function* () {
        yield* telemetry.start
        yield* telemetry.dispose
      })
    )

    expect(named(spans, Telemetry.Sniffing.Session.Span.Name).length).toBe(1)
    expect(named(spans, Telemetry.Sniffing.InitialLoad.Span.Name).length).toBe(1)
    for (const s of spans) expect(s.endCount).toBe(1)
  })
})
