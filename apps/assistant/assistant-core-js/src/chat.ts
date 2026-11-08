import type {
  BetaAssistantMessageParam,
  BetaContentBlockParam,
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUseBlockParam,
  BetaUserMessageParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import {
  getStorageItem,
  removeStorageItem,
  setStorageItem,
  type StorageBlocked,
} from '@wildflowerhealthio/kitchen-sink'
import { Array, Effect, Match, Option, Predicate, Schema } from 'effect'

import * as ChatPatient from './chat-patient.ts'
import { type StoragePage, storageOf } from './internal/page-storage.ts'
import * as Style from './style.ts'

/**
 * One chat with Claude: its style, fixed when it starts, and its entries in
 * order. Kept in the tab's `sessionStorage`, so it survives a reload or a
 * re-authorization redirect and is gone when the tab closes.
 *
 * @remarks
 * A namespace module: `Chat.Schema`, `Chat.Type`, `Chat.Entry`, `Chat.questionOf`,
 * `Chat.start`, `Chat.append`, `Chat.requestMessagesOf`, `Chat.toolCallsOf`,
 * `Chat.toolResultsByCallIdOf`, and the storage
 * calls `Chat.storageKeyOf`, `Chat.read`, `Chat.write`, `Chat.forget`.
 *
 * Append-only: {@link append} adds an entry after the last, and nothing
 * rewrites one. Each message is kept exactly as it was sent or returned,
 * thinking blocks included; what goes back to the API is derived from the
 * entries by {@link requestMessagesOf}.
 *
 * @packageDocumentation
 */

/**
 * Whether `value` has the outline of an `@anthropic-ai/sdk` message param
 * with `role`: string content, or an array of objects each naming its
 * block `type`.
 */
const isMessageParamWithRole =
  (role: BetaMessageParam['role']) =>
  (value: unknown): boolean =>
    Predicate.isRecord(value) &&
    value['role'] === role &&
    (Predicate.isString(value['content']) ||
      (globalThis.Array.isArray(value['content']) &&
        value['content'].every(
          (block: unknown) => Predicate.isRecord(block) && Predicate.isString(block['type'])
        )))

/**
 * A user message, as the SDK types it.
 *
 * @remarks
 * Checked only for its outline (role, and content that is a string or typed
 * blocks): the blocks are the SDK's dozens of types, every one written by
 * this app from what it sent or what the SDK returned, so the SDK's own
 * types are asserted rather than mirrored in schemas that would drift.
 */
const UserMessageSchema = Schema.declare(
  (value: unknown): value is BetaUserMessageParam => isMessageParamWithRole('user')(value),
  { identifier: 'BetaUserMessageParam' }
)

/** An assistant message, as the SDK types it; checked only for its outline, as {@link UserMessageSchema}. */
const AssistantMessageSchema = Schema.declare(
  (value: unknown): value is BetaAssistantMessageParam =>
    isMessageParamWithRole('assistant')(value),
  { identifier: 'BetaAssistantMessageParam' }
)

/**
 * The stop reasons a reply is kept with: `end_turn`, finished;
 * `max_tokens`, cut off at the output limit with what came before kept;
 * and `tool_use`, calling tools, whose results the entry after it holds.
 */
const ReplyStopReason = Schema.Literal('end_turn', 'max_tokens', 'tool_use')

/** Something the person asked. */
const QuestionEntry = Schema.TaggedStruct('question', { message: UserMessageSchema })

/** Claude's answer, from `model`, as returned. */
const ReplyEntry = Schema.TaggedStruct('reply', {
  model: Schema.String,
  stopReason: ReplyStopReason,
  message: AssistantMessageSchema,
})

/**
 * The results of the tool calls in the reply before it, all in one user
 * message, as they were sent back.
 */
const ToolResultsEntry = Schema.TaggedStruct('tool-results', { message: UserMessageSchema })

/**
 * `model` declined to answer the question before it (`stop_reason:
 * "refusal"`). Whatever it had written is not kept.
 */
const RefusalEntry = Schema.TaggedStruct('refusal', { model: Schema.String })

/** One entry in a chat, in the order they happened. */
const EntrySchema = Schema.Union(QuestionEntry, ReplyEntry, ToolResultsEntry, RefusalEntry)

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

/** A question entry for `text`, as the person typed it. */
const questionOf = (text: string): Entry => ({
  _tag: 'question',
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

/** Every tool result in `entries`, by the id of the call it answers. */
const toolResultsByCallIdOf = (
  entries: readonly Entry[]
): ReadonlyMap<string, BetaToolResultBlockParam> =>
  new Map(
    entries.flatMap((entry) =>
      entry._tag === 'tool-results' && !Predicate.isString(entry.message.content)
        ? Array.filter(
            entry.message.content,
            (block): block is BetaToolResultBlockParam => block.type === 'tool_result'
          ).map((result) => [result.tool_use_id, result] as const)
        : []
    )
  )

/**
 * Whether the entry at `index` belongs to a question Claude declined: the
 * refusal itself, or anything after that question and before the refusal
 * (its tool calls and their results), the question included.
 */
const isDeclinedAt = (entries: readonly Entry[], index: number): boolean =>
  entries[index]?._tag === 'refusal' ||
  Array.findFirst(
    entries.slice(index + 1),
    (later) => later._tag === 'question' || later._tag === 'refusal'
  ).pipe(Option.exists((later) => later._tag === 'refusal'))

/**
 * The messages a turn sends for `chat`: each question, each reply's message
 * and each set of tool results, in order. A question Claude declined is left
 * out with everything up to its refusal, so the chat can go on from there; a
 * question with no reply (the person stopped it) stays, and the API reads it
 * together with the next.
 */
const requestMessagesOf = (chat: Type): BetaMessageParam[] =>
  Array.filterMap(chat.entries, (entry, index) =>
    isDeclinedAt(chat.entries, index)
      ? Option.none()
      : Match.value(entry).pipe(
          Match.tag('question', ({ message }) => Option.some<BetaMessageParam>(message)),
          Match.tag('reply', ({ message }) => Option.some(withoutDeclinedParts(message))),
          Match.tag('tool-results', ({ message }) => Option.some<BetaMessageParam>(message)),
          Match.tag('refusal', () => Option.none()),
          Match.exhaustive
        )
  )

/**
 * What is kept where a chat should be is not one. It names nothing of what
 * was kept: a chat holds the person's and the model's words.
 */
class StoredChatUnreadable extends Schema.TaggedError<StoredChatUnreadable>()(
  'StoredChatUnreadable',
  {}
) {}

/** The chat as the JSON kept in `sessionStorage`. */
const StoredChat = Schema.parseJson(ChatSchema)

/** Where a chat is kept: the FHIR server it reads and whose record it is about. */
interface ChatPlace {
  /** The FHIR server's base URL. */
  readonly fhirBase: string
  readonly patient: ChatPatient.Type
}

/**
 * The `sessionStorage` key of the chat at `place`:
 * `wildflower.assistant-chat:<fhirBase>:<patient id, or * for every patient>`.
 */
const storageKeyOf = ({ fhirBase, patient }: ChatPlace): string =>
  `wildflower.assistant-chat:${fhirBase}:${ChatPatient.keyOf(patient)}`

/**
 * The chat kept at `place` in `page`'s `sessionStorage`; `None` when there is
 * none. Fails when the browser refuses the read, or when what is kept is not
 * a chat ({@link StoredChatUnreadable}).
 */
const read = (
  page: StoragePage,
  place: ChatPlace
): Effect.Effect<Option.Option<Type>, StorageBlocked | StoredChatUnreadable> => {
  const key = storageKeyOf(place)
  return storageOf(page, 'sessionStorage', 'read', key).pipe(
    Effect.flatMap((storage) => getStorageItem(storage, key)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<Type>()),
        onSome: (json) =>
          Schema.decode(StoredChat)(json).pipe(
            Effect.mapBoth({ onFailure: () => new StoredChatUnreadable(), onSuccess: Option.some })
          ),
      })
    )
  )
}

/** Keep `chat` at `place` in `page`'s `sessionStorage`, replacing what was kept. */
const write = (
  page: StoragePage,
  place: ChatPlace,
  chat: Type
): Effect.Effect<void, StorageBlocked> => {
  const key = storageKeyOf(place)
  return storageOf(page, 'sessionStorage', 'write', key).pipe(
    Effect.flatMap((storage) => setStorageItem(storage, key, Schema.encodeSync(StoredChat)(chat)))
  )
}

/** Remove the chat at `place` from `page`'s `sessionStorage`, for a new chat. */
const forget = (page: StoragePage, place: ChatPlace): Effect.Effect<void, StorageBlocked> => {
  const key = storageKeyOf(place)
  return storageOf(page, 'sessionStorage', 'remove', key).pipe(
    Effect.flatMap((storage) => removeStorageItem(storage, key))
  )
}

export {
  append,
  ChatSchema as Schema,
  EntrySchema,
  forget,
  questionOf,
  read,
  requestMessagesOf,
  start,
  storageKeyOf,
  StoredChatUnreadable,
  toolCallsOf,
  toolResultsByCallIdOf,
  write,
}
export type { ChatPlace, Entry, Type }
