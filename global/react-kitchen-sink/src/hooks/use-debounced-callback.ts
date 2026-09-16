import { useCallback, useEffect, useMemo, useRef } from 'react'

/**
 * The handle {@link useDebouncedCallback} returns: schedule a call, run a
 * scheduled one early, or drop it.
 *
 * @typeParam A - The wrapped callback's argument tuple.
 */
interface DebouncedCallback<A extends readonly unknown[]> {
  /**
   * Schedule a call with these arguments, restarting the delay and replacing
   * any call already scheduled — only the most recent arguments ever run.
   */
  readonly call: (...args: A) => void
  /** Run the scheduled call now, if there is one. A no-op when there is none. */
  readonly flush: () => void
  /** Drop the scheduled call without running it. A no-op when there is none. */
  readonly cancel: () => void
}

/**
 * Wrap a callback so that rapid calls collapse into one, run `delayMs` after
 * the last of them — the trailing-edge debounce, with explicit `flush` and
 * `cancel`.
 *
 * @remarks
 * For work that is too expensive or too disruptive to run on every keystroke:
 * a search that hits the network, an autosave, or a form field whose every
 * committed value kicks off an expensive recomputation downstream.
 *
 * `call`, `flush` and `cancel` keep a stable identity for the lifetime of the
 * component, so they are safe to pass as props or name in a dependency array.
 * The wrapped `callback` does not have to be stable: the *latest* one rendered
 * is what runs, so a closure over fresh props or state is read at fire time
 * rather than at schedule time. That is the point of the hook — the naive
 * `useEffect` + `setTimeout` version either restarts its timer on every parent
 * render (because the callback is a new closure each time) or fires a stale
 * closure, and neither failure is visible in the code.
 *
 * A scheduled call is dropped on unmount: a commit fired into a tree that is
 * gone is wasted at best. Flush first (from an `onBlur`, say) when the value
 * must survive the component.
 *
 * @example
 * ```tsx
 * const [draft, setDraft] = useState(value)
 * const commit = useDebouncedCallback((next: string) => onChange(next), 400)
 * <input
 *   value={draft}
 *   onChange={(event) => {
 *     setDraft(event.target.value)
 *     commit.call(event.target.value)
 *   }}
 *   onBlur={commit.flush}
 * />
 * ```
 *
 * @typeParam A - The callback's argument tuple.
 * @param callback - What to run; the most recently rendered one is used.
 * @param delayMs - Quiet period after the last `call` before it runs. Must be
 *   a non-negative finite number — a `NaN` or negative delay would silently
 *   fire on a timing nothing intended, so misuse throws instead.
 * @returns The {@link DebouncedCallback} handle.
 */
const useDebouncedCallback = <A extends readonly unknown[]>(
  callback: (...args: A) => void,
  delayMs: number
): DebouncedCallback<A> => {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new RangeError(
      `useDebouncedCallback: delayMs must be a non-negative finite number, got ${String(delayMs)}`
    )
  }

  // The latest rendered callback, written in an effect and read only when the
  // timer fires — never during render, which react-hooks v6 forbids.
  const latest = useRef(callback)
  useEffect(() => {
    latest.current = callback
  })

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const scheduled = useRef<A | undefined>(undefined)

  /** Clear the timer and take the pending arguments, leaving nothing scheduled. */
  const take = useCallback((): A | undefined => {
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = undefined
    const args = scheduled.current
    scheduled.current = undefined
    return args
  }, [])

  const cancel = useCallback((): void => {
    take()
  }, [take])

  const flush = useCallback((): void => {
    const args = take()
    if (args !== undefined) latest.current(...args)
  }, [take])

  const call = useCallback(
    (...args: A): void => {
      take()
      scheduled.current = args
      timer.current = setTimeout(() => {
        const queued = take()
        if (queued !== undefined) latest.current(...queued)
      }, delayMs)
    },
    [take, delayMs]
  )

  useEffect(() => cancel, [cancel])

  return useMemo((): DebouncedCallback<A> => ({ call, flush, cancel }), [call, flush, cancel])
}

export { useDebouncedCallback, type DebouncedCallback }
