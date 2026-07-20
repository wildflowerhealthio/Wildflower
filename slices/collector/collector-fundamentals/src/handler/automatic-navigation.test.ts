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
 * The machine now *owns a breadth-first step queue* (seeded from `stepSequence`,
 * grown by `handleStepsGenerated`) rather than an index. There is **no implicit
 * settle timer**: a `Navigation` dispatches on the same transition as the
 * gating `PageLoaded`, so the dispatch assertions need no clock advance. Only
 * explicit `Delay` steps and URL-match timeouts involve the clock. Completion is
 * `queue drained (Drained) ∧ NoMoreResultsExpected`.
 */
describe('automatic-navigation.make', () => {
  describe('navigation dispatch', () => {
    it('should dispatch each navigation immediately on its PageLoaded, with no settle delay', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [linkA, linkB] })

          // No clock is advanced anywhere: the dispatch is on the PageLoaded
          // transition itself.
          yield* machine.handlePageLoaded(pageLoaded('https://example.com/'))
          expect(sendMessage).toHaveBeenCalledTimes(1)
          expect(sendMessage.mock.calls[0][0]).toEqual(linkA.action)

          yield* machine.handlePageLoaded(pageLoaded('https://example.com/a'))
          expect(sendMessage).toHaveBeenCalledTimes(2)
          expect(sendMessage.mock.calls[1][0]).toEqual(linkB.action)
        })
      ))

    it('should dispatch a PageAction step verbatim, never carrying advanceWhen on the wire payload', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [gatedFill] })

          yield* machine.handlePageLoaded(pageLoaded('https://example.com/dashboard'))

          expect(sendMessage).toHaveBeenCalledTimes(1)
          const sent = sendMessage.mock.calls[0][0]
          expect(sent).toEqual({
            _tag: 'PageAction',
            action: { kind: 'Fill', querySelector: '#username', value: 'alice' },
          })
          // The gate rode the step wrapper; the wire payload never carries it.
          expect(sent).not.toHaveProperty('advanceWhen')
        })
      ))

    it('should dispatch every navigation action in queue order, then SniffingComplete', () =>
      fc.assert(
        fc.property(fc.array(fc.webUrl()), (uris) => {
          // Arrange: one ungated Open step per url.
          const steps = uris.map(openStep)
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: steps })

          // Act: one PageLoaded pops+dispatches each step; a final PageLoaded
          // drains the queue; NoMoreResultsExpected then completes.
          Effect.runSync(
            Effect.gen(function* () {
              for (let i = 0; i <= steps.length; i += 1) {
                yield* machine.handlePageLoaded(pageLoaded())
              }
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

    it('should not complete while the queue still has steps', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [linkA] })

          // Queue non-empty → NoMoreResultsExpected is a no-op.
          yield* machine.signalNoMoreResultsExpected
          expect(sendMessage).not.toHaveBeenCalled()
        })
      ))

    it('should not complete while awaiting the last dispatched navigation PageLoaded', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [linkA] })

          // linkA dispatched; queue empty but state is AwaitingPageLoaded, NOT
          // Drained — the machine still expects linkA's PageLoaded.
          yield* machine.handlePageLoaded(pageLoaded('https://example.com/'))
          yield* machine.signalNoMoreResultsExpected
          expect(sendMessage).toHaveBeenCalledTimes(1) // linkA only, no terminal
          expect(sentTags(sendMessage)).not.toContain('SniffingComplete')

          // The nav's PageLoaded drains the queue; only then does the signal complete.
          yield* machine.handlePageLoaded(pageLoaded('https://example.com/a'))
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
          const machine = makeMachine({ sendMessage, stepSequence: [linkA, linkB] })

          yield* machine.handlePageLoaded(pageLoaded('https://example.com/')) // dispatch linkA
          // linkC is generated mid-run: it queues *after* the remaining linkB.
          yield* machine.handleStepsGenerated([linkC])
          yield* machine.handlePageLoaded(pageLoaded('https://example.com/a')) // dispatch linkB
          yield* machine.handlePageLoaded(pageLoaded('https://example.com/b')) // dispatch linkC

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

          yield* machine.handlePageLoaded(pageLoaded('https://example.com/')) // dispatch linkA
          yield* machine.handlePageLoaded(pageLoaded('https://example.com/a')) // arm trailing delay
          yield* settleForkedWork
          expect(drainedCount).toBe(0) // still delaying, not drained

          yield* TestClock.adjust(five)
          yield* settleForkedWork
          expect(drainedCount).toBe(1) // delay elapsed → Drained → onDrained fires
        })
      ))
  })

  describe('advanceWhen: UrlMatch', () => {
    it('should hold the step until a matching PageLoaded, then dispatch immediately', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [gatedLink] })

          yield* machine.handlePageLoaded(pageLoaded('https://example.com/login'))
          expect(sendMessage).not.toHaveBeenCalled()

          // On match the step dispatches on that same transition — no settle wait.
          yield* machine.handlePageLoaded(pageLoaded('https://example.com/dashboard'))
          expect(sendMessage).toHaveBeenCalledTimes(1)
          expect(sendMessage.mock.calls[0][0]).toEqual(gatedLink.action)
        })
      ))

    it('should abort via SniffingComplete when no matching PageLoaded arrives within the timeout', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [gatedLink] })

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

    it('should cancel the abort when a matching PageLoaded arrives before the timeout', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [gatedLink] })

          yield* machine.handlePageLoaded(pageLoaded('https://example.com/login'))
          yield* TestClock.adjust(Duration.seconds(10))
          yield* machine.handlePageLoaded(pageLoaded('https://example.com/dashboard'))
          expect(sendMessage).toHaveBeenCalledTimes(1)
          expect(sendMessage.mock.calls[0][0]).toEqual(gatedLink.action)

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

    it('should interrupt a pending URL-match timeout', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [gatedLink] })

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
          const machine = makeMachine({ sendMessage, stepSequence: [linkA, linkB] })

          yield* machine.handlePageLoaded(pageLoaded()) // dispatch linkA
          expect(sendMessage).toHaveBeenCalledTimes(1)

          yield* machine.stopAutomaticNavigation()
          yield* machine.handlePageLoaded(pageLoaded()) // restart from linkA
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

const delayStep = (duration: Duration.Duration): Step.Step => ({ _tag: 'Delay', duration })

const linkA = openStep('https://example.com/a')
const linkB = openStep('https://example.com/b')
const linkC = openStep('https://example.com/c')

/** A step gated on landing at `…/dashboard`, timing out after 30s. */
const dashboardPattern = UrlMatch.make({ segments: [UrlMatch.literal('dashboard')] })
const gatedLink: Step.NavigationStep = {
  _tag: 'Navigation',
  action: { _tag: 'Open', source: { _tag: 'Uri', uri: 'https://example.com/next' } },
  advanceWhen: { _tag: 'UrlMatch', pattern: dashboardPattern, timeout: Duration.seconds(30) },
}
const gatedFill: Step.NavigationStep = {
  _tag: 'Navigation',
  action: {
    _tag: 'PageAction',
    action: { kind: 'Fill', querySelector: '#username', value: 'alice' },
  },
  advanceWhen: { _tag: 'UrlMatch', pattern: dashboardPattern, timeout: Duration.seconds(30) },
}

/** The `_tag`s of the messages sent so far, in order. */
const sentTags = (sendMessage: ReturnType<typeof vi.fn<SendMessage>>): string[] =>
  sendMessage.mock.calls.map((call) => call[0]._tag)
