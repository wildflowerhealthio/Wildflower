import type { Error as PlatformError, KeyValueStore } from '@effect/platform'
import { Context, Effect, Layer, Option, type Redacted, Schema } from 'effect'

import * as BrowserStorage from './browser-storage.ts'

/**
 * The person's own Claude API key, kept in this browser's `localStorage` and
 * sent only to Anthropic.
 *
 * @remarks
 * A namespace module: `ApiKey.Type`, `ApiKey.fromInput`, `ApiKey.Store`,
 * `ApiKey.layer`, `ApiKey.read`, `ApiKey.write`, `ApiKey.forget`. The key is
 * held `Redacted`, so printing or logging it shows `<redacted>`;
 * `Redacted.value` takes it out where the client is built.
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

/** Where the key is kept: {@link BrowserStorage.Local}, holding the key as JSON. */
class Store extends Context.Tag('@wildflowerhealthio/assistant-core-js/ApiKey/Store')<
  Store,
  KeyValueStore.SchemaStore<Type, never>
>() {}

/** The {@link Store} over {@link BrowserStorage.Local}. */
const layer: Layer.Layer<Store, never, BrowserStorage.Local> = Layer.effect(
  Store,
  Effect.map(BrowserStorage.Local, (store) => store.forSchema(ApiKeySchema))
)

/**
 * The kept key; `None` when there is none, or what is kept is not a key.
 * Fails when the browser refuses the read.
 */
const read: Effect.Effect<Option.Option<Type>, PlatformError.PlatformError, Store> = Store.pipe(
  Effect.flatMap((store) => store.get(STORAGE_KEY)),
  Effect.catchTag('ParseError', () => Effect.succeed(Option.none<Type>()))
)

/** Keep `apiKey`, replacing any key kept before. */
const write = (apiKey: Type): Effect.Effect<void, PlatformError.PlatformError, Store> =>
  Store.pipe(
    Effect.flatMap((store) => store.set(STORAGE_KEY, apiKey)),
    Effect.catchTag('ParseError', Effect.die)
  )

/** Remove the kept key, whether or not one is kept. */
const forget: Effect.Effect<void, PlatformError.PlatformError, Store> = Store.pipe(
  Effect.flatMap((store) => store.remove(STORAGE_KEY))
)

export { forget, fromInput, layer, read, Store, STORAGE_KEY, write }
export type { Type }
