import type { Duration } from 'effect'
import { deepFreeze } from 'kitchen-sink'
import type * as EntityDefinition from './entity-definition.ts'
import type * as Step from './step.ts'
import type * as WebViewSource from './web-view-source.ts'

/** Default {@link ScrapingPlan.maxGeneratedSteps} when a plan omits it. */
const DEFAULT_MAX_GENERATED_STEPS = 500

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
 * whose `requestSniffingResults` stream carries each terminal outcome, and
 * which:
 *
 *   - Consults `entityDefinitions` for each `ResponseStart` to decide
 *     whether to track the in-flight response (first `isFoundAt` match
 *     wins; non-matching responses are cancelled via `sendMessage`).
 *   - Drives the sniffer through a **breadth-first step queue** seeded with
 *     `stepSequence`. Starting on the first settled `PageLoaded` it drains the
 *     queue front-to-back: each `Navigation` step's `action` is dispatched and
 *     the drain immediately continues (a `Fill` / `Click` / `Open` never waits
 *     for a `PageLoaded`), a `Delay` step arms a timer for its `duration`, and
 *     an `AwaitPageSettled` step holds until a settled `PageLoaded` matches its
 *     `pattern` (aborting via `SniffingComplete` if its `timeout` elapses first).
 *     When the queue drains *and* every sniffed request has settled, fires
 *     `SniffingComplete`.
 *   - Appends any steps an entity's `followUpSteps` produces to the *back* of
 *     that same queue, so a parsed list/table can open every page it links —
 *     naturally recursive. `maxGeneratedSteps` and run-wide URI dedup of
 *     generated `Open`s (see below) keep that fan-out terminating.
 *
 * `firstPage` is the host-side `WebViewSource` the sniffer webview is
 * initially mounted with; it is *not* read by the handler (the handler
 * only sees PageLoaded events). It lives on the plan so each slice's
 * configuration is a single export.
 *
 * - `name`: stable identifier for logs / UI.
 * - `entityDefinitions`: ordered list of recognizer/parser pairs.
 *   `CollectorBridgeMessageHandler` consults `isFoundAt` against each
 *   response URL; the first match wins.
 * - `firstPage`: the initial `WebViewSource` (inline HTML or absolute
 *   `https://` URI) to mount the sniffer webview with.
 * - `stepSequence`: the *initial* contents of the navigation queue — an
 *   ordered list of `Step`s (`Navigation` actions and/or `Delay` pauses). An
 *   empty array completes as soon as the first `PageLoaded`'s requests settle.
 * - `maxGeneratedSteps`: per-run safety cap on steps produced by
 *   `followUpSteps` (default {@link DEFAULT_MAX_GENERATED_STEPS}). Generated
 *   steps beyond it are WARN-logged and dropped; the run continues. The
 *   authored `stepSequence` never counts against this.
 * - `dedupeGeneratedOpenUris`: when `true` (the default), a *generated* `Open`
 *   step whose `Uri` source was already visited (the `firstPage`, any authored
 *   `Open`, or an earlier generated `Open`) is dropped, so a page that links to
 *   itself or a cycle of pages terminates. Dedup applies only to *generated*
 *   steps — the authored sequence is never dropped.
 * - `idleTimeout`: overrides the sync runner's silent-host idle guard for this
 *   plan (the runner's `DEFAULT_IDLE_TIMEOUT` otherwise). Raise it (e.g.
 *   `Duration.infinity`) for a plan that ends in an `AwaitUserDismiss` step, whose
 *   wait for the user to close the sniffer webview is unbounded and would
 *   otherwise be abandoned by the default idle timeout.
 */
interface ScrapingPlan<TResources> {
  readonly name: string
  readonly entityDefinitions: readonly EntityDefinition.EntityDefinition<TResources>[]
  readonly firstPage: WebViewSource.Any
  readonly stepSequence: readonly Step.Step[]
  readonly maxGeneratedSteps?: number
  readonly dedupeGeneratedOpenUris?: boolean
  readonly idleTimeout?: Duration.DurationInput
}

/**
 * Shallow-clone + deep-freeze the supplied plan. Freezing matters
 * because the handler pins the matched entity per in-flight request
 * at `ResponseStart` and seeds its step queue from `stepSequence`;
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
    maxGeneratedSteps: plan.maxGeneratedSteps,
    dedupeGeneratedOpenUris: plan.dedupeGeneratedOpenUris,
    idleTimeout: plan.idleTimeout,
  })

export { make, DEFAULT_MAX_GENERATED_STEPS }
export type { ScrapingPlan }
