import { vi } from 'vite-plus/test'

/**
 * Suppress React's error-boundary `console.error` noise for the duration of a
 * test that asserts on a synchronous render throw. Returns a `restore`
 * function to call in `finally`.
 *
 * @example
 * ```ts
 * const restore = silenceReactErrorBoundary()
 * try {
 *   expect(() => renderHook(useFoo)).toThrow()
 * } finally {
 *   restore()
 * }
 * ```
 */
const silenceReactErrorBoundary = (): (() => void) => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  return (): void => {
    spy.mockRestore()
  }
}

export { silenceReactErrorBoundary }
