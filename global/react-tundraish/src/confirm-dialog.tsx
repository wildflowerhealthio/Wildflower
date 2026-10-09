import { type JSX, type ReactNode, useState } from 'react'
import { cn } from 'react-kitchen-sink'

import { Dialog } from './dialog.tsx'
import { TextField } from './text-field.tsx'
import styles from './confirm-dialog.module.css'

type ConfirmDialogProps = {
  readonly open: boolean
  readonly title: ReactNode
  /** The question being confirmed, rendered as the dialog's one paragraph. */
  readonly children: ReactNode
  /** The confirm button's label — the action's verb (`Revoke`, `Disable`). */
  readonly confirmLabel: string
  /** Paint the confirm button red, for an action that takes something away. */
  readonly destructive?: boolean
  /**
   * The confirmed action is in flight: the confirm button is disabled until
   * it settles, so a second click can't send it twice. Cancel stays live.
   */
  readonly pending: boolean
  /**
   * Text the user must type to confirm, such as the name of what is deleted:
   * when given, a field under the question asks for it, and the confirm
   * button is disabled until the field holds exactly this text.
   */
  readonly confirmText?: string
  readonly onConfirm: () => void
  /** Cancel, the ×, a backdrop click and ESC all land here. */
  readonly onCancel: () => void
}

/**
 * A yes/no {@link Dialog}: one question, a confirm button, and Cancel. The
 * caller owns `open` and closes it from `onConfirm`'s outcome and `onCancel`.
 *
 * @remarks
 * With `confirmText`, the user types it before confirming; what they typed
 * is cleared whenever the dialog closes, so it is asked for again each time
 * the dialog opens.
 */
const ConfirmDialog = ({
  open,
  title,
  children,
  confirmLabel,
  destructive = false,
  pending,
  confirmText,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): JSX.Element => {
  const [typedText, setTypedText] = useState('')
  const [wasOpen, setWasOpen] = useState(open)
  // Clearing during render, as the dialog closes, rather than in an effect,
  // so a reopened dialog never shows the old text for a frame.
  if (open !== wasOpen) {
    setWasOpen(open)
    if (!open) setTypedText('')
  }
  const typedTextMatches = confirmText === undefined || typedText === confirmText
  return (
    <Dialog open={open} onClose={onCancel} title={title}>
      <p className="text-body-2">{children}</p>
      {confirmText === undefined ? null : (
        <TextField
          label={`Type ${confirmText} to confirm`}
          value={typedText}
          onChange={setTypedText}
          autoCapitalize="none"
          autoComplete="off"
        />
      )}
      <div className={styles['confirm-dialog__buttons']}>
        <button
          type="button"
          className={cn('button-2 filled', { 'accent-red': destructive })}
          disabled={pending || !typedTextMatches}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
        <button type="button" className="button-2 outline" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </Dialog>
  )
}

export { ConfirmDialog, type ConfirmDialogProps }
