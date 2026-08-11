import { Duration, type Effect } from 'effect'
import type * as EntityDefinition from './entity-definition.ts'
import type { RemoteResponse } from './response.ts'
import type * as Step from './step.ts'

/** Default {@link ScrapingPlan.maxGeneratedSteps} when a plan omits it. */
const DEFAULT_MAX_GENERATED_STEPS = 500

/**
 * What one invocation of {@link ScrapingPlan.captureProvenance} hands back:
 * the parse output (possibly annotated with links) and any diagnostic
 * resources the capture minted alongside it.
 */
interface CaptureProvenanceResult<TResources> {
  /** The parse output, possibly link-annotated; the run's primary output. */
  readonly resources: readonly TResources[]
  /**
   * Records *about* the run, not part of it — persisted best-effort through
   * the same sink, WARN-logged on failure, and never part of the run's
   * failure summary.
   */
  readonly diagnostics: readonly TResources[]
}

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
 *     `stepSequence`. The host mounts the sniffer webview on `about:blank`; its
 *     near-instant settle is the first `PageLoaded`, which kicks off draining
 *     the queue front-to-back — so the plan's first step is an `Open` to the
 *     real starting page. Each `Navigation` step's `action` is dispatched and
 *     the drain immediately continues (a `Fill` / `Click` / `Open` never waits
 *     for a `PageLoaded`), a `Delay` step arms a timer for its `duration`, and
 *     an `AwaitPageSettled` step holds until a settled `PageLoaded` matches its
 *     `pattern` — or, when it has no `pattern`, until the *next* settled load
 *     arrives (aborting via `SniffingComplete` if its `timeout` elapses first).
 *     When the queue drains *and* every sniffed request has settled, fires
 *     `SniffingComplete`.
 *   - Appends any steps an entity's `followUpSteps` produces to the *back* of
 *     that same queue, so a parsed list/table can open every page it links —
 *     naturally recursive. `maxGeneratedSteps` and run-wide URI dedup of
 *     generated `Open`s (see below) keep that fan-out terminating.
 *
 * The sniffer webview is always mounted on `about:blank` (the host takes no
 * per-plan starting page), so the run's very first navigation is an authored
 * `Open` step at the head of `stepSequence`.
 *
 * - `name`: stable identifier for logs / UI.
 * - `entityDefinitions`: ordered list of recognizer/parser pairs.
 *   `CollectorBridgeMessageHandler` consults `isFoundAt` against each
 *   response URL; the first match wins.
 * - `stepSequence`: the *initial* contents of the navigation queue — an
 *   ordered list of `Step`s (`Navigation` actions and/or `Delay` pauses),
 *   beginning with the `Open` that navigates off `about:blank` to the real
 *   first page. An empty array completes as soon as `about:blank` settles.
 * - `maxGeneratedSteps`: per-run safety cap on steps produced by
 *   `followUpSteps` (default {@link DEFAULT_MAX_GENERATED_STEPS}). Generated
 *   steps beyond it are WARN-logged and dropped; the run continues. The
 *   authored `stepSequence` never counts against this.
 * - `dedupeGeneratedOpenUris`: when `true` (the default), a *generated* `Open`
 *   step whose `Uri` source was already visited (any authored `Open` or an
 *   earlier generated `Open`) is dropped, so a page that links to itself or a
 *   cycle of pages terminates. Dedup applies only to *generated* steps — the
 *   authored sequence is never dropped.
 */
interface ScrapingPlan<TResources> {
  readonly name: string
  readonly entityDefinitions: readonly EntityDefinition.EntityDefinition<TResources>[]
  readonly stepSequence: readonly Step.Step[]
  readonly maxGeneratedSteps?: number
  readonly dedupeGeneratedOpenUris?: boolean
  // Declared as a *method* signature, not a `readonly` arrow property, for the
  // same reason as `EntityDefinition.followUpSteps`: `produced` puts
  // `TResources` in a parameter (contravariant) position, which would make
  // `ScrapingPlan` invariant in `TResources` and break the
  // `ScrapingPlan<Resources>` → `ScrapingPlan<unknown>` widening the
  // sealed-`Resources` existential relies on. Method parameters are checked
  // bivariantly, so this keeps the type covariant.
  /**
   * The plan-level provenance seam. When present, the handler invokes it once
   * per response whose parse succeeded with a **non-empty** batch — the only
   * moment the "this response → these resources" pairing exists — passing the
   * framework-minted run id, the settled response, and the parse output.
   *
   * The framework owns every rule that keeps this a diagnostic: a failed parse
   * is never captured, an empty parse is never captured, a failing or *dying*
   * hook is WARN-logged and the parse output flows on unchanged (hence the
   * permissive `unknown` error channel — nothing downstream widens), and
   * `followUpSteps` always sees the raw parse output, never the hook's.
   * `diagnostics` ride a separate channel to the sink and are written
   * best-effort — see {@link CaptureProvenanceResult}.
   */
  captureProvenance?(
    runId: string,
    response: RemoteResponse,
    produced: readonly TResources[]
  ): Effect.Effect<CaptureProvenanceResult<TResources>, unknown>
}

/**
 * Recursively freeze `value` — `kitchen-sink`'s `deepFreeze`, except that
 * `Duration`s are left alone.
 *
 * A plan carries `Duration`s in three places (`Delay.duration`,
 * `AwaitPageSettled.timeout`, and `AwaitUserDismiss.timeout`), and some of them
 * are **process-wide singletons**: `Duration.infinity` and
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
    stepSequence: plan.stepSequence,
    maxGeneratedSteps: plan.maxGeneratedSteps,
    dedupeGeneratedOpenUris: plan.dedupeGeneratedOpenUris,
    // Declared as a method (for covariance — see the interface note), so
    // copying the reference trips `unbound-method`; it is a pure, `this`-free
    // function, so the concern (unintended `this` scoping) can't apply.
    // oxlint-disable-next-line typescript-eslint/unbound-method -- pure, this-free method; the copy is safe
    captureProvenance: plan.captureProvenance,
  }
  freezePlanValue(frozen)
  return frozen
}

export { make, DEFAULT_MAX_GENERATED_STEPS }
export type { CaptureProvenanceResult, ScrapingPlan }
