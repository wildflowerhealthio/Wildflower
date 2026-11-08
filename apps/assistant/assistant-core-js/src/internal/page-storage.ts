import { StorageBlocked } from '@wildflowerhealthio/kitchen-sink'
import { Effect } from 'effect'

/**
 * The Web Storage calls Assistant makes, declared structurally so this
 * package names no DOM type: an app passes `window.localStorage` or
 * `window.sessionStorage`, and a test a `Map`-backed stand-in.
 */
interface KeptStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * The page whose storage Assistant keeps its key, model choice and chats
 * in: `window` in an app.
 */
interface StoragePage {
  readonly localStorage: KeptStorage
  readonly sessionStorage: KeptStorage
}

/**
 * `page`'s `localStorage` or `sessionStorage`, read inside the Effect: a
 * browser that blocks storage can throw on the property read itself, which
 * fails as a {@link StorageBlocked} for `operation` at `key`.
 */
const storageOf = (
  page: StoragePage,
  area: 'localStorage' | 'sessionStorage',
  operation: StorageBlocked['operation'],
  key: string
): Effect.Effect<KeptStorage, StorageBlocked> =>
  Effect.try({
    try: () => page[area],
    catch: () => new StorageBlocked({ operation, key }),
  })

export { storageOf }
export type { KeptStorage, StoragePage }
