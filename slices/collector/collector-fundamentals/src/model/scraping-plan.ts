import { Duration, type Effect } from 'effect'
import type * as CollectorHttpResponseKind from './collector-http-response-kind.ts'
import type { CollectorHttpResponse } from './collector-http-response.ts'
import type * as Step from './step.ts'

/** Default {@link ScrapingPlan.maxGeneratedSteps} when a plan omits it. */
const DEFAULT_MAX_GENERATED_STEPS = 500

/**
 * Default {@link ScrapingPlan.drainedGuardTimeout} when a plan omits it.
 * Generous, because it only ever runs with the queue empty: a minute of total
 * silence there means the host will not deliver the terminal event.
 */
const DEFAULT_DRAINED_GUARD_TIMEOUT = Duration.seconds(60)

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
 *   - Consults `responseKinds` for each `ResponseStart` to decide
 *     whether to track the in-flight response (first `isFoundAt` match
 *     wins; non-matching responses are cancelled via `sendMessage`).
 *   - Drives the sniffer through a **breadth-first step queue** seeded with
 *     `stepSequence`. The runner's one-shot `Start` kicks off draining the
 *     queue front-to-back with no page in hand — so the plan's first step is an
 *     `Open`, which is what *builds* the sniffer webview, on the real starting
 *     page. Each `Navigation` step's `action` is dispatched and
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
 * There is no placeholder mount: the host builds the sniffer webview on the
 * first `Open` it receives, so the run's very first navigation is an authored
 * `Open` step at the head of `stepSequence`.
 *
 * - `name`: stable identifier for logs / UI.
 * - `responseKinds`: ordered list of recognizer/parser pairs.
 *   `CollectorBridgeMessageHandler` consults `isFoundAt` against each
 *   response URL; the first match wins.
 * - `stepSequence`: the *initial* contents of the navigation queue — an
 *   ordered list of `Step`s (`Navigation` actions and/or `Delay` pauses),
 *   beginning with the `Open` that opens the real first page. An empty array
 *   completes as soon as the run starts — no page is ever opened.
 * - `maxGeneratedSteps`: per-run safety cap on steps produced by
 *   `followUpSteps` (default {@link DEFAULT_MAX_GENERATED_STEPS}). Generated
 *   steps beyond it are WARN-logged and dropped; the run continues. The
 *   authored `stepSequence` never counts against this.
 * - `dedupeGeneratedOpenUris`: when `true` (the default), a *generated* `Open`
 *   step whose `Uri` source was already visited (any authored `Open` or an
 *   earlier generated `Open`) is dropped, so a page that links to itself or a
 *   cycle of pages terminates. Dedup applies only to *generated* steps — the
 *   authored sequence is never dropped.
 * - `drainedGuardTimeout`: bounds the run's *tail* — the window after the queue
 *   drains where completion waits only on in-flight requests to settle, and no
 *   step hold is parked to bound anything (default
 *   {@link DEFAULT_DRAINED_GUARD_TIMEOUT}). Raise it for a plan whose tail
 *   requests are legitimately slow; it never has to account for how long the
 *   plan's *holds* run, because it is armed only while the queue is empty. See
 *   [Handler Explanation](../../docs/Handler%20Explanation.md#the-drained-guard-the-only-bound-on-gate-b).
 */
interface ScrapingPlan<TResources> {
  readonly name: string
  readonly responseKinds: readonly CollectorHttpResponseKind.CollectorHttpResponseKind<TResources>[]
  readonly stepSequence: readonly Step.Step[]
  readonly maxGeneratedSteps?: number
  readonly dedupeGeneratedOpenUris?: boolean
  readonly drainedGuardTimeout?: Duration.Duration
  // Declared as a *method* signature, not a `readonly` arrow property, for the
  // same reason as `CollectorHttpResponseKind.followUpSteps`: `produced` puts
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
    response: CollectorHttpResponse,
    produced: readonly TResources[]
  ): Effect.Effect<CaptureProvenanceResult<TResources>, unknown>
}

/**
 * Recursively freeze `value` — `kitchen-sink`'s `deepFreeze`, except that
 * `Duration`s are left alone.
 *
 * A plan carries `Duration`s in four places (`Delay.duration`,
 * `AwaitPageSettled.timeout`, `AwaitUserDismiss.timeout`, and the plan-level
 * `drainedGuardTimeout`), and some of them
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
 * a caller can't push into `responseKinds` or `stepSequence`
 * after construction.
 *
 * `Duration`-valued fields are the one exception — see {@link freezePlanValue}.
 */
const make = <TResources>(plan: ScrapingPlan<TResources>): ScrapingPlan<TResources> => {
  const frozen: ScrapingPlan<TResources> = {
    name: plan.name,
    responseKinds: plan.responseKinds,
    stepSequence: plan.stepSequence,
    maxGeneratedSteps: plan.maxGeneratedSteps,
    dedupeGeneratedOpenUris: plan.dedupeGeneratedOpenUris,
    drainedGuardTimeout: plan.drainedGuardTimeout,
    // Declared as a method (for covariance — see the interface note), so
    // copying the reference trips `unbound-method`; it is a pure, `this`-free
    // function, so the concern (unintended `this` scoping) can't apply.
    // oxlint-disable-next-line typescript-eslint/unbound-method -- pure, this-free method; the copy is safe
    captureProvenance: plan.captureProvenance,
  }
  freezePlanValue(frozen)
  return frozen
}

export { make, DEFAULT_DRAINED_GUARD_TIMEOUT, DEFAULT_MAX_GENERATED_STEPS }
export type { CaptureProvenanceResult, ScrapingPlan }
