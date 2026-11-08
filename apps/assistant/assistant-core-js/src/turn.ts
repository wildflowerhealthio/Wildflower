import type {
  BetaMessage,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { DateTime, Effect, Match, Option, Schema } from 'effect'

import type * as ChatPatient from './chat-patient.ts'
import * as Chat from './chat.ts'
import type * as ClaudeModel from './claude-model.ts'
import { Claude, ClaudeRequestFailed } from './claude.ts'
import * as Style from './style.ts'

/**
 * One turn of a chat: the chat's messages sent to Claude, the reply streamed
 * back as it is written, and the entry the chat keeps for it.
 *
 * @remarks
 * A namespace module: `Turn.Delta`, `Turn.run`, `Turn.paramsOf`,
 * `Turn.UnexpectedStop`.
 *
 * @packageDocumentation
 */

/** The most a reply may write, thinking included. */
const MAX_TOKENS = 64000

/**
 * The beta header for server-side refusal fallbacks in their `"default"`
 * form, where the API picks the fallback model by the refusal's category.
 */
const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01'

/** A piece of the reply as it streams in: answer text, or summarized thinking. */
interface Delta {
  readonly kind: 'text' | 'thinking'
  readonly text: string
}

/**
 * A reply that stopped for a reason a chat without tools never expects
 * (`tool_use`, `pause_turn`, `stop_sequence`, `compaction`, a full context
 * window, or none). It names the reason and nothing the model wrote.
 */
class UnexpectedStop extends Schema.TaggedError<UnexpectedStop>()('UnexpectedStop', {
  stopReason: Schema.NullOr(Schema.String),
}) {}

/** What a turn sends. */
interface TurnRequest {
  /** The chat so far, ending with the person's question. */
  readonly chat: Chat.Type
  /** The model this turn runs on. */
  readonly model: ClaudeModel.Type
  readonly patient: ChatPatient.Type
}

/**
 * The request a turn streams on `today`: the chat's messages under the
 * style's system prompt, with no tools, the most output {@link MAX_TOKENS} allows, adaptive
 * thinking summarized where the model takes it, automatic prompt caching,
 * and server-side refusal fallbacks.
 */
const paramsOf = (
  { chat, model, patient }: TurnRequest,
  today: DateTime.DateTime
): BetaMessageStreamParams => ({
  model: model.id,
  max_tokens: MAX_TOKENS,
  system: Style.systemPromptOf({ style: chat.style, patient, today }),
  messages: Chat.requestMessagesOf(chat),
  tools: [],
  cache_control: { type: 'ephemeral' },
  betas: [SERVER_SIDE_FALLBACK_BETA],
  fallbacks: 'default',
  ...(model.adaptiveThinking ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
})

/** The piece of the reply `event` carries, if it carries text or thinking. */
const deltaOf = (event: BetaRawMessageStreamEvent): Option.Option<Delta> => {
  if (event.type !== 'content_block_delta') return Option.none()
  return Match.value(event.delta).pipe(
    Match.when({ type: 'text_delta' }, ({ text }) => Option.some<Delta>({ kind: 'text', text })),
    Match.when({ type: 'thinking_delta' }, ({ thinking }) =>
      Option.some<Delta>({ kind: 'thinking', text: thinking })
    ),
    Match.orElse(() => Option.none())
  )
}

/**
 * The entry a chat keeps for `message`, by its stop reason: a reply for
 * `end_turn` and `max_tokens`, a refusal for `refusal`. Its content is read
 * only once the stop reason says it can be trusted.
 */
const entryOf = (
  model: ClaudeModel.Type,
  message: BetaMessage
): Effect.Effect<Chat.Entry, UnexpectedStop> =>
  Match.value(message.stop_reason).pipe(
    Match.whenOr('end_turn', 'max_tokens', (stopReason) =>
      Effect.succeed<Chat.Entry>({
        _tag: 'reply',
        model: model.id,
        stopReason,
        message: { role: 'assistant', content: message.content },
      })
    ),
    Match.when('refusal', () => Effect.succeed<Chat.Entry>({ _tag: 'refusal', model: model.id })),
    Match.orElse((stopReason) => Effect.fail(UnexpectedStop.make({ stopReason })))
  )

/**
 * Run one turn: stream `request`'s chat to Claude, handing each piece of
 * the reply to `reportDelta` as it arrives, and succeed with the entry the
 * chat keeps for the whole reply.
 *
 * @remarks
 * The system prompt states today's date in the `CurrentTimeZone`, the
 * person's own in an app (`DateTime.layerCurrentZoneLocal`). Interrupting the Effect aborts the stream. API failures are mapped by
 * error class ({@link ClaudeRequestFailed.fromThrown}); a reply that stopped
 * for any reason but `end_turn`, `max_tokens` or `refusal` fails as
 * {@link UnexpectedStop}.
 */
const run = (
  request: TurnRequest,
  reportDelta: (delta: Delta) => void
): Effect.Effect<
  Chat.Entry,
  ClaudeRequestFailed | UnexpectedStop,
  Claude | DateTime.CurrentTimeZone
> =>
  Effect.all([Claude, DateTime.nowInCurrentZone]).pipe(
    Effect.flatMap(([client, today]) =>
      Effect.tryPromise({
        try: async (signal) => {
          const stream = client.beta.messages.stream(paramsOf(request, today), { signal })
          for await (const event of stream) Option.map(deltaOf(event), reportDelta)
          return stream.finalMessage()
        },
        catch: ClaudeRequestFailed.fromThrown,
      })
    ),
    Effect.flatMap((message) => entryOf(request.model, message))
  )

export { MAX_TOKENS, paramsOf, run, SERVER_SIDE_FALLBACK_BETA, UnexpectedStop }
export type { Delta, TurnRequest }
