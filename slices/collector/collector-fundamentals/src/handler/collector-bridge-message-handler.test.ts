// oxlint-disable typescript-eslint/no-unsafe-assignment -- vitest matchers and `vi.fn()` call args are typed as `any`; the unsafe-assignment lint fires on idiomatic `mock.calls[0]` access here

import { Duration, Effect, Layer, Option, Schema, TestClock, TestContext } from 'effect'
import { LoggingLayerTest } from 'kitchen-sink/test'
import { describe, expect, it, vi } from 'vite-plus/test'

import { OpenMessage } from 'collector-fundamentals/bridge'
import {
  EntityDefinition,
  ScrapingPlan,
  type Step,
  UrlMatch,
  WebViewSource,
} from 'collector-fundamentals/model'
import type { TransportAdapter } from 'effect-messaging-core'

import {
  adapterLayer,
  drainResults,
  makeSimpleHandler,
  pageLoaded,
  responseData,
  responseFinished,
  responseStart,
  settleForkedWork,
  type SimpleHandlerArgs,
  snifferDisposed,
  userDismissed,
} from './collector-bridge-message-handler.test-helpers.ts'
import * as CollectorBridgeMessageHandler from './collector-bridge-message-handler.ts'

/**
 * Cross-machine integration: `make` composes the response tracker, the
 * automatic-navigation machine, and the run lifecycle into one surface. These
 * cases pin the composition seams the per-part suites can't reach on their own:
 * `cancelAllRequestSniffing` folding *both* machines' teardown, the end-to-end
 * completion coupling (queue drained ∧ requests settled → `SniffingComplete` →
 * stream closed), and the `followUpSteps` → dedup/cap → queue injection path.
 */
describe('CollectorBridgeMessageHandler.make: composition', () => {
  it('startAutomaticNavigation dispatches the plan’s leading Open without a PageLoaded', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sendMessage = vi.fn<SimpleHandlerArgs['sendMessage']>(() => Effect.void)
        // Leading Open, then a page hold so the run parks rather than draining to
        // completion — isolating the start-up dispatch. `awaitSettledFor('1')`
        // matches `…/people/1`, which the Open's url does not, so it stays parked.
        const handler = makeSimpleHandler({
          sendMessage,
          stepSequence: [linkA, awaitSettledFor('1')],
        })

        // The runner fires this at run start; the leading Open dispatches with
        // no page in hand and builds the sniffer directly on the real URL — a
        // sniffer whose first page never settles can't strand the run in the
        // machine's timer-less start-up state.
        yield* handler.startAutomaticNavigation
        expect(dispatchedOpens(sendMessage)).toEqual(['https://example.com/a'])
      }).pipe(Effect.provide(Layer.mergeAll(TestContext.TestContext, adapterLayer)))
    ))

  it('cancelAllRequestSniffing cancels each incomplete id AND stops the automatic navigation', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sendMessage = vi.fn<SimpleHandlerArgs['sendMessage']>(() => Effect.void)
        const cancelSend = vi.fn<SimpleHandlerArgs['sendMessage']>(() => Effect.void)
        // A trailing `Delay` parks the machine in `DelayPending` with a live
        // timer, so stopping it is observable: `linkA` after the delay must never
        // dispatch once the timer is interrupted.
        const handler = makeSimpleHandler({
          sendMessage,
          stepSequence: [delayStep(Duration.seconds(5)), linkA],
        })

        yield* handler.ResponseStart(
          responseStart({ id: 'r1', url: 'https://example.com/people/1' })
        )
        yield* handler.ResponseStart(
          responseStart({ id: 'r2', url: 'https://example.com/people/2' })
        )
        // Arms the delay timer; the delay step's name is pushed to the chrome,
        // but nothing is *dispatched* yet.
        yield* handler.PageLoaded(pageLoaded())
        expect(dispatched(sendMessage)).toEqual([])

        yield* handler.cancelAllRequestSniffing(cancelSend)

        // Tracker half: one CancelSnifferRequest per id.
        expect(cancelSend).toHaveBeenCalledTimes(2)
        expect(cancelSend.mock.calls.map((call) => call[0])).toEqual(
          expect.arrayContaining([
            { _tag: 'CancelSnifferRequest', id: 'r1' },
            { _tag: 'CancelSnifferRequest', id: 'r2' },
          ])
        )

        // Navigation half: the interrupted delay timer never processes `linkA`.
        yield* TestClock.adjust(Duration.seconds(5))
        yield* Effect.yieldNow()
        expect(dispatched(sendMessage)).toEqual([])
      }).pipe(Effect.provide(Layer.mergeAll(TestContext.TestContext, adapterLayer)))
    ))

  it('an empty step sequence completes on the first PageLoaded once nothing is incomplete', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sendMessage = vi.fn<SimpleHandlerArgs['sendMessage']>(() => Effect.void)
        const handler = makeSimpleHandler({ sendMessage, stepSequence: [] })
        expect(Option.isNone(yield* handler.requestSniffingResults.size)).toBe(false)

        // No request is tracked (the PageLoaded url matches no entity), so the
        // queue drains onto an empty map and the forked completion check drives
        // completion: a terminal `SetSnifferStatus('Done')` chrome label, then
        // `SniffingComplete` → the stream closes.
        yield* handler.PageLoaded(pageLoaded())
        yield* settleForkedWork
        expect(sendMessage).toHaveBeenCalledTimes(2)
        expect(sendMessage.mock.calls[0][0]).toEqual({ _tag: 'SetSnifferStatus', name: 'Done' })
        expect(sendMessage.mock.calls[1][0]).toEqual({ _tag: 'SniffingComplete' })
        expect(Option.isNone(yield* handler.requestSniffingResults.size)).toBe(true)
      }).pipe(Effect.provide(Layer.mergeAll(TestContext.TestContext, adapterLayer)))
    ))

  it('injects a follow-up Open + hold, dedups the repeated URI, and completes after the last settle', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sendMessage = vi.fn<SendMessage>(() => Effect.void)
        // A follow-up `Open` dispatches and advances immediately (the new model),
        // so a bare `Open` would drain onto an empty map and let the run complete
        // before its page is ever sniffed. The crawl therefore pairs the `Open`
        // with a trailing `AwaitPageSettled` hold that keeps the run open until
        // /people/2 loads. /people/2 then links back to itself, but as a *bare*
        // `Open` (no hold) — URI dedup drops that repeat cleanly, so nothing
        // dangles and the crawl terminates on the last settle.
        const handler = makeGeneratingHandler({
          sendMessage,
          followUpSteps: (_resources, response) =>
            response.url.endsWith('/people/1')
              ? [openStepFor('https://example.com/people/2'), awaitSettledFor('2')]
              : [openStepFor('https://example.com/people/2')],
        })

        // First page settles → dispatches Open(/people/2) and parks on the hold,
        // so r1 settling does NOT complete the run — it stays open for /people/2.
        yield* handler.ResponseStart(
          responseStart({ id: 'r1', url: 'https://example.com/people/1' })
        )
        yield* handler.PageLoaded(pageLoaded({ url: 'https://example.com/people/1' }))
        yield* settleRequest(handler, 'r1', { name: 'Ada', age: 36 })
        expect(dispatchedOpens(sendMessage)).toEqual(['https://example.com/people/2'])

        // /people/2 loads → releases the hold → is tracked and settles → its
        // follow-up repeats /people/2 → dedup drops it → queue drains onto an
        // empty map → SniffingComplete → close.
        yield* handler.ResponseStart(
          responseStart({ id: 'r2', url: 'https://example.com/people/2' })
        )
        yield* handler.PageLoaded(pageLoaded({ url: 'https://example.com/people/2' }))
        yield* settleRequest(handler, 'r2', { name: 'Alan', age: 41 })

        // Exactly one generated Open (the repeat was deduped) and one terminal.
        expect(dispatchedOpens(sendMessage)).toEqual(['https://example.com/people/2'])
        expect(sendMessage.mock.calls.at(-1)?.[0]).toEqual({ _tag: 'SniffingComplete' })
        // Both results were published; draining them empties the now-closed stream.
        expect(drainResults(handler)).toHaveLength(2)
        expect(Option.isNone(yield* handler.requestSniffingResults.size)).toBe(true)
      }).pipe(Effect.provide(Layer.mergeAll(TestContext.TestContext, adapterLayer)))
    ))

  it('drops generated steps beyond maxGeneratedSteps and WARN-logs the count', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sendMessage = vi.fn<SendMessage>(() => Effect.void)
        // Cap at 1: the first generated Open dispatches, the second is dropped.
        const handler = makeGeneratingHandler({
          sendMessage,
          maxGeneratedSteps: 1,
          followUpSteps: () => [
            openStepFor('https://example.com/people/a'),
            openStepFor('https://example.com/people/b'),
          ],
        })

        yield* handler.ResponseStart(
          responseStart({ id: 'r1', url: 'https://example.com/people/1' })
        )
        yield* handler.PageLoaded(pageLoaded({ url: 'https://example.com/people/1' }))
        yield* settleRequest(handler, 'r1', { name: 'Ada', age: 36 }).pipe(
          LoggingLayerTest.expectToLog((logs) => {
            expect(logs).toContainEqual(
              expect.objectContaining({
                level: 'WARN',
                message: expect.stringContaining('maxGeneratedSteps (1) reached; dropped 1'),
              })
            )
          }),
          Effect.scoped
        )

        // Only the first generated Open dispatched; the cap dropped the second.
        expect(dispatchedOpens(sendMessage)).toEqual(['https://example.com/people/a'])
      }).pipe(Effect.provide(Layer.mergeAll(TestContext.TestContext, adapterLayer)))
    ))

  describe('AwaitUserDismiss against the real run lifecycle', () => {
    // These exercise the composition rather than the FSM alone. The machine's own
    // tests stub `onSniffingComplete`, so they cannot see what the *lifecycle*
    // does with a terminal — and the whole hazard here is that a dismissal could
    // fire `SniffingComplete` while requests are still incomplete, which
    // `handleSniffingComplete` answers by leaving the results stream open forever.

    it('keeps the run open when the user dismisses with a request still in flight, then completes on its settle', () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const handler = makeSimpleHandler({
            sendMessage,
            stepSequence: [awaitUserDismissStep()],
          })

          // A request is sniffed and still accumulating when the user closes the
          // window — the realistic case: they finished their manual step while an
          // XHR the page kicked off is mid-flight.
          yield* handler.ResponseStart(
            responseStart({ id: 'r1', url: 'https://example.com/people/1' })
          )
          yield* handler.PageLoaded(pageLoaded())
          yield* handler.UserDismissed(userDismissed())
          yield* settleForkedWork

          // The run must NOT have completed: `SniffingComplete` here would be
          // dispatched against a non-empty incomplete map, and the lifecycle only
          // closes the stream when that map is empty — so the stream would never
          // close and the run would hang indefinitely (there is no idle backstop).
          expect(dispatched(sendMessage)).toEqual([])
          expect(Option.isNone(yield* handler.requestSniffingResults.size)).toBe(false)

          // The webview stayed alive and the request finished. *Now* the run ends,
          // through the ordinary gate, and the result is not lost.
          yield* settleRequest(handler, 'r1', { name: 'Ada', age: 36 })
          yield* settleForkedWork
          expect(dispatched(sendMessage)).toEqual([{ _tag: 'SniffingComplete' }])
          expect(drainResults(handler)).toHaveLength(1)
          expect(Option.isNone(yield* handler.requestSniffingResults.size)).toBe(true)
        }).pipe(Effect.provide(Layer.mergeAll(TestContext.TestContext, adapterLayer)))
      ))

    it('completes promptly when the user dismisses with nothing in flight', () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const handler = makeSimpleHandler({
            sendMessage,
            stepSequence: [awaitUserDismissStep()],
          })

          yield* handler.PageLoaded(pageLoaded())
          expect(dispatched(sendMessage)).toEqual([]) // parked on the hold

          yield* handler.UserDismissed(userDismissed())
          yield* settleForkedWork
          expect(dispatched(sendMessage)).toEqual([{ _tag: 'SniffingComplete' }])
          expect(Option.isNone(yield* handler.requestSniffingResults.size)).toBe(true)
        }).pipe(Effect.provide(Layer.mergeAll(TestContext.TestContext, adapterLayer)))
      ))

    it('wraps up when the sniffer webview is disposed while the hold is waiting', () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const handler = makeSimpleHandler({
            sendMessage,
            stepSequence: [awaitUserDismissStep()],
          })

          yield* handler.PageLoaded(pageLoaded())
          // The window is gone (plugin lifetime cap, app quit): nothing will ever
          // deliver the dismissal the hold is waiting for.
          yield* handler.SnifferDisposed(snifferDisposed())
          yield* settleForkedWork
          expect(dispatched(sendMessage)).toEqual([{ _tag: 'SniffingComplete' }])
          expect(Option.isNone(yield* handler.requestSniffingResults.size)).toBe(true)
        }).pipe(Effect.provide(Layer.mergeAll(TestContext.TestContext, adapterLayer)))
      ))

    it('leaves a run without the step untouched when a dismiss or dispose arrives', () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          // A trailing hold keeps the run open, so an incidental signal that
          // wrongly ended it would be visible as an early terminal.
          const handler = makeSimpleHandler({
            sendMessage,
            stepSequence: [awaitSettledFor('never')],
          })

          yield* handler.ResponseStart(
            responseStart({ id: 'r1', url: 'https://example.com/people/1' })
          )
          yield* handler.PageLoaded(pageLoaded())
          yield* handler.UserDismissed(userDismissed())
          yield* handler.SnifferDisposed(snifferDisposed())
          yield* settleForkedWork

          // Neither signal is meaningful here — the run is still going.
          expect(dispatched(sendMessage)).toEqual([])
          expect(Option.isNone(yield* handler.requestSniffingResults.size)).toBe(false)
        }).pipe(Effect.provide(Layer.mergeAll(TestContext.TestContext, adapterLayer)))
      ))
  })
})

// Helpers

type Person = { name: string; age: number }
type SendMessage = (
  message: CollectorBridgeMessageHandler.OutboundMessage
) => Effect.Effect<void, never, never>

const PersonSchema = Schema.Struct({ name: Schema.String, age: Schema.Number })

const linkA: Step.Step = {
  _tag: 'Navigation',
  name: 'open a',
  action: { _tag: 'Open', source: { _tag: 'Uri', uri: 'https://example.com/a' } },
}

const delayStep = (duration: Duration.Duration): Step.Step => ({
  _tag: 'Delay',
  name: 'delay',
  duration,
})

/** A `Navigation`/`Open` step targeting `uri` (the shape `followUpSteps` returns). */
const openStepFor = (uri: string): Step.Step => ({
  _tag: 'Navigation',
  name: `open ${uri}`,
  action: { _tag: 'Open', source: { _tag: 'Uri', uri } },
})

/** A terminal hold that parks until the user closes the sniffer webview. */
const awaitUserDismissStep = (timeout = Duration.minutes(10)): Step.Step => ({
  _tag: 'AwaitUserDismiss',
  name: 'await dismiss',
  timeout,
})

/**
 * An `AwaitPageSettled` hold matching `…/people/<segment>` — a `followUpSteps`
 * crawl trails one after its `Open` so the run stays open until the opened page
 * settles (a bare `Open` dispatches and advances without waiting).
 */
const awaitSettledFor = (segment: string): Step.Step => ({
  _tag: 'AwaitPageSettled',
  name: `await people/${segment}`,
  pattern: UrlMatch.make({ segments: [UrlMatch.literal('people'), UrlMatch.literal(segment)] }),
  timeout: Duration.seconds(30),
})

const isOpenMessage = Schema.is(OpenMessage)
const isUriSource = Schema.is(WebViewSource.UriSchema)

/** The `Uri`s of the `Open` navigations sent so far, in order (ignores the terminal). */
const dispatchedOpens = (sendMessage: ReturnType<typeof vi.fn<SendMessage>>): string[] =>
  sendMessage.mock.calls
    .map((call) => call[0])
    .filter(isOpenMessage)
    .map((m) => (isUriSource(m.source) ? m.source.uri : ''))

/**
 * The messages the machine actually *dispatched*, with the per-step
 * `SetSnifferStatus` chrome-label pushes filtered out. Every step emits one
 * before its own effect, so a "no navigation dispatched yet" assertion checks
 * this rather than the raw call count.
 */
const dispatched = (
  sendMessage: ReturnType<typeof vi.fn<SendMessage>>
): readonly CollectorBridgeMessageHandler.OutboundMessage[] =>
  sendMessage.mock.calls
    .map((call) => call[0])
    .filter((message) => message._tag !== 'SetSnifferStatus')

/**
 * Build a handler whose single entity parses a JSON person and generates the
 * given `followUpSteps`. The step sequence is empty (the crawl is driven
 * entirely by generation, and these tests simulate the page events directly),
 * so the dedup visited-set starts empty and grows only from generated `Open`s.
 */
const makeGeneratingHandler = (opts: {
  readonly sendMessage: SendMessage
  readonly followUpSteps: EntityDefinition.EntityDefinition<Person>['followUpSteps']
  readonly maxGeneratedSteps?: number
}): CollectorBridgeMessageHandler.CollectorBridgeMessageHandler<Person> =>
  Effect.runSync(
    CollectorBridgeMessageHandler.make<Person>({
      scrapingPlan: ScrapingPlan.make<Person>({
        name: 'GeneratingPlan',
        entityDefinitions: [
          EntityDefinition.make<Person>({
            name: 'PersonEntity',
            isFoundAt: (url) => /\/people\//.test(url),
            parse: (response) =>
              Effect.map(Schema.decode(Schema.parseJson(PersonSchema))(response.text()), (p) => [
                p,
              ]),
            followUpSteps: opts.followUpSteps,
          }),
        ],
        stepSequence: [],
        maxGeneratedSteps: opts.maxGeneratedSteps,
      }),
      sendMessage: opts.sendMessage,
      runId: 'test-run',
    })
  )

/** Feed a valid person body to a tracked request and finish it. */
const settleRequest = (
  handler: CollectorBridgeMessageHandler.CollectorBridgeMessageHandler<Person>,
  id: string,
  person: Person
): Effect.Effect<void, never, TransportAdapter> =>
  Effect.gen(function* () {
    yield* handler.ResponseData(responseData(id, JSON.stringify(person)))
    yield* handler.ResponseFinished(responseFinished(id))
  })
