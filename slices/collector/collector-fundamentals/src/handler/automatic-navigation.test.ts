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
          expect(dispatched(sendMessage)).toHaveLength(2)
          expect(dispatched(sendMessage)[0]).toEqual(linkA.action)
          expect(dispatched(sendMessage)[1]).toEqual(linkB.action)
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
          expect(dispatched(sendMessage)).toEqual([
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

          expect(dispatched(sendMessage)).toHaveLength(1)
          expect(dispatched(sendMessage)[0]).toEqual({
            _tag: 'PageAction',
            action: { kind: 'Fill', querySelector: '#field', value: 'alice' },
          })
        })
      ))

    it('should dispatch every navigation action in queue order, then SniffingComplete', () =>
      fc.assert(
        fc.property(fc.array(fc.webUrl()), (uris) => {
          // Arrange: one ungated Open step per url. (Wrapped so `Array.map`'s
          // index isn't passed as `openStep`'s `name`.)
          const steps = uris.map((uri) => openStep(uri))
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
          const sent = dispatched(sendMessage)
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
          expect(dispatched(sendMessage)).toEqual([])

          // No incomplete requests → the lifecycle signals → complete.
          yield* machine.signalNoMoreResultsExpected
          expect(dispatched(sendMessage)).toHaveLength(1)
          expect(dispatched(sendMessage)[0]).toEqual({ _tag: 'SniffingComplete' })
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
          expect(dispatched(sendMessage)).toEqual([])
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
          expect(dispatched(sendMessage)).toEqual([])

          // A generated step dispatches immediately — the machine is idle.
          yield* machine.handleStepsGenerated([linkA])
          expect(dispatched(sendMessage)).toHaveLength(1)
          expect(dispatched(sendMessage)[0]).toEqual(linkA.action)
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

          expect(dispatched(sendMessage)).toEqual([linkA.action, linkB.action, linkC.action])
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
          expect(dispatched(sendMessage)).toEqual([])

          yield* TestClock.adjust(Duration.seconds(1))
          yield* Effect.yieldNow()
          expect(dispatched(sendMessage)).toHaveLength(1)
          expect(dispatched(sendMessage)[0]).toEqual(linkA.action)
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
          expect(dispatched(sendMessage)).toEqual([]) // second delay now running

          yield* TestClock.adjust(Duration.seconds(2))
          yield* Effect.yieldNow()
          expect(dispatched(sendMessage)).toHaveLength(1)
          expect(dispatched(sendMessage)[0]).toEqual(linkA.action)
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
          expect(dispatched(sendMessage)).toHaveLength(1)
          expect(dispatched(sendMessage)[0]).toEqual(linkA.action)
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
          expect(dispatched(sendMessage)).toEqual([]) // login ≠ dashboard → parked

          // On match the hold is consumed and the tail drains — linkA dispatches.
          yield* machine.handlePageLoaded(pageLoaded('https://example.com/dashboard'))
          expect(dispatched(sendMessage)).toHaveLength(1)
          expect(dispatched(sendMessage)[0]).toEqual(linkA.action)
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
          expect(dispatched(sendMessage)).toHaveLength(1)
          expect(dispatched(sendMessage)[0]).toEqual(linkA.action)
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
          expect(dispatched(sendMessage)).toEqual([])

          yield* TestClock.adjust(Duration.seconds(1))
          yield* Effect.yieldNow()
          expect(dispatched(sendMessage)).toHaveLength(1)
          expect(dispatched(sendMessage)[0]).toEqual({ _tag: 'SniffingComplete' })
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
          expect(dispatched(sendMessage)).toHaveLength(1)
          expect(dispatched(sendMessage)[0]).toEqual(linkA.action)

          // The superseded timeout must not fire an abort after being cancelled.
          yield* TestClock.adjust(Duration.seconds(60))
          yield* Effect.yieldNow()
          expect(dispatched(sendMessage)).toHaveLength(1)
        })
      ))
  })

  describe('AwaitUserDismiss', () => {
    it('should park on the hold, dispatching nothing and staying open under NoMoreResultsExpected', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          let completed = 0
          const machine = makeMachine({
            sendMessage,
            stepSequence: [linkA, awaitUserDismiss()],
            onSniffingComplete: Effect.sync(() => {
              completed += 1
            }),
          })

          // linkA dispatches, then the machine parks on the hold — no terminal.
          yield* machine.handlePageLoaded(pageLoaded())
          expect(sentTags(sendMessage)).toEqual(['Open'])

          // While parked the run stays open: an empty-map signal cannot complete
          // it (the queue is not drained — the hold is still at its head).
          yield* machine.signalNoMoreResultsExpected
          expect(sentTags(sendMessage)).toEqual(['Open'])
          expect(completed).toBe(0)
        })
      ))

    it('should end the run via SniffingComplete when the user dismisses while parked', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          let completed = 0
          const machine = makeMachine({
            sendMessage,
            stepSequence: [awaitUserDismiss()],
            onSniffingComplete: Effect.sync(() => {
              completed += 1
            }),
          })

          yield* machine.handlePageLoaded(pageLoaded()) // → parked, nothing sent
          expect(sendMessage).not.toHaveBeenCalled()

          yield* machine.handleUserDismissed(userDismissed())
          expect(sentTags(sendMessage)).toEqual(['SniffingComplete'])
          expect(completed).toBe(1)
        })
      ))

    it('should ignore a page load while parked (the webview is still alive)', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [awaitUserDismiss()] })

          yield* machine.handlePageLoaded(pageLoaded('https://example.com/one'))
          yield* machine.handlePageLoaded(pageLoaded('https://example.com/two'))
          expect(sendMessage).not.toHaveBeenCalled() // still parked, not advanced
        })
      ))

    it('should no-op on UserDismissed when no AwaitUserDismiss hold is pending', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [linkA] })

          yield* machine.handlePageLoaded(pageLoaded()) // linkA drains → Drained
          expect(sentTags(sendMessage)).toEqual(['Open'])

          // An incidental dismiss in a run without the step must not end it.
          yield* machine.handleUserDismissed(userDismissed())
          expect(sentTags(sendMessage)).toEqual(['Open'])
        })
      ))

    it('should silently no-op (no dispatch, no WARN) on a UserDismissed after Done', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [awaitUserDismiss()] })

          yield* machine.handlePageLoaded(pageLoaded())
          yield* machine.handleUserDismissed(userDismissed()) // → Done + SniffingComplete
          expect(sentTags(sendMessage)).toEqual(['SniffingComplete'])

          // A second dismiss (e.g. the follow-up Disposed's own hide) is expected,
          // so — unlike a stray PageLoaded — it neither dispatches nor WARNs.
          yield* machine.handleUserDismissed(userDismissed()).pipe(
            LoggingLayerTest.expectToLog((logs) => {
              expect(logs).not.toContainEqual(expect.objectContaining({ level: 'WARN' }))
            }),
            Effect.scoped
          )
          expect(sentTags(sendMessage)).toEqual(['SniffingComplete'])
        })
      ))

    it('should always end in exactly one trailing SniffingComplete for park-then-dismiss', () =>
      fc.assert(
        fc.property(fc.array(fc.webUrl(), { maxLength: 6 }), (uris) => {
          // Arbitrary navigations followed by a terminal user-dismiss hold.
          const steps = [...uris.map(openStep), awaitUserDismiss()]
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: steps })

          Effect.runSync(
            Effect.gen(function* () {
              yield* machine.handlePageLoaded(pageLoaded())
              yield* machine.handleUserDismissed(userDismissed())
            }).pipe(Effect.provide(TestContext.TestContext))
          )

          // Every navigation dispatches in order, then a single trailing terminal.
          const sent = sendMessage.mock.calls.map((call) => call[0])
          expect(sent).toEqual([
            ...uris.map((uri) => openStep(uri).action),
            { _tag: 'SniffingComplete' },
          ])
        }),
        { numRuns: numRunsFor({ base: 100 }) }
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
          expect(dispatched(sendMessage)).toEqual([])
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
          expect(dispatched(sendMessage)).toEqual([])
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
          expect(dispatched(sendMessage)).toHaveLength(1)
          expect(dispatched(sendMessage)[0]).toEqual(linkA.action)

          yield* machine.stopAutomaticNavigation()
          yield* machine.handlePageLoaded(pageLoaded('https://example.com/')) // restart from linkA
          expect(dispatched(sendMessage)).toHaveLength(2)
          expect(dispatched(sendMessage)[1]).toEqual(linkA.action)
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
          expect(dispatched(sendMessage)).toEqual([])
        })
      ))

    it('should WARN and no-op on PageLoaded after SniffingComplete has fired', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({ sendMessage, stepSequence: [] })

          yield* machine.handlePageLoaded(pageLoaded())
          yield* machine.signalNoMoreResultsExpected // → Done
          expect(dispatched(sendMessage)).toHaveLength(1)

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
          expect(dispatched(sendMessage)).toHaveLength(1) // no extra dispatch
        })
      ))
  })

  describe('step names (SetSnifferStatus)', () => {
    it('should push a Navigation step name to the sniffer chrome right before its action', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const step = openStep('https://example.com/a', 'Loading page')
          const machine = makeMachine({ sendMessage, stepSequence: [step] })

          yield* machine.handlePageLoaded(pageLoaded())
          // The chrome label is pushed in the same turn, immediately before the
          // action — never on the wire action itself.
          expect(allSent(sendMessage)).toEqual([
            { _tag: 'SetSnifferStatus', name: 'Loading page' },
            step.action,
          ])
        })
      ))

    it('should push a Delay step name while the timer is still running (before any dispatch)', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({
            sendMessage,
            stepSequence: [delayStep(five, 'Pausing before login'), linkA],
          })

          yield* machine.handlePageLoaded(pageLoaded())
          // The hold's name is visible even though nothing has dispatched yet.
          expect(statusNames(sendMessage)).toEqual(['Pausing before login'])
          expect(dispatched(sendMessage)).toEqual([])
        })
      ))

    it('should push an AwaitPageSettled step name when it parks', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({
            sendMessage,
            stepSequence: [
              awaitSettled('dashboard', Duration.seconds(30), 'Waiting for dashboard'),
              linkA,
            ],
          })

          yield* machine.handlePageLoaded(pageLoaded('https://example.com/login')) // parks
          expect(statusNames(sendMessage)).toEqual(['Waiting for dashboard'])
          expect(dispatched(sendMessage)).toEqual([])
        })
      ))

    it('should push each name in step order for back-to-back navigations (the chrome ends on the last)', () =>
      run(
        Effect.gen(function* () {
          const sendMessage = vi.fn<SendMessage>(() => Effect.void)
          const machine = makeMachine({
            sendMessage,
            stepSequence: [
              fillStep('alice', 'Entering email'),
              fillStep('hunter2', 'Entering password'),
            ],
          })

          yield* machine.handlePageLoaded(pageLoaded())
          // Both names are pushed, in order — the last is what the user is left seeing.
          expect(statusNames(sendMessage)).toEqual(['Entering email', 'Entering password'])
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

// Every step carries a required `name`. The builders default it from the step's
// content so the fixtures stay terse; a caller that asserts on the name passes an
// explicit one. The name never rides the step's `action`, so `linkA.action`
// comparisons are unaffected — only the separate `SetSnifferStatus` push carries it.
const openStep = (uri: string, name = `open ${uri}`): Step.NavigationStep => ({
  _tag: 'Navigation',
  name,
  action: { _tag: 'Open', source: { _tag: 'Uri', uri } },
})

/** A `Fill` PageAction step; the querySelector is fixed so equality is by value. */
const fillStep = (value: string, name = `fill ${value}`): Step.NavigationStep => ({
  _tag: 'Navigation',
  name,
  action: { _tag: 'PageAction', action: { kind: 'Fill', querySelector: '#field', value } },
})

const clickStep = (
  querySelector: string,
  name = `click ${querySelector}`
): Step.NavigationStep => ({
  _tag: 'Navigation',
  name,
  action: { _tag: 'PageAction', action: { kind: 'Click', querySelector } },
})

const delayStep = (duration: Duration.Duration, name = 'delay'): Step.Step => ({
  _tag: 'Delay',
  name,
  duration,
})

/** A terminal hold that parks until the user dismisses the sniffer webview. */
const awaitUserDismiss = (): Step.AwaitUserDismissStep => ({ _tag: 'AwaitUserDismiss' })

/** The decoded `UserDismissed` bridge message the machine's handler accepts. */
const userDismissed = (): { readonly _tag: 'UserDismissed' } => ({ _tag: 'UserDismissed' })

/** A hold until a settled `PageLoaded` whose last path segment is `segment`. */
const awaitSettled = (
  segment: string,
  timeout: Duration.Duration = Duration.seconds(30),
  name = `await ${segment}`
): Step.AwaitPageSettledStep => ({
  _tag: 'AwaitPageSettled',
  name,
  pattern: UrlMatch.make({ segments: [UrlMatch.literal(segment)] }),
  timeout,
})

const linkA = openStep('https://example.com/a')
const linkB = openStep('https://example.com/b')
const linkC = openStep('https://example.com/c')

/**
 * The messages the machine actually *dispatched*, with the per-step
 * `SetSnifferStatus` chrome-label pushes filtered out. Every step emits one of
 * those before its own effect (see `Step.name`); the dispatch/timer/completion
 * tests assert on the navigation actions and terminals only, so they route
 * through this. The `SetSnifferStatus` emission has its own dedicated tests.
 */
const dispatched = (
  sendMessage: ReturnType<typeof vi.fn<SendMessage>>
): readonly StepOutboundMessage[] =>
  sendMessage.mock.calls
    .map((call) => call[0])
    .filter((message) => message._tag !== 'SetSnifferStatus')

/** Every message sent so far, in order — status pushes included. */
const allSent = (
  sendMessage: ReturnType<typeof vi.fn<SendMessage>>
): readonly StepOutboundMessage[] => sendMessage.mock.calls.map((call) => call[0])

/** The `_tag`s of the *dispatched* messages so far (status pushes excluded), in order. */
const sentTags = (sendMessage: ReturnType<typeof vi.fn<SendMessage>>): string[] =>
  dispatched(sendMessage).map((message) => message._tag)

/** The step names pushed to the sniffer chrome so far, in order. */
const statusNames = (sendMessage: ReturnType<typeof vi.fn<SendMessage>>): string[] =>
  sendMessage.mock.calls
    .map((call) => call[0])
    .filter((message) => message._tag === 'SetSnifferStatus')
    .map((message) => (message as { readonly name: string }).name)
