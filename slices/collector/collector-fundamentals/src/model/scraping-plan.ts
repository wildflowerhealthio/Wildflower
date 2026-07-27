import { Duration } from 'effect'
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
 * - `idleTimeout`: the plan's silent-host idle guard, used when the caller
 *   doesn't override it (the runner's `DEFAULT_IDLE_TIMEOUT` otherwise; an
 *   explicit runner option beats both). Raise it for a plan that ends in an
 *   `AwaitUserDismiss` step: that hold waits on a person, not the host, so the
 *   default 30 s guard would abandon the run long before the user acts. Set it
 *   comfortably *above* that step's own `timeout`, or the guard fires first and
 *   the hold's bound never gets to do its job.
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
 * Recursively freeze `value` — `kitchen-sink`'s `deepFreeze`, except that
 * `Duration`s are left alone.
 *
 * A plan carries `Duration`s in four places (`Delay.duration`,
 * `AwaitPageSettled.timeout`, `AwaitUserDismiss.timeout`, and `idleTimeout`), and
 * some of them are **process-wide singletons**: `Duration.infinity` and
 * `Duration.zero` are module-level values Effect hands out by reference, so
 * freezing one here mutates state every other caller in the process shares.
 * Concretely, `Duration`'s `Hash` implementation memoises onto the instance with
 * `Object.defineProperty`, which throws on a frozen object — so freezing
 * `Duration.infinity` while building one plan can make hashing it throw
 * anywhere, for the rest of the process.
 *
 * Fixed here rather than in `deepFreeze` itself: this is the boundary that knows
 * it is freezing Effect values, and narrowing the shared utility's semantics
 * would change behaviour for every other caller.
 */
const freezePlanValue = (value: unknown): void => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return
  }
  if (Duration.isDuration(value)) {
    return
  }
  Object.freeze(value)
  for (const child of Object.values(value)) {
    freezePlanValue(child)
  }
}

/**
 * Shallow-clone + deep-freeze the supplied plan. Freezing matters
 * because the handler pins the matched entity per in-flight request
 * at `ResponseStart` and seeds its step queue from `stepSequence`;
 * freezing also keeps the type-level `readonly` honest at runtime so
 * a caller can't push into `entityDefinitions` or `stepSequence`
 * after construction.
 *
 * `Duration`-valued fields are the one exception — see {@link freezePlanValue}.
 */
const make = <TResources>(plan: ScrapingPlan<TResources>): ScrapingPlan<TResources> => {
  const frozen: ScrapingPlan<TResources> = {
    name: plan.name,
    entityDefinitions: plan.entityDefinitions,
    firstPage: plan.firstPage,
    stepSequence: plan.stepSequence,
    maxGeneratedSteps: plan.maxGeneratedSteps,
    dedupeGeneratedOpenUris: plan.dedupeGeneratedOpenUris,
    idleTimeout: plan.idleTimeout,
  }
  freezePlanValue(frozen)
  return frozen
}

export { make, DEFAULT_MAX_GENERATED_STEPS }
export type { ScrapingPlan }
