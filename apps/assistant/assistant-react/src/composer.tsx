import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { type ComponentProps, type JSX, useId, useState } from 'react'

import styles from './composer.module.css'

/** Props for {@link Composer}: its own, and any other `<form>` prop. */
interface ComposerProps extends Omit<ComponentProps<'form'>, 'children' | 'onSubmit'> {
  /** A reply is streaming in: Send waits, and Stop shows. */
  readonly replying: boolean
  readonly onSend: (text: string) => void
  readonly onStop: () => void
  readonly onNewChat: () => void
}

/**
 * Where the person writes: the message box, then Send (or Stop while a
 * reply streams in) and "New chat". Lines about the chat go above it,
 * never below its buttons.
 */
const Composer = ({
  replying,
  onSend,
  onStop,
  onNewChat,
  className,
  ...rootProps
}: ComposerProps): JSX.Element => {
  const [draft, setDraft] = useState('')
  const messageDomId = useId()
  const sendable = !replying && draft.trim() !== ''
  return (
    <form
      {...rootProps}
      className={cn(styles['composer'], className)}
      onSubmit={(event) => {
        event.preventDefault()
        if (!sendable) return
        onSend(draft)
        setDraft('')
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
