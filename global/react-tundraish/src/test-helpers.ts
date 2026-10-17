/**
 * Test support for this package's consumers: stand-ins for the browser APIs
 * its components read that jsdom lacks.
 *
 * @packageDocumentation
 */

/**
 * A `ResizeObserver` that never fires: jsdom has no layout, so a test of a
 * page around `RouteTabs` (which observes its strip) has no resize to wait on.
 */
class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** A `matchMedia` answer that never matches and never changes. */
const unmatchedMediaQuery = (
  media: string
): Pick<MediaQueryList, 'matches' | 'media' | 'addEventListener' | 'removeEventListener'> => ({
  matches: false,
  media,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
})

/**
 * Stand in for the browser APIs `RouteTabs` reads that jsdom lacks:
 * `ResizeObserver` (inert), `matchMedia` (nothing matches, so motion is not
 * reduced) and `Element.scrollTo` (a no-op), for a test that renders a page
 * around the strip rather than the strip itself.
 *
 * @returns Put back what was there before, as a test's `afterEach` does.
 */
const stubRouteTabsBrowserApis = (): (() => void) => {
  const stubs = [
    [globalThis, 'ResizeObserver', InertResizeObserver],
    [globalThis, 'matchMedia', unmatchedMediaQuery],
    [Element.prototype, 'scrollTo', () => undefined],
  ] as const
  const saved = stubs.map(
    ([target, key]) => [target, key, Object.getOwnPropertyDescriptor(target, key)] as const
  )
  for (const [target, key, value] of stubs) {
    Object.defineProperty(target, key, { value, writable: true, configurable: true })
  }
  return () => {
    for (const [target, key, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(target, key)
      else Object.defineProperty(target, key, descriptor)
    }
  }
}

export { stubRouteTabsBrowserApis }
