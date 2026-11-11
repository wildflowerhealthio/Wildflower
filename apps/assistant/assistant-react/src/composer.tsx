import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { type ComponentProps, type JSX, useId, useState } from 'react'

import styles from './composer.module.css'

/** Props for {@link Composer}: its own, and any other `<form>` prop. */
interface ComposerProps extends Omit<ComponentProps<'form'>, 'children' | 'onSubmit'> {
  /** A turn is running: Send waits, and Stop shows. */
  readonly replying: boolean
  /** Nothing can be written: a change Claude proposed waits on the person's decision. Stop stays. */
  readonly messageDisabled: boolean
  /**
   * Send the draft. The message box and Send are locked until it settles;
   * the draft is cleared once it resolves and kept when it rejects.
   */
  readonly onSend: (text: string) => Promise<void>
  readonly onStop: () => void
  readonly onNewChat: () => void
}

/**
 * Where the person writes: the message box (disabled while Claude's
 * proposed changes wait on the person, and while a message is being sent),
 * then Send (or Stop while a turn runs) and "New chat". Lines about the
 * chat go above it, never below its buttons.
 */
const Composer = ({
  replying,
  messageDisabled,
  onSend,
  onStop,
  onNewChat,
  className,
  ...rootProps
}: ComposerProps): JSX.Element => {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const messageDomId = useId()
  const sendable = !replying && !sending && draft.trim() !== ''
  return (
    <form
      {...rootProps}
      className={cn(styles['composer'], className)}
      onSubmit={(event) => {
        event.preventDefault()
        if (!sendable) return
        setSending(true)
        onSend(draft).then(
          () => {
            setDraft('')
            setSending(false)
          },
          () => {
            setSending(false)
          }
        )
      }}
    >
      <label htmlFor={messageDomId} className="sr-only">
        Message
      </label>
      <textarea
        id={messageDomId}
        className={cn('input-3', styles['composer__message'])}
        rows={3}
        value={draft}
        disabled={messageDisabled || sending}
        placeholder="Ask Claude"
        onChange={(event) => {
          setDraft(event.currentTarget.value)
        }}
      />
      <div className={styles['composer__buttons']}>
        {replying ? (
          <button type="button" className="button-2 filled" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="button-2 filled" disabled={!sendable}>
            Send
          </button>
        )}
        <button type="button" className="button-2 outline" onClick={onNewChat}>
          New chat
        </button>
      </div>
    </form>
  )
}

export { Composer }
export type { ComposerProps }
