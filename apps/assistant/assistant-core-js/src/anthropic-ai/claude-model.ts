import type { Error as PlatformError, KeyValueStore } from '@effect/platform'
import { Array, Context, DateTime, Effect, Layer, Option, Order, ParseResult, Schema } from 'effect'

import * as BrowserStorage from '../browser-storage.ts'
import { Claude, ClaudeRequestFailed } from './claude.ts'

/**
 * A Claude model the person's key can use, as `GET /v1/models` lists it, and
 * the person's choice among them.
 *
 * @remarks
 * A namespace module: `ClaudeModel.Type`, `ClaudeModel.list`,
 * `ClaudeModel.startingModelOf`, and the remembered choice: `ClaudeModel.ChosenIdStore`,
 * `ClaudeModel.chosenIdLayer`, `ClaudeModel.readChosenId`, `ClaudeModel.writeChosenId`.
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
  /** The most `max_tokens` a request to the model may ask for; `null` when the listing gives none. */
  maxTokens: Schema.propertySignature(Schema.NullOr(Schema.Number)).pipe(
    Schema.fromKey('max_tokens')
  ),
  /** `active`, `deprecated`, or `retired`: a retired model stays listed but answers no request. */
  lifecycle: Schema.String,
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

/** The models a chat may use from `models`: the `claude-` ones not retired, newest first. */
const choicesOf = (models: readonly Type[]): readonly Type[] =>
  Array.sort(
    models.filter((model) => model.id.startsWith('claude-') && model.lifecycle !== 'retired'),
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

/** Where the last chosen model's id is kept: {@link BrowserStorage.Local}, as JSON. */
class ChosenIdStore extends Context.Tag(
  '@wildflowerhealthio/assistant-core-js/ClaudeModel/ChosenIdStore'
)<ChosenIdStore, KeyValueStore.SchemaStore<string, never>>() {}

/** The {@link ChosenIdStore} over {@link BrowserStorage.Local}. */
const chosenIdLayer: Layer.Layer<ChosenIdStore, never, BrowserStorage.Local> = Layer.effect(
  ChosenIdStore,
  Effect.map(BrowserStorage.Local, (store) => store.forSchema(Schema.String))
)

/**
 * The id of the model last chosen; `None` when none was, or what is kept is
 * not an id. Fails when the browser refuses the read.
 */
const readChosenId: Effect.Effect<
  Option.Option<string>,
  PlatformError.PlatformError,
  ChosenIdStore
> = ChosenIdStore.pipe(
  Effect.flatMap((store) => store.get(CHOSEN_ID_STORAGE_KEY)),
  Effect.catchTag('ParseError', () => Effect.succeed(Option.none<string>()))
)

/** Keep `modelId` as the last chosen model. */
const writeChosenId = (
  modelId: string
): Effect.Effect<void, PlatformError.PlatformError, ChosenIdStore> =>
  ChosenIdStore.pipe(
    Effect.flatMap((store) => store.set(CHOSEN_ID_STORAGE_KEY, modelId)),
    Effect.catchTag('ParseError', Effect.die)
  )

export {
  CHOSEN_ID_STORAGE_KEY,
  chosenIdLayer,
  ChosenIdStore,
  choicesOf,
  ClaudeModelSchema as Schema,
  DEFAULT_ID,
  list,
  readChosenId,
  startingModelOf,
  writeChosenId,
}
export type { Type }
