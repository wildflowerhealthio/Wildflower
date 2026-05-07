import { useEffect, useState } from 'react'

/**
 * Discriminated union representing the three states of a tracked
 * promise: loading, resolved (with `value`), or rejected (with
 * `error`).
 */
type LoadingPromiseState<T> =
  | { readonly value: T; readonly loading: false; readonly error: undefined }
  | { readonly value: undefined; readonly loading: true; readonly error: undefined }
  | { readonly value: undefined; readonly loading: false; readonly error: unknown }

/**
 * Tracks a `Promise<T>` as React state, returning a
 * {@link LoadingPromiseState} that transitions through loading →
 * loaded/error. Resets to loading when the promise reference
 * changes; ignores stale settlements after unmount.
 */
const useLoadingPromise = <T>(value: Promise<T>): LoadingPromiseState<T> => {
  const [state, setState] = useState<LoadingPromiseState<T>>({
    error: undefined,
    loading: true,
    value: undefined,
  })

  useEffect(() => {
    let isMounted = true
    value
      .then((resolved) => {
        if (isMounted) {
          setState({ error: undefined, loading: false, value: resolved })
        }
      })
      .catch((error: unknown) => {
        if (isMounted) {
          setState({ value: undefined, loading: false, error })
        }
      })
    return (): void => {
      isMounted = false
      setState({ error: undefined, loading: true, value: undefined })
    }
  }, [value])

  return state
}

export { useLoadingPromise }
export type { LoadingPromiseState }
