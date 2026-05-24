/**
 * Side-effect polyfill for `Promise.withResolvers` (ES2024). Import
 * this module once near the entry point (or transitively via a
 * library that depends on it) on platforms whose runtime ships a
 * pre-2024 JS engine — notably Hermes on older React Native.
 *
 * The ambient `declare global` augments `PromiseConstructor` so
 * downstream TypeScript code can call `Promise.withResolvers()`
 * without bumping `lib` to `ES2024` (which would also expose APIs
 * that aren't actually polyfilled here).
 */

declare global {
  interface PromiseConstructor {
    withResolvers<T>(): {
      promise: Promise<T>
      resolve: (value: T | PromiseLike<T>) => void
      reject: (reason?: unknown) => void
    }
  }
}

interface MaybePolyfilled {
  withResolvers?: PromiseConstructor['withResolvers']
}

const polyfillWithResolvers = <T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

if ((Promise as MaybePolyfilled).withResolvers === undefined) {
  Promise.withResolvers = polyfillWithResolvers
}

const installed = (Promise as MaybePolyfilled).withResolvers !== undefined

export { installed }
export default installed
