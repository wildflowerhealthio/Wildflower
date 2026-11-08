import type {
  BetaAssistantMessageParam,
  BetaMessage,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { Array, DateTime, Effect, Match, Option, Schema } from 'effect'

import type * as ChatPatient from './chat-patient.ts'
import * as Chat from './chat.ts'
import type * as ClaudeModel from './claude-model.ts'
import { Claude, ClaudeRequestFailed } from './claude.ts'
import type { FhirRecords } from './fhir-records.ts'
import type * as RecordAccess from './record-access.ts'
import * as Style from './style.ts'
import * as Tools from './tools.ts'

/**
 * One turn of a chat: the chat's messages sent to Claude, each reply
 * streamed back as it is written, the tools it calls run and their results
 * sent back, until Claude answers; and the entries the chat keeps for it.
 *
 * @remarks
 * A namespace module: `Turn.Delta`, `Turn.Request`, `Turn.Report`,
 * `Turn.run`, `Turn.paramsOf`, `Turn.UnexpectedStop`.
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
 * A reply that stopped for a reason the chat can't keep (`pause_turn`,
 * `stop_sequence`, `compaction`, a full context window, or none); a
 * `max_tokens` that cut a tool call's input short; or a `tool_use` with no
 * tool call to run. It names the reason and nothing the model wrote.
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
  /** What the grant lets the assistant do with the record; with `patient`, it fixes the chat's tools. */
  readonly recordAccess: RecordAccess.Type
}

/** What a turn reports while it runs. */
interface TurnReport {
  /** A piece of the reply streaming in. */
  readonly delta: (delta: Delta) => void
  /**
   * A finished round of tool calls, every call with its result, to append
   * to the chat. The next reply streams in after it.
   */
  readonly toolRound: (round: Chat.ToolRound) => void
}

/** The request for `chat` with `tools`, on `today`. */
const requestParamsOf = (
  { chat, model, patient, recordAccess }: TurnRequest,
  tools: Tools.Type,
  today: DateTime.DateTime
): BetaMessageStreamParams => ({
  model: model.id,
  max_tokens: MAX_TOKENS,
  system: Style.systemPromptOf({ style: chat.style, patient, today, recordAccess }),
  messages: Chat.requestMessagesOf(chat),
  tools: [...tools.definitions],
  cache_control: { type: 'ephemeral' },
  betas: [SERVER_SIDE_FALLBACK_BETA],
  fallbacks: 'default',
  ...(model.supportsAdaptiveThinking
    ? { thinking: { type: 'adaptive', display: 'summarized' } }
    : {}),
})

/**
 * The request a turn streams on `today`: the chat's messages under the
 * style's system prompt, with the chat's tools (the same every request of
 * the chat, so the prompt cache holds), the most output {@link MAX_TOKENS}
 * allows, adaptive thinking summarized where the model takes it, automatic
 * prompt caching, and server-side refusal fallbacks.
 */
const paramsOf = (request: TurnRequest, today: DateTime.DateTime): BetaMessageStreamParams =>
  requestParamsOf(
    request,
    Tools.make({ access: request.recordAccess, patient: request.patient }),
    today
  )

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

/** Stream `params`, handing each piece to `reportDelta`, and succeed with the whole message. */
const streamReply = (
  params: BetaMessageStreamParams,
  reportDelta: (delta: Delta) => void
): Effect.Effect<BetaMessage, ClaudeRequestFailed, Claude> =>
  Effect.flatMap(Claude, (client) =>
    Effect.tryPromise({
      try: async (signal) => {
        const stream = client.beta.messages.stream(params, { signal })
        for await (const event of stream) Option.map(deltaOf(event), reportDelta)
        return stream.finalMessage()
      },
      catch: ClaudeRequestFailed.fromThrown,
    })
  )

/**
 * The entry a chat keeps for `message`, the turn's last, by its stop
 * reason: a reply for `end_turn` and `max_tokens`, a refusal for `refusal`.
 * Its content is read only once the stop reason says it can be trusted. A
 * `max_tokens` part way through a tool call fails: the call's input is cut
 * short, and a call kept without its result would break the next request.
 */
const finalEntryOf = (
  model: ClaudeModel.Type,
  message: BetaMessage
): Effect.Effect<Chat.Entry, UnexpectedStop> => {
  const replyStoppedFor = (stopReason: 'end_turn' | 'max_tokens'): Chat.Entry => ({
    _tag: 'reply',
    modelId: model.id,
    stopReason,
    message: { role: 'assistant', content: message.content },
  })
  return Match.value(message.stop_reason).pipe(
    Match.when('max_tokens', (stopReason) =>
      message.content.some((block) => block.type === 'tool_use')
        ? Effect.fail(UnexpectedStop.make({ stopReason }))
        : Effect.succeed(replyStoppedFor(stopReason))
    ),
    Match.when('end_turn', (stopReason) => Effect.succeed(replyStoppedFor(stopReason))),
    Match.when('refusal', () => Effect.succeed<Chat.Entry>({ _tag: 'refusal', modelId: model.id })),
    Match.orElse((stopReason) => Effect.fail(UnexpectedStop.make({ stopReason })))
  )
}

/**
 * Run the tool calls in `message` (stopped for `tool_use`) side by side, and
 * succeed with the round to keep: the reply as returned, and every result in
 * the order of the calls.
 */
const toolRoundOf = (
  model: ClaudeModel.Type,
  tools: Tools.Type,
  message: BetaMessage
): Effect.Effect<Chat.ToolRound, UnexpectedStop, FhirRecords> => {
  const reply: BetaAssistantMessageParam = { role: 'assistant', content: message.content }
  const calls = Chat.toolCallsOf(reply)
  if (!Array.isNonEmptyReadonlyArray(calls)) {
    return Effect.fail(UnexpectedStop.make({ stopReason: 'tool_use' }))
  }
  return Effect.forEach(calls, (call) => Tools.run(tools, call), { concurrency: 'unbounded' }).pipe(
    Effect.map((results): Chat.ToolRound => ({
      _tag: 'tool-round',
      modelId: model.id,
      message: reply,
      results,
    }))
  )
}

/**
 * Stream a reply to `chat`; while it stops to call tools, run them, report
 * the round, and stream the next reply to the chat with the round appended.
 */
const replyUntilAnswered = (
  request: TurnRequest,
  tools: Tools.Type,
  today: DateTime.DateTime,
  report: TurnReport,
  chat: Chat.Type
): Effect.Effect<Chat.Entry, ClaudeRequestFailed | UnexpectedStop, Claude | FhirRecords> =>
  streamReply(requestParamsOf({ ...request, chat }, tools, today), report.delta).pipe(
    Effect.flatMap((message) =>
      message.stop_reason === 'tool_use'
        ? toolRoundOf(request.model, tools, message).pipe(
            Effect.tap((round) =>
              Effect.sync(() => {
                report.toolRound(round)
              })
            ),
            Effect.flatMap((round) =>
              replyUntilAnswered(request, tools, today, report, Chat.append(chat, round))
            )
          )
        : finalEntryOf(request.model, message)
    )
  )

/**
 * Run one turn: stream `request`'s chat to Claude, reporting each piece of
 * each reply as it arrives; while Claude stops to call tools, run them
 * against the FHIR server and report each round; and succeed with the entry
 * the chat keeps for the reply that ends the turn.
 *
 * @remarks
 * The tools are built once from the grant and the patient
 * ({@link Tools.make}) and sent unchanged with every request. The system
 * prompt states today's date in the `CurrentTimeZone`, the person's own in
 * an app (`DateTime.layerCurrentZoneLocal`). Interrupting the Effect aborts
 * the stream or the reads in flight; rounds already reported stay. API
 * failures are mapped by error class ({@link ClaudeRequestFailed.fromThrown});
 * a reply that stopped for any other reason than `end_turn`, `max_tokens`,
 * `refusal` or a `tool_use` with calls, or at `max_tokens` part way through
 * a tool call, fails as {@link UnexpectedStop}. A tool call that fails is
 * not a turn failure: its result says so to Claude.
 */
const run = (
  request: TurnRequest,
  report: TurnReport
): Effect.Effect<
  Chat.Entry,
  ClaudeRequestFailed | UnexpectedStop,
  Claude | DateTime.CurrentTimeZone | FhirRecords
> =>
  Effect.flatMap(DateTime.nowInCurrentZone, (today) =>
    replyUntilAnswered(
      request,
      Tools.make({ access: request.recordAccess, patient: request.patient }),
      today,
      report,
      request.chat
    )
  )

export { MAX_TOKENS, paramsOf, run, SERVER_SIDE_FALLBACK_BETA, UnexpectedStop }
export type { Delta, TurnReport as Report, TurnRequest as Request }
