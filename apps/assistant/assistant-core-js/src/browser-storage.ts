import { Error as PlatformError, KeyValueStore } from '@effect/platform'
import { Context, Effect, Layer, Option } from 'effect'

/**
 * The browser's two Web Storage areas, as `@effect/platform` key-value
 * stores: `localStorage`, which keeps the API key and the model choice
 * across visits, and `sessionStorage`, which keeps the tab's chats.
 *
 * @remarks
 * A namespace module: `BrowserStorage.Local`, `BrowserStorage.Session`,
 * `BrowserStorage.layer`, `BrowserStorage.memoryStore`,
 * `BrowserStorage.refusingStore`. What each thing
 * kept is, and its key, is the task-specific store built on top of one of
 * these: `ApiKey.Store`, `ClaudeModel.ChosenIdStore`, `Chat.Store`.
 *
 * @packageDocumentation
 */

/** The browser's `localStorage`, kept across visits. */
class Local extends Context.Tag('@wildflowerhealthio/assistant-core-js/BrowserStorage/Local')<
  Local,
  KeyValueStore.KeyValueStore
>() {}

/** The tab's `sessionStorage`, gone when the tab closes. */
class Session extends Context.Tag('@wildflowerhealthio/assistant-core-js/BrowserStorage/Session')<
  Session,
  KeyValueStore.KeyValueStore
>() {}

/**
 * An empty store in memory, gone with the page: where a chat is kept once
 * the person chooses that over a browser that refuses `sessionStorage`.
 */
const memoryStore = (): KeyValueStore.KeyValueStore =>
  Effect.runSync(KeyValueStore.KeyValueStore.pipe(Effect.provide(KeyValueStore.layerMemory)))

/** The Web Storage areas the two stores are backed by. */
type Area = 'localStorage' | 'sessionStorage'

/**
 * A store whose every call fails, as a browser that refuses `area` does:
 * a read fails rather than finding nothing, so a refused read is never
 * taken for no key.
 */
const refusingStore = (area: Area): KeyValueStore.KeyValueStore => {
  const refused = (method: string, key: string): PlatformError.SystemError =>
    new PlatformError.SystemError({
      reason: 'PermissionDenied',
      module: 'KeyValueStore',
      method,
      pathOrDescriptor: key,
      description: `The browser refused ${area}`,
    })
  return KeyValueStore.makeStringOnly({
    get: (key) => Effect.fail(refused('get', key)),
    set: (key) => Effect.fail(refused('set', key)),
    remove: (key) => Effect.fail(refused('remove', key)),
    clear: Effect.fail(refused('clear', area)),
    size: Effect.fail(refused('size', area)),
  })
}

/**
 * The page's `area` as a store. The property is read when the layer is
 * built, inside the Effect: a browser that blocks storage can throw on the
 * read itself, which gives the {@link refusingStore} rather than a defect.
 */
const storeOf = (area: Area): Effect.Effect<KeyValueStore.KeyValueStore> =>
  Effect.try(() => globalThis[area]).pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(refusingStore(area)),
        onSome: (storage) =>
          KeyValueStore.KeyValueStore.pipe(
            Effect.provide(KeyValueStore.layerStorage(() => storage))
          ),
      })
    )
  )

/** Both stores, over the page's own `localStorage` and `sessionStorage`. */
const layer: Layer.Layer<Local | Session> = Layer.merge(
  Layer.effect(Local, storeOf('localStorage')),
  Layer.effect(Session, storeOf('sessionStorage'))
)

export { layer, Local, memoryStore, refusingStore, Session }
export type { Area }
