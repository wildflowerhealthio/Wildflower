import {
  getStorageItem,
  setStorageItem,
  type StorageBlocked,
} from '@wildflowerhealthio/kitchen-sink'
import { Array, DateTime, Effect, Option, Order, ParseResult, Schema } from 'effect'

import { Claude, ClaudeRequestFailed } from './claude.ts'
import { type StoragePage, storageOf } from './internal/page-storage.ts'

/**
 * A Claude model the person's key can use, as `GET /v1/models` lists it, and
 * the person's choice among them.
 *
 * @remarks
 * A namespace module: `ClaudeModel.Type`, `ClaudeModel.list`,
 * `ClaudeModel.startingModelOf`, `ClaudeModel.readChosenId`, `ClaudeModel.writeChosenId`.
 *
 * @packageDocumentation
 */

/** The model a chat starts on when the key can use it and no other was chosen. */
const DEFAULT_ID = 'claude-sonnet-5'

/** The `localStorage` key the last chosen model's id is kept under. */
const CHOSEN_ID_STORAGE_KEY = 'wildflower.assistant.model'

/**
 * A `ModelInfo`'s `capabilities` (the SDK's `ModelCapabilities`), narrowed
 * to the one a turn reads: whether the model takes `thinking: { type:
 * 'adaptive' }`.
 */
const AdaptiveThinkingCapabilities = Schema.Struct({
  thinking: Schema.Struct({
    types: Schema.Struct({ adaptive: Schema.Struct({ supported: Schema.Boolean }) }),
  }),
})

/**
 * Whether a model supports adaptive thinking, read from its `capabilities`:
 * a model listing none (`null`) does not. Read only: a listed model is
 * never written back.
 */
const SupportsAdaptiveThinking = Schema.transformOrFail(
  Schema.NullOr(AdaptiveThinkingCapabilities),
  Schema.Boolean,
  {
    strict: true,
    decode: (capabilities) =>
      ParseResult.succeed(capabilities?.thinking.types.adaptive.supported ?? false),
    encode: (supported, _options, ast) =>
      ParseResult.fail(
        new ParseResult.Forbidden(ast, supported, "A model's capabilities are only read.")
      ),
  }
)

/** A model as the listing names it, with only what Assistant reads. */
const ClaudeModelSchema = Schema.Struct({
  id: Schema.String,
  displayName: Schema.propertySignature(Schema.String).pipe(Schema.fromKey('display_name')),
  createdAt: Schema.propertySignature(Schema.DateTimeUtc).pipe(Schema.fromKey('created_at')),
  supportsAdaptiveThinking: Schema.propertySignature(SupportsAdaptiveThinking).pipe(
    Schema.fromKey('capabilities')
  ),
})

/**
 * A model the key can use: its id, the name to show, when it was released,
 * and whether it supports adaptive thinking.
 */
type Type = typeof ClaudeModelSchema.Type

/** Newest release first. */
const NewestFirst: Order.Order<Type> = Order.reverse(
  Order.mapInput(DateTime.Order, (model: Type) => model.createdAt)
)

/** The models a chat may use from `models`: the `claude-` ones, newest first. */
const choicesOf = (models: readonly Type[]): readonly Type[] =>
  Array.sort(
    models.filter((model) => model.id.startsWith('claude-')),
    NewestFirst
  )

/**
 * The models the key behind {@link Claude} can use ({@link choicesOf} the
 * listing, every page of it).
 *
 * @remarks
 * A listing that does not decode fails as `model-list-unreadable`: the API
 * answered, but not with models.
 */
const list: Effect.Effect<readonly Type[], ClaudeRequestFailed, Claude> = Claude.pipe(
  Effect.flatMap((client) =>
    Effect.tryPromise({
      try: async (signal) => {
        const listed: unknown[] = []
        for await (const info of client.models.list(null, { signal })) listed.push(info)
        return listed
      },
      catch: ClaudeRequestFailed.fromThrown,
    })
  ),
  Effect.flatMap((listed) =>
    Schema.decodeUnknown(Schema.Array(ClaudeModelSchema))(listed).pipe(
      Effect.mapError(() =>
        ClaudeRequestFailed.make({ kind: 'model-list-unreadable', status: null })
      )
    )
  ),
  Effect.map(choicesOf)
)

/**
 * The model to start on among `models`: the one `chosenId` names while it is
 * listed, else {@link DEFAULT_ID}, else the first listed. `None` only when
 * `models` is empty.
 */
const startingModelOf = (
  models: readonly Type[],
  chosenId: Option.Option<string>
): Option.Option<Type> => {
  const listed = (id: string): Option.Option<Type> =>
    Array.findFirst(models, (model) => model.id === id)
  return chosenId.pipe(
    Option.flatMap(listed),
    Option.orElse(() => listed(DEFAULT_ID)),
    Option.orElse(() => Array.head(models))
  )
}

/**
 * The id of the model last chosen, kept in `page`'s `localStorage`. `None`
 * when none was, and also when the browser refuses the read: the default
 * model is chosen instead.
 */
const readChosenId = (page: StoragePage): Effect.Effect<Option.Option<string>> =>
  storageOf(page, 'localStorage', 'read', CHOSEN_ID_STORAGE_KEY).pipe(
    Effect.flatMap((storage) => getStorageItem(storage, CHOSEN_ID_STORAGE_KEY)),
    Effect.orElseSucceed(() => Option.none<string>())
  )

/** Keep `modelId` as the last chosen model in `page`'s `localStorage`. */
const writeChosenId = (page: StoragePage, modelId: string): Effect.Effect<void, StorageBlocked> =>
  storageOf(page, 'localStorage', 'write', CHOSEN_ID_STORAGE_KEY).pipe(
    Effect.flatMap((storage) => setStorageItem(storage, CHOSEN_ID_STORAGE_KEY, modelId))
  )

export {
  CHOSEN_ID_STORAGE_KEY,
  choicesOf,
  ClaudeModelSchema as Schema,
  DEFAULT_ID,
  list,
  readChosenId,
  startingModelOf,
  writeChosenId,
}
export type { Type }
