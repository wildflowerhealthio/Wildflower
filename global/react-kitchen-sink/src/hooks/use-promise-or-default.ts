import { useEffect, useState } from 'react'

/**
 * Tracks a `Promise<T>` as React state, returning the resolved value
 * once it settles or `whilePending` until then. On rejection, the
 * caller's {@link onErr} is invoked with the rejection reason and its
 * return value is stored as the resolved value — the rejection is
 * never re-thrown into React.
 *
 * Returns to `whilePending` when the `promise` reference changes;
 * ignores stale settlements after unmount.
 *
 * @remarks
 * Compared to {@link useLoadingPromise}, this hook flattens the
 * three-state union (`loading | resolved | error`) into a single `T`
 * by asking the caller for a pending-window value and an
 * error-mapping function. Useful when the consumer wants to render
 * unconditionally and the fallback is a sensible no-op of the same
 * shape — e.g. a stub service used until the real one resolves.
 *
 * `whilePending` and `onErr` are read on first render and on promise
 * reference changes; later changes to these props do not retroactively
 * rewrite the state. Pass stable references if you need different
 * semantics across re-renders.
 */
const usePromiseOrDefault = <T>(
  promise: Promise<T>,
  whilePending: T,
  onErr: (err: unknown) => T
): T => {
  const [value, setValue] = useState<T>(whilePending)

  useEffect(() => {
    let isMounted = true
    setValue(whilePending)
    promise
      .then((resolved) => {
        if (isMounted) setValue(resolved)
      })
      .catch((err: unknown) => {
        if (isMounted) setValue(onErr(err))
      })
    return (): void => {
      isMounted = false
    }
    // `whilePending` and `onErr` are intentionally not in the dep list:
    // re-syncing on those would reset the value mid-flight when the
    // caller passes inline literals/closures. The promise reference is
    // the load-bearing input.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- see comment above
  }, [promise])

  return value
}

export { usePromiseOrDefault }
