import { Context, Data, Effect, Layer, Option, Ref, Schema } from 'effect'

import { subtle, type WebCryptoUnavailable } from '../signing/web-crypto.ts'
import { indexedDbRecord, type IndexedDbUnavailable } from './indexed-db.ts'

/** The fewest bytes the relay accepts in `WILDFLOWER_RELAY_ADMIN_KEY`. */
const ADMIN_KEY_MIN_BYTES = 32

const encoder = new TextEncoder()

const TOO_SHORT = `The admin key is at least ${ADMIN_KEY_MIN_BYTES} bytes: paste WILDFLOWER_RELAY_ADMIN_KEY whole`

/**
 * `WILDFLOWER_RELAY_ADMIN_KEY` as the operator pastes it: surrounding
 * whitespace dropped, as the relay drops it from its environment, and at least
 * {@link ADMIN_KEY_MIN_BYTES} bytes of UTF-8, the relay's own minimum.
 */
const AdminKeyText = Schema.Trim.pipe(
  Schema.filter((key) => encoder.encode(key).byteLength >= ADMIN_KEY_MIN_BYTES, {
    message: () => TOO_SHORT,
  })
)

/** The pasted text is not a usable admin key. */
class AdminKeyRejected extends Data.TaggedError('AdminKeyRejected')<{
  readonly reason: string
}> {
  override get message(): string {
    return this.reason
  }
}

/** No admin key is stored, so a request cannot be signed. */
class NoAdminKey extends Data.TaggedError('NoAdminKey') {
  override get message(): string {
    return 'No admin key is stored: sign in with WILDFLOWER_RELAY_ADMIN_KEY'
  }
}

/**
 * Import the pasted admin key as a **non-extractable** HMAC SHA-256 key that
 * can only sign. The relay keys its MAC with the key's UTF-8 bytes, as written,
 * so they are imported raw rather than decoded.
 */
const importAdminKey = (
  pasted: string
): Effect.Effect<CryptoKey, AdminKeyRejected | WebCryptoUnavailable> =>
  Effect.gen(function* () {
    const text = yield* Schema.decode(AdminKeyText)(pasted).pipe(
      Effect.mapError(() => new AdminKeyRejected({ reason: TOO_SHORT }))
    )
    return yield* subtle('Could not import the admin key', (s) =>
      s.importKey('raw', encoder.encode(text), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    )
  })

/**
 * Where the admin key lives between visits: the imported `CryptoKey`, never
 * the pasted text. Signing out clears it.
 */
class AdminKeyStore extends Context.Tag('relay-core/AdminKeyStore')<
  AdminKeyStore,
  {
    readonly load: Effect.Effect<Option.Option<CryptoKey>, IndexedDbUnavailable>
    readonly save: (key: CryptoKey) => Effect.Effect<void, IndexedDbUnavailable>
    readonly clear: Effect.Effect<void, IndexedDbUnavailable>
  }
>() {
  /**
   * The browser's store: one record in IndexedDB, which keeps a `CryptoKey`
   * by structured clone, so a non-extractable key stays non-extractable.
   */
  static readonly layerIndexedDb: Layer.Layer<AdminKeyStore> = Layer.sync(AdminKeyStore, () => {
    const record = indexedDbRecord<CryptoKey>({
      database: 'relay-admin',
      store: 'keys',
      key: 'admin',
      is: (value): value is CryptoKey => value instanceof CryptoKey,
    })
    return {
      load: record.get,
      save: record.put,
      clear: record.delete,
    }
  })

  /** A store that lasts as long as the layer, for tests. */
  static readonly layerMemory: Layer.Layer<AdminKeyStore> = Layer.effect(
    AdminKeyStore,
    Effect.map(Ref.make(Option.none<CryptoKey>()), (ref) => ({
      load: Ref.get(ref),
      save: (key: CryptoKey) => Ref.set(ref, Option.some(key)),
      clear: Ref.set(ref, Option.none()),
    }))
  )
}

export {
  ADMIN_KEY_MIN_BYTES,
  AdminKeyRejected,
  AdminKeyStore,
  AdminKeyText,
  importAdminKey,
  NoAdminKey,
}
