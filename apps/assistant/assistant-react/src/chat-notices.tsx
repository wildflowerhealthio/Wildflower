import type { Style, Turn } from '@wildflowerhealthio/assistant-core-js'
import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { ErrorBanner } from '@wildflowerhealthio/react-tundraish'
import { Match, Option } from 'effect'
import type { JSX } from 'react'

import { turnFailureText } from './failure-text.ts'
import type { ChatStorageProblem } from './use-chat.ts'
import styles from './chat-notices.module.css'

/** The line for each way the chat could not be kept. */
const storageProblemText = (problem: ChatStorageProblem): string =>
  Match.value(problem).pipe(
    Match.when(
      'unreadable',
      () => "The chat kept in this tab couldn't be read, so this is a new chat."
    ),
    Match.when('not-kept', () => "This browser won't keep the chat in this tab."),
    Match.when(
      'message-not-kept',
      () => "This browser won't keep your message in this tab, so it wasn't sent."
    ),
    Match.when('kept-in-memory', () => 'This chat is kept until this tab closes or refreshes.'),
    Match.exhaustive
  )

/** Whether `problem` is the browser refusing the tab's storage, which keeping the chat in memory gets round. */
const isRefusedStorage = (problem: ChatStorageProblem): boolean =>
  problem === 'not-kept' || problem === 'message-not-kept'

/** Props for {@link ChatNotices}. */
interface ChatNoticesProps {
  readonly style: Style.Type
  readonly storageProblem: Option.Option<ChatStorageProblem>
  /** Whether the browser kept the API key. */
  readonly keyKept: boolean
  readonly turnFailure: Option.Option<Turn.Failure>
  /** A write Claude proposed waits on the person's decision, so nothing else can be sent. */
  readonly writesAwaitingDecision: boolean
  /** Keep the chat in memory instead, offered while the browser refuses the tab's storage. */
  readonly onKeepInMemory: () => void
}

/**
 * The lines about the chat that sit above the composer, full width: the
 * academic style's banner while it is on, then why the chat or the key is
 * not kept, then that a proposed change waits on the person, then why the
 * last turn failed. Nothing when none applies.
 */
const ChatNotices = ({
  style,
  storageProblem,
  keyKept,
  turnFailure,
  writesAwaitingDecision,
  onKeepInMemory,
}: ChatNoticesProps): JSX.Element => (
  <div className={styles['chat-notices']}>
    {style === 'academic' ? (
      <p role="note" className={cn('text-body-3', styles['chat-notices__academic-banner'])}>
        Academic style: diagnoses and treatment suggestions for teaching, for sample data only.
      </p>
    ) : null}
    {storageProblem.pipe(
      Option.map((problem) => (
        <div key="storage" className={styles['chat-notices__storage']}>
          <p role="status" className={cn('text-body-3', styles['chat-notices__line'])}>
            {storageProblemText(problem)}
          </p>
          {isRefusedStorage(problem) ? (
            <button type="button" className="button-3 outline" onClick={onKeepInMemory}>
              Keep until this tab closes or refreshes
            </button>
          ) : null}
        </div>
      )),
      Option.getOrNull
    )}
    {keyKept ? null : (
      <p role="status" className={cn('text-body-3', styles['chat-notices__line'])}>
        This browser wouldn&apos;t keep your key, so you&apos;ll enter it again next time.
      </p>
    )}
    {writesAwaitingDecision ? (
      <p role="status" className={cn('text-body-3', styles['chat-notices__line'])}>
        Approve or decline Claude&apos;s proposed change above to go on.
      </p>
    ) : null}
    {turnFailure.pipe(
      Option.map((failure) => <ErrorBanner key="turn" error={turnFailureText(failure)} />),
      Option.getOrNull
    )}
  </div>
)

export { ChatNotices }
export type { ChatNoticesProps }
