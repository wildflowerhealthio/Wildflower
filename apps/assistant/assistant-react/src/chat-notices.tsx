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
    Match.when(
      'not-kept',
      () => "This browser won't keep the chat in this tab, so it will be lost if the page reloads."
    ),
    Match.exhaustive
  )

/** Props for {@link ChatNotices}. */
interface ChatNoticesProps {
  readonly style: Style.Type
  readonly storageProblem: Option.Option<ChatStorageProblem>
  /** Whether the browser kept the API key. */
  readonly keyKept: boolean
  readonly turnFailure: Option.Option<Turn.Failure>
  /** Claude's proposed writes wait on the person, so nothing else can be sent. */
  readonly writesWaiting: boolean
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
  writesWaiting,
}: ChatNoticesProps): JSX.Element => (
  <div className={styles['chat-notices']}>
    {style === 'academic' ? (
      <p role="note" className={cn('text-body-3', styles['chat-notices__academic-banner'])}>
        Academic style: diagnoses and treatment suggestions for teaching, for sample data only.
      </p>
    ) : null}
    {storageProblem.pipe(
      Option.map((problem) => (
        <p key="storage" role="status" className={cn('text-body-3', styles['chat-notices__line'])}>
          {storageProblemText(problem)}
        </p>
      )),
      Option.getOrNull
    )}
    {keyKept ? null : (
      <p role="status" className={cn('text-body-3', styles['chat-notices__line'])}>
        This browser wouldn&apos;t keep your key, so you&apos;ll enter it again next time.
      </p>
    )}
    {writesWaiting ? (
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
