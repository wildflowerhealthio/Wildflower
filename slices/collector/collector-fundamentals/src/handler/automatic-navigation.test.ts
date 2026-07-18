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
      // The composition wires this to the run lifecycle's `handleSniffingComplete`;
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

// ---- ForEach discovery helpers --------------------------------------------

const LIST_URL = 'https://example.com/list'

const openTo = (uri: string): Step.StepAction => ({
  _tag: 'Open',
  source: { _tag: 'Uri', uri },
})
const clickAction = (querySelector: string): Step.StepAction => ({
  _tag: 'PageAction',
  action: { kind: 'Click', querySelector },
})

/**
 * A `ForEach` over `.detail` rows whose body clicks each match then returns to
 * the list — the canonical SPA iteration shape (a return-to-list step between
 * items). `discover.timeout` defaults to 10s.
 */
const forEachRows = (timeout = Duration.seconds(10)): Step.Step => ({
  _tag: 'ForEach',
  discover: { querySelector: '.detail', timeout },
  body: (match) => [{ action: clickAction(match.generatedSelector) }, { action: openTo(LIST_URL) }],
})

/** The decoded `MatchesFound` answer the sniffer would post for `selectors`. */
const matchesFound = (
  queryId: string,
  selectors: readonly string[]
): {
  readonly _tag: 'MatchesFound'
  readonly queryId: string
  readonly matches: readonly { readonly generatedSelector: string }[]
} => ({
  _tag: 'MatchesFound',
  queryId,
  matches: selectors.map((generatedSelector) => ({ generatedSelector })),
})

/** Read back the correlation id the machine put on the `QueryMatches` it sent. */
const queryIdOf = (message: StepOutboundMessage): string => {
  if (message._tag !== 'QueryMatches') {
    throw new Error(`expected a QueryMatches message, got ${message._tag}`)
  }
  return message.queryId
}

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

          yield* machine.handlePageLoaded(pageLoaded())
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

          yield* machine.handlePageLoaded(pageLoaded())
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

          yield* machine.handlePageLoaded(pageLoaded('https://example.com/'))
          yield* TestClock.adjust(Duration.seconds(5))
          yield* Effect.yieldNow()
          expect(sendMessage).toHaveBeenCalledTimes(1)
          expect(sendMessage.mock.calls[0][0]).toEqual(linkA.action)

          yield* machine.handlePageLoaded(pageLoaded('https://example.com/a'))
          yield* TestClock.adjust(Duration.seconds(5))
          yield* Effect.yieldNow()
          expect(sendMessage).toHaveBeenCalledTimes(2)
          expect(sendMessage.mock.calls[1][0]).toEqual(linkB.action)

          yield* machine.handlePageLoaded(pageLoaded('https://example.com/b'))
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

          yield* machine.handlePageLoaded(pageLoaded('https://example.com/'))
          yield* TestClock.adjust(Duration.seconds(3))
          yield* Effect.yieldNow()
          expect(sendMessage).not.toHaveBeenCalled()

          yield* machine.handlePageLoaded(pageLoaded('https://example.com/'))
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

          yield* machine.handlePageLoaded(pageLoaded())
          yield* TestClock.adjust(Duration.seconds(5))
          yield* Effect.yieldNow()
          expect(sendMessage).toHaveBeenCalledOnce()

          yield* machine.handlePageLoaded(pageLoaded('https://example.com/next')).pipe(
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

          yield* machine.handlePageLoaded(pageLoaded())
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

          yield* machine.handlePageLoaded(pageLoaded())
          yield* TestClock.adjust(Duration.seconds(5))
          yield* Effect.yieldNow()
          expect(sendMessage).toHaveBeenCalledTimes(1)

          yield* machine.stopAutomaticNavigation()

          yield* machine.handlePageLoaded(pageLoaded())
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

          yield* machine.handlePageLoaded(pageLoaded())
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

          yield* machine.handlePageLoaded(pageLoaded('https://example.com/dashboard'))
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

            yield* machine.handlePageLoaded(pageLoaded('https://example.com/login'))
            yield* TestClock.adjust(Duration.seconds(5))
            yield* Effect.yieldNow()
            expect(sendMessage).not.toHaveBeenCalled()

            yield* machine.handlePageLoaded(pageLoaded('https://example.com/dashboard'))
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

            yield* machine.handlePageLoaded(pageLoaded('https://example.com/login'))
            yield* TestClock.adjust(Duration.seconds(29))
            yield* Effect.yieldNow()
            expect(sendMessage).not.toHaveBeenCalled()

            yield* TestClock.adjust(Duration.seconds(1))
            yield* Effect.yieldNow()
            expect(sendMessage).toHaveBeenCalledTimes(1)
            expect(sendMessage.mock.calls[0][0]).toEqual({ _tag: 'SniffingComplete' })

            yield* machine.handlePageLoaded(pageLoaded('https://example.com/dashboard')).pipe(
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

            yield* machine.handlePageLoaded(pageLoaded('https://example.com/login'))
            yield* TestClock.adjust(Duration.seconds(10))
            yield* Effect.yieldNow()

            yield* machine.handlePageLoaded(pageLoaded('https://example.com/dashboard'))
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

            yield* machine.handlePageLoaded(pageLoaded('https://example.com/login'))
            yield* machine.stopAutomaticNavigation()
            yield* TestClock.adjust(Duration.seconds(30))
            yield* Effect.yieldNow()
            expect(sendMessage).not.toHaveBeenCalled()
          }).pipe(Effect.provide(TestContext.TestContext))
        ))
    })
  })
})

describe('automatic-navigation.make: ForEach runtime link discovery', () => {
  it('dispatches QueryMatches (not a bridge action) after stepDelay when a ForEach step is reached', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sendMessage = vi.fn<SendMessage>(() => Effect.void)
        const machine = makeMachine({ sendMessage, stepSequence: [forEachRows()] })

        yield* machine.handlePageLoaded(pageLoaded(LIST_URL))
        yield* TestClock.adjust(Duration.seconds(5))
        yield* Effect.yieldNow()

        expect(sendMessage).toHaveBeenCalledTimes(1)
        const sent = sendMessage.mock.calls[0][0]
        expect(sent).toEqual({
          _tag: 'QueryMatches',
          // A non-empty correlation id the answer must echo (derived from the
          // machine's generation; its exact value is an internal detail).
          queryId: expect.stringMatching(/.+/),
          querySelector: '.detail',
        })
      }).pipe(Effect.provide(TestContext.TestContext))
    ))

  it('expands a single discovered match into its body sequence, then completes', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sendMessage = vi.fn<SendMessage>(() => Effect.void)
        const machine = makeMachine({ sendMessage, stepSequence: [forEachRows()] })

        // List settles → discovery request.
        yield* machine.handlePageLoaded(pageLoaded(LIST_URL))
        yield* TestClock.adjust(Duration.seconds(5))
        yield* Effect.yieldNow()
        const queryId = queryIdOf(sendMessage.mock.calls[0][0])

        // The answer expands the ForEach in place; nothing dispatches until the
        // re-armed settle elapses (no new PageLoaded is coming).
        yield* machine.handleMatchesFound(matchesFound(queryId, ['#row-0']))
        expect(sendMessage).toHaveBeenCalledTimes(1)

        yield* TestClock.adjust(Duration.seconds(5))
        yield* Effect.yieldNow()
        // First body step: click the discovered row.
        expect(sendMessage).toHaveBeenCalledTimes(2)
        expect(sendMessage.mock.calls[1][0]).toEqual(clickAction('#row-0'))

        // The click navigates to the detail page; the body's return-to-list
        // step dispatches after that page settles.
        yield* machine.handlePageLoaded(pageLoaded('https://example.com/detail/0'))
        yield* TestClock.adjust(Duration.seconds(5))
        yield* Effect.yieldNow()
        expect(sendMessage.mock.calls[2][0]).toEqual(openTo(LIST_URL))

        // Back on the list, the expanded queue is exhausted → SniffingComplete.
        yield* machine.handlePageLoaded(pageLoaded(LIST_URL))
        yield* TestClock.adjust(Duration.seconds(5))
        yield* Effect.yieldNow()
        expect(sendMessage.mock.calls[3][0]).toEqual({ _tag: 'SniffingComplete' })
      }).pipe(Effect.provide(TestContext.TestContext))
    ))

  it('expands N matches, iterating each with a return-to-list step between items', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sendMessage = vi.fn<SendMessage>(() => Effect.void)
        const machine = makeMachine({ sendMessage, stepSequence: [forEachRows()] })

        yield* machine.handlePageLoaded(pageLoaded(LIST_URL))
        yield* TestClock.adjust(Duration.seconds(5))
        yield* Effect.yieldNow()
        const queryId = queryIdOf(sendMessage.mock.calls[0][0])

        yield* machine.handleMatchesFound(matchesFound(queryId, ['#row-0', '#row-1']))

        // Drive the interleaved click → return-to-list → click → return-to-list
        // sequence. Each dispatch follows a PageLoaded + settle.
        yield* TestClock.adjust(Duration.seconds(5))
        yield* Effect.yieldNow()
        expect(sendMessage.mock.calls[1][0]).toEqual(clickAction('#row-0'))

        yield* machine.handlePageLoaded(pageLoaded('https://example.com/detail/0'))
        yield* TestClock.adjust(Duration.seconds(5))
        yield* Effect.yieldNow()
        expect(sendMessage.mock.calls[2][0]).toEqual(openTo(LIST_URL))

        yield* machine.handlePageLoaded(pageLoaded(LIST_URL))
        yield* TestClock.adjust(Duration.seconds(5))
        yield* Effect.yieldNow()
        expect(sendMessage.mock.calls[3][0]).toEqual(clickAction('#row-1'))

        yield* machine.handlePageLoaded(pageLoaded('https://example.com/detail/1'))
        yield* TestClock.adjust(Duration.seconds(5))
        yield* Effect.yieldNow()
        expect(sendMessage.mock.calls[4][0]).toEqual(openTo(LIST_URL))

        yield* machine.handlePageLoaded(pageLoaded(LIST_URL))
        yield* TestClock.adjust(Duration.seconds(5))
        yield* Effect.yieldNow()
        expect(sendMessage.mock.calls[5][0]).toEqual({ _tag: 'SniffingComplete' })
      }).pipe(Effect.provide(TestContext.TestContext))
    ))

  it('treats an empty discovery result as a clean skip: completes and WARN-logs', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sendMessage = vi.fn<SendMessage>(() => Effect.void)
        const machine = makeMachine({ sendMessage, stepSequence: [forEachRows()] })

        yield* machine.handlePageLoaded(pageLoaded(LIST_URL))
        yield* TestClock.adjust(Duration.seconds(5))
        yield* Effect.yieldNow()
        const queryId = queryIdOf(sendMessage.mock.calls[0][0])

        // Zero matches: the ForEach contributes no body steps and WARN-logs.
        yield* machine.handleMatchesFound(matchesFound(queryId, [])).pipe(
          LoggingLayerTest.expectToLog((logs) => {
            expect(logs).toEqual([
              expect.objectContaining({
                level: 'WARN',
                message: expect.stringContaining('discovered no matches'),
              }),
            ])
          }),
          Effect.scoped
        )
        expect(sendMessage).toHaveBeenCalledTimes(1)

        // The run still completes (it does not hang, and later steps — here the
        // terminal — still fire).
        yield* TestClock.adjust(Duration.seconds(5))
        yield* Effect.yieldNow()
        expect(sendMessage).toHaveBeenCalledTimes(2)
        expect(sendMessage.mock.calls[1][0]).toEqual({ _tag: 'SniffingComplete' })
      }).pipe(Effect.provide(TestContext.TestContext))
    ))

  it('aborts via SniffingComplete when no MatchesFound arrives within the discovery timeout', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sendMessage = vi.fn<SendMessage>(() => Effect.void)
        const machine = makeMachine({
          sendMessage,
          stepSequence: [forEachRows(Duration.seconds(10))],
        })

        yield* machine.handlePageLoaded(pageLoaded(LIST_URL))
        yield* TestClock.adjust(Duration.seconds(5))
        yield* Effect.yieldNow()
        expect(sendMessage).toHaveBeenCalledTimes(1) // QueryMatches only

        // Just short of the discovery timeout: still waiting.
        yield* TestClock.adjust(Duration.seconds(9))
        yield* Effect.yieldNow()
        expect(sendMessage).toHaveBeenCalledTimes(1)

        // The timeout elapses → abort via SniffingComplete (not a hang).
        yield* TestClock.adjust(Duration.seconds(1))
        yield* Effect.yieldNow()
        expect(sendMessage).toHaveBeenCalledTimes(2)
        expect(sendMessage.mock.calls[1][0]).toEqual({ _tag: 'SniffingComplete' })
      }).pipe(Effect.provide(TestContext.TestContext))
    ))

  it('drops a MatchesFound whose queryId does not match the in-flight query, then honours the real one', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sendMessage = vi.fn<SendMessage>(() => Effect.void)
        const machine = makeMachine({ sendMessage, stepSequence: [forEachRows()] })

        yield* machine.handlePageLoaded(pageLoaded(LIST_URL))
        yield* TestClock.adjust(Duration.seconds(5))
        yield* Effect.yieldNow()
        const queryId = queryIdOf(sendMessage.mock.calls[0][0])

        // A stale/duplicate answer for a different query is dropped (WARN);
        // nothing expands.
        yield* machine.handleMatchesFound(matchesFound('not-the-query', ['#ghost'])).pipe(
          LoggingLayerTest.expectToLog((logs) => {
            expect(logs).toEqual([
              expect.objectContaining({
                level: 'WARN',
                message: expect.stringContaining('no ForEach step awaiting queryId=not-the-query'),
              }),
            ])
          }),
          Effect.scoped
        )
        expect(sendMessage).toHaveBeenCalledTimes(1)

        // The correct answer still drives the fan-out.
        yield* machine.handleMatchesFound(matchesFound(queryId, ['#row-0']))
        yield* TestClock.adjust(Duration.seconds(5))
        yield* Effect.yieldNow()
        expect(sendMessage.mock.calls[1][0]).toEqual(clickAction('#row-0'))
      }).pipe(Effect.provide(TestContext.TestContext))
    ))

  it('stopAutomaticNavigation() interrupts a pending discovery timeout', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sendMessage = vi.fn<SendMessage>(() => Effect.void)
        const machine = makeMachine({
          sendMessage,
          stepSequence: [forEachRows(Duration.seconds(10))],
        })

        yield* machine.handlePageLoaded(pageLoaded(LIST_URL))
        yield* TestClock.adjust(Duration.seconds(5))
        yield* Effect.yieldNow()
        expect(sendMessage).toHaveBeenCalledTimes(1)

        yield* machine.stopAutomaticNavigation()
        yield* TestClock.adjust(Duration.seconds(30))
        yield* Effect.yieldNow()
        // No SniffingComplete: the discovery timeout was interrupted.
        expect(sendMessage).toHaveBeenCalledTimes(1)
      }).pipe(Effect.provide(TestContext.TestContext))
    ))

  it('runs a leaf step before reaching the ForEach, then runs discovery', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sendMessage = vi.fn<SendMessage>(() => Effect.void)
        const openList: Step.Step = { action: openTo(LIST_URL) }
        const machine = makeMachine({ sendMessage, stepSequence: [openList, forEachRows()] })

        // First page settles → the leaf Open dispatches.
        yield* machine.handlePageLoaded(pageLoaded('https://example.com/'))
        yield* TestClock.adjust(Duration.seconds(5))
        yield* Effect.yieldNow()
        expect(sendMessage.mock.calls[0][0]).toEqual(openTo(LIST_URL))

        // The list settles → the ForEach runs discovery.
        yield* machine.handlePageLoaded(pageLoaded(LIST_URL))
        yield* TestClock.adjust(Duration.seconds(5))
        yield* Effect.yieldNow()
        expect(sendMessage.mock.calls[1][0]).toEqual(
          expect.objectContaining({ _tag: 'QueryMatches', querySelector: '.detail' })
        )
      }).pipe(Effect.provide(TestContext.TestContext))
    ))

  it('lets the body navigate straight to a match href via Open', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sendMessage = vi.fn<SendMessage>(() => Effect.void)
        // A body that prefers a real anchor's href over a synthetic click.
        const anchorForEach: Step.Step = {
          _tag: 'ForEach',
          discover: { querySelector: 'a.detail', timeout: Duration.seconds(10) },
          body: (match) => [
            {
              action:
                match.href === undefined
                  ? clickAction(match.generatedSelector)
                  : openTo(match.href),
            },
            { action: openTo(LIST_URL) },
          ],
        }
        const machine = makeMachine({ sendMessage, stepSequence: [anchorForEach] })

        yield* machine.handlePageLoaded(pageLoaded(LIST_URL))
        yield* TestClock.adjust(Duration.seconds(5))
        yield* Effect.yieldNow()
        const queryId = queryIdOf(sendMessage.mock.calls[0][0])

        yield* machine.handleMatchesFound({
          _tag: 'MatchesFound',
          queryId,
          matches: [
            { generatedSelector: 'a.detail:nth-child(1)', href: 'https://example.com/med/9' },
          ],
        })
        yield* TestClock.adjust(Duration.seconds(5))
        yield* Effect.yieldNow()
        expect(sendMessage.mock.calls[1][0]).toEqual(openTo('https://example.com/med/9'))
      }).pipe(Effect.provide(TestContext.TestContext))
    ))
})
