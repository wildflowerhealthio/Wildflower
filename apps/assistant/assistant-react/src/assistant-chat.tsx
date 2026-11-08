import { Chat, type ChatPatient } from '@wildflowerhealthio/assistant-core-js'
import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { ErrorBanner, PageLoading } from '@wildflowerhealthio/react-tundraish'
import { Match } from 'effect'
import { type ComponentProps, type JSX, useMemo } from 'react'

import { type AssistantEnvironment, BROWSER_ENVIRONMENT } from './assistant-environment.ts'
import { ChatView } from './chat-view.tsx'
import { claudeFailureText } from './failure-text.ts'
import { KeySetup } from './key-setup.tsx'
import { useClaudeAccess } from './use-claude-access.ts'
import styles from './assistant-chat.module.css'

/** Props for {@link AssistantChat}: where the chat is, and any other `<div>` prop. */
interface AssistantChatProps extends Omit<ComponentProps<'div'>, 'children'> {
  /** The connected FHIR server's base URL; chats are kept per server. */
  readonly fhirBase: string
  /** Whose record the chat is about; chats are kept per patient. */
  readonly patient: ChatPatient.Type
  /** The storage and Claude API the chat runs against; the browser's own unless a test gives one. */
  readonly environment?: AssistantEnvironment
}

/**
 * Assistant's whole chat with Claude about `patient`'s record on the FHIR
 * server at `fhirBase`: asking for the person's API key until one works,
 * then the model picker, the style choice, the transcript and the
 * composer.
 *
 * @remarks
 * The key and the chosen model are kept in `localStorage`; the chat in
 * `sessionStorage`, one per server and patient, so a change of patient
 * starts a new chat. The page logic is `useClaudeAccess` and `useChat`.
 */
const AssistantChat = ({
  fhirBase,
  patient,
  environment = BROWSER_ENVIRONMENT,
  className,
  ...rootProps
}: AssistantChatProps): JSX.Element => {
  const claudeAccess = useClaudeAccess(environment)
  const place = useMemo<Chat.ChatPlace>(() => ({ fhirBase, patient }), [fhirBase, patient])
  return (
    <div {...rootProps} className={cn(styles['assistant-chat'], className)}>
      {Match.value(claudeAccess.access).pipe(
        Match.when({ kind: 'checking-key' }, () => <PageLoading message="Checking your key…" />),
        Match.when({ kind: 'needs-key' }, ({ keyWasRejected }) => (
          <KeySetup keyWasRejected={keyWasRejected} onSaveKey={claudeAccess.saveKey} />
        )),
        Match.when({ kind: 'models-unavailable' }, ({ failure }) => (
          <div className={styles['assistant-chat__unavailable']}>
            <ErrorBanner error={claudeFailureText(failure)} />
            <button type="button" className="button-2 outline" onClick={claudeAccess.retry}>
              Try again
            </button>
          </div>
        )),
        Match.when({ kind: 'no-models' }, () => (
          <p className="text-body-2">This key can&apos;t use any Claude model.</p>
        )),
        Match.when({ kind: 'ready' }, (ready) => (
          <ChatView
            // A new place is a new chat: nothing carries over from the last one.
            key={Chat.storageKeyOf(place)}
            environment={environment}
            place={place}
            claudeAccess={claudeAccess}
            ready={ready}
          />
        )),
        Match.exhaustive
      )}
    </div>
  )
}

export { AssistantChat }
export type { AssistantChatProps }
