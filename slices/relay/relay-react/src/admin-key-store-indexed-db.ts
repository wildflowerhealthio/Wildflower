import { Effect, Layer, Option } from 'effect'
import { AdminKeyStore, AdminKeyStoreUnavailable } from 'relay-core/key-store'

/** Where the admin key lives: a key in an object store of a database. */
const DATABASE = 'relay-admin'
const STORE = 'keys'
const KEY = 'admin'

/** The settled result of `request`, or its error as {@link AdminKeyStoreUnavailable}. */
const settle = <A>(
  what: string,
  request: IDBRequest<A>
): Effect.Effect<A, AdminKeyStoreUnavailable> =>
  Effect.async<A, AdminKeyStoreUnavailable>((resume) => {
    request.addEventListener('success', () => {
      resume(Effect.succeed(request.result))
    })
    request.addEventListener('error', () => {
      resume(
        Effect.fail(new AdminKeyStoreUnavailable({ reason: `${what}: ${String(request.error)}` }))
      )
    })
  })

/** Open the database, creating its object store on first use. */
const open: Effect.Effect<IDBDatabase, AdminKeyStoreUnavailable> = Effect.suspend(() => {
  if (globalThis.indexedDB === undefined) {
    return Effect.fail(new AdminKeyStoreUnavailable({ reason: 'IndexedDB is unavailable' }))
  }
  const request = globalThis.indexedDB.open(DATABASE, 1)
  request.addEventListener('upgradeneeded', () => {
    request.result.createObjectStore(STORE)
  })
  return settle(`Could not open ${DATABASE}`, request)
})

/** Run one request against the store and close the database. */
const withStore = <A>(
  mode: IDBTransactionMode,
  what: string,
  makeRequest: (store: IDBObjectStore) => IDBRequest<A>
): Effect.Effect<A, AdminKeyStoreUnavailable> =>
  Effect.acquireUseRelease(
    open,
    (db) =>
      Effect.suspend(() =>
        settle(what, makeRequest(db.transaction(STORE, mode).objectStore(STORE)))
      ),
    (db) =>
      Effect.sync(() => {
        db.close()
      })
  )

const isCryptoKey = (value: unknown): value is CryptoKey => value instanceof CryptoKey

/**
 * The browser's `AdminKeyStore`: one record in IndexedDB. Values go in by
 * structured clone, so the non-extractable `CryptoKey` is stored as itself and
 * stays non-extractable.
 */
const adminKeyStoreIndexedDb: Layer.Layer<AdminKeyStore> = Layer.succeed(AdminKeyStore, {
  // An absent key reads as `undefined`, which is no `CryptoKey`, as nothing
  // else stored there would be.
  load: Effect.map(
    withStore('readonly', 'Could not read the key', (store) => store.get(KEY)),
    Option.liftPredicate(isCryptoKey)
  ),
  save: (key) =>
    Effect.asVoid(
      withStore('readwrite', 'Could not store the key', (store) => store.put(key, KEY))
    ),
  clear: Effect.asVoid(
    withStore('readwrite', 'Could not delete the key', (store) => store.delete(KEY))
  ),
})

export { adminKeyStoreIndexedDb }
