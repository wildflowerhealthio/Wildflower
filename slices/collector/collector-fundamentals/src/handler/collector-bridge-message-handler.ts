import { type CancelSnifferRequestMessage, type PageActionMessage } from 'browser-sniffer-core'
import { Effect, type Mailbox, type MutableHashMap, Option, Schema } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import {
  type CollectorBridge,
  type EnsureSnifferVisible as EnsureSnifferVisibleMessage,
  OpenMessage,
  type SetSnifferStatus as SetSnifferStatusMessage,
  type SniffingComplete as SniffingCompleteMessage,
} from '../bridge.ts'
import { type Response, ScrapingPlan, WebViewSource } from '../model/index.ts'
import type * as Step from '../model/step.ts'
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
 * hand-off when the link sequence is exhausted (automatic navigation).
 * `EnsureSnifferVisible` is the fire-and-advance `EnsureWindowVisible` step's
 * request to re-present the sniffer webview. The `Open` / `PageAction` payloads
 * *are* a `Navigation` step's `action` — the handler forwards that `action` to
 * `sendMessage` without translation (the plan-only holds carry no `action`: a
 * `Delay` / `AwaitPageSettled` / `AwaitUserDismiss` step is consumed by the FSM as
 * a timer / page-settle / dismiss wait, so none reaches the wire).
 * `SetSnifferStatus` carries each step's `name` to the host, which writes it to
 * the sniffer chrome subtitle (automatic navigation).
 */
type OutboundMessage =
  | typeof CancelSnifferRequestMessage.Type
  | typeof OpenMessage.Type
  | typeof PageActionMessage.Type
  | typeof EnsureSnifferVisibleMessage.Type
  | typeof SniffingCompleteMessage.Type
  | typeof SetSnifferStatusMessage.Type

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
   * Start the automatic navigation: dispatch the plan's leading `Open` — which
   * builds the sniffer webview directly on the real target URL — without waiting
   * for its first `PageLoaded`. The runner fires this **once**, at run start
   * (that `Open` is the only mount), so a sniffer whose first page
   * never settles (its web content process dies, say) can't strand the run in
   * the automatic navigation's timer-less start-up state. See
   * {@link AutomaticNavigation.AutomaticNavigation.handleStart}.
   */
  readonly startAutomaticNavigation: Effect.Effect<void, never, never>
  /**
   * Force-close escape: publish every still-incomplete sniffed request as a
   * `Left` failure and close `requestSniffingResults`, so a caller can report a
   * stalled download as a loss instead of hanging. Nothing in the *runner* drives
   * it — the automatic-navigation machine's drained guard does, on expiry of the
   * plan's `drainedGuardTimeout`. Exposed here anyway so a caller can force the
   * same escape. See {@link RunLifecycleState}.
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
 * Structural guards compiled once (the `CollectorDescriptor`
 * `Schema.is(configSchema)` pattern): the step-action shapes below are
 * schema-backed, so their variants are tested with `Schema.is` rather than
 * hand-chained `_tag` comparisons.
 */
const isOpenAction = Schema.is(OpenMessage)
const isUriSource = Schema.is(WebViewSource.UriSchema)

/**
 * The `Uri` a step's `Open` action navigates to, or `undefined` for a
 * `PageAction` step, an `Open` with an inline `Html` source, or a `Delay`. Used
 * to key the generated-`Open` dedup visited-set (only `Uri` sources dedup).
 */
const openUri = (step: Step.Step): string | undefined => {
  if (step._tag !== 'Navigation') return undefined
  const { action } = step
  if (!isOpenAction(action)) return undefined
  return isUriSource(action.source) ? action.source.uri : undefined
}

/**
 * Compose the response tracker, the automatic navigation, and the run lifecycle into
 * the single `CollectorBridgeMessageHandler` public surface. The tracker owns
 * the five response handlers and the `incompleteSniffedRequests` map; the step
 * machine owns `PageLoaded`, the breadth-first step queue, and the generated
 * follow-ups; the {@link RunLifecycleState} owns the `requestSniffingResults`
 * stream and every way a run can end (`handleSniffingComplete` /
 * `abandonAllRequestSniffing` / `cancelAllRequestSniffing`). The two machines
 * interact only through the supplied `sendMessage` and the injected hooks, and
 * share no state — the lifecycle mediates completion via explicit
 * `onSniffingComplete` / `onDrained` hooks and the `signalNoMoreResultsExpected`
 * injection (no message-tag sniffing). See the
 * [Handler Explanation](../../docs/Handler%20Explanation.md).
 *
 * **Dedup + cap live here, at the injection point**, so the pure transition table
 * stays free of run-history: generated steps are filtered (run-wide URI dedup of
 * `Open`s, seeded with the authored `Open` URIs — which include the run's first
 * navigation; a `maxGeneratedSteps` cap) *before*
 * `handleStepsGenerated` dispatches them, and dropped counts are WARN-logged.
 *
 * The three parts form a construction cycle — the tracker publishes into the
 * lifecycle's stream and injects generated steps into the machine, the lifecycle
 * reads the tracker's incomplete-request state and drives the machine's
 * completion, and its teardown drives both machines. We break it the way the
 * automatic navigation breaks its own `dispatch`/`ctx` cycle: forward references
 * that are only *invoked* after construction (the tracker's hooks fire only when
 * a request settles; the lifecycle's `signalNoMoreResultsExpected` and teardown
 * fire only later), so there is no temporal-dead-zone hazard.
 */
const make = <TResources>({
  scrapingPlan,
  sendMessage,
  runId,
}: {
  scrapingPlan: ScrapingPlan.ScrapingPlan<TResources>
  sendMessage: (message: OutboundMessage) => Effect.Effect<void, never, never>
  /**
   * The framework-minted id of this sync run, from the
   * `ResourcePersistenceContext` the plan was sealed with. Pre-applied to the
   * plan's `captureProvenance` hook here so the tracker stays run-id-agnostic;
   * every trace the run writes shares it.
   */
  runId: string
}): Effect.Effect<CollectorBridgeMessageHandler<TResources>, never, never> =>
  Effect.gen(function* () {
    // Bind the plan's provenance hook (declared as a method for covariance —
    // see `ScrapingPlan`) with the run id applied, so the tracker receives a
    // plain `(response, produced)` capture or nothing at all.
    // oxlint-disable-next-line typescript-eslint/unbound-method -- pure, this-free method; the copy is safe
    const planCaptureProvenance = scrapingPlan.captureProvenance
    const captureProvenance =
      planCaptureProvenance === undefined
        ? undefined
        : (response: Response.RemoteResponse, produced: readonly TResources[]) =>
            planCaptureProvenance(runId, response, produced)
    // Run-wide crawler safety, applied to *generated* steps only (never the
    // authored sequence): dedup generated `Open`s by URI so a self-link or a
    // cycle terminates, and cap total generated steps. The visited-set is seeded
    // with the authored `Open` URIs (which include the run's first
    // navigation), so a generator can't re-open an
    // already-visited page.
    const maxGeneratedSteps =
      scrapingPlan.maxGeneratedSteps ?? ScrapingPlan.DEFAULT_MAX_GENERATED_STEPS
    const dedupeGeneratedOpenUris = scrapingPlan.dedupeGeneratedOpenUris ?? true
    const visitedUris = new Set<string>()
    // Only seed when dedup is on — with it off the set is never consulted below.
    if (dedupeGeneratedOpenUris) {
      for (const step of scrapingPlan.stepSequence) {
        const uri = openUri(step)
        if (uri !== undefined) visitedUris.add(uri)
      }
    }
    let generatedCount = 0

    /**
     * Filter a batch of `followUpSteps`-generated steps through dedup + cap, then
     * hand the survivors to the machine. WARN-logs the dropped counts. Only
     * `Uri`-source `Open`s participate in dedup; `PageAction` / `Delay` /
     * inline-`Html` `Open`s pass through (and don't count against the visited-set,
     * but do count against the cap).
     */
    const enqueueGeneratedSteps = (
      steps: readonly Step.Step[]
    ): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
        const kept: Step.Step[] = []
        let dedupDropped = 0
        let capDropped = 0
        for (const step of steps) {
          const uri = dedupeGeneratedOpenUris ? openUri(step) : undefined
          if (uri !== undefined && visitedUris.has(uri)) {
            dedupDropped += 1
            continue
          }
          if (generatedCount >= maxGeneratedSteps) {
            capDropped += 1
            continue
          }
          if (uri !== undefined) visitedUris.add(uri)
          generatedCount += 1
          kept.push(step)
        }
        if (dedupDropped > 0) {
          yield* Effect.logWarning(
            `CollectorBridgeMessageHandler: dropped ${dedupDropped} generated Open step(s) whose URI was already visited`
          )
        }
        if (capDropped > 0) {
          yield* Effect.logWarning(
            `CollectorBridgeMessageHandler: maxGeneratedSteps (${maxGeneratedSteps}) reached; dropped ${capDropped} generated step(s)`
          )
        }
        if (kept.length > 0) yield* automaticNavigation.handleStepsGenerated(kept)
      })

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
        handleGeneratedSteps: (steps) => enqueueGeneratedSteps(steps),
        captureProvenance,
      })

    const lifecycle: RunLifecycleState.RunLifecycleState<TResources> =
      yield* RunLifecycleState.make<TResources>({
        hasIncompleteSniffedRequests: tracker.hasIncompleteSniffedRequests,
        failIncompleteSniffedRequests: tracker.failIncompleteSniffedRequests,
        cancelIncompleteSniffedRequests: tracker.cancelIncompleteSniffedRequests,
        stopAutomaticNavigation: () => automaticNavigation.stopAutomaticNavigation(),
        // Forward-ref the machine (built below): only *invoked* at runtime.
        signalNoMoreResultsExpected: Effect.suspend(
          () => automaticNavigation.signalNoMoreResultsExpected
        ),
      })

    // `sendMessage` is a plain passthrough: the automatic navigation's terminal
    // `SniffingComplete` reaches the lifecycle through the explicit
    // `onSniffingComplete` hook, and the queue-drained fact through `onDrained`
    // (wired to the lifecycle's end-check so a trailing `Delay` still completes).
    const automaticNavigation: AutomaticNavigation.AutomaticNavigation =
      yield* AutomaticNavigation.make<TResources>({
        scrapingPlan,
        sendMessage,
        onSniffingComplete: lifecycle.handleSniffingComplete,
        onDrained: lifecycle.endRequestSniffingResultsUnlessMoreExpected,
        // The tail bound: a stalled request becomes a reported partial result
        // rather than a permanent hang.
        onDrainedGuardExpired: lifecycle.abandonAllRequestSniffing,
      })

    return {
      incompleteSniffedRequests: tracker.incompleteSniffedRequests,
      requestSniffingResults: lifecycle.requestSniffingResults,
      startAutomaticNavigation: automaticNavigation.handleStart,
      abandonAllRequestSniffing: lifecycle.abandonAllRequestSniffing,
      cancelAllRequestSniffing: lifecycle.cancelAllRequestSniffing,
      ResponseStart: tracker.handleResponseStart,
      ResponseData: tracker.handleResponseData,
      ResponseFinished: tracker.handleResponseFinished,
      RequestError: tracker.handleRequestError,
      Cancelled: tracker.handleCancelled,
      PageLoaded: automaticNavigation.handlePageLoaded,
      PageRequested: automaticNavigation.handlePageRequested,
      UserDismissed: automaticNavigation.handleUserDismissed,
      SnifferDisposed: automaticNavigation.handleSnifferDisposed,
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
