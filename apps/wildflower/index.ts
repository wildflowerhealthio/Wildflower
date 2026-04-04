import 'expo-router/entry'

import { getRandomValues } from 'expo-crypto'

globalThis.crypto = globalThis.crypto ?? {}

globalThis.crypto.getRandomValues = <T extends ArrayBufferView<ArrayBufferLike>>(arr: T): T => {
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  return getRandomValues<any>(arr)
}

globalThis.performance.mark =
  globalThis.performance.mark?.bind(globalThis.performance) ?? ((): void => {})
globalThis.performance.measure =
  globalThis.performance.measure?.bind(globalThis.performance) ?? ((): void => {})

// Polyfill for Promise.withResolver

if (typeof Promise.withResolvers === 'undefined') {
  // oxlint-disable
  Promise.withResolvers = function withResolvers<T>() {
    let resolve, reject
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })

    return { promise, resolve, reject }
  } as any
  // oxlint-enable
}
