import type { PageActionMessage } from 'browser-sniffer-core'
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
 * What a step tells the sniffer to do, typed *against the bridge message
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
 *
 * Because {@link Step} is just `{ action; advanceWhen? }`, the plan-only
 * `advanceWhen` lives on the wrapper, not the action — the automatic-navigation machine
 * forwards `step.action` untouched and it can never leak onto the wire.
 */
type StepAction = typeof OpenMessage.Type | typeof PageActionMessage.Type

/**
 * A scripted navigation step: an {@link StepAction} to dispatch plus an
 * optional {@link Advance} gating *when* the automatic-navigation machine dispatches it.
 *
 * `advanceWhen` is a plan-only field — the automatic-navigation machine reads it to schedule
 * the dispatch but forwards only `action` to the sniffer, so it never reaches
 * the wire. A `Fill` action's `value` is interpolated from the remote's
 * config (e.g. a username / password) when the collector builds its
 * `ScrapingPlan`; because a credential can therefore ride that payload, see
 * the secrets note on `browser-sniffer-core`'s `FillAction`.
 */
interface Step {
  readonly action: StepAction
  readonly advanceWhen?: Advance
}

export type { Step, StepAction, Advance, UrlMatchAdvance }
