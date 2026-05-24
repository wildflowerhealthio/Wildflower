import { installed as _wasInstalled } from 'kitchen-sink/polyfills/promise-with-resolvers'

globalThis.performance.mark =
  globalThis.performance.mark?.bind(globalThis.performance) ?? ((): void => {})
globalThis.performance.measure =
  globalThis.performance.measure?.bind(globalThis.performance) ?? ((): void => {})

import { install as installQuickCrypto, CryptoKey } from 'react-native-quick-crypto'

installQuickCrypto()

// Minimal, typed shims required by a few deps under React Native
globalThis.crypto ??= global.crypto ?? {}
// import { getRandomValues } from 'expo-crypto'
// globalThis.crypto.getRandomValues ??= getRandomValues as any

// @ts-expect-error
globalThis.CryptoKey = CryptoKey
// @ts-expect-error
global.CryptoKey = CryptoKey
