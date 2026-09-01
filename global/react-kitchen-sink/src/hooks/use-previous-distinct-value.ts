import { useState } from 'react'

/**
 * Change-detection hook: returns a value that differs from `value` **exactly
 * once** — during the render pass in which `value` first changes — and equals
 * `value` at every other observation. Use `value !== usePreviousDistinctValue(value)`
 * inside the component body to run a same-tick side effect exactly once per
 * transition of `value`, without a `useEffect` (that recipe cascades a render
 * and paints stale state for one frame).
 *
 * @remarks
 * **This is not the classic ref-based `usePrevious`.** That recipe assigns
 * `ref.current = value` from a `useEffect` and reads `ref.current` during
 * render — the read is a react/refs violation under react-hooks v6. This hook
 * uses the useState + "set state while rendering" recipe from the React docs
 * instead, and the semantics are optimised for **change detection**, not for
 * "give me literally whatever the value was one render ago":
 *
 * - On the very first render, returns the initial value (so `value !== hook`
 *   is false — no false-fire on mount).
 * - On the render in which `value` transitions, pass 1 returns the *old*
 *   value (so `value !== hook` is true — caller fires); React's set-state-
 *   while-rendering recipe re-runs the render, and pass 2 returns `value`
 *   (so `value !== hook` is false — no second fire in the same render).
 *   The pass-2 render is what commits.
 * - On subsequent unchanged renders, returns `value` (no fire).
 *
 * The consequence: the caller sees the change signal in the first render pass
 * that observes it and never again. That is the ONLY invariant this hook
 * guarantees — code that inspects the returned "previous" value for any
 * purpose other than a same-tick `value !== hook` comparison will find it
 * usually equal to `value`, which is not what its name implies. If you need
 * the literal previous value across a full render (e.g. for a diff render
 * that shows both), you want a different hook.
 *
 * @example
 * ```tsx
 * const prevOpen = usePreviousDistinctValue(open)
 * const prevIndex = usePreviousDistinctValue(firstEnabledIndex)
 * if (open !== prevOpen || firstEnabledIndex !== prevIndex) {
 *   if (open) setActiveIndex(firstEnabledIndex)
 * }
 * ```
 *
 * @param value - The value to detect changes on.
 * @returns A value that differs from `value` only during the render pass in
 *   which `value` transitions.
 */
function usePreviousDistinctValue<T>(value: T): T {
  const [committed, setCommitted] = useState<T>(value)
  if (!Object.is(committed, value)) {
    // Advance to the new value; React will re-run this render with the
    // updated state (pass 2), where `committed === value` and the caller's
    // `value !== hook(value)` comparison flips false. The returned value
    // below is `committed` (the *old* value) because setState-during-render
    // takes effect on the follow-up pass, not on this one.
    setCommitted(value)
    return committed
  }
  return value
}

export { usePreviousDistinctValue }
