import type { Duration } from 'effect'
import { deepFreeze } from 'kitchen-sink'
import type * as EntityDefinition from './entity-definition.ts'
import type * as Step from './step.ts'
import type * as WebViewSource from './web-view-source.ts'

/**
 * Per-slice declaration of *what* to recognize on a sync run and *how*
 * to walk through it. Wiring this up to a live network stream is the
 * job of
 * ```
 * CollectorBridgeMessageHandler.make({
 *   scrapingPlan,
 *   sendMessage
 * })
 * ```
 * whose `results` mailbox carries each terminal outcome, and which:
 *
 *   - Consults `entityDefinitions` for each `ResponseStart` to decide
 *     whether to track the in-flight response (first `isFoundAt` match
 *     wins; non-matching responses are cancelled via `sendMessage`).
 *   - Drives the sniffer through `stepSequence` step-by-step,
 *     dispatching each `LeafStep`'s `action` `stepDelay` after each
 *     `PageLoaded` event. A step may instead carry `advanceWhen: { _tag: 'UrlMatch',
 *     … }`, in which case the handler holds it until a `PageLoaded`
 *     whose `url` matches the pattern (then still waits `stepDelay`),
 *     aborting via `SniffingComplete` if the per-step `timeout` elapses
 *     first. A `ForEachStep` instead runs runtime link discovery
 *     (`QueryMatches`/`MatchesFound`) and expands into one `body(match)`
 *     sub-sequence per discovered match inside the machine's dynamic step
 *     queue — the plan below stays frozen. When the (possibly expanded)
 *     sequence is exhausted, fires `SniffingComplete` after a final
 *     `stepDelay`.
 *
 * `firstPage` is the host-side `WebViewSource` the sniffer webview is
 * initially mounted with; it is *not* read by the handler (the handler
 * only sees PageLoaded events). It lives on the plan so each slice's
 * configuration is a single export.
 *
 * Replaces the previous `RemoteKind<T>` shape (`name + entityDefinitions`),
 * absorbing the slice's `firstPage(config)` factory and adding the new
 * `stepSequence` / `stepDelay` fields. Splitting "what to recognize"
 * from "how to navigate" was attempted and reverted: every consumer
 * needed both, and a single per-config function is easier to reason
 * about.
 *
 * - `name`: stable identifier for logs / UI.
 * - `entityDefinitions`: ordered list of recognizer/parser pairs.
 *   `CollectorBridgeMessageHandler` consults `isFoundAt` against each
 *   response URL; the first match wins.
 * - `firstPage`: the initial `WebViewSource` (inline HTML or absolute
 *   `https://` URI) to mount the sniffer webview with.
 * - `stepSequence`: ordered list of navigation steps, each a `LeafStep` or a
 *   `ForEachStep`. A `LeafStep`'s `action` is forwarded to the sniffer
 *   verbatim: an `Open` action becomes an `Open` web→host message
 *   (host-navigation); a `PageAction` action becomes a `PageAction` message
 *   the sniffer demuxes by its inner `kind` (`Click` / `Fill`). A `ForEachStep`
 *   fans out over links the sniffer discovers at runtime. A step's optional
 *   `advanceWhen` gates when it is dispatched (default: a fixed `stepDelay`;
 *   `UrlMatch`: after a matching `PageLoaded`). An empty array fires
 *   `SniffingComplete` after the first `PageLoaded`.
 * - `stepDelay`: how long the handler waits between observing a
 *   `PageLoaded` and dispatching the next step (or `SniffingComplete`).
 *   The wait lets any post-load XHR fan-out finish before the next
 *   navigation tears the page down. Per-slice so each scraper can
 *   pick a cadence that matches the remote's loading characteristics.
 */
interface ScrapingPlan<TResources> {
  readonly name: string
  readonly entityDefinitions: readonly EntityDefinition.EntityDefinition<TResources>[]
  readonly firstPage: WebViewSource.Any
  readonly stepSequence: readonly Step.Step[]
  readonly stepDelay: Duration.Duration
}

/**
 * Shallow-clone + deep-freeze the supplied plan. Freezing matters
 * because the handler pins the matched entity per in-flight request
 * at `ResponseStart` and consumes `stepSequence` step-by-step;
 * freezing also keeps the type-level `readonly` honest at runtime so
 * a caller can't push into `entityDefinitions` or `stepSequence`
 * after construction.
 */
const make = <TResources>(plan: ScrapingPlan<TResources>): ScrapingPlan<TResources> =>
  deepFreeze({
    name: plan.name,
    entityDefinitions: plan.entityDefinitions,
    firstPage: plan.firstPage,
    stepSequence: plan.stepSequence,
    stepDelay: plan.stepDelay,
  })

export { make }
export type { ScrapingPlan }
