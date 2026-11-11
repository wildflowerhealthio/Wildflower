import type {
  BetaAssistantMessageParam,
  BetaContentBlockParam,
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUseBlockParam,
  BetaUserMessageParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { Error as PlatformError, KeyValueStore } from '@effect/platform'
import { Array, Context, Effect, Layer, Match, Option, Predicate, Schema } from 'effect'

import * as MessageParams from './anthropic-ai/message-params.ts'
import * as BrowserStorage from './browser-storage.ts'
import * as ChatPatient from './chat-patient.ts'
import * as Style from './style.ts'

/**
 * One chat with Claude: its style, fixed when it starts, and its entries in
 * order. Kept in the tab's `sessionStorage`, so it survives a reload or a
 * re-authorization redirect and is gone when the tab closes.
 *
 * @remarks
 * A namespace module: `Chat.Schema`, `Chat.Type`, `Chat.Entry`,
 * `Chat.ToolRound`, `Chat.userEntryOf`, `Chat.start`, `Chat.append`,
 * `Chat.requestMessagesOf`, `Chat.toolCallsOf`, `Chat.toolResultsByCallIdOf`,
 * and the storage: `Chat.Store`, `Chat.layer`, `Chat.storageKeyOf`,
 * `Chat.read`, `Chat.write`, `Chat.forget`.
 *
 * Append-only: {@link append} adds an entry after the last, and nothing
 * rewrites one. Each message is kept exactly as it was sent or returned,
 * thinking blocks included; what goes back to the API is derived from the
 * entries by {@link requestMessagesOf}.
 *
 * @packageDocumentation
 */

/**
 * The stop reasons an agent entry, the reply that ends a turn, is kept with: `end_turn`,
 * finished; and `max_tokens`, cut off at the output limit with what came
 * before kept.
 */
const AgentStopReason = Schema.Literal('end_turn', 'max_tokens')

/** What the person wrote. */
const UserEntry = Schema.TaggedStruct('user', { message: MessageParams.UserMessageSchema })

/** The agent's reply that ended a turn, from the model `modelId` names, as returned. */
const AgentEntry = Schema.TaggedStruct('agent', {
  modelId: Schema.String,
  stopReason: AgentStopReason,
  message: MessageParams.AssistantMessageSchema,
})

/**
 * A reply that stopped to call tools (`stop_reason: "tool_use"`), as
 * returned from the model `modelId` names, and the results of the calls it
 * ran, in call order, as they were sent back. Kept only once every call has
 * its result.
 */
const ToolRoundEntry = Schema.TaggedStruct('tool-round', {
  modelId: Schema.String,
  message: MessageParams.AssistantMessageSchema,
  results: Schema.NonEmptyArray(MessageParams.ToolResultSchema),
})

/** A reply that called tools, and the results it was sent back. */
type ToolRound = typeof ToolRoundEntry.Type

/**
 * The model `modelId` names declined to answer the user entry before it
 * (`stop_reason: "refusal"`). Whatever it had written is not kept.
 */
const RefusalEntry = Schema.TaggedStruct('refusal', { modelId: Schema.String })

/** One entry in a chat, in the order they happened. */
const EntrySchema = Schema.Union(UserEntry, AgentEntry, ToolRoundEntry, RefusalEntry)

/** One entry in a chat. */
type Entry = typeof EntrySchema.Type

/** A chat: its style and its entries. */
const ChatSchema = Schema.Struct({
  style: Style.Schema,
  entries: Schema.Array(EntrySchema),
})

/** A chat. */
type Type = typeof ChatSchema.Type

/** A chat in `style` with nothing said yet. */
const start = (style: Style.Type): Type => ({ style, entries: [] })

/** `chat` with `entry` after its last. */
const append = (chat: Type, entry: Entry): Type => ({
  ...chat,
  entries: [...chat.entries, entry],
})

/** A user entry for `text`, as the person typed it. */
const userEntryOf = (text: string): Entry => ({
  _tag: 'user',
  message: { role: 'user', content: text },
})

/**
 * Block types a mid-reply fallback leaves before its switch point that the
 * API is not to be sent back: the declining model's thinking and tool calls.
 */
const DECLINED_PART_TYPES: ReadonlySet<BetaContentBlockParam['type']> = new Set([
  'thinking',
  'redacted_thinking',
  'tool_use',
])

/**
 * `message` as it is sent back: when a server-side fallback switched models
 * part way through it, without the thinking and tool calls before the last
 * `fallback` block; otherwise as it is.
 */
const withoutDeclinedParts = (message: BetaAssistantMessageParam): BetaAssistantMessageParam => {
  if (Predicate.isString(message.content)) return message
  const blocks = message.content
  return Array.findLastIndex(blocks, (block) => block.type === 'fallback').pipe(
    Option.match({
      onNone: () => message,
      onSome: (lastFallbackIndex) => ({
        ...message,
        content: blocks.filter(
          (block, index) => index > lastFallbackIndex || !DECLINED_PART_TYPES.has(block.type)
        ),
      }),
    })
  )
}

/**
 * The tool calls in `message` that run: every `tool_use` block, except those
 * a server-side fallback left before its last switch point, which are not
 * sent back ({@link withoutDeclinedParts}).
 */
const toolCallsOf = (message: BetaAssistantMessageParam): readonly BetaToolUseBlockParam[] => {
  const { content } = withoutDeclinedParts(message)
  return Predicate.isString(content)
    ? []
    : Array.filter(content, (block): block is BetaToolUseBlockParam => block.type === 'tool_use')
}

/** `round`'s results, by the id of the call each answers. */
const toolResultsByCallIdOf = (round: ToolRound): ReadonlyMap<string, BetaToolResultBlockParam> =>
  new Map(round.results.map((result) => [result.tool_use_id, result] as const))

/**
 * Whether the entry at `index` belongs to a user entry Claude declined: the
 * refusal itself, or the user entry and its tool rounds, whose next user
 * entry or refusal is a refusal.
 */
const isDeclinedAt = (entries: readonly Entry[], index: number): boolean =>
  entries[index]?._tag === 'refusal' ||
  Array.findFirst(
    entries.slice(index + 1),
    (later) => later._tag === 'user' || later._tag === 'refusal'
  ).pipe(Option.exists((later) => later._tag === 'refusal'))

/** The messages `entry` stands for in a request: a tool round is the reply that called and the user message of its results. */
const messagesOfEntry = (entry: Entry): readonly BetaMessageParam[] =>
  Match.value(entry).pipe(
    Match.tag('user', ({ message }) => [message]),
    Match.tag('agent', ({ message }) => [withoutDeclinedParts(message)]),
    Match.tag('tool-round', ({ message, results }) => [
      withoutDeclinedParts(message),
      { role: 'user', content: [...results] } satisfies BetaUserMessageParam,
    ]),
    Match.tag('refusal', () => []),
    Match.exhaustive
  )

/**
 * The messages a turn sends for `chat`: each user entry, each agent entry,
 * and each tool round as its reply then one user message of its results, in
 * order. A user entry Claude declined is left out with everything up to its
 * refusal, so the chat can go on from there; a user entry with no reply (the
 * person stopped it) stays, and the API reads it together with the next.
 */
const requestMessagesOf = (chat: Type): BetaMessageParam[] =>
  chat.entries.flatMap((entry, index) =>
    isDeclinedAt(chat.entries, index) ? [] : messagesOfEntry(entry)
  )

/**
 * What is kept where a chat should be is not one. It names nothing of what
 * was kept: a chat holds the person's and the model's words.
 */
class StoredChatUnreadable extends Schema.TaggedError<StoredChatUnreadable>()(
  'StoredChatUnreadable',
  {}
) {}

/** Where chats are kept: {@link BrowserStorage.Session}, each as JSON. */
class Store extends Context.Tag('@wildflowerhealthio/assistant-core-js/Chat/Store')<
  Store,
  KeyValueStore.SchemaStore<Type, never>
>() {}

/** The {@link Store} over {@link BrowserStorage.Session}. */
const layer: Layer.Layer<Store, never, BrowserStorage.Session> = Layer.effect(
  Store,
  Effect.map(BrowserStorage.Session, (store) => store.forSchema(ChatSchema))
)

/** Where a chat is kept: the FHIR server it reads and whose record it is about. */
interface ChatPlace {
  /** The FHIR server's base URL. */
  readonly fhirBaseUrl: string
  readonly patient: ChatPatient.Type
}

/**
 * The `sessionStorage` key of the chat at `place`:
 * `wildflower.assistant-chat:<fhirBaseUrl>:<patient id, or * for every patient>`.
 */
const storageKeyOf = ({ fhirBaseUrl, patient }: ChatPlace): string =>
  `wildflower.assistant-chat:${fhirBaseUrl}:${ChatPatient.keyOf(patient)}`

/**
 * The chat kept at `place`; `None` when there is none. Fails when the
 * browser refuses the read, or when what is kept is not a chat
 * ({@link StoredChatUnreadable}).
 */
const read = (
  place: ChatPlace
): Effect.Effect<Option.Option<Type>, PlatformError.PlatformError | StoredChatUnreadable, Store> =>
  Store.pipe(
    Effect.flatMap((store) => store.get(storageKeyOf(place))),
    Effect.catchTag('ParseError', () => Effect.fail(new StoredChatUnreadable()))
  )

/** Keep `chat` at `place`, replacing what was kept. */
const write = (
  place: ChatPlace,
  chat: Type
): Effect.Effect<void, PlatformError.PlatformError, Store> =>
  Store.pipe(
    Effect.flatMap((store) => store.set(storageKeyOf(place), chat)),
    Effect.catchTag('ParseError', Effect.die)
  )

/** Remove the chat at `place`, for a new chat. */
const forget = (place: ChatPlace): Effect.Effect<void, PlatformError.PlatformError, Store> =>
  Store.pipe(Effect.flatMap((store) => store.remove(storageKeyOf(place))))

export {
  append,
  ChatSchema as Schema,
  EntrySchema,
  forget,
  layer,
  userEntryOf,
  read,
  requestMessagesOf,
  start,
  storageKeyOf,
  Store,
  StoredChatUnreadable,
  toolCallsOf,
  toolResultsByCallIdOf,
  write,
}
export type { ChatPlace as Place, Entry, ToolRound, Type }
