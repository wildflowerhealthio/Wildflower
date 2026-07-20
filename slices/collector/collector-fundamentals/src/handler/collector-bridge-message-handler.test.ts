// oxlint-disable typescript-eslint/no-unsafe-assignment -- vitest matchers and `vi.fn()` call args are typed as `any`; the unsafe-assignment lint fires on idiomatic `mock.calls[0]` access here

import { Duration, Effect, Layer, Option, Schema, TestClock, TestContext } from 'effect'
import { LoggingLayerTest } from 'kitchen-sink/test'
import { describe, expect, it, vi } from 'vite-plus/test'

import {
  EntityDefinition,
  ScrapingPlan,
  type Step,
  type WebViewSource,
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
  type SimpleHandlerArgs,
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
        // Arms the delay timer; nothing dispatched yet.
        yield* handler.PageLoaded(pageLoaded())
        expect(sendMessage).not.toHaveBeenCalled()

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
        expect(sendMessage).not.toHaveBeenCalled()
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
        // `SniffingComplete` → the stream closes.
        yield* handler.PageLoaded(pageLoaded())
        yield* settleForkedWork
        expect(sendMessage).toHaveBeenCalledOnce()
        expect(sendMessage.mock.calls[0][0]).toEqual({ _tag: 'SniffingComplete' })
        expect(Option.isNone(yield* handler.requestSniffingResults.size)).toBe(true)
      }).pipe(Effect.provide(Layer.mergeAll(TestContext.TestContext, adapterLayer)))
    ))

  it('injects a follow-up Open, dedups the repeated URI, and completes after the last settle', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sendMessage = vi.fn<SendMessage>(() => Effect.void)
        // Every parse links back to the *same* second page — the repeat is
        // dropped by URI dedup, which is what terminates the crawl.
        const handler = makeGeneratingHandler({
          sendMessage,
          followUpSteps: () => [openStepFor('https://example.com/people/2')],
        })

        // First page settles → generates Open(/people/2), which dispatches now
        // (the machine is drained) without waiting for a PageLoaded.
        yield* handler.ResponseStart(
          responseStart({ id: 'r1', url: 'https://example.com/people/1' })
        )
        yield* handler.PageLoaded(pageLoaded({ url: 'https://example.com/people/1' }))
        yield* settleRequest(handler, 'r1', { name: 'Ada', age: 36 })
        expect(dispatchedOpens(sendMessage)).toEqual(['https://example.com/people/2'])

        // Second page settles → its follow-up repeats /people/2 → dedup drops it →
        // queue drains onto an empty map → SniffingComplete → close.
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
})

// Helpers

type Person = { name: string; age: number }
type SendMessage = (
  message: CollectorBridgeMessageHandler.OutboundMessage
) => Effect.Effect<void, never, never>

const PersonSchema = Schema.Struct({ name: Schema.String, age: Schema.Number })

const linkA: Step.Step = {
  _tag: 'Navigation',
  action: { _tag: 'Open', source: { _tag: 'Uri', uri: 'https://example.com/a' } },
}

const delayStep = (duration: Duration.Duration): Step.Step => ({ _tag: 'Delay', duration })

/** A `Navigation`/`Open` step targeting `uri` (the shape `followUpSteps` returns). */
const openStepFor = (uri: string): Step.Step => ({
  _tag: 'Navigation',
  action: { _tag: 'Open', source: { _tag: 'Uri', uri } },
})

/** The `Uri`s of the `Open` navigations sent so far, in order (ignores the terminal). */
const dispatchedOpens = (sendMessage: ReturnType<typeof vi.fn<SendMessage>>): string[] =>
  sendMessage.mock.calls
    .map((call) => call[0])
    .filter((m): m is Extract<typeof m, { _tag: 'Open' }> => m._tag === 'Open')
    .map((m) => (m.source._tag === 'Uri' ? m.source.uri : ''))

/**
 * Build a handler whose single entity parses a JSON person and generates the
 * given `followUpSteps`. `firstPage` defaults to `/people/1` (seeding the dedup
 * visited-set), the step sequence is empty (the crawl is driven entirely by
 * generation).
 */
const makeGeneratingHandler = (opts: {
  readonly sendMessage: SendMessage
  readonly followUpSteps: EntityDefinition.EntityDefinition<Person>['followUpSteps']
  readonly maxGeneratedSteps?: number
  readonly firstPage?: WebViewSource.Any
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
        firstPage: opts.firstPage ?? { _tag: 'Uri', uri: 'https://example.com/people/1' },
        stepSequence: [],
        maxGeneratedSteps: opts.maxGeneratedSteps,
      }),
      sendMessage: opts.sendMessage,
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

/**
 * Let the forked `RequestCompletionCheck` daemon run to completion. It sleeps
 * nothing, so cooperative yields (not a clock tick) are what let it re-enter the
 * machine and drive `SniffingComplete`; bounded so a genuine hang still fails.
 */
const settleForkedWork: Effect.Effect<void> = Effect.gen(function* () {
  for (let i = 0; i < 20; i += 1) {
    yield* Effect.yieldNow()
  }
})
