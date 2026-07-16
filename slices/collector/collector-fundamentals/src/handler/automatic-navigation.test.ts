// oxlint-disable typescript-eslint/no-unsafe-assignment -- vitest matchers and `vi.fn()` call args are typed as `any`; the unsafe-assignment / unsafe-destructure lint fires on idiomatic `mock.calls[0]` access here

import { Duration, Effect, TestClock, TestContext } from 'effect'
import { LoggingLayerTest } from 'kitchen-sink/test'
import { describe, expect, it, vi } from 'vite-plus/test'

import { type Step, ScrapingPlan, UrlMatch } from 'collector-fundamentals/model'
import {
  type AutomaticNavigation,
  make,
  type StepOutboundMessage,
} from './automatic-navigation/index.ts'

/**
 * Build an automatic-navigation machine directly (not via
 * `CollectorBridgeMessageHandler`), so this suite exercises the machine in
 * isolation; the composition with the response tracker is covered by
 * `collector-bridge-message-handler.test.ts`. The machine ignores
 * `entityDefinitions`, so the plan carries an empty list.
 */
const makeMachine = (options: {
  readonly sendMessage: (message: StepOutboundMessage) => Effect.Effect<void, never, never>
  readonly onSniffingComplete?: Effect.Effect<void, never, never>
  readonly stepSequence?: readonly Step.Step[]
  readonly stepDelay?: Duration.Duration
}): AutomaticNavigation =>
  Effect.runSync(
    make({
      scrapingPlan: ScrapingPlan.make({
        name: 'TestPlan',
        entityDefinitions: [],
        firstPage: { _tag: 'Uri', uri: 'https://example.com/' },
        stepSequence: options.stepSequence ?? [],
        stepDelay: options.stepDelay ?? Duration.seconds(5),
      }),
      sendMessage: options.sendMessage,
      // The composition wires this to the run lifecycle's `markSniffingComplete`;
      // the machine treats it opaquely. Tests default to a no-op unless they
      // assert it fired.
      onSniffingComplete: options.onSniffingComplete ?? Effect.void,
    })
  )

type SendMessage = (message: StepOutboundMessage) => Effect.Effect<void, never, never>

/** The decoded `PageLoaded` bridge message the machine's handler accepts. */
const pageLoaded = (
  url = 'https://example.com/'
): { readonly _tag: 'PageLoaded'; readonly url: string; readonly pageContentId: string } => ({
  _tag: 'PageLoaded',
  url,
  pageContentId: 'page-1',
})

describe('automatic-navigation.make: automatic navigation', () => {
  describe('PageLoaded', () => {
    const linkA: Step.Step = {
      action: { _tag: 'Open', source: { _tag: 'Uri', uri: 'https://example.com/a' } },
    }
    const linkB: Step.Step = {
      action: { _tag: 'Open', source: { _tag: 'Uri', uri: 'https://example.com/b' } },
    }
    const fillLink: Step.Step = {
      action: {
        _tag: 'PageAction',
        action: { kind: 'Fill', querySelector: '#username', value: 'alice' },
      },
    }
    // A step gated on landing at `…/dashboard`, timing out after 30s.
    const dashboardPattern = UrlMatch.make({ segments: [UrlMatch.literal('dashboard')] })
    const urlMatchLink: Step.Step = {
      action: { _tag: 'Open', source: { _tag: 'Uri', uri: 'https://example.com/next' } },
      advanceWhen: { _tag: 'UrlMatch', pattern: dashboardPattern, timeout: Duration.seconds(30) },
    }

    it('dispatches SniffingComplete after stepDelay when stepSequence is empty', () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [] })

          yield* machine.PageLoaded(pageLoaded())
          expect(sendMessage).not.toHaveBeenCalled()

          yield* TestClock.adjust(Duration.seconds(5))
          yield* Effect.yieldNow()
          expect(sendMessage).toHaveBeenCalledOnce()
          expect(sendMessage.mock.calls[0][0]).toEqual({ _tag: 'SniffingComplete' })
        }).pipe(Effect.provide(TestContext.TestContext))
      ))

    it('runs the onSniffingComplete hook when it dispatches SniffingComplete', () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          let completed = 0
          const machine = makeMachine({
            sendMessage,
            onSniffingComplete: Effect.sync(() => {
              completed += 1
            }),
            stepSequence: [],
          })

          yield* machine.PageLoaded(pageLoaded())
          yield* TestClock.adjust(Duration.seconds(5))
          yield* Effect.yieldNow()

          expect(sendMessage.mock.calls[0][0]).toEqual({ _tag: 'SniffingComplete' })
          // The hook fires exactly once, after the terminal message is sent.
          expect(completed).toBe(1)
        }).pipe(Effect.provide(TestContext.TestContext))
      ))

    it('dispatches each link in order, separated by stepDelay, then SniffingComplete', () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [linkA, linkB] })

          yield* machine.PageLoaded(pageLoaded('https://example.com/'))
          yield* TestClock.adjust(Duration.seconds(5))
          yield* Effect.yieldNow()
          expect(sendMessage).toHaveBeenCalledTimes(1)
          expect(sendMessage.mock.calls[0][0]).toEqual(linkA.action)

          yield* machine.PageLoaded(pageLoaded('https://example.com/a'))
          yield* TestClock.adjust(Duration.seconds(5))
          yield* Effect.yieldNow()
          expect(sendMessage).toHaveBeenCalledTimes(2)
          expect(sendMessage.mock.calls[1][0]).toEqual(linkB.action)

          yield* machine.PageLoaded(pageLoaded('https://example.com/b'))
          yield* TestClock.adjust(Duration.seconds(5))
          yield* Effect.yieldNow()
          expect(sendMessage).toHaveBeenCalledTimes(3)
          expect(sendMessage.mock.calls[2][0]).toEqual({ _tag: 'SniffingComplete' })
        }).pipe(Effect.provide(TestContext.TestContext))
      ))

    it('a second PageLoaded during the wait interrupts the pending timer and re-arms for the same index', () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [linkA, linkB] })

          yield* machine.PageLoaded(pageLoaded('https://example.com/'))
          yield* TestClock.adjust(Duration.seconds(3))
          yield* Effect.yieldNow()
          expect(sendMessage).not.toHaveBeenCalled()

          yield* machine.PageLoaded(pageLoaded('https://example.com/'))
          yield* TestClock.adjust(Duration.seconds(3))
          yield* Effect.yieldNow()
          expect(sendMessage).not.toHaveBeenCalled()

          yield* TestClock.adjust(Duration.seconds(2))
          yield* Effect.yieldNow()
          expect(sendMessage).toHaveBeenCalledTimes(1)
          expect(sendMessage.mock.calls[0][0]).toEqual(linkA.action)
        }).pipe(Effect.provide(TestContext.TestContext))
      ))

    it('warns and no-ops on PageLoaded after SniffingComplete has fired', () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [] })

          yield* machine.PageLoaded(pageLoaded())
          yield* TestClock.adjust(Duration.seconds(5))
          yield* Effect.yieldNow()
          expect(sendMessage).toHaveBeenCalledOnce()

          yield* machine.PageLoaded(pageLoaded('https://example.com/next')).pipe(
            LoggingLayerTest.expectToLog((logs) => {
              expect(logs).toEqual([
                expect.objectContaining({
                  level: 'WARN',
                  message: expect.stringContaining(
                    'CollectorBridgeMessageHandler.PageLoaded: handler is done'
                  ),
                }),
              ])
            }),
            Effect.scoped
          )

          yield* TestClock.adjust(Duration.seconds(5))
          yield* Effect.yieldNow()
          expect(sendMessage).toHaveBeenCalledOnce()
        }).pipe(Effect.provide(TestContext.TestContext))
      ))

    it('stopAutomaticNavigation() interrupts the pending step timer', () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [linkA] })

          yield* machine.PageLoaded(pageLoaded())
          yield* machine.stopAutomaticNavigation()
          yield* TestClock.adjust(Duration.seconds(5))
          yield* Effect.yieldNow()
          expect(sendMessage).not.toHaveBeenCalled()
        }).pipe(Effect.provide(TestContext.TestContext))
      ))

    it('stopAutomaticNavigation() resets the index so subsequent PageLoadeds restart from stepSequence[0]', () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [linkA, linkB] })

          yield* machine.PageLoaded(pageLoaded())
          yield* TestClock.adjust(Duration.seconds(5))
          yield* Effect.yieldNow()
          expect(sendMessage).toHaveBeenCalledTimes(1)

          yield* machine.stopAutomaticNavigation()

          yield* machine.PageLoaded(pageLoaded())
          yield* TestClock.adjust(Duration.seconds(5))
          yield* Effect.yieldNow()
          expect(sendMessage).toHaveBeenCalledTimes(2)
          expect(sendMessage.mock.calls[1][0]).toEqual(linkA.action)
        }).pipe(Effect.provide(TestContext.TestContext))
      ))

    it('dispatches a PageAction:Fill step verbatim (minus advanceWhen) after stepDelay', () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [fillLink] })

          yield* machine.PageLoaded(pageLoaded())
          yield* TestClock.adjust(Duration.seconds(5))
          yield* Effect.yieldNow()

          expect(sendMessage).toHaveBeenCalledTimes(1)
          // The step's `action` is forwarded untouched; `advanceWhen` (absent
          // here) would ride the wrapper, never this payload.
          expect(sendMessage.mock.calls[0][0]).toEqual({
            _tag: 'PageAction',
            action: { kind: 'Fill', querySelector: '#username', value: 'alice' },
          })
        }).pipe(Effect.provide(TestContext.TestContext))
      ))

    it('never forwards the plan-only advanceWhen on the dispatched action', () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const gatedClick: Step.Step = {
            action: { _tag: 'PageAction', action: { kind: 'Click', querySelector: '#login' } },
            advanceWhen: {
              _tag: 'UrlMatch',
              pattern: dashboardPattern,
              timeout: Duration.seconds(30),
            },
          }
          const machine = makeMachine({ sendMessage, stepSequence: [gatedClick] })

          yield* machine.PageLoaded(pageLoaded('https://example.com/dashboard'))
          yield* TestClock.adjust(Duration.seconds(5))
          yield* Effect.yieldNow()

          expect(sendMessage).toHaveBeenCalledTimes(1)
          const sent = sendMessage.mock.calls[0][0]
          expect(sent).toEqual({
            _tag: 'PageAction',
            action: { kind: 'Click', querySelector: '#login' },
          })
          // The gate lives on the step wrapper; the wire payload never carries it.
          expect(sent).not.toHaveProperty('advanceWhen')
        }).pipe(Effect.provide(TestContext.TestContext))
      ))

    describe('advanceWhen: UrlMatch', () => {
      it('holds the step until a matching PageLoaded, then dispatches after stepDelay', () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const sendMessage = vi.fn<SendMessage>(() => Effect.void)
            const machine = makeMachine({ sendMessage, stepSequence: [urlMatchLink] })

            yield* machine.PageLoaded(pageLoaded('https://example.com/login'))
            yield* TestClock.adjust(Duration.seconds(5))
            yield* Effect.yieldNow()
            expect(sendMessage).not.toHaveBeenCalled()

            yield* machine.PageLoaded(pageLoaded('https://example.com/dashboard'))
            yield* TestClock.adjust(Duration.seconds(5))
            yield* Effect.yieldNow()
            expect(sendMessage).toHaveBeenCalledTimes(1)
            expect(sendMessage.mock.calls[0][0]).toEqual(urlMatchLink.action)
          }).pipe(Effect.provide(TestContext.TestContext))
        ))

      it('aborts via SniffingComplete when no matching PageLoaded arrives within the timeout', () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const sendMessage = vi.fn<SendMessage>(() => Effect.void)
            const machine = makeMachine({ sendMessage, stepSequence: [urlMatchLink] })

            yield* machine.PageLoaded(pageLoaded('https://example.com/login'))
            yield* TestClock.adjust(Duration.seconds(29))
            yield* Effect.yieldNow()
            expect(sendMessage).not.toHaveBeenCalled()

            yield* TestClock.adjust(Duration.seconds(1))
            yield* Effect.yieldNow()
            expect(sendMessage).toHaveBeenCalledTimes(1)
            expect(sendMessage.mock.calls[0][0]).toEqual({ _tag: 'SniffingComplete' })

            yield* machine.PageLoaded(pageLoaded('https://example.com/dashboard')).pipe(
              LoggingLayerTest.expectToLog((logs) => {
                expect(logs).toEqual([
                  expect.objectContaining({
                    level: 'WARN',
                    message: expect.stringContaining(
                      'CollectorBridgeMessageHandler.PageLoaded: handler is done'
                    ),
                  }),
                ])
              }),
              Effect.scoped
            )
            yield* TestClock.adjust(Duration.seconds(5))
            yield* Effect.yieldNow()
            expect(sendMessage).toHaveBeenCalledTimes(1)
          }).pipe(Effect.provide(TestContext.TestContext))
        ))

      it('a matching PageLoaded before the timeout cancels the abort', () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const sendMessage = vi.fn<SendMessage>(() => Effect.void)
            const machine = makeMachine({ sendMessage, stepSequence: [urlMatchLink] })

            yield* machine.PageLoaded(pageLoaded('https://example.com/login'))
            yield* TestClock.adjust(Duration.seconds(10))
            yield* Effect.yieldNow()

            yield* machine.PageLoaded(pageLoaded('https://example.com/dashboard'))
            yield* TestClock.adjust(Duration.seconds(5))
            yield* Effect.yieldNow()
            expect(sendMessage).toHaveBeenCalledTimes(1)
            expect(sendMessage.mock.calls[0][0]).toEqual(urlMatchLink.action)

            yield* TestClock.adjust(Duration.seconds(60))
            yield* Effect.yieldNow()
            expect(sendMessage).toHaveBeenCalledTimes(1)
          }).pipe(Effect.provide(TestContext.TestContext))
        ))

      it('stopAutomaticNavigation() interrupts a pending URL-match timeout', () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const sendMessage = vi.fn<SendMessage>(() => Effect.void)
            const machine = makeMachine({ sendMessage, stepSequence: [urlMatchLink] })

            yield* machine.PageLoaded(pageLoaded('https://example.com/login'))
            yield* machine.stopAutomaticNavigation()
            yield* TestClock.adjust(Duration.seconds(30))
            yield* Effect.yieldNow()
            expect(sendMessage).not.toHaveBeenCalled()
          }).pipe(Effect.provide(TestContext.TestContext))
        ))
    })
  })
})
