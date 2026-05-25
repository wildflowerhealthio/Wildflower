import 'kitchen-sink/polyfills/promise-with-resolvers'

globalThis.performance.mark =
  globalThis.performance.mark?.bind(globalThis.performance) ?? ((): void => {})
globalThis.performance.measure =
  globalThis.performance.measure?.bind(globalThis.performance) ?? ((): void => {})

import { install as installQuickCrypto, CryptoKey } from 'react-native-quick-crypto'

installQuickCrypto()

// react-native-quick-crypto's `CryptoKey` constructor takes four args
// (`keyObject, keyAlgorithm, keyUsages, keyExtractable`); the DOM lib
// (enabled in tsconfig for fetch/performance/etc.) declares `var CryptoKey`
// as a zero-arg `new()`. Declaration merging resolves to the DOM signature,
// so the runtime swap onto the global has to launder its type.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
globalThis.CryptoKey = CryptoKey as unknown as typeof globalThis.CryptoKey
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
global.CryptoKey = CryptoKey as unknown as typeof global.CryptoKey
