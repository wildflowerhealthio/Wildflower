import type {
  BetaAssistantMessageParam,
  BetaMessage,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
  BetaToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { Array, DateTime, Effect, Either, Match, Option, Schema } from 'effect'

import type * as ChatPatient from './chat-patient.ts'
import * as Chat from './chat.ts'
import type * as ClaudeModel from './claude-model.ts'
import { Claude, ClaudeRequestFailed } from './claude.ts'
import type { FhirRecords } from './fhir-records.ts'
import type * as RecordAccess from './record-access.ts'
import * as Style from './style.ts'
import * as Tools from './tools.ts'
import type * as WriteProposal from './write-proposal.ts'

/**
 * One turn of a chat: the chat's messages sent to Claude, each reply
 * streamed back as it is written, the tools it calls run and their results
 * sent back, until Claude answers; and the entries the chat keeps for it.
 *
 * @remarks
 * A namespace module: `Turn.Delta`, `Turn.Request`, `Turn.Report`, `Turn.Failure`,
 * `Turn.ProposedWrites`, `Turn.run`, `Turn.paramsOf`, `Turn.UnexpectedStop`.
 *
 * @packageDocumentation
 */

/** The most a reply may write, thinking included, on a model that allows as much. */
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

/** Why a turn failed: the API call failed, or a reply stopped where the chat can't keep it. */
type TurnFailure = ClaudeRequestFailed | UnexpectedStop

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

/**
 * A round of tool calls paused on the writes it proposes, for the person to
 * decide on: the reply that called them, the results already in for the
 * round's other calls (its reads, and any write refused before it was
 * proposed), and the proposals, in call order.
 */
interface ProposedWrites {
  readonly message: BetaAssistantMessageParam
  /** The results already in, by the id of the call each answers. */
  readonly results: ReadonlyMap<string, BetaToolResultBlockParam>
  readonly proposals: Array.NonEmptyReadonlyArray<WriteProposal.Type>
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
  /**
   * Ask the person to decide on a round's proposed writes, and succeed with
   * a decision for each proposal, in the same order, once every one is
   * decided. The turn waits on it; interrupting the turn interrupts it.
   */
  readonly confirmWrites: (
    proposed: ProposedWrites
  ) => Effect.Effect<Array.NonEmptyReadonlyArray<WriteProposal.Decision>>
}

/** The request for `chat` with `tools`, on `today`. */
const requestParamsOf = (
  { chat, model, patient, recordAccess }: TurnRequest,
  tools: Tools.Type,
  today: DateTime.DateTime
): BetaMessageStreamParams => ({
  model: model.id,
  max_tokens: Math.min(MAX_TOKENS, model.maxTokens ?? MAX_TOKENS),
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

/** Where a call of a round stands before its writes are decided: answered, or a write awaiting the person. */
type CallStep =
  | { readonly kind: 'answered'; readonly result: BetaToolResultBlockParam }
  | { readonly kind: 'awaiting-decision'; readonly proposal: WriteProposal.Type }

/** `call` run if it reads, or proposed if it writes. */
const stepOf = (
  tools: Tools.Type,
  versionsRead: ReadonlyMap<string, string>,
  cursorsIssued: ReadonlySet<string>,
  call: Tools.Call
): Effect.Effect<CallStep, never, FhirRecords> =>
  Tools.isWriteCall(call)
    ? Effect.map(
        Tools.propose(tools, call, versionsRead),
        Either.match({
          onLeft: (result): CallStep => ({ kind: 'answered', result }),
          onRight: (proposal): CallStep => ({ kind: 'awaiting-decision', proposal }),
        })
      )
    : Effect.map(Tools.run(tools, call, cursorsIssued), (result): CallStep => ({
        kind: 'answered',
        result,
      }))

/**
 * The person's decision on each of `proposals`, by the id of the call it
 * answers, asked through `confirmWrites` with the round's `reply` and the
 * results already in; none to ask when there are no proposals.
 */
const decisionsOn = (
  reply: BetaAssistantMessageParam,
  steps: readonly CallStep[],
  confirmWrites: TurnReport['confirmWrites']
): Effect.Effect<ReadonlyMap<string, WriteProposal.Decision>> => {
  const proposals = Array.filterMap(steps, (step) =>
    step.kind === 'awaiting-decision' ? Option.some(step.proposal) : Option.none()
  )
  if (!Array.isNonEmptyReadonlyArray(proposals)) return Effect.succeed(new Map())
  const results = new Map(
    Array.filterMap(steps, (step) =>
      step.kind === 'answered'
        ? Option.some([step.result.tool_use_id, step.result] as const)
        : Option.none()
    )
  )
  return confirmWrites({ message: reply, results, proposals }).pipe(
    Effect.flatMap((decisions) =>
      decisions.length === proposals.length
        ? Effect.succeed(
            new Map(
              Array.zip(proposals, decisions).map(([{ callId }, decision]) => [callId, decision])
            )
          )
        : Effect.dieMessage('confirmWrites must decide every proposal it is given, in order')
    )
  )
}

/**
 * The result of each of `steps`, in their order: an answered call's as it
 * is, a proposal's once `decisionByCallId` decides it, each approved write
 * made one after another.
 */
const resultsOf = (
  steps: Array.NonEmptyReadonlyArray<CallStep>,
  decisionByCallId: ReadonlyMap<string, WriteProposal.Decision>
): Effect.Effect<Array.NonEmptyArray<BetaToolResultBlockParam>, never, FhirRecords> =>
  Effect.forEach(steps, (step) =>
    Match.value(step).pipe(
      Match.when({ kind: 'answered' }, ({ result }) => Effect.succeed(result)),
      Match.when({ kind: 'awaiting-decision' }, ({ proposal }) =>
        Option.fromNullable(decisionByCallId.get(proposal.callId)).pipe(
          Option.match({
            onNone: () => Effect.dieMessage('A proposal reached its result undecided'),
            onSome: (decision) => Tools.carryOut(proposal, decision),
          })
        )
      ),
      Match.exhaustive
    )
  )

/**
 * Run the tool calls in `message` (stopped for `tool_use`) side by side:
 * reads at once, writes proposed (an update reading its record again). When
 * the round proposes writes, it pauses for the person's decisions through
 * `report.confirmWrites`, then makes the approved writes. Succeed with the
 * round to keep: the reply as returned, and every result in the order of
 * the calls, sent back together.
 */
const toolRoundOf = (
  model: ClaudeModel.Type,
  tools: Tools.Type,
  chat: Chat.Type,
  report: TurnReport,
  message: BetaMessage
): Effect.Effect<Chat.ToolRound, UnexpectedStop, FhirRecords> => {
  const reply: BetaAssistantMessageParam = { role: 'assistant', content: message.content }
  const calls = Chat.toolCallsOf(reply)
  if (!Array.isNonEmptyReadonlyArray(calls)) {
    return Effect.fail(UnexpectedStop.make({ stopReason: 'tool_use' }))
  }
  const versionsRead = Tools.versionsReadIn(chat)
  const cursorsIssued = Tools.cursorsIssuedIn(chat)
  return Effect.forEach(calls, (call) => stepOf(tools, versionsRead, cursorsIssued, call), {
    concurrency: 'unbounded',
  }).pipe(
    Effect.flatMap((steps) =>
      decisionsOn(reply, steps, report.confirmWrites).pipe(
        Effect.flatMap((decisionByCallId) =>
          // Once decided, the writes are made and the round reported whole,
          // even if the turn is stopped meanwhile: a write the server made is
          // never left out of the chat.
          resultsOf(steps, decisionByCallId).pipe(
            Effect.map((results): Chat.ToolRound => ({
              _tag: 'tool-round',
              modelId: model.id,
              message: reply,
              results,
            })),
            Effect.tap((round) =>
              Effect.sync(() => {
                report.toolRound(round)
              })
            ),
            Effect.uninterruptible
          )
        )
      )
    )
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
): Effect.Effect<Chat.Entry, TurnFailure, Claude | FhirRecords> =>
  streamReply(requestParamsOf({ ...request, chat }, tools, today), report.delta).pipe(
    Effect.flatMap((message) =>
      message.stop_reason === 'tool_use'
        ? toolRoundOf(request.model, tools, chat, report, message).pipe(
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
 * against the FHIR server (pausing for the person to decide on any write
 * they propose) and report each round; and succeed with the entry the chat
 * keeps for the reply that ends the turn.
 *
 * @remarks
 * The tools are built once from the grant and the patient
 * ({@link Tools.make}) and sent unchanged with every request. The system
 * prompt states today's date in the `CurrentTimeZone`, the person's own in
 * an app (`DateTime.layerCurrentZoneLocal`). Interrupting the Effect aborts
 * the stream, the reads in flight or the wait for decisions; rounds already
 * reported stay, and a round interrupted before its decisions keeps nothing.
 * Once the person has decided, the approved writes are made and the round
 * reported even if the turn is interrupted meanwhile. API
 * failures are mapped by error class ({@link ClaudeRequestFailed.fromThrown});
 * a reply that stopped for any other reason than `end_turn`, `max_tokens`,
 * `refusal` or a `tool_use` with calls, or at `max_tokens` part way through
 * a tool call, fails as {@link UnexpectedStop}. A tool call that fails is
 * not a turn failure: its result says so to Claude.
 */
const run = (
  request: TurnRequest,
  report: TurnReport
): Effect.Effect<Chat.Entry, TurnFailure, Claude | DateTime.CurrentTimeZone | FhirRecords> =>
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
export type {
  Delta,
  ProposedWrites,
  TurnFailure as Failure,
  TurnReport as Report,
  TurnRequest as Request,
}
