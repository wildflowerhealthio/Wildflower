import { useCallback, useState } from 'react'

/**
 * `useState` variant whose setter always uses the updater form, so a
 * function value can be stored as state without being misinterpreted as
 * a state updater.
 *
 * @remarks
 * React's `setState` overloads `(next | (prev) => next)`: when you pass
 * a function, React invokes it with the previous state instead of
 * storing it. That makes the plain `useState` API unusable for state
 * whose value is itself a function (e.g. a `MessageSender` callback,
 * an imperative ref handler, a memoised closure handed back from a
 * factory). The standard workaround is to wrap every write in the
 * updater form — `setState(() => fn)` — which is easy to forget and
 * noisy at call sites.
 *
 * `useFunctionSafeState` bakes that wrapper into the setter. The setter
 * is stable across renders and accepts any `F`, including `null` or
 * other non-function values, so callers can use the same hook for
 * `MessageSender | null`-style slots without fighting the type system.
 *
 * @example
 * ```ts
 * const [sender, setSender] = useFunctionSafeState<MessageSender | null>(null)
 * // safe: stored as the function value, not invoked as an updater
 * setSender(messageSender)
 * setSender(null)
 * ```
 */
const useFunctionSafeState = <F>(initial: F): readonly [F, (next: F) => void] => {
  const [value, setValue] = useState<F>(initial)
  const setNext = useCallback((next: F): void => {
    setValue(() => next)
  }, [])
  return [value, setNext] as const
}

export { useFunctionSafeState }
