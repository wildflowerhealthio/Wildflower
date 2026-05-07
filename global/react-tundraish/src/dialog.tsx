import { cn } from 'kitchen-sink'
import { useLayoutEffect, useRef, type JSX, type ReactNode, type SyntheticEvent } from 'react'

import styles from './dialog.module.css'

type DialogProps = {
  readonly open: boolean
  readonly onClose: () => void
  readonly onCancel?: (event: SyntheticEvent<HTMLDialogElement>) => void
  readonly title?: ReactNode
  readonly children: ReactNode
  readonly className?: string
}

const Dialog = ({
  open,
  onClose,
  onCancel,
  title,
  children,
  className,
}: DialogProps): JSX.Element => {
  const ref = useRef<HTMLDialogElement>(null)
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    const node = ref.current
    if (node === null) return undefined
    if (open && !node.open) {
      previouslyFocusedRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      node.showModal()
    } else if (!open && node.open) {
      node.close()
    }
    return undefined
  }, [open])

  return (
    <dialog
      ref={ref}
      className={cn(styles['dialog'], className)}
      onClose={() => {
        previouslyFocusedRef.current?.focus()
        previouslyFocusedRef.current = null
        onClose()
      }}
      onCancel={onCancel}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          ref.current?.close()
        }
      }}
    >
      {title !== undefined ? (
        <h2 className={cn('text-heading-4', styles['dialog__title'])}>{title}</h2>
      ) : null}
      <div className={styles['dialog__body']}>{children}</div>
    </dialog>
  )
}

export { Dialog, type DialogProps }
