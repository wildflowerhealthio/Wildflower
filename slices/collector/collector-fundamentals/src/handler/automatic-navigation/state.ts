/**
 * Part 2 of the automatic-navigation machine: the states.
 *
 * The machine state is a pair — a **dynamic step queue** plus a **phase**. The
 * queue is seeded from the frozen `ScrapingPlan.stepSequence`; a `ForEachStep`
 * in it is replaced *in place* by its expanded body steps when its
 * `MatchesFound` arrives (see [transition.ts](./transition.ts)). Keeping the
 * queue *in the state* (not a side ref) is what lets the pure transition both
 * read it — advance lookups, the terminal-length check — and grow it, without
 * any effect reaching outside the transition. The plan stays frozen; the queue
 * is the machine's own copy.
 *
 * The phase is a plain tagged union identified by `_tag` (not a runtime
 * `Schema` — nothing here crosses a wire). The timer-bearing variants hold no
 * live `Fiber.RuntimeFiber`; instead every phase carries a monotonic
 * `generation` that correlates it with the timer daemon scheduled under that
 * number, so a superseded timer's `*Fired` input is dropped as stale (the
 * fiber lives in the registry in `./side-effect-handlers.ts`). See
 * [Handler Explanation](../../../docs/Handler%20Explanation.md#timers-are-inputs-correlated-by-generation)
 * for the full discipline.
 */

import type { Step } from '../../model/step.ts'

/**
 * One entry in the machine's runtime queue: a leaf step to dispatch or a
 * not-yet-expanded `ForEachStep`. Just `Step` — the queue starts as a copy of
 * `plan.stepSequence` and a `ForEachStep` is spliced out for its body steps on
 * expansion, so both kinds can appear.
 */
type QueueStep = Step

type StepPhase =
  | { readonly _tag: 'AwaitingPageLoaded'; readonly nextIndex: number; readonly generation: number }
  | { readonly _tag: 'TimerPending'; readonly dispatchIndex: number; readonly generation: number }
  | {
      readonly _tag: 'AwaitingUrlMatch'
      readonly dispatchIndex: number
      readonly generation: number
    }
  | {
      readonly _tag: 'AwaitingMatches'
      readonly dispatchIndex: number
      readonly generation: number
    }
  | { readonly _tag: 'Done'; readonly generation: number }

/**
 * The whole machine state: the current runtime {@link QueueStep} queue and the
 * {@link StepPhase} the machine is in. The transition threads `queue` forward
 * unchanged on every transition except a `ForEach` expansion, which rewrites it.
 */
interface StepState {
  readonly queue: readonly QueueStep[]
  readonly phase: StepPhase
}

const awaitingPageLoaded = (nextIndex: number, generation: number): StepPhase => ({
  _tag: 'AwaitingPageLoaded',
  nextIndex,
  generation,
})
const timerPending = (dispatchIndex: number, generation: number): StepPhase => ({
  _tag: 'TimerPending',
  dispatchIndex,
  generation,
})
const awaitingUrlMatch = (dispatchIndex: number, generation: number): StepPhase => ({
  _tag: 'AwaitingUrlMatch',
  dispatchIndex,
  generation,
})
const awaitingMatches = (dispatchIndex: number, generation: number): StepPhase => ({
  _tag: 'AwaitingMatches',
  dispatchIndex,
  generation,
})
const done = (generation: number): StepPhase => ({ _tag: 'Done', generation })

/** Build a {@link StepState} from a queue and phase — the transition's return shape. */
const stateOf = (queue: readonly QueueStep[], phase: StepPhase): StepState => ({ queue, phase })

export type { QueueStep, StepPhase, StepState }
export { awaitingMatches, awaitingPageLoaded, awaitingUrlMatch, done, stateOf, timerPending }
