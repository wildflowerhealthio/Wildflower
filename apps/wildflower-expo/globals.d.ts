// Polyfills installed by `side-effect-imports/polyfill.ts` add a
// `CryptoKey` constructor to `globalThis` and `global`. Augment the
// global type so downstream consumers (and the polyfill assignment)
// type-check without `@ts-expect-error`.
import type { CryptoKey as QuickCryptoKey } from 'react-native-quick-crypto'

declare global {
  var CryptoKey: typeof QuickCryptoKey

  // The RN `global` object aliases `globalThis`, but TypeScript's lib
  // doesn't include `CryptoKey` on it. Mirror the augmentation.
  interface Global {
    CryptoKey: typeof QuickCryptoKey
  }
}
