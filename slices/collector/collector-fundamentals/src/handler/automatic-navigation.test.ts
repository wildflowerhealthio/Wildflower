// oxlint-disable typescript-eslint/no-unsafe-assignment -- vitest matchers and `vi.fn()` call args are typed as `any`; the unsafe-assignment lint fires on idiomatic `mock.calls[0]` access here

import { Duration, Effect, TestClock, TestContext } from 'effect'
import * as fc from 'fast-check'
import { LoggingLayerTest, numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, vi } from 'vite-plus/test'

import { type Step, ScrapingPlan, UrlMatch } from 'collector-fundamentals/model'
import {
  type AutomaticNavigation,
  make,
  type StepOutboundMessage,
} from './automatic-navigation/index.ts'
import { settleForkedWork } from './collector-bridge-message-handler.test-helpers.ts'

/**
 * The automatic-navigation machine in isolation (not via
 * `CollectorBridgeMessageHandler`) — the composition with the response tracker
 * is covered by `collector-bridge-message-handler.test.ts`. The machine ignores
 * `entityDefinitions`, so the plan carries an empty list.
 *
 * The machine *owns a breadth-first step queue* (seeded from `stepSequence`,
 * grown by `handleStepsGenerated`). Every `Navigation` **dispatches and advances
 * immediately** — no action waits for a `PageLoaded` — so consecutive
 * navigations drain on a single settled load. The only waits are the hold steps:
 * a `Delay` (fixed timer) and an `AwaitPageSettled` (park until a matching
 * settled `PageLoaded`, aborting on its `timeout`). The first `PageLoaded` is
 * start-up: it kicks off draining the queue. Completion is `queue drained
 * (Drained) ∧ NoMoreResultsExpected`.
 */
describe('automatic-navigation.make', () => {
  describe('navigation dispatch', () => {
    it('should drain consecutive navigations on the first settled load, with no settle delay', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [linkA, linkB] })

          // A single PageLoaded drains BOTH — each `Open` dispatches and advances
          // in the same turn. No clock is advanced anywhere.
          yield* machine.handlePageLoaded(pageLoaded('https://example.com/'))
          expect(sendMessage).toHaveBeenCalledTimes(2)
          expect(sendMessage.mock.calls[0][0]).toEqual(linkA.action)
          expect(sendMessage.mock.calls[1][0]).toEqual(linkB.action)
        })
      ))

    it('should chain consecutive PageActions (fill/fill/click) on a single settled load', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({
            sendMessage,
            stepSequence: [
              fillStep('alice'),
              fillStep('hunter2'),
              clickStep('button[type="submit"]'),
            ],
          })

          // A `Fill`/`Click` fires no `PageLoaded`, yet all three dispatch in
          // order off the single start-up load — the whole point of the model.
          yield* machine.handlePageLoaded(pageLoaded('https://example.com/login'))
          expect(sendMessage.mock.calls.map((call) => call[0])).toEqual([
            fillStep('alice').action,
            fillStep('hunter2').action,
            clickStep('button[type="submit"]').action,
          ])
        })
      ))

    it('should dispatch a PageAction step verbatim (no extra step fields on the wire)', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [fillStep('alice')] })

          yield* machine.handlePageLoaded(pageLoaded('https://example.com/login'))

          expect(sendMessage).toHaveBeenCalledTimes(1)
          expect(sendMessage.mock.calls[0][0]).toEqual({
            _tag: 'PageAction',
            action: { kind: 'Fill', querySelector: '#field', value: 'alice' },
          })
        })
      ))

    it('should dispatch every navigation action in queue order, then SniffingComplete', () =>
      fc.assert(
        fc.property(fc.array(fc.webUrl()), (uris) => {
          // Arrange: one ungated Open step per url.
          const steps = uris.map(openStep)
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: steps })

          // Act: a single PageLoaded drains the whole queue (each Open dispatches
          // and advances); NoMoreResultsExpected then completes.
          Effect.runSync(
            Effect.gen(function* () {
              yield* machine.handlePageLoaded(pageLoaded())
              yield* machine.signalNoMoreResultsExpected
            }).pipe(Effect.provide(TestContext.TestContext))
          )

          // Assert: each action in order, then the terminal.
          const sent = sendMessage.mock.calls.map((call) => call[0])
          expect(sent).toEqual([...steps.map((s) => s.action), { _tag: 'SniffingComplete' }])
        }),
        { numRuns: numRunsFor({ base: 100 }) }
      ))
  })

  describe('completion (NoMoreResultsExpected)', () => {
    it('should complete on the first PageLoaded for an empty sequence, once no results remain', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          let completed = 0
          const machine = makeMachine({
            sendMessage,
            stepSequence: [],
            onSniffingComplete: Effect.sync(() => {
              completed += 1
            }),
          })

          // Empty queue drains on the first PageLoaded, but is not terminal yet.
          yield* machine.handlePageLoaded(pageLoaded())
          expect(sendMessage).not.toHaveBeenCalled()

          // No incomplete requests → the lifecycle signals → complete.
          yield* machine.signalNoMoreResultsExpected
          expect(sendMessage).toHaveBeenCalledOnce()
          expect(sendMessage.mock.calls[0][0]).toEqual({ _tag: 'SniffingComplete' })
          expect(completed).toBe(1)
        })
      ))

    it('should not complete before the start-up load while the queue still has steps', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [linkA] })

          // Still AwaitingPageLoaded (start-up) → NoMoreResultsExpected is a no-op.
          yield* machine.signalNoMoreResultsExpected
          expect(sendMessage).not.toHaveBeenCalled()
        })
      ))

    it('should reach Drained immediately after an Open — no implicit page wait', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [linkA] })

          // linkA dispatches AND the queue drains on the same load — the machine
          // does NOT park awaiting linkA's page. So the very next signal completes.
          yield* machine.handlePageLoaded(pageLoaded('https://example.com/'))
          yield* machine.signalNoMoreResultsExpected
          expect(sentTags(sendMessage)).toEqual([linkA.action._tag, 'SniffingComplete'])
        })
      ))

    it('should stay open past an Open when a trailing AwaitPageSettled holds the run', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({
            sendMessage,
            stepSequence: [linkA, awaitSettled('done')],
          })

          // linkA dispatches, then the hold parks the run: not Drained yet.
          yield* machine.handlePageLoaded(pageLoaded('https://example.com/'))
          yield* machine.signalNoMoreResultsExpected
          expect(sentTags(sendMessage)).toEqual([linkA.action._tag]) // no terminal

          // The awaited settled page arrives → queue drains → the signal completes.
          yield* machine.handlePageLoaded(pageLoaded('https://example.com/done'))
          yield* machine.signalNoMoreResultsExpected
          expect(sentTags(sendMessage)).toEqual([linkA.action._tag, 'SniffingComplete'])
        })
      ))

    it('should fire the onDrained hook when the queue drains', () =>
      run(
        Effect.gen(function* () {
          let drainedCount = 0
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({
            sendMessage,
            stepSequence: [],
            onDrained: Effect.sync(() => {
              drainedCount += 1
            }),
          })

          yield* machine.handlePageLoaded(pageLoaded())
          // RequestCompletionCheck forks the onDrained hook.
          yield* settleForkedWork
          expect(drainedCount).toBe(1)
        })
      ))
  })

  describe('follow-up steps (StepsGenerated)', () => {
    it('should re-awaken a drained machine and dispatch without a PageLoaded', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [] })

          yield* machine.handlePageLoaded(pageLoaded()) // → Drained
          expect(sendMessage).not.toHaveBeenCalled()

          // A generated step dispatches immediately — the machine is idle.
          yield* machine.handleStepsGenerated([linkA])
          expect(sendMessage).toHaveBeenCalledTimes(1)
          expect(sendMessage.mock.calls[0][0]).toEqual(linkA.action)
        })
      ))

    it('should append generated steps to the back of the queue (breadth-first)', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({
            sendMessage,
            // A hold sits between linkA and linkB so the machine rests mid-queue
            // when linkC is generated — otherwise the whole queue would drain at
            // once and there'd be no "back of the queue" to observe.
            stepSequence: [linkA, awaitSettled('gate'), linkB],
          })

          yield* machine.handlePageLoaded(pageLoaded('https://example.com/')) // dispatch linkA, park on hold
          // linkC is generated mid-run: it queues *after* the remaining linkB.
          yield* machine.handleStepsGenerated([linkC])
          yield* machine.handlePageLoaded(pageLoaded('https://example.com/gate')) // release hold → linkB, linkC

          expect(sendMessage.mock.calls.map((call) => call[0])).toEqual([
            linkA.action,
            linkB.action,
            linkC.action,
          ])
        })
      ))

    it('should drop and WARN follow-up steps generated after the run completed', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [] })

          yield* machine.handlePageLoaded(pageLoaded())
          yield* machine.signalNoMoreResultsExpected // → Done
          expect(sentTags(sendMessage)).toEqual(['SniffingComplete'])

          yield* machine.handleStepsGenerated([linkA]).pipe(
            LoggingLayerTest.expectToLog((logs) => {
              expect(logs).toContainEqual(
                expect.objectContaining({
                  level: 'WARN',
                  message: expect.stringContaining('generated after the run completed'),
                })
              )
            }),
            Effect.scoped
          )
          // No further dispatch — the machine is terminal.
          expect(sentTags(sendMessage)).toEqual(['SniffingComplete'])
        })
      ))
  })

  describe('Delay steps', () => {
    it('should wait out a Delay before processing the next step', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [delayStep(five), linkA] })

          yield* machine.handlePageLoaded(pageLoaded())
          yield* TestClock.adjust(Duration.seconds(4))
          yield* Effect.yieldNow()
          expect(sendMessage).not.toHaveBeenCalled()

          yield* TestClock.adjust(Duration.seconds(1))
          yield* Effect.yieldNow()
          expect(sendMessage).toHaveBeenCalledTimes(1)
          expect(sendMessage.mock.calls[0][0]).toEqual(linkA.action)
        })
      ))

    it('should chain consecutive Delays before the next step', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({
            sendMessage,
            stepSequence: [delayStep(Duration.seconds(3)), delayStep(Duration.seconds(2)), linkA],
          })

          yield* machine.handlePageLoaded(pageLoaded())
          yield* TestClock.adjust(Duration.seconds(3))
          yield* Effect.yieldNow()
          expect(sendMessage).not.toHaveBeenCalled() // second delay now running

          yield* TestClock.adjust(Duration.seconds(2))
          yield* Effect.yieldNow()
          expect(sendMessage).toHaveBeenCalledTimes(1)
          expect(sendMessage.mock.calls[0][0]).toEqual(linkA.action)
        })
      ))

    it('should not re-arm the Delay timer on extra PageLoadeds during the wait', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [delayStep(five), linkA] })

          yield* machine.handlePageLoaded(pageLoaded()) // arm 5s at t=0
          yield* TestClock.adjust(Duration.seconds(3)) // t=3
          // A second PageLoaded must NOT restart the 5s window.
          yield* machine.handlePageLoaded(pageLoaded('https://example.com/x'))
          yield* TestClock.adjust(Duration.seconds(2)) // t=5: original window elapses
          yield* Effect.yieldNow()
          expect(sendMessage).toHaveBeenCalledTimes(1)
          expect(sendMessage.mock.calls[0][0]).toEqual(linkA.action)
        })
      ))

    it('should postpone reaching Drained with a trailing Delay', () =>
      run(
        Effect.gen(function* () {
          let drainedCount = 0
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({
            sendMessage,
            stepSequence: [linkA, delayStep(five)],
            onDrained: Effect.sync(() => {
              drainedCount += 1
            }),
          })

          // One load dispatches linkA and arms the trailing delay in the same turn.
          yield* machine.handlePageLoaded(pageLoaded('https://example.com/'))
          yield* settleForkedWork
          expect(drainedCount).toBe(0) // still delaying, not drained

          yield* TestClock.adjust(five)
          yield* settleForkedWork
          expect(drainedCount).toBe(1) // delay elapsed → Drained → onDrained fires
        })
      ))
  })

  describe('AwaitPageSettled', () => {
    it('should hold until a matching settled load, then resume draining', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({
            sendMessage,
            stepSequence: [awaitSettled('dashboard'), linkA],
          })

          yield* machine.handlePageLoaded(pageLoaded('https://example.com/login'))
          expect(sendMessage).not.toHaveBeenCalled() // login ≠ dashboard → parked

          // On match the hold is consumed and the tail drains — linkA dispatches.
          yield* machine.handlePageLoaded(pageLoaded('https://example.com/dashboard'))
          expect(sendMessage).toHaveBeenCalledTimes(1)
          expect(sendMessage.mock.calls[0][0]).toEqual(linkA.action)
        })
      ))

    it('should be satisfied immediately when the page in hand already matches', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [awaitSettled('login'), linkA] })

          // The start-up load is already on the awaited page → the hold passes
          // through in the same drain and linkA dispatches at once.
          yield* machine.handlePageLoaded(pageLoaded('https://example.com/login'))
          expect(sendMessage).toHaveBeenCalledTimes(1)
          expect(sendMessage.mock.calls[0][0]).toEqual(linkA.action)
        })
      ))

    it('should abort via SniffingComplete when no matching settled load arrives within the timeout', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({
            sendMessage,
            stepSequence: [awaitSettled('dashboard'), linkA],
          })

          yield* machine.handlePageLoaded(pageLoaded('https://example.com/login'))
          yield* TestClock.adjust(Duration.seconds(29))
          yield* Effect.yieldNow()
          expect(sendMessage).not.toHaveBeenCalled()

          yield* TestClock.adjust(Duration.seconds(1))
          yield* Effect.yieldNow()
          expect(sendMessage).toHaveBeenCalledTimes(1)
          expect(sendMessage.mock.calls[0][0]).toEqual({ _tag: 'SniffingComplete' })
        })
      ))

    it('should cancel the abort when a matching settled load arrives before the timeout', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({
            sendMessage,
            stepSequence: [awaitSettled('dashboard'), linkA],
          })

          yield* machine.handlePageLoaded(pageLoaded('https://example.com/login'))
          yield* TestClock.adjust(Duration.seconds(10))
          yield* machine.handlePageLoaded(pageLoaded('https://example.com/dashboard'))
          expect(sendMessage).toHaveBeenCalledTimes(1)
          expect(sendMessage.mock.calls[0][0]).toEqual(linkA.action)

          // The superseded timeout must not fire an abort after being cancelled.
          yield* TestClock.adjust(Duration.seconds(60))
          yield* Effect.yieldNow()
          expect(sendMessage).toHaveBeenCalledTimes(1)
        })
      ))
  })

  describe('Stop', () => {
    it('should interrupt a pending Delay timer', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [delayStep(five), linkA] })

          yield* machine.handlePageLoaded(pageLoaded())
          yield* machine.stopAutomaticNavigation()
          yield* TestClock.adjust(five)
          yield* Effect.yieldNow()
          expect(sendMessage).not.toHaveBeenCalled()
        })
      ))

    it('should interrupt a pending AwaitPageSettled timeout', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({
            sendMessage,
            stepSequence: [awaitSettled('dashboard'), linkA],
          })

          yield* machine.handlePageLoaded(pageLoaded('https://example.com/login'))
          yield* machine.stopAutomaticNavigation()
          yield* TestClock.adjust(Duration.seconds(30))
          yield* Effect.yieldNow()
          expect(sendMessage).not.toHaveBeenCalled()
        })
      ))

    it('should restore the initial queue so a subsequent PageLoaded restarts from step 0', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          // A hold after linkA keeps the first drain from consuming linkB, so the
          // restart is observable as a *second* linkA dispatch.
          const machine = makeMachine({
            sendMessage,
            stepSequence: [linkA, awaitSettled('gate'), linkB],
          })

          yield* machine.handlePageLoaded(pageLoaded('https://example.com/')) // dispatch linkA, park
          expect(sendMessage).toHaveBeenCalledTimes(1)
          expect(sendMessage.mock.calls[0][0]).toEqual(linkA.action)

          yield* machine.stopAutomaticNavigation()
          yield* machine.handlePageLoaded(pageLoaded('https://example.com/')) // restart from linkA
          expect(sendMessage).toHaveBeenCalledTimes(2)
          expect(sendMessage.mock.calls[1][0]).toEqual(linkA.action)
        })
      ))
  })

  describe('PageLoaded while terminal', () => {
    it('should WARN and no-op on PageLoaded while Drained', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [] })

          yield* machine.handlePageLoaded(pageLoaded()) // → Drained
          yield* machine.handlePageLoaded(pageLoaded('https://example.com/late')).pipe(
            LoggingLayerTest.expectToLog((logs) => {
              expect(logs).toContainEqual(
                expect.objectContaining({
                  level: 'WARN',
                  message: expect.stringContaining(
                    'CollectorBridgeMessageHandler.PageLoaded: handler is done'
                  ),
                })
              )
            }),
            Effect.scoped
          )
          expect(sendMessage).not.toHaveBeenCalled()
        })
      ))

    it('should WARN and no-op on PageLoaded after SniffingComplete has fired', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [] })

          yield* machine.handlePageLoaded(pageLoaded())
          yield* machine.signalNoMoreResultsExpected // → Done
          expect(sendMessage).toHaveBeenCalledOnce()

          yield* machine.handlePageLoaded(pageLoaded('https://example.com/late')).pipe(
            LoggingLayerTest.expectToLog((logs) => {
              expect(logs).toContainEqual(
                expect.objectContaining({
                  level: 'WARN',
                  message: expect.stringContaining(
                    'CollectorBridgeMessageHandler.PageLoaded: handler is done'
                  ),
                })
              )
            }),
            Effect.scoped
          )
          expect(sendMessage).toHaveBeenCalledOnce() // no extra dispatch
        })
      ))
  })
})

// Helpers

type SendMessage = (message: StepOutboundMessage) => Effect.Effect<void, never, never>

const five = Duration.seconds(5)

const makeMachine = (options: {
  readonly sendMessage: SendMessage
  readonly onSniffingComplete?: Effect.Effect<void, never, never>
  readonly onDrained?: Effect.Effect<void, never, never>
  readonly stepSequence?: readonly Step.Step[]
}): AutomaticNavigation =>
  Effect.runSync(
    make({
      scrapingPlan: ScrapingPlan.make({
        name: 'TestPlan',
        entityDefinitions: [],
        firstPage: { _tag: 'Uri', uri: 'https://example.com/' },
        stepSequence: options.stepSequence ?? [],
      }),
      sendMessage: options.sendMessage,
      onSniffingComplete: options.onSniffingComplete ?? Effect.void,
      onDrained: options.onDrained ?? Effect.void,
    })
  )

/** Run a scenario Effect under a fresh `TestClock`/`TestContext`. */
const run = <A>(scenario: Effect.Effect<A>): Promise<A> =>
  Effect.runPromise(scenario.pipe(Effect.provide(TestContext.TestContext)))

/** The decoded `PageLoaded` bridge message the machine's handler accepts. */
const pageLoaded = (
  url = 'https://example.com/'
): { readonly _tag: 'PageLoaded'; readonly url: string; readonly pageContentId: string } => ({
  _tag: 'PageLoaded',
  url,
  pageContentId: 'page-1',
})

const openStep = (uri: string): Step.NavigationStep => ({
  _tag: 'Navigation',
  action: { _tag: 'Open', source: { _tag: 'Uri', uri } },
})

/** A `Fill` PageAction step; the querySelector is fixed so equality is by value. */
const fillStep = (value: string): Step.NavigationStep => ({
  _tag: 'Navigation',
  action: { _tag: 'PageAction', action: { kind: 'Fill', querySelector: '#field', value } },
})

const clickStep = (querySelector: string): Step.NavigationStep => ({
  _tag: 'Navigation',
  action: { _tag: 'PageAction', action: { kind: 'Click', querySelector } },
})

const delayStep = (duration: Duration.Duration): Step.Step => ({ _tag: 'Delay', duration })

/** A hold until a settled `PageLoaded` whose last path segment is `segment`. */
const awaitSettled = (
  segment: string,
  timeout: Duration.Duration = Duration.seconds(30)
): Step.AwaitPageSettledStep => ({
  _tag: 'AwaitPageSettled',
  pattern: UrlMatch.make({ segments: [UrlMatch.literal(segment)] }),
  timeout,
})

const linkA = openStep('https://example.com/a')
const linkB = openStep('https://example.com/b')
const linkC = openStep('https://example.com/c')

/** The `_tag`s of the messages sent so far, in order. */
const sentTags = (sendMessage: ReturnType<typeof vi.fn<SendMessage>>): string[] =>
  sendMessage.mock.calls.map((call) => call[0]._tag)
