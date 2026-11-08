import type {
  BetaAssistantMessageParam,
  BetaToolResultBlockParam,
  BetaUserMessageParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { Chat } from '@wildflowerhealthio/assistant-core-js'
import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { Array, Match, Option } from 'effect'
import type { ComponentProps, JSX } from 'react'

import { ReplyMarkdown } from './reply-markdown.tsx'
import { ToolCallCard } from './tool-call-card.tsx'
import type { StreamingReply } from './use-chat.ts'
import styles from './transcript.module.css'

/** The text the person typed in `message`. */
const questionTextOf = ({ content }: BetaUserMessageParam): string =>
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

/**
 * A reply's blocks in order: its thinking folded, its text as Markdown, each
 * tool call as a card with its result from `toolResults`, nothing else.
 */
const ReplyBlocks = ({
  message,
  toolResults,
}: {
  readonly message: BetaAssistantMessageParam
  readonly toolResults: ToolResults
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
            <ToolCallCard
              key={`tool-${String(blockIndex)}`}
              call={call}
              result={Option.fromNullable(toolResults.get(call.id))}
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
    Match.tag('question', ({ message }) => (
      <li className={styles['transcript__question']}>
        <p className={cn('text-body-2', styles['transcript__question-text'])}>
          {questionTextOf(message)}
        </p>
        {answered ? null : <TranscriptNote>No reply to this message.</TranscriptNote>}
      </li>
    )),
    Match.tag('reply', ({ message, stopReason }) => (
      <li className={styles['transcript__reply']}>
        <ReplyBlocks message={message} toolResults={NO_TOOL_RESULTS} />
        {stopReason === 'max_tokens' ? (
          <TranscriptNote>Claude reached its output limit and stopped partway.</TranscriptNote>
        ) : null}
      </li>
    )),
    Match.tag('tool-round', (round) => (
      <li className={styles['transcript__reply']}>
        <ReplyBlocks message={round.message} toolResults={Chat.toolResultsByCallIdOf(round)} />
      </li>
    )),
    Match.tag('refusal', () => (
      <li className={styles['transcript__reply']}>
        <TranscriptNote>Claude declined to answer this.</TranscriptNote>
      </li>
    )),
    Match.exhaustive
  )

/** Whether the entry after `index` is Claude's (a reply, a tool round or a refusal) rather than another question or nothing. */
const isFollowedByClaudeAt = (entries: readonly Chat.Entry[], index: number): boolean =>
  Option.fromNullable(entries[index + 1]).pipe(Option.exists((next) => next._tag !== 'question'))

/** Props for {@link Transcript}: the chat and the reply streaming in, and any other `<ol>` prop. */
interface TranscriptProps extends Omit<ComponentProps<'ol'>, 'children'> {
  readonly entries: readonly Chat.Entry[]
  readonly streamingReply: Option.Option<StreamingReply>
}

/**
 * The chat so far: each question, each reply (thinking folded under
 * "Thinking", text as Markdown, tool calls as cards), each refusal, and the
 * reply streaming in. A question nothing answered says so.
 *
 * @remarks
 * Entries are only ever appended, so an entry's position is its identity.
 */
const Transcript = ({
  entries,
  streamingReply,
  className,
  ...rootProps
}: TranscriptProps): JSX.Element => {
  return (
    <ol {...rootProps} className={cn(styles['transcript'], className)}>
      {entries.map((entry, index) => (
        <TranscriptEntry
          key={`entry-${String(index)}`}
          entry={entry}
          answered={
            entry._tag !== 'question' ||
            isFollowedByClaudeAt(entries, index) ||
            (index === entries.length - 1 && Option.isSome(streamingReply))
          }
        />
      ))}
      {streamingReply.pipe(
        Option.map(({ thinking, text }) => (
          <li key="streaming" className={styles['transcript__reply']} aria-busy="true">
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
    </ol>
  )
}

export { Transcript }
export type { TranscriptProps }
