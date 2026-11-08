import type {
  BetaAssistantMessageParam,
  BetaUserMessageParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { Chat } from '@wildflowerhealthio/assistant-core-js'
import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { Array, Match, Option } from 'effect'
import type { ComponentProps, JSX } from 'react'

import { ReplyMarkdown } from './reply-markdown.tsx'
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

/** A reply's blocks in order: its thinking folded, its text as Markdown, nothing else. */
const ReplyBlocks = ({ message }: { readonly message: BetaAssistantMessageParam }): JSX.Element =>
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
          Match.orElse(() => null)
        )
      )}
    </>
  )

/** A line in the transcript that is about a reply rather than one. */
const TranscriptNote = ({ children }: { readonly children: string }): JSX.Element => (
  <p className={cn('text-body-3', styles['transcript__note'])}>{children}</p>
)

/** One kept entry, given whether a reply follows it (or is streaming in after it). */
const TranscriptEntry = ({
  entry,
  answered,
}: {
  readonly entry: Chat.Entry
  readonly answered: boolean
}): JSX.Element =>
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
        <ReplyBlocks message={message} />
        {stopReason === 'max_tokens' ? (
          <TranscriptNote>Claude reached its output limit and stopped partway.</TranscriptNote>
        ) : null}
      </li>
    )),
    Match.tag('refusal', () => (
      <li className={styles['transcript__reply']}>
        <TranscriptNote>Claude declined to answer this.</TranscriptNote>
      </li>
    )),
    Match.exhaustive
  )

/** Props for {@link Transcript}: the chat and the reply streaming in, and any other `<ol>` prop. */
interface TranscriptProps extends Omit<ComponentProps<'ol'>, 'children'> {
  readonly entries: readonly Chat.Entry[]
  readonly streamingReply: Option.Option<StreamingReply>
}

/**
 * The chat so far: each question, each reply (thinking folded under
 * "Thinking", text as Markdown), each refusal, and the reply streaming in.
 * A question nothing answered says so.
 *
 * @remarks
 * Entries are only ever appended, so an entry's position is its identity.
 */
const Transcript = ({
  entries,
  streamingReply,
  className,
  ...rootProps
}: TranscriptProps): JSX.Element => (
  <ol {...rootProps} className={cn(styles['transcript'], className)}>
    {entries.map((entry, index) => (
      <TranscriptEntry
        key={`entry-${String(index)}`}
        entry={entry}
        answered={
          entry._tag !== 'question' ||
          entries[index + 1]?._tag === 'reply' ||
          entries[index + 1]?._tag === 'refusal' ||
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

export { Transcript }
export type { TranscriptProps }
