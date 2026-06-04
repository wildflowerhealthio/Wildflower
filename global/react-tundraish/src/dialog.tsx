import { useLayoutEffect, useRef, type JSX, type ReactNode, type SyntheticEvent } from 'react'
import { cn } from 'react-kitchen-sink'

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
      <header className={styles['dialog__header']}>
        <h2 className="text-heading-4">{title}</h2>
        <button
          type="button"
          className={styles['dialog__close']}
          onClick={() => ref.current?.close()}
        >
          &#215;
        </button>
      </header>
      <div className={styles['dialog__body']}>{children}</div>
    </dialog>
  )
}

export { Dialog, type DialogProps }
