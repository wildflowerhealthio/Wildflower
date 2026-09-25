import type { JSX, ReactNode } from 'react'
import { cn } from 'react-kitchen-sink'

import { Dialog } from './dialog.tsx'
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
  readonly onConfirm: () => void
  /** Cancel, the ×, a backdrop click and ESC all land here. */
  readonly onCancel: () => void
}

/**
 * A yes/no {@link Dialog}: one question, a confirm button, and Cancel. The
 * caller owns `open` and closes it from `onConfirm`'s outcome and `onCancel`.
 */
const ConfirmDialog = ({
  open,
  title,
  children,
  confirmLabel,
  destructive = false,
  pending,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): JSX.Element => (
  <Dialog open={open} onClose={onCancel} title={title}>
    <p className="text-body-2">{children}</p>
    <div className={styles['confirm-dialog__buttons']}>
      <button
        type="button"
        className={cn('button-2 filled', { 'accent-red': destructive })}
        disabled={pending}
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

export { ConfirmDialog, type ConfirmDialogProps }
