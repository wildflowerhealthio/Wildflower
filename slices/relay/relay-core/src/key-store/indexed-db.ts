import { Data, Effect, Option } from 'effect'

/** IndexedDB is missing, refused to open, or failed a request. */
class IndexedDbUnavailable extends Data.TaggedError('IndexedDbUnavailable')<{
  readonly reason: string
}> {
  override get message(): string {
    return this.reason
  }
}

/** Where one record lives: a key in an object store of a database. */
interface RecordLocation {
  readonly database: string
  readonly store: string
  readonly key: string
}

/** A record's location, and how to tell a stored value is one. */
interface RecordSpec<A> extends RecordLocation {
  readonly is: (value: unknown) => value is A
}

/** Read, write and delete one record. */
interface IndexedDbRecord<A> {
  readonly get: Effect.Effect<Option.Option<A>, IndexedDbUnavailable>
  readonly put: (value: A) => Effect.Effect<void, IndexedDbUnavailable>
  readonly delete: Effect.Effect<void, IndexedDbUnavailable>
}

/** The settled result of `request`, or its error as {@link IndexedDbUnavailable}. */
const settle = <A>(what: string, request: IDBRequest<A>): Effect.Effect<A, IndexedDbUnavailable> =>
  Effect.async<A, IndexedDbUnavailable>((resume) => {
    request.addEventListener('success', () => {
      resume(Effect.succeed(request.result))
    })
    request.addEventListener('error', () => {
      resume(Effect.fail(new IndexedDbUnavailable({ reason: `${what}: ${String(request.error)}` })))
    })
  })

/** Open `location`'s database, creating its object store on first use. */
const open = (location: RecordLocation): Effect.Effect<IDBDatabase, IndexedDbUnavailable> =>
  Effect.suspend(() => {
    if (globalThis.indexedDB === undefined) {
      return Effect.fail(new IndexedDbUnavailable({ reason: 'IndexedDB is unavailable' }))
    }
    const request = globalThis.indexedDB.open(location.database, 1)
    request.addEventListener('upgradeneeded', () => {
      request.result.createObjectStore(location.store)
    })
    return settle(`Could not open ${location.database}`, request)
  })

/** Run one request against `location`'s store and close the database. */
const withStore = <A>(
  location: RecordLocation,
  mode: IDBTransactionMode,
  what: string,
  makeRequest: (store: IDBObjectStore) => IDBRequest<A>
): Effect.Effect<A, IndexedDbUnavailable> =>
  Effect.acquireUseRelease(
    open(location),
    (db) =>
      Effect.suspend(() =>
        settle(what, makeRequest(db.transaction(location.store, mode).objectStore(location.store)))
      ),
    (db) =>
      Effect.sync(() => {
        db.close()
      })
  )

/**
 * One record in IndexedDB, at `location`; a stored value `location.is` refuses
 * reads as none. Values go in by structured clone, so
 * a `CryptoKey` is stored as itself, extractable or not.
 */
const indexedDbRecord = <A>(location: RecordSpec<A>): IndexedDbRecord<A> => ({
  // An absent key reads as `undefined`, which `is` refuses, as it does
  // anything else that is not an `A`.
  get: Effect.map(
    withStore(location, 'readonly', 'Could not read the key', (store) => store.get(location.key)),
    Option.liftPredicate(location.is)
  ),
  put: (value) =>
    Effect.asVoid(
      withStore(location, 'readwrite', 'Could not store the key', (store) =>
        store.put(value, location.key)
      )
    ),
  delete: Effect.asVoid(
    withStore(location, 'readwrite', 'Could not delete the key', (store) =>
      store.delete(location.key)
    )
  ),
})

export { indexedDbRecord, IndexedDbUnavailable }
export type { IndexedDbRecord, RecordLocation, RecordSpec }
