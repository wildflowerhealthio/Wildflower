import 'expo-router/entry'

import { getRandomValues } from 'expo-crypto'

globalThis.crypto = globalThis.crypto ?? {}

globalThis.crypto.getRandomValues = <T extends ArrayBufferView<ArrayBufferLike>>(arr: T): T =>
  getRandomValues<any>(arr)

globalThis.performance.mark =
  globalThis.performance.mark?.bind(globalThis.performance) ?? ((): void => {})
globalThis.performance.measure =
  globalThis.performance.measure?.bind(globalThis.performance) ?? ((): void => {})
