import type { Step } from '../../model/step.ts'

/**
 * Part 2 of the automatic-navigation machine: the states.
 *
 * A plain tagged union identified by `_tag` (not a runtime `Schema` —
 * nothing here crosses a wire). The machine's identity is *owner of a step
 * queue*: the active variants carry the remaining `queue` (a breadth-first
 * work list, seeded from `ScrapingPlan.stepSequence` and grown by
 * `followUpSteps`), not an index into a frozen array. The timer-bearing
 * variants hold no live `Fiber.RuntimeFiber`; instead every state carries a
 * monotonic `generation` that correlates it with the timer daemon scheduled
 * under that number, so a superseded timer's `*Fired` input is dropped as
 * stale (the fiber lives in the registry in `./side-effect-handlers.ts`). See
 * [Handler Explanation](../../../docs/Handler%20Explanation.md#timers-are-inputs-correlated-by-generation)
 * for the full discipline.
 *
 * - `AwaitingPageLoaded` — dispatched a navigation (or idle at start); waiting
 *   for a `PageLoaded` to pop and process the next `queue` head.
 * - `DelayPending` — a `Delay` step's timer is running; `queue` is what remains
 *   *after* that delay.
 * - `AwaitingUrlMatch` — the head `Navigation` step's `advanceWhen` `UrlMatch`
 *   is unmet; `queue[0]` is that still-undispatched step and a URL-match
 *   timeout daemon is pending.
 * - `Drained` — the queue is empty, but the run may not be over: an in-flight
 *   request could still `followUpSteps` more work. Terminal only once the
 *   lifecycle confirms no sniffed request is still incomplete (via
 *   `NoMoreResultsExpected`); an empty queue alone is not completion.
 * - `Done` — terminal; `SniffingComplete` has been dispatched.
 */
type Queue = readonly Step[]

type StepState =
  | { readonly _tag: 'AwaitingPageLoaded'; readonly queue: Queue; readonly generation: number }
  | { readonly _tag: 'DelayPending'; readonly queue: Queue; readonly generation: number }
  | { readonly _tag: 'AwaitingUrlMatch'; readonly queue: Queue; readonly generation: number }
  | { readonly _tag: 'Drained'; readonly generation: number }
  | { readonly _tag: 'Done'; readonly generation: number }

const awaitingPageLoaded = (queue: Queue, generation: number): StepState => ({
  _tag: 'AwaitingPageLoaded',
  queue,
  generation,
})
const delayPending = (queue: Queue, generation: number): StepState => ({
  _tag: 'DelayPending',
  queue,
  generation,
})
const awaitingUrlMatch = (queue: Queue, generation: number): StepState => ({
  _tag: 'AwaitingUrlMatch',
  queue,
  generation,
})
const drained = (generation: number): StepState => ({ _tag: 'Drained', generation })
const done = (generation: number): StepState => ({ _tag: 'Done', generation })

export type { StepState, Queue }
export { awaitingPageLoaded, awaitingUrlMatch, delayPending, done, drained }
