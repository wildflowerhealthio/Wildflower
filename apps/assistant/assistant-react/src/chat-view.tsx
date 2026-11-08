import type { Chat } from '@wildflowerhealthio/assistant-core-js'
import { ConfirmDialog, LinkButton } from '@wildflowerhealthio/react-tundraish'
import { type JSX, useState } from 'react'

import type { AssistantEnvironment } from './assistant-environment.ts'
import { ChatNotices } from './chat-notices.tsx'
import { Composer } from './composer.tsx'
import { ModelPicker } from './model-picker.tsx'
import { SettingsDialog } from './settings-dialog.tsx'
import { StyleChoice } from './style-choice.tsx'
import { Transcript } from './transcript.tsx'
import { type ChatRecords, useChat } from './use-chat.ts'
import type { ClaudeAccess, ClaudeAccessControls } from './use-claude-access.ts'
import styles from './chat-view.module.css'

/** The confirmation the academic style needs, each chat. */
const ACADEMIC_CONFIRMATION =
  "This style gives diagnoses and treatment suggestions for teaching. Use it only with sample data, not a real person's record."

/** Props for {@link ChatView}. */
interface ChatViewProps {
  readonly environment: AssistantEnvironment
  readonly place: Chat.Place
  /** What the chat's tools reach. */
  readonly records: ChatRecords
  readonly claudeAccess: ClaudeAccessControls
  /** The access `claudeAccess` holds, known to be ready. */
  readonly ready: Extract<ClaudeAccess, { kind: 'ready' }>
}

/**
 * The chat once the key works: the toolbar (model, style, settings), the
 * transcript with its live region, the lines about the chat, then the
 * composer; and the academic confirmation and the settings dialog.
 */
const ChatView = ({
  environment,
  place,
  records,
  claudeAccess,
  ready,
}: ChatViewProps): JSX.Element => {
  const chat = useChat(environment, place, records)
  const [settingsOpen, setSettingsOpen] = useState(false)
  return (
    <>
      <div className={styles['chat-view__toolbar']}>
        <ModelPicker
          models={ready.models}
          model={ready.model}
          onModelChange={claudeAccess.chooseModel}
        />
        <StyleChoice
          style={chat.chat.style}
          locked={chat.styleLocked}
          onStyleRequest={chat.requestStyle}
        />
        <LinkButton
          className={styles['chat-view__settings']}
          onClick={() => {
            setSettingsOpen(true)
          }}
        >
          Settings
        </LinkButton>
      </div>
      <Transcript
        entries={chat.chat.entries}
        streamingReply={chat.streamingReply}
        pendingWrites={chat.pendingWrites}
        onDecideWrite={chat.decideWrite}
      />
      <p aria-live="polite" className="sr-only">
        {chat.announcement}
      </p>
      <ChatNotices
        style={chat.chat.style}
        storageProblem={chat.storageProblem}
        keyKept={ready.keyKept}
        turnFailure={chat.turnFailure}
        writesAwaitingDecision={chat.writesAwaitingDecision}
      />
      <Composer
        replying={chat.turnRunning}
        messageDisabled={chat.writesAwaitingDecision}
        onSend={(text) => {
          chat.send({ text, model: ready.model, apiKey: ready.apiKey })
        }}
        onStop={chat.stop}
        onNewChat={chat.newChat}
      />
      <ConfirmDialog
        open={chat.academicConfirmationOpen}
        title="Use the academic style?"
        confirmLabel="Use academic style"
        pending={false}
        onConfirm={chat.confirmAcademic}
        onCancel={chat.cancelAcademic}
      >
        {ACADEMIC_CONFIRMATION}
      </ConfirmDialog>
      <SettingsDialog
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false)
        }}
        onForgetKey={claudeAccess.forgetKey}
        forgetFailed={claudeAccess.forgetFailed}
      />
    </>
  )
}

export { ChatView }
export type { ChatViewProps }
