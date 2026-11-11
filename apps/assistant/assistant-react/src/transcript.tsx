import type {
  BetaAssistantMessageParam,
  BetaToolResultBlockParam,
  BetaToolUseBlockParam,
  BetaUserMessageParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { Chat, type WriteProposal } from '@wildflowerhealthio/assistant-core-js'
import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { Array, Match, Option } from 'effect'
import type { ComponentProps, JSX } from 'react'

import { ReplyMarkdown } from './reply-markdown.tsx'
import { ToolCallCard } from './tool-call-card.tsx'
import type { PendingWrites, StreamingReply } from './use-chat.ts'
import { WriteCard } from './write-card.tsx'
import styles from './transcript.module.css'

/** The text the person typed in `message`. */
const userTextOf = ({ content }: BetaUserMessageParam): string =>
  typeof content === 'string'
    ? content
    : Array.filterMap(content, (block) =>
        block.type === 'text' ? Option.some(block.text) : Option.none()
      ).join('\n\n')

/** Summarized thinking, folded away under "Thinking" until opened. */
const ThinkingDisclosure = ({ thinking }: { readonly thinking: string }): JSX.Element => (
  <details className={styles['transcript__thinking']}>
    <summary className="text-label-3">Thinking</summary>
    <p className={cn('text-body-3', styles['transcript__thinking-text'])}>{thinking}</p>
  </details>
)

/** A reply's tool results, by the id of the call each answers. */
type ToolResults = ReadonlyMap<string, BetaToolResultBlockParam>

/** The results of a reply that ended the turn: it ran no calls. */
const NO_TOOL_RESULTS: ToolResults = new Map()

/** A round's writes waiting on the person, by call id, and how to decide one. */
interface WritesAwaitingDecision {
  readonly pendingWrites: PendingWrites
  readonly onDecideWrite: (callId: string, decision: WriteProposal.Decision) => void
}

/** The proposal for the call `callId` in `writes`, if it proposes one. */
const proposalFor = (
  writes: Option.Option<WritesAwaitingDecision>,
  callId: string
): Option.Option<WriteProposal.Type> =>
  Option.flatMap(writes, ({ pendingWrites }) =>
    Array.findFirst(pendingWrites.proposed.proposals, (proposal) => proposal.callId === callId)
  )

/**
 * One tool call in a reply: the write it proposes, while its round waits on
 * the person, as a {@link WriteCard}; otherwise the call as a
 * {@link ToolCallCard} with its result from `toolResults`.
 */
const ToolCallBlock = ({
  call,
  toolResults,
  writes,
}: {
  readonly call: BetaToolUseBlockParam
  readonly toolResults: ToolResults
  readonly writes: Option.Option<WritesAwaitingDecision>
}): JSX.Element =>
  Option.all({ proposal: proposalFor(writes, call.id), awaiting: writes }).pipe(
    Option.map(({ proposal, awaiting }) => (
      <WriteCard
        key="write"
        proposal={proposal}
        decision={Option.fromNullable(awaiting.pendingWrites.decisions.get(call.id))}
        onDecide={(decision) => {
          awaiting.onDecideWrite(call.id, decision)
        }}
      />
    )),
    Option.getOrElse(() => (
      <ToolCallCard call={call} result={Option.fromNullable(toolResults.get(call.id))} />
    ))
  )

/**
 * A reply's blocks in order: its thinking folded, its text as Markdown, each
 * tool call as a card with its result from `toolResults` (or, while its
 * round waits on the person, the write it proposes as a {@link WriteCard}),
 * nothing else.
 */
const AgentMessageBlocks = ({
  message,
  toolResults,
  writes = Option.none(),
}: {
  readonly message: BetaAssistantMessageParam
  readonly toolResults: ToolResults
  readonly writes?: Option.Option<WritesAwaitingDecision>
}): JSX.Element =>
  typeof message.content === 'string' ? (
    <ReplyMarkdown markdown={message.content} />
  ) : (
    <>
      {message.content.map((block, blockIndex) =>
        Match.value(block).pipe(
          Match.when({ type: 'text' }, ({ text }) => (
            <ReplyMarkdown key={`text-${String(blockIndex)}`} markdown={text} />
          )),
          Match.when({ type: 'thinking' }, ({ thinking }) =>
            thinking === '' ? null : (
              <ThinkingDisclosure key={`thinking-${String(blockIndex)}`} thinking={thinking} />
            )
          ),
          Match.when({ type: 'tool_use' }, (call) => (
            <ToolCallBlock
              key={`tool-${String(blockIndex)}`}
              call={call}
              toolResults={toolResults}
              writes={writes}
            />
          )),
          Match.orElse(() => null)
        )
      )}
    </>
  )

/** A line in the transcript that is about a reply rather than one. */
const TranscriptNote = ({ children }: { readonly children: string }): JSX.Element => (
  <p className={cn('text-body-3', styles['transcript__note'])}>{children}</p>
)

/**
 * One kept entry, given whether a reply follows it (or is streaming in after
 * it). A tool round's results show in its calls' cards, not on their own.
 */
const TranscriptEntry = ({
  entry,
  answered,
}: {
  readonly entry: Chat.Entry
  readonly answered: boolean
}): JSX.Element | null =>
  Match.value(entry).pipe(
    Match.tag('user', ({ message }) => (
      <li className={styles['transcript__user']}>
        <p className={cn('text-body-2', styles['transcript__user-text'])}>{userTextOf(message)}</p>
        {answered ? null : <TranscriptNote>No reply to this message.</TranscriptNote>}
      </li>
    )),
    Match.tag('agent', ({ message, stopReason }) => (
      <li className={styles['transcript__agent']}>
        <AgentMessageBlocks message={message} toolResults={NO_TOOL_RESULTS} />
        {stopReason === 'max_tokens' ? (
          <TranscriptNote>Claude reached its output limit and stopped partway.</TranscriptNote>
        ) : null}
      </li>
    )),
    Match.tag('tool-round', (round) => (
      <li className={styles['transcript__agent']}>
        <AgentMessageBlocks
          message={round.message}
          toolResults={Chat.toolResultsByCallIdOf(round)}
        />
      </li>
    )),
    Match.tag('refusal', () => (
      <li className={styles['transcript__agent']}>
        <TranscriptNote>Claude declined to answer this.</TranscriptNote>
      </li>
    )),
    Match.exhaustive
  )

/** Whether the entry after `index` is Claude's (a reply, a tool round or a refusal) rather than another user entry or nothing. */
const isFollowedByClaudeAt = (entries: readonly Chat.Entry[], index: number): boolean =>
  Option.fromNullable(entries[index + 1]).pipe(Option.exists((next) => next._tag !== 'user'))

/** Props for {@link Transcript}: the chat, the reply streaming in, the round waiting on the person, and any other `<ol>` prop. */
interface TranscriptProps extends Omit<ComponentProps<'ol'>, 'children'> {
  readonly entries: readonly Chat.Entry[]
  readonly streamingReply: Option.Option<StreamingReply>
  /** The round whose proposed writes wait on the person; `None` when none does. */
  readonly pendingWrites: Option.Option<PendingWrites>
  readonly onDecideWrite: (callId: string, decision: WriteProposal.Decision) => void
}

/**
 * The chat so far: each of the person's messages, each reply (thinking folded under
 * "Thinking", text as Markdown, tool calls as cards), each refusal, and the
 * reply streaming in, or the round waiting on the person, its proposed
 * writes as cards to approve or decline. A message nothing answered says so.
 *
 * @remarks
 * Entries are only ever appended, so an entry's position is its identity.
 */
const Transcript = ({
  entries,
  streamingReply,
  pendingWrites,
  onDecideWrite,
  className,
  ...rootProps
}: TranscriptProps): JSX.Element => {
  const turnRunning = Option.isSome(streamingReply) || Option.isSome(pendingWrites)
  return (
    <ol {...rootProps} className={cn(styles['transcript'], className)}>
      {entries.map((entry, index) => (
        <TranscriptEntry
          key={`entry-${String(index)}`}
          entry={entry}
          answered={
            entry._tag !== 'user' ||
            isFollowedByClaudeAt(entries, index) ||
            (index === entries.length - 1 && turnRunning)
          }
        />
      ))}
      {streamingReply.pipe(
        Option.map(({ thinking, text }) => (
          <li key="streaming" className={styles['transcript__agent']} aria-busy="true">
            {thinking === '' ? null : <ThinkingDisclosure thinking={thinking} />}
            {text === '' ? (
              <TranscriptNote>Claude is writing…</TranscriptNote>
            ) : (
              <ReplyMarkdown markdown={text} />
            )}
          </li>
        )),
        Option.getOrNull
      )}
      {pendingWrites.pipe(
        Option.map((pending) => (
          <li key="pending-writes" className={styles['transcript__agent']}>
            <AgentMessageBlocks
              message={pending.proposed.message}
              toolResults={pending.proposed.results}
              writes={Option.some({ pendingWrites: pending, onDecideWrite })}
            />
          </li>
        )),
        Option.getOrNull
      )}
    </ol>
  )
}

export { Transcript }
export type { TranscriptProps }
