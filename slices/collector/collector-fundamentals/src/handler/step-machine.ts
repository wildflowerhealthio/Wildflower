import { type ClickMessage, type FillMessage } from 'browser-sniffer-core'
import { Duration, Effect, Fiber, Match, SynchronizedRef } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import type { RuntimeFiber } from 'effect/Fiber'
import type {
  CollectorBridge,
  OpenMessage,
  SniffingComplete as SniffingCompleteMessage,
} from '../bridge.ts'
import type { ScrapingPlan } from '../model/index.ts'
import type * as Link from '../model/link.ts'
import * as Telemetry from '../telemetry/index.ts'

type Service = MessageHandler.HandlersFor<CollectorBridge['HostToWeb']>

/**
 * The subset of {@link OutboundMessage} the step machine can ask the host
 * to send: the scripted `Open` / `Click` / `Fill` navigation steps and
 * the terminal `SniffingComplete`. (`CancelSnifferRequest` is the
 * response tracker's, not the step machine's.)
 */
type StepOutboundMessage =
  | typeof OpenMessage.Type
  | typeof ClickMessage.Type
  | typeof FillMessage.Type
  | typeof SniffingCompleteMessage.Type

/**
 * Step-driver finite state machine. Each variant carries exactly the
 * data needed for that state — no shared optional fields, no
 * sentinels for "running but no timer yet".
 *
 * `AwaitingUrlMatch` exists only for a step whose `advanceWhen` is a
 * `UrlMatch`: the machine parks there after a `PageLoaded` whose `url`
 * did *not* match, holding the step until a matching `PageLoaded`
 * arrives (→ `TimerPending`, i.e. the normal `stepDelay` settle) or the
 * per-step `timeout` fiber fires (→ `Done`, having dispatched
 * `SniffingComplete` to abort the run rather than hang).
 *
 * Transitions:
 *   AwaitingPageLoaded(n)   ─PageLoaded, step n has no/ satisfied UrlMatch→ TimerPending(n, fiber)
 *   AwaitingPageLoaded(n)   ─PageLoaded, step n UrlMatch unmet→ AwaitingUrlMatch(n, timeoutFiber)
 *   AwaitingUrlMatch(d, tf) ─PageLoaded, url matches→ TimerPending(d, fiber)   (tf interrupted)
 *   AwaitingUrlMatch(d, tf) ─PageLoaded, url still unmatched→ AwaitingUrlMatch(d, tf)  (no-op)
 *   AwaitingUrlMatch(d, _)  ─timeout fires→ Done   (dispatches SniffingComplete)
 *   TimerPending(d, f)      ─PageLoaded→ TimerPending(d, fiber')   (f interrupted; fresh fiber)
 *   TimerPending(d, _)      ─timer fires, `d < N` → AwaitingPageLoaded(d + 1)
 *   TimerPending(N, _)      ─timer fires, `d ≡ N` → Done
 *   Done                    ─PageLoaded→ Done (WARN-log)
 *   any                     ─clear()→ AwaitingPageLoaded(0)
 *   any                     ─cancelAllInFlight→ AwaitingPageLoaded(d) (d preserved)
 *
 * All transitions go through `SynchronizedRef.update*Effect`, which
 * serializes reads and writes through a semaphore — no interleaving
 * is possible. Both the settle-timer and the URL-match timeout fibers
 * additionally check the cell against the fiber they scheduled
 * themselves as (`TimerPending.fiber` / `AwaitingUrlMatch.timeoutFiber`);
 * if another transition (`PageLoaded` re-arm, `clear`,
 * `cancelAllInFlight`) has swapped a different record in, the commit
 * no-ops and the replacement state survives.
 */
type StepState =
  | { readonly _tag: 'AwaitingPageLoaded'; readonly nextIndex: number }
  | {
      readonly _tag: 'TimerPending'
      readonly dispatchIndex: number
      readonly fiber: Fiber.RuntimeFiber<void, never>
    }
  | {
      readonly _tag: 'AwaitingUrlMatch'
      readonly dispatchIndex: number
      readonly timeoutFiber: Fiber.RuntimeFiber<void, never>
    }
  | { readonly _tag: 'Done' }

/**
 * The step-machine half of {@link CollectorBridgeMessageHandler}: the
 * `PageLoaded` handler, the settle-timer / URL-match-timeout daemons, and
 * this machine's share of `clear` / `cancelAllInFlight`. It interacts
 * with the response tracker only through the supplied `sendMessage`.
 */
interface StepMachine {
  readonly PageLoaded: Service['PageLoaded']
  /**
   * Interrupt any pending timer fiber and reset the index to 0. The
   * step machine's contribution to the composed `clear`.
   */
  readonly clear: () => Effect.Effect<void, never, never>
  /**
   * Interrupt any pending timer fiber and fold back to
   * `AwaitingPageLoaded` at the *same* index, so a future `PageLoaded`
   * re-attempts the step. The step machine's contribution to the
   * composed `cancelAllInFlight`.
   */
  readonly cancelAllInFlight: () => Effect.Effect<void, never, never>
}

const warnAndDrop = (event: { readonly url: string }): Effect.Effect<void, never, never> =>
  Effect.logWarning(
    `CollectorBridgeMessageHandler.PageLoaded: handler is done; ignoring (url=${event.url})`
  )

const make = <TResources>({
  scrapingPlan,
  sendMessage,
}: {
  scrapingPlan: ScrapingPlan.ScrapingPlan<TResources>
  sendMessage: (message: StepOutboundMessage) => Effect.Effect<void, never, never>
}): Effect.Effect<StepMachine, never, never> =>
  Effect.gen(function* () {
    const stepStateRef = yield* SynchronizedRef.make<StepState>({
      _tag: 'AwaitingPageLoaded',
      nextIndex: 0,
    })

    /**
     * The `advanceWhen` condition of the step at `index`, or `undefined`
     * for the out-of-range "index" that stands for the terminal
     * `SniffingComplete` (which is never URL-gated) and for steps that
     * don't declare one.
     */
    const advanceWhenForIndex = (index: number): Link.Advance | undefined =>
      index < scrapingPlan.linkSequence.length
        ? scrapingPlan.linkSequence[index].advanceWhen
        : undefined

    /**
     * The guarded daemon-commit pattern shared by {@link scheduleTimer}
     * and {@link scheduleTimeout}. Fork a daemon that:
     *   1. Sleeps `duration` (interruptible), inside the named span.
     *   2. Inside an `Effect.uninterruptible` block, takes the
     *      synchronized lock on `stepStateRef`. If the cell still holds
     *      the record this daemon installed — identity checked via
     *      `matchesInstalled(stepState, fiber)`, comparing `_tag`,
     *      `dispatchIndex`, and the fiber reference — runs `commit`.
     *      Otherwise no-ops.
     *
     * Returns the `StepState` record naming the forked fiber, for the
     * caller to install into `stepStateRef`.
     *
     * The fiber-identity check is the discriminator: any interleaved
     * transition (`PageLoaded` re-arm, `clear`, `cancelAllInFlight`)
     * installs a record naming a different (or no) fiber, so this
     * daemon's commit sees a stale view, no-ops, and the replacement
     * survives.
     *
     * Caller responsibility: interrupt any prior timer fiber before
     * scheduling a fresh one. Orphan fibers from skipped interrupts still
     * die safely (the identity check fails), but waste a
     * `duration`-length sleep.
     */
    const scheduleGuardedDaemon = (options: {
      readonly duration: Duration.Duration
      readonly spanName: string
      readonly spanAttributes: Record<string, string | number>
      readonly matchesInstalled: (stepState: StepState, fiber: RuntimeFiber<void, never>) => boolean
      readonly makeRecord: (fiber: RuntimeFiber<void, never>) => StepState
      readonly commit: Effect.Effect<StepState, never, never>
    }): Effect.Effect<StepState, never, never> =>
      Effect.gen(function* () {
        const fiber: RuntimeFiber<void, never> = yield* Effect.forkDaemon(
          Effect.gen(function* () {
            yield* Effect.sleep(options.duration).pipe(
              Effect.withSpan(options.spanName, { attributes: options.spanAttributes })
            )
            yield* Effect.uninterruptible(
              SynchronizedRef.getAndUpdateEffect(stepStateRef, (stepState) =>
                options.matchesInstalled(stepState, fiber)
                  ? options.commit
                  : Effect.succeed(stepState)
              )
            )
          })
        )
        return options.makeRecord(fiber)
      })

    /**
     * Schedule a fresh settle timer for `dispatchIndex` and return the
     * `TimerPending` record naming it. When the timer fires and the cell
     * still holds this record, dispatches the indexed link — or
     * `SniffingComplete` when `dispatchIndex === linkSequence.length` —
     * and transitions to the post-dispatch state. See
     * {@link scheduleGuardedDaemon} for the fiber-identity discipline.
     */
    const scheduleTimer = (dispatchIndex: number): Effect.Effect<StepState, never, never> =>
      scheduleGuardedDaemon({
        duration: scrapingPlan.stepDelay,
        spanName: Telemetry.Sniffing.Wait.Span.Name,
        spanAttributes: {
          [Telemetry.Sniffing.Attributes.StepIndex]: dispatchIndex,
          [Telemetry.Sniffing.Attributes.StepDelayMs]: Duration.toMillis(scrapingPlan.stepDelay),
        },
        matchesInstalled: (stepState, fiber) =>
          stepState._tag === 'TimerPending' &&
          stepState.dispatchIndex === dispatchIndex &&
          stepState.fiber === fiber,
        makeRecord: (fiber) => ({ _tag: 'TimerPending', dispatchIndex, fiber }),
        commit: Effect.gen(function* () {
          if (dispatchIndex < scrapingPlan.linkSequence.length) {
            // `Link.Open` / `Link.Click` / `Link.Fill` are
            // structurally identical to the `Open` / `Click` /
            // `Fill` bridge messages once the plan-only
            // `advanceWhen` field is dropped — strip it and
            // forward the rest verbatim.
            const link = scrapingPlan.linkSequence[dispatchIndex]
            const { advanceWhen: _advanceWhen, ...message } = link
            yield* sendMessage(message).pipe(
              Effect.withSpan(Telemetry.Sniffing.Dispatch.Span.Name, {
                attributes: {
                  [Telemetry.Sniffing.Attributes.StepIndex]: dispatchIndex,
                  [Telemetry.Sniffing.Attributes.LinkKind]: link._tag,
                },
              })
            )
            return {
              _tag: 'AwaitingPageLoaded',
              nextIndex: dispatchIndex + 1,
            } as const
          } else {
            yield* sendMessage({ _tag: 'SniffingComplete' }).pipe(
              Effect.withSpan(Telemetry.Sniffing.Dispatch.Span.Name, {
                attributes: {
                  [Telemetry.Sniffing.Attributes.StepIndex]: dispatchIndex,
                  [Telemetry.Sniffing.Attributes.LinkKind]: 'SniffingComplete',
                },
              })
            )
            return { _tag: 'Done' } as const
          }
        }),
      })

    /**
     * Schedule the URL-match wait cap for a step whose `advanceWhen` is
     * `UrlMatch` and whose target url has not been seen yet, returning
     * the `AwaitingUrlMatch` record naming its timeout fiber. When the
     * timeout fires and the cell still holds this record, aborts the run
     * by dispatching `SniffingComplete` and transitioning to `Done`. A
     * matching `PageLoaded` interrupts the fiber first (`PageLoaded`'s
     * `AwaitingUrlMatch` arm), so a fired timeout means the target url
     * genuinely never arrived. See {@link scheduleGuardedDaemon} for the
     * fiber-identity discipline.
     */
    const scheduleTimeout = (
      dispatchIndex: number,
      timeout: Duration.Duration
    ): Effect.Effect<StepState, never, never> =>
      scheduleGuardedDaemon({
        duration: timeout,
        spanName: Telemetry.Sniffing.UrlMatchWait.Span.Name,
        spanAttributes: {
          [Telemetry.Sniffing.Attributes.StepIndex]: dispatchIndex,
          [Telemetry.Sniffing.Attributes.UrlMatchTimeoutMs]: Duration.toMillis(timeout),
        },
        matchesInstalled: (stepState, fiber) =>
          stepState._tag === 'AwaitingUrlMatch' &&
          stepState.dispatchIndex === dispatchIndex &&
          stepState.timeoutFiber === fiber,
        makeRecord: (fiber) => ({ _tag: 'AwaitingUrlMatch', dispatchIndex, timeoutFiber: fiber }),
        commit: Effect.gen(function* () {
          yield* Effect.logWarning(
            `CollectorBridgeMessageHandler.PageLoaded: URL-match step ${dispatchIndex} timed out after ${Duration.toMillis(
              timeout
            )}ms with no matching PageLoaded; aborting via SniffingComplete`
          )
          yield* sendMessage({ _tag: 'SniffingComplete' }).pipe(
            Effect.withSpan(Telemetry.Sniffing.Dispatch.Span.Name, {
              attributes: {
                [Telemetry.Sniffing.Attributes.StepIndex]: dispatchIndex,
                [Telemetry.Sniffing.Attributes.LinkKind]: 'SniffingComplete',
              },
            })
          )
          return { _tag: 'Done' } as const
        }),
      })

    /**
     * Arm the machine for `dispatchIndex` given the url of the
     * `PageLoaded` just observed. A step with no `advanceWhen` (or a
     * `UrlMatch` whose pattern already matches this url) goes straight
     * to the `stepDelay` settle timer; a `UrlMatch` whose pattern does
     * not match parks in `AwaitingUrlMatch` under a fresh timeout fiber.
     *
     * The `advanceWhen` kind is dispatched through `Match.type` so future
     * `Advance` kinds (element-present, response-seen — see `model/link.ts`)
     * are added as arms rather than growing an inline `if` chain.
     */
    const armForIndex = (
      dispatchIndex: number,
      url: string
    ): Effect.Effect<StepState, never, never> => {
      const advance = advanceWhenForIndex(dispatchIndex)
      if (advance === undefined) {
        return scheduleTimer(dispatchIndex)
      }
      return Match.type<Link.Advance>().pipe(
        Match.tag('UrlMatch', (urlMatch) =>
          urlMatch.pattern.test(url)
            ? scheduleTimer(dispatchIndex)
            : scheduleTimeout(dispatchIndex, urlMatch.timeout)
        ),
        Match.exhaustive
      )(advance)
    }

    const PageLoaded: Service['PageLoaded'] = (event) =>
      // Atomic transition (serialized via SynchronizedRef):
      // - `AwaitingPageLoaded(n)`: arm step `n` for this url — a fixed
      //   settle timer, or (for an unmet `UrlMatch`) `AwaitingUrlMatch`.
      // - `TimerPending(d, f)`: interrupt `f`, then re-schedule the
      //   settle timer at the same `d` → `TimerPending(d, f')`. This is
      //   the "page navigated again mid-wait" case; restart the settle
      //   wait without advancing the index (the URL gate, if any, was
      //   already satisfied to reach `TimerPending`).
      // - `AwaitingUrlMatch(d, tf)`: re-test step `d`'s pattern against
      //   this url. On a match, interrupt the timeout fiber `tf` and
      //   start the settle timer → `TimerPending(d, f)`. Otherwise stay
      //   parked under the same timeout fiber.
      // - `Done`: WARN-log and stay in `Done`.
      SynchronizedRef.updateAndGetEffect(
        stepStateRef,
        Match.type<StepState>().pipe(
          Match.withReturnType<Effect.Effect<StepState>>(),
          Match.tag('TimerPending', (s) =>
            Fiber.interrupt(s.fiber).pipe(Effect.andThen(scheduleTimer(s.dispatchIndex)))
          ),
          Match.tag('AwaitingPageLoaded', (prior) => armForIndex(prior.nextIndex, event.url)),
          Match.tag('AwaitingUrlMatch', (s) => {
            const advance = advanceWhenForIndex(s.dispatchIndex)
            if (
              advance !== undefined &&
              advance._tag === 'UrlMatch' &&
              advance.pattern.test(event.url)
            ) {
              return Fiber.interrupt(s.timeoutFiber).pipe(
                Effect.andThen(scheduleTimer(s.dispatchIndex))
              )
            }
            return Effect.succeed(s)
          }),
          Match.tag('Done', (state) => warnAndDrop(event).pipe(Effect.as(state))),
          Match.exhaustive
        )
      ).pipe(Effect.asVoid)

    const reset: StepState = { _tag: 'AwaitingPageLoaded', nextIndex: 0 }

    const clear = (): Effect.Effect<void, never, never> =>
      // Atomic transition (serialized via SynchronizedRef): interrupt
      // any pending timer fiber, then reset the index to 0 regardless
      // of prior state. The daemon's fiber-identity check guards
      // against a racing commit from a not-yet-cancelled timer.
      SynchronizedRef.updateEffect(
        stepStateRef,
        Match.type<StepState>().pipe(
          Match.withReturnType<Effect.Effect<StepState>>(),
          Match.tag('TimerPending', (s) => Fiber.interrupt(s.fiber).pipe(Effect.as(reset))),
          Match.tag('AwaitingUrlMatch', (s) =>
            Fiber.interrupt(s.timeoutFiber).pipe(Effect.as(reset))
          ),
          Match.orElse(() => Effect.succeed(reset))
        )
      )

    const cancelAllInFlight = (): Effect.Effect<void, never, never> =>
      // Atomic transition (serialized via SynchronizedRef):
      // - `TimerPending(d, f)`: interrupt `f`, fold to `AwaitingPageLoaded(d)`.
      //   A future `PageLoaded` would re-attempt the same step.
      // - `AwaitingUrlMatch(d, tf)`: interrupt `tf`, fold to
      //   `AwaitingPageLoaded(d)` — a future `PageLoaded` re-attempts the
      //   URL-match wait from scratch.
      // - `AwaitingPageLoaded(n)` / `Done`: leave alone.
      SynchronizedRef.updateEffect(
        stepStateRef,
        Match.type<StepState>().pipe(
          Match.withReturnType<Effect.Effect<StepState>>(),
          Match.tag('TimerPending', (prior) =>
            Fiber.interrupt(prior.fiber).pipe(
              Effect.as({ _tag: 'AwaitingPageLoaded', nextIndex: prior.dispatchIndex })
            )
          ),
          Match.tag('AwaitingUrlMatch', (prior) =>
            Fiber.interrupt(prior.timeoutFiber).pipe(
              Effect.as({ _tag: 'AwaitingPageLoaded', nextIndex: prior.dispatchIndex })
            )
          ),
          Match.orElse((state) => Effect.succeed(state))
        )
      )

    return {
      PageLoaded,
      clear,
      cancelAllInFlight,
    }
  })

export type { StepMachine, StepOutboundMessage, StepState }
export { make }
