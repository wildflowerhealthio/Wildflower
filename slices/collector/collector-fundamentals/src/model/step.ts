import type {
  DiscoveredMatch as DiscoveredMatchSchema,
  PageActionMessage,
} from 'browser-sniffer-core'
import type { Duration } from 'effect'

import type { OpenMessage } from '../bridge.ts'

/**
 * When the automatic-navigation machine should dispatch a step, relative to the
 * `PageLoaded` events flowing back from the sniffer.
 *
 * - Absent (`advanceWhen` omitted): the default — dispatch a fixed
 *   `ScrapingPlan.stepDelay` after each `PageLoaded`, matching the
 *   pre-existing behaviour (so plans that don't script a login, like
 *   the fhir-r4 collector, need no edits).
 * - `UrlMatch`: hold the step until a `PageLoaded` arrives whose `url`
 *   matches `pattern`, then dispatch after the usual `stepDelay` settle.
 *   Use for login flows whose redirects / SPA navigations settle at an
 *   unpredictable time — a fixed delay would race them. `pattern` is a
 *   `RegExp` built with `UrlMatch.make({ segments, end })`. `timeout`
 *   bounds the wait: if no matching `PageLoaded` is seen within it, the
 *   run aborts via `SniffingComplete` rather than hanging (the sync
 *   runner's idle timeout is the ultimate backstop).
 */
interface UrlMatchAdvance {
  readonly _tag: 'UrlMatch'
  readonly pattern: RegExp
  readonly timeout: Duration.Duration
}

/**
 * The advance condition attached to a {@link Step}. A union so more
 * trigger kinds (element-present, response-seen, …) can be added later
 * without touching the {@link Step} shape; today the only non-default kind
 * is {@link UrlMatchAdvance}.
 */
type Advance = UrlMatchAdvance

/**
 * What a leaf step tells the sniffer to do, typed *against the bridge message
 * bodies themselves* so a step can never carry a field the wire doesn't:
 *
 * - `Open` (the collector bridge's `OpenMessage`): host-navigation. Carries
 *   the same `WebViewSource` shape the host uses for the initial `firstPage`,
 *   so a slice's `stepSequence` can mix inline-HTML bootstraps and absolute
 *   `https://` URIs without a translation layer. It is its own tag because
 *   the Tauri host *decodes* it to navigate the sniffer `WebviewWindow`.
 * - `PageAction` (`browser-sniffer-core`'s `PageActionMessage`): an in-page
 *   interaction (`Click` / `Fill`, discriminated by the inner `kind`). New
 *   interaction kinds are added as `action` union variants, not new tags.
 */
type StepAction = typeof OpenMessage.Type | typeof PageActionMessage.Type

/**
 * One element the sniffer's discovery query matched, as decoded from a
 * `MatchesFound` (`browser-sniffer-core`'s `DiscoveredMatch`). A
 * {@link ForEachStep}'s `body` receives one per match and decides how to
 * visit it: `Click(generatedSelector)` for a row that navigates via a click
 * handler (an Angular SPA row), or `Open(href)` when the match is a real
 * anchor.
 */
type DiscoveredMatch = typeof DiscoveredMatchSchema.Type

/**
 * A scripted navigation step whose `action` is a single bridge message — the
 * original `Step` shape, now one arm of the {@link Step} union. The
 * automatic-navigation machine forwards `action` to the sniffer untouched; the
 * plan-only `advanceWhen` rides this wrapper and never reaches the wire.
 *
 * A `Fill` action's `value` is interpolated from the remote's config (e.g. a
 * username / password) when the collector builds its `ScrapingPlan`; because a
 * credential can therefore ride that payload, see the secrets note on
 * `browser-sniffer-core`'s `FillAction`.
 */
interface LeafStep {
  readonly action: StepAction
  readonly advanceWhen?: Advance
}

/**
 * How a {@link ForEachStep} discovers the elements to fan out over: the
 * sniffer runs `document.querySelectorAll(querySelector)` in the live DOM and
 * answers with a `MatchesFound`. `timeout` bounds that wait — if no answer
 * arrives, the run aborts via `SniffingComplete` (so a silent host can't hang
 * it) rather than stalling; an *empty* answer is not a timeout but a clean
 * skip (zero matches → zero body steps).
 */
interface DiscoverSpec {
  readonly querySelector: string
  readonly timeout: Duration.Duration
}

/**
 * A declarative fan-out step: at runtime the automatic-navigation machine asks
 * the sniffer to enumerate `discover.querySelector`, then expands the step into
 * one `body(match)` sub-sequence per discovered match, splices those concrete
 * steps into its internal queue *in place of* the `ForEach`, and continues. The
 * plan stays frozen — the expansion lives in the machine's dynamic queue, not
 * the plan (which is why `stepSequence` can stay deep-frozen).
 *
 * `body` maps a {@link DiscoveredMatch} to a small sequence of {@link LeafStep}s
 * — not another `ForEach`; v1 does not nest. Iterating a SPA list usually needs
 * a return-to-list step between items, so the body is a *sequence*, e.g.
 * `(m) => [{ action: click(m.generatedSelector) }, { action: openList }]`; each
 * body step may carry its own `advanceWhen`.
 *
 * `advanceWhen` gates *when discovery runs* (default: a fixed `stepDelay` after
 * the list `PageLoaded`; `UrlMatch` to wait for a specific URL first), exactly
 * as it gates when a {@link LeafStep} is dispatched. `_tag: 'ForEach'` is the
 * discriminant — only this arm of {@link Step} carries a top-level `_tag`.
 */
interface ForEachStep {
  readonly _tag: 'ForEach'
  readonly discover: DiscoverSpec
  readonly body: (match: DiscoveredMatch) => readonly LeafStep[]
  readonly advanceWhen?: Advance
}

/**
 * One entry in a plan's `stepSequence`: either a {@link LeafStep} (a single
 * bridge action) or a {@link ForEachStep} (a runtime fan-out over discovered
 * links). The union is discriminated structurally — a `ForEachStep` has a
 * top-level `_tag: 'ForEach'`, a `LeafStep` has none — via {@link isForEach}.
 * Existing static plans (all `LeafStep`s) are unchanged: `{ action, advanceWhen? }`
 * is still a valid `Step`.
 */
type Step = LeafStep | ForEachStep

/**
 * Runtime guard: does this step fan out at runtime? Only {@link ForEachStep}
 * carries a top-level `_tag`, so its presence discriminates the union at both
 * type and value level.
 */
const isForEach = (step: Step): step is ForEachStep => '_tag' in step && step._tag === 'ForEach'

export type {
  Step,
  LeafStep,
  ForEachStep,
  StepAction,
  Advance,
  UrlMatchAdvance,
  DiscoverSpec,
  DiscoveredMatch,
}
export { isForEach }
