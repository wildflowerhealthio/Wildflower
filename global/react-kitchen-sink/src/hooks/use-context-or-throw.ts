import { Data } from 'effect'
import { useContext, type Context } from 'react'

/**
 * Thrown by {@link useContextOrThrow} when a context hook runs outside
 * its matching `<Provider>`. Carries the context's debug name so the
 * stack trace points at the missing provider rather than a generic
 * `Error`.
 */
class NoContextException extends Data.TaggedError('NoContextException')<{
  readonly contextName: string
}> {
  override get message(): string {
    return `${this.contextName} must be used inside its matching <Provider>`
  }
}

/**
 * Read a non-null value from a React context, throwing
 * {@link NoContextException} when the hook runs outside a `<Provider>`.
 * Centralises the "useFoo must be used inside <FooProvider>" pattern
 * sprinkled across context-reading hooks.
 *
 * @example
 * ```ts
 * const AuthTokenContext = createContext<Token | null>(null)
 * const useAuthToken = (): Token => useContextOrThrow(AuthTokenContext)
 * ```
 */
const useContextOrThrow = <T>(context: Context<T | null>): T => {
  const value = useContext(context)
  if (value === null) {
    throw new NoContextException({ contextName: context.displayName ?? 'context' })
  }
  return value
}

export { NoContextException, useContextOrThrow }
