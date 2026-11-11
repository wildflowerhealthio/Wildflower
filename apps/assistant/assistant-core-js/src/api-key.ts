import {
  getStorageItem,
  removeStorageItem,
  setStorageItem,
  type StorageBlocked,
} from '@wildflowerhealthio/kitchen-sink'
import { Effect, Option, type Redacted, Schema } from 'effect'

import { type StoragePage, storageOf } from './internal/page-storage.ts'

/**
 * The person's own Claude API key, kept in this browser's `localStorage` and
 * sent only to Anthropic.
 *
 * @remarks
 * A namespace module: `ApiKey.Type`, `ApiKey.fromInput`, `ApiKey.read`,
 * `ApiKey.write`, `ApiKey.forget`. The key is held `Redacted`, so printing
 * or logging it shows `<redacted>`; `Redacted.value` takes it out where the
 * client is built.
 *
 * @packageDocumentation
 */

/** The `localStorage` key the API key is kept under. */
const STORAGE_KEY = 'wildflower.assistant.api-key'

/** A key as typed or pasted, trimmed and non-empty, held redacted. */
const ApiKeySchema = Schema.Redacted(Schema.compose(Schema.Trim, Schema.NonEmptyString))

/** A Claude API key, redacted. */
type Type = Redacted.Redacted<string>

/** The key in `input`, trimmed; `None` when nothing but whitespace was entered. */
const fromInput: (input: string) => Option.Option<Type> = Schema.decodeOption(ApiKeySchema)

/**
 * The key kept in `page`'s `localStorage`; `None` when there is none. Fails
 * when the browser refuses the read.
 */
const read = (page: StoragePage): Effect.Effect<Option.Option<Type>, StorageBlocked> =>
  storageOf(page, 'localStorage', 'read', STORAGE_KEY).pipe(
    Effect.flatMap((storage) => getStorageItem(storage, STORAGE_KEY)),
    Effect.map(Option.flatMap(fromInput))
  )

/** Keep `apiKey` in `page`'s `localStorage`, replacing any key kept before. */
const write = (page: StoragePage, apiKey: Type): Effect.Effect<void, StorageBlocked> =>
  storageOf(page, 'localStorage', 'write', STORAGE_KEY).pipe(
    Effect.flatMap((storage) =>
      setStorageItem(storage, STORAGE_KEY, Schema.encodeSync(ApiKeySchema)(apiKey))
    )
  )

/** Remove the key from `page`'s `localStorage`, whether or not one is kept. */
const forget = (page: StoragePage): Effect.Effect<void, StorageBlocked> =>
  storageOf(page, 'localStorage', 'remove', STORAGE_KEY).pipe(
    Effect.flatMap((storage) => removeStorageItem(storage, STORAGE_KEY))
  )

export { forget, fromInput, read, STORAGE_KEY, write }
export type { Type }
