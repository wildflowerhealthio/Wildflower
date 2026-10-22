import type { WalkthroughStorage } from '@wildflowerhealthio/walkthrough-core'

/** A `WalkthroughStorage` kept in a `Map`, standing in for `window.localStorage`. */
const mapWalkthroughStorage = (): WalkthroughStorage => {
  const items = new Map<string, string>()
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value)
    },
  }
}

export { mapWalkthroughStorage }
