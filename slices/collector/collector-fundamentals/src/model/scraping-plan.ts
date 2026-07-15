import type { Duration } from 'effect'
import { deepFreeze } from 'kitchen-sink'
import type * as EntityDefinition from './entity-definition.ts'
import type * as Link from './link.ts'
import type * as WebViewSource from './web-view-source.ts'

/**
 * Per-slice declaration of *what* to recognize on a sync run and *how*
 * to walk through it. Wiring this up to a live network stream is the
 * job of
 * ```
 * CollectorBridgeMessageHandler.make({
 *   scrapingPlan,
 *   sendMessage,
 *   onResult
 * })
 * ```
 * which:
 *
 *   - Consults `entityDefinitions` for each `ResponseStart` to decide
 *     whether to track the in-flight response (first `isFoundAt` match
 *     wins; non-matching responses are cancelled via `sendMessage`).
 *   - Drives the sniffer through `linkSequence` step-by-step,
 *     dispatching each `Link.Step`'s `action` `stepDelay` after each
 *     `PageLoaded` event. A step may instead carry `advanceWhen: { _tag: 'UrlMatch',
 *     … }`, in which case the handler holds it until a `PageLoaded`
 *     whose `url` matches the pattern (then still waits `stepDelay`),
 *     aborting via `SniffingComplete` if the per-step `timeout` elapses
 *     first. When the sequence is exhausted, fires `SniffingComplete`
 *     after a final `stepDelay`.
 *
 * `firstPage` is the host-side `WebViewSource` the sniffer webview is
 * initially mounted with; it is *not* read by the handler (the handler
 * only sees PageLoaded events). It lives on the plan so each slice's
 * configuration is a single export.
 *
 * Replaces the previous `RemoteKind<T>` shape (`name + entityDefinitions`),
 * absorbing the slice's `firstPage(config)` factory and adding the new
 * `linkSequence` / `stepDelay` fields. Splitting "what to recognize"
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
 * - `linkSequence`: ordered list of navigation steps. Each step's `action`
 *   is forwarded to the sniffer verbatim: an `Open` action becomes an `Open`
 *   web→host message (host-navigation); a `PageAction` action becomes a
 *   `PageAction` message the sniffer demuxes by its inner `kind`
 *   (`Click` / `Fill`). A step's optional `advanceWhen` gates when it is
 *   dispatched (default: a fixed `stepDelay`; `UrlMatch`: after a matching
 *   `PageLoaded`). An empty array fires `SniffingComplete` after the first
 *   `PageLoaded`.
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
  readonly linkSequence: readonly Link.Step[]
  readonly stepDelay: Duration.Duration
}

/**
 * Shallow-clone + deep-freeze the supplied plan. Freezing matters
 * because the handler pins the matched entity per in-flight request
 * at `ResponseStart` and consumes `linkSequence` step-by-step;
 * freezing also keeps the type-level `readonly` honest at runtime so
 * a caller can't push into `entityDefinitions` or `linkSequence`
 * after construction.
 */
const make = <TResources>(plan: ScrapingPlan<TResources>): ScrapingPlan<TResources> =>
  deepFreeze({
    name: plan.name,
    entityDefinitions: plan.entityDefinitions,
    firstPage: plan.firstPage,
    linkSequence: plan.linkSequence,
    stepDelay: plan.stepDelay,
  })

/**
 * The `advanceWhen` condition of the step at `index`, or `undefined` for
 * the out-of-range "index" that stands for the terminal `SniffingComplete`
 * (never URL-gated) and for steps that don't declare one.
 */
const advanceConditionByIndex = <TResources>(
  scrapingPlan: ScrapingPlan<TResources>,
  index: number
): Link.Advance | undefined =>
  index < scrapingPlan.linkSequence.length
    ? scrapingPlan.linkSequence[index].advanceWhen
    : undefined

export { make, advanceConditionByIndex }
export type { ScrapingPlan }
