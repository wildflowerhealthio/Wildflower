import { useState } from 'react'

/**
 * Returns the value from the last render in which it differed from the render
 * before, or the initial value on the very first render. Meant for the
 * "adjust state while rendering" pattern from the React docs: read this hook's
 * result, compare it to the current value, and if they differ update whatever
 * derived state needs to reset — all inside the component body, no `useEffect`.
 *
 * @remarks
 * **This is not `usePrevious`.** The classic ref-based `usePrevious` returns
 * whatever the value was during the previous render, whether it changed or not.
 * That recipe assigns `ref.current = value` from a `useEffect` and reads
 * `ref.current` during render — the second of those trips react/refs under
 * react-hooks v6, so this hook does not attempt it. Instead the returned
 * "previous" is the value from the last render in which it changed: stable
 * across identical-value renders, updated in the render where it changes.
 * That is what the change-detection use case wants — a stable reference to
 * compare against — and it stays clear of both `useEffect` and render-time
 * ref access.
 *
 * The internal state advances via the "set state while rendering" recipe, so
 * the caller sees the previous value in the pass where the change first
 * appears. If the caller reacts by calling its own setter with a stable value
 * (e.g. `setActiveIndex(firstEnabledIndex)`), React deduplicates the identical
 * update on the follow-up render pass and no extra commit fires.
 *
 * @example
 * ```tsx
 * const prevOpen = useLastRendersValue(open)
 * const prevFirstEnabledIndex = useLastRendersValue(firstEnabledIndex)
 * if (open !== prevOpen || firstEnabledIndex !== prevFirstEnabledIndex) {
 *   if (open) setActiveIndex(firstEnabledIndex)
 * }
 * ```
 *
 * @param value - The value to remember across renders.
 * @returns The value from the last render in which it differed, or the initial
 *   value on first render.
 */
function useLastRendersValue<T>(value: T): T {
  const [snapshot, setSnapshot] = useState<{ readonly prev: T; readonly current: T }>({
    prev: value,
    current: value,
  })
  if (!Object.is(snapshot.current, value)) {
    setSnapshot({ prev: snapshot.current, current: value })
  }
  return snapshot.prev
}

export { useLastRendersValue }
