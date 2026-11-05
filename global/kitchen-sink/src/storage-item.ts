import { Effect, Option, Schema } from 'effect'

/**
 * Raised when a `Storage` (`sessionStorage`, `localStorage`) throws on a call:
 * blocked site data, Safari's private mode refusing a write, a quota exceeded.
 * The browser gives no portable way to tell these apart, so the error names
 * only what was asked of the store.
 */
class StorageBlocked extends Schema.TaggedError<StorageBlocked>()('StorageBlocked', {
  /** The call the store refused. */
  operation: Schema.Literal('read', 'write', 'remove'),
  /** The key the call was made with. */
  key: Schema.String,
}) {}

/**
 * Take the item at `key` out of `store`: read it, then remove it, so it is
 * read at most once. `None` when there is none, in which case nothing is
 * removed.
 *
 * @remarks
 * Only a refused read fails the take. Once the item has been read, a store
 * that refuses its removal does not take the read away: the item is still
 * returned, and the refusal is logged as a warning.
 */
const takeStorageItem = (
  store: Pick<Storage, 'getItem' | 'removeItem'>,
  key: string
): Effect.Effect<Option.Option<string>, StorageBlocked> =>
  Effect.try({
    try: () => Option.fromNullable(store.getItem(key)),
    catch: () => new StorageBlocked({ operation: 'read', key }),
  }).pipe(
    Effect.tap(
      Option.match({
        onNone: () => Effect.void,
        onSome: () =>
          removeStorageItem(store, key).pipe(
            Effect.catchAll((blocked) =>
              Effect.logWarning('Read a storage item but could not remove it', blocked)
            )
          ),
      })
    )
  )

/** Write `value` to `store` at `key`. */
const setStorageItem = (
  store: Pick<Storage, 'setItem'>,
  key: string,
  value: string
): Effect.Effect<void, StorageBlocked> =>
  Effect.try({
    try: () => store.setItem(key, value),
    catch: () => new StorageBlocked({ operation: 'write', key }),
  })

/** Remove the item at `key` from `store`, whether or not there is one. */
const removeStorageItem = (
  store: Pick<Storage, 'removeItem'>,
  key: string
): Effect.Effect<void, StorageBlocked> =>
  Effect.try({
    try: () => store.removeItem(key),
    catch: () => new StorageBlocked({ operation: 'remove', key }),
  })

export { removeStorageItem, setStorageItem, StorageBlocked, takeStorageItem }
