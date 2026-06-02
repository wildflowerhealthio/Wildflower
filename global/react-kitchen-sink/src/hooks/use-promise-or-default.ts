import { useEffect, useRef, useState } from 'react'

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
 * @param promise - Promise to track. Reference identity is the
 *   load-bearing input — a new reference resets the value to
 *   `whilePending` and re-subscribes.
 * @param whilePending - Value rendered until the current promise
 *   settles. Read from the current render whenever a fresh promise
 *   reference is observed; an already-settled `Promise.resolve(x)`
 *   never overwrites with this value.
 * @param onErr - Mapper invoked with the rejection reason on the
 *   current promise; its return value is stored as the resolved value.
 *   Read from the current render at settlement time.
 *
 * @remarks
 * Compared to {@link useLoadingPromise}, this hook flattens the
 * three-state union (`loading | resolved | error`) into a single `T`
 * by asking the caller for a pending-window value and an
 * error-mapping function. Useful when the consumer wants to render
 * unconditionally and the fallback is a sensible no-op of the same
 * shape — e.g. a stub service used until the real one resolves.
 *
 * The settlement callbacks close over the rendering closure each pass,
 * so `whilePending` and `onErr` always reflect the current render's
 * values at settle time (not first-render snapshots). The `setValue`
 * to `whilePending` on promise-change is gated on the promise actually
 * being a new reference, so a pre-resolved `Promise.resolve(x)` does
 * not flicker through `whilePending` before landing on `x`.
 */
const usePromiseOrDefault = <T>(
  promise: Promise<T>,
  whilePending: T,
  onErr: (err: unknown) => T
): T => {
  const [value, setValue] = useState<T>(whilePending)
  const lastPromiseRef = useRef<Promise<T> | null>(null)

  useEffect(() => {
    let isMounted = true
    // Only reset to `whilePending` if the promise reference actually
    // changed. Without the gate, a pre-resolved `Promise.resolve(x)`
    // (or any effect re-run for the same promise) would briefly clobber
    // the resolved value back to `whilePending` before the microtask
    // settlement repainted it.
    if (lastPromiseRef.current !== promise) {
      lastPromiseRef.current = promise
      setValue(whilePending)
    }
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
