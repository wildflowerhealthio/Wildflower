import {
  createContext,
  useEffect,
  useRef,
  type FC as ReactFC,
  type JSX,
  type RefObject,
} from 'react'
import { useContextOrThrow } from 'react-kitchen-sink'

/**
 * A friendly-named React "late-bound slot": one mutable cell holding a
 * value of type `T`, seeded with a `default` and swappable by components
 * rendered under its {@link Outlet.Provider}.
 *
 * @remarks
 * The generic mechanism behind {@link makeNamedPipe}, which specializes
 * it to a transport sender. Registration is last-writer-wins; the default
 * fills the slot until a {@link Outlet.useRegister} effect commits. Reads
 * go through {@link Outlet.useValueRef} so a consumer can observe a value
 * registered later without re-rendering — the cell is read at call time,
 * not captured at render.
 */
interface Outlet<TName extends string, T> {
  /**
   * Renders the slot's context. `displayName` is `${TName}Provider`, so
   * it shows up under that friendly tag in React DevTools.
   */
  readonly Provider: ReactFC<{ children: React.ReactNode }> & {
    displayName: `${TName}Provider`
  }
  /**
   * Register `value` as the slot's contents for the registrant's mounted
   * lifetime — last writer wins. Runs in an effect, so the value lands at
   * commit time.
   */
  readonly useRegister: (value: T) => void
  /**
   * The underlying identity-stable {@link RefObject}. Initially points at
   * {@link Outlet.default}; {@link Outlet.useRegister} updates `.current`.
   * Direct mutation of `.current` is supported for registration sites that
   * can't run inside a `useEffect`.
   */
  readonly useValueRef: () => RefObject<T>
  /** The slot's seed value, held until a {@link Outlet.useRegister} commits. */
  readonly default: T
}

/**
 * Build a typed, friendly-named {@link Outlet} seeded with `defaultValue`.
 *
 * @example
 * ```ts
 * const outlet = makeOutlet('Navigate', (_: Path) => {})
 * // outlet.Provider.displayName === 'NavigateProvider'
 * ```
 */
const makeOutlet = <const TName extends string, T>(
  name: TName,
  defaultValue: T
): Outlet<TName, T> => {
  const Context = createContext<RefObject<T> | null>(null)
  Context.displayName = `${name}Context`

  // oxlint-disable-next-line react-refresh/only-export-components
  const Provider = ({ children }: { children: React.ReactNode }): JSX.Element => {
    const valueRef = useRef<T>(defaultValue)

    return <Context.Provider value={valueRef}>{children}</Context.Provider>
  }
  Provider.displayName = `${name}Provider`

  const useRegister = (value: T): void => {
    const valueRef = useContextOrThrow(Context)
    useEffect(() => {
      valueRef.current = value
    }, [value, valueRef])
  }

  const useValueRef = (): RefObject<T> => useContextOrThrow(Context)

  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    Provider: Provider as ReactFC<{ children: React.ReactNode }> & {
      displayName: `${TName}Provider`
    },
    useRegister,
    useValueRef,
    default: defaultValue,
  }
}

export { makeOutlet }
export type { Outlet }
