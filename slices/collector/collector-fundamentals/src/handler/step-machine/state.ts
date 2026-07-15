/**
 * Part 2 of the step machine: the states.
 *
 * A plain tagged union identified by `_tag` (not a runtime `Schema` —
 * nothing here crosses a wire). The timer-bearing variants hold no live
 * `Fiber.RuntimeFiber`; instead every state carries a monotonic
 * `generation` that correlates it with the timer daemon scheduled under
 * that number, so a superseded timer's `*Fired` input is dropped as stale
 * (the fiber lives in the registry in `./side-effect-handlers.ts`). See
 * [Handler Explanation](../../../docs/Handler%20Explanation.md#timers-are-inputs-correlated-by-generation)
 * for the full discipline.
 */

type StepState =
  | { readonly _tag: 'AwaitingPageLoaded'; readonly nextIndex: number; readonly generation: number }
  | { readonly _tag: 'TimerPending'; readonly dispatchIndex: number; readonly generation: number }
  | {
      readonly _tag: 'AwaitingUrlMatch'
      readonly dispatchIndex: number
      readonly generation: number
    }
  | { readonly _tag: 'Done'; readonly generation: number }

const awaitingPageLoaded = (nextIndex: number, generation: number): StepState => ({
  _tag: 'AwaitingPageLoaded',
  nextIndex,
  generation,
})
const timerPending = (dispatchIndex: number, generation: number): StepState => ({
  _tag: 'TimerPending',
  dispatchIndex,
  generation,
})
const awaitingUrlMatch = (dispatchIndex: number, generation: number): StepState => ({
  _tag: 'AwaitingUrlMatch',
  dispatchIndex,
  generation,
})
const done = (generation: number): StepState => ({ _tag: 'Done', generation })

export type { StepState }
export { awaitingPageLoaded, awaitingUrlMatch, done, timerPending }
