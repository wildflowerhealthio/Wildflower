import { type CancelSnifferRequestMessage, type PageActionMessage } from 'browser-sniffer-core'
import { Effect, type Mailbox, type MutableHashMap, Option } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import type {
  CollectorBridge,
  OpenMessage,
  SniffingComplete as SniffingCompleteMessage,
} from '../bridge.ts'
import type { ScrapingPlan } from '../model/index.ts'
import * as AutomaticNavigation from './automatic-navigation/index.ts'
import * as RunLifecycleState from './run-lifecycle-state.ts'
import * as SnifferResponseTracker from './sniffer-response-tracker.ts'
import {
  type IncompleteSniffedRequest,
  SnifferCancelled,
  type SniffFailure,
  type SniffResult,
} from './sniffer-response-tracker.ts'

type Service = MessageHandler.HandlersFor<CollectorBridge['HostToWeb']>

/**
 * The union of every message the handler can ask the host to send via
 * the supplied `sendMessage`. `CancelSnifferRequest` short-circuits an
 * unmatched response stream (response tracker); `Open` / `PageAction`
 * drive the scripted navigation and `SniffingComplete` is the terminal
 * hand-off when the link sequence is exhausted (automatic navigation). The
 * `Open` / `PageAction` payloads *are* the step's `action` — the handler
 * forwards `scrapingPlan.stepSequence[i].action` to `sendMessage` without
 * translation (the plan-only `advanceWhen` rides the step wrapper, never
 * the action).
 */
type OutboundMessage =
  | typeof CancelSnifferRequestMessage.Type
  | typeof OpenMessage.Type
  | typeof PageActionMessage.Type
  | typeof SniffingCompleteMessage.Type

interface CollectorBridgeMessageHandler<TResources> extends Service {
  readonly incompleteSniffedRequests: MutableHashMap.MutableHashMap<
    string,
    IncompleteSniffedRequest<TResources>
  >
  /**
   * The run's {@link SniffResult} stream, surfaced as the handler's result
   * source. Read-only: the handler is the sole producer. The runner drains this
   * instead of being handed an `onResult` callback — see the
   * [Handler Explanation](../../docs/Handler%20Explanation.md).
   */
  readonly requestSniffingResults: Mailbox.ReadonlyMailbox<SniffResult<TResources>>
  /**
   * Idle-timeout escape: publish every still-incomplete sniffed request as a
   * `Left` failure and close `requestSniffingResults`. The runner calls this when
   * its drive loop has been idle past the idle timeout (a stalled download that
   * never finished), so the run reports the loss instead of hanging. See
   * {@link RunLifecycleState}.
   */
  readonly abandonAllRequestSniffing: Effect.Effect<void, never, never>
  /**
   * Screen-unmount teardown: stop the automatic navigation (interrupt the
   * pending step-timer fiber) and ask the host to `CancelSnifferRequest` every
   * still-incomplete sniffed request, so the page stops streaming bytes that
   * would otherwise be log-and-dropped by the runtime provider once the handler
   * ref is null. Publishes no result and does not close the stream — the consumer
   * has gone.
   *
   * The Effect runs each cancel sequentially; consumers typically
   * `Effect.runFork` it during a synchronous React cleanup.
   */
  readonly cancelAllRequestSniffing: (
    send: (message: typeof CancelSnifferRequestMessage.Type) => Effect.Effect<void, never, never>
  ) => Effect.Effect<void, never, never>
}

/**
 * Compose the response tracker, the automatic navigation, and the run lifecycle into
 * the single `CollectorBridgeMessageHandler` public surface. The tracker owns
 * the five response handlers and the `incompleteSniffedRequests` map; the step
 * machine owns `PageLoaded` and the scripted `stepSequence`; the
 * {@link RunLifecycleState} owns the `requestSniffingResults` stream and every way a
 * run can end (`handleSniffingComplete` / `abandonAllRequestSniffing` /
 * `cancelAllRequestSniffing`). The two machines interact only through the
 * supplied `sendMessage` and share no state — the lifecycle mediates completion
 * via an explicit `onSniffingComplete` hook (no message-tag sniffing). See the
 * [Handler Explanation](../../docs/Handler%20Explanation.md).
 *
 * The three parts form a construction cycle — the tracker publishes into the
 * lifecycle's stream, the lifecycle reads the tracker's incomplete-request state
 * and the automatic navigation's completion, and its teardown drives both machines. We
 * break it the way the automatic navigation breaks its own `dispatch`/`ctx` cycle:
 * forward references that are only *invoked* after construction. The tracker's
 * `handleNewSniffResult` closes over `lifecycle` (fired only when a request
 * settles), and the lifecycle's teardown
 * closes over `automaticNavigation` (fired only at teardown), so there is no
 * temporal-dead-zone hazard.
 */
const make = <TResources>({
  scrapingPlan,
  sendMessage,
}: {
  scrapingPlan: ScrapingPlan.ScrapingPlan<TResources>
  sendMessage: (message: OutboundMessage) => Effect.Effect<void, never, never>
}): Effect.Effect<CollectorBridgeMessageHandler<TResources>, never, never> =>
  Effect.gen(function* () {
    // Explicit annotations break the construction cycle's type inference (the
    // three bindings reference one another): without them TS infers `any`.
    const tracker: SnifferResponseTracker.SnifferResponseTracker<TResources> =
      yield* SnifferResponseTracker.make<TResources>({
        // The tracker only needs "which entity (if any) parses this URL"; derive
        // it from the plan here so the tracker stays decoupled from `ScrapingPlan`.
        matchEntity: (url) =>
          Option.fromNullable(scrapingPlan.entityDefinitions.find((e) => e.isFoundAt(url))),
        sendMessage,
        handleNewSniffResult: (result) => lifecycle.handleNewSniffResult(result),
      })

    const lifecycle: RunLifecycleState.RunLifecycleState<TResources> =
      yield* RunLifecycleState.make<TResources>({
        hasIncompleteSniffedRequests: tracker.hasIncompleteSniffedRequests,
        failIncompleteSniffedRequests: tracker.failIncompleteSniffedRequests,
        cancelIncompleteSniffedRequests: tracker.cancelIncompleteSniffedRequests,
        stopAutomaticNavigation: () => automaticNavigation.stopAutomaticNavigation(),
      })

    // `sendMessage` is now a plain passthrough: the automatic navigation's
    // terminal `SniffingComplete` reaches the lifecycle through the explicit
    // `onSniffingComplete` hook, not by inspecting the outbound message tag.
    const automaticNavigation: AutomaticNavigation.AutomaticNavigation =
      yield* AutomaticNavigation.make<TResources>({
        scrapingPlan,
        sendMessage,
        onSniffingComplete: lifecycle.handleSniffingComplete,
      })

    return {
      incompleteSniffedRequests: tracker.incompleteSniffedRequests,
      requestSniffingResults: lifecycle.requestSniffingResults,
      abandonAllRequestSniffing: lifecycle.abandonAllRequestSniffing,
      cancelAllRequestSniffing: lifecycle.cancelAllRequestSniffing,
      ResponseStart: tracker.handleResponseStart,
      ResponseData: tracker.handleResponseData,
      ResponseFinished: tracker.handleResponseFinished,
      RequestError: tracker.handleRequestError,
      Cancelled: tracker.handleCancelled,
      PageLoaded: automaticNavigation.handlePageLoaded,
    }
  })

export type {
  CollectorBridgeMessageHandler,
  IncompleteSniffedRequest,
  OutboundMessage,
  SniffFailure,
  SniffResult,
}
export { make, SnifferCancelled }
