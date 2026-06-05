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
  /**
   * Whether the user can dismiss the dialog themselves. When `true`
   * (default) the close (×) button, backdrop click, and ESC key all
   * close it. When `false` none of those do — the × button is hidden,
   * backdrop clicks are ignored, and the native `cancel` event (ESC) is
   * `preventDefault`-ed. Use for modals whose lifetime the *host* owns:
   * e.g. the device-consent popup, which stays up until the request is
   * approved, denied, expires, or is superseded. The `open` prop is
   * still the source of truth, so a non-dismissable dialog closes when
   * its owner flips `open` to `false`.
   */
  readonly dismissable?: boolean
}

const Dialog = ({
  open,
  onClose,
  onCancel,
  title,
  children,
  className,
  dismissable = true,
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
      onCancel={(event) => {
        // ESC dispatches `cancel` before `close`; preventing the default
        // here keeps a non-dismissable dialog open. Otherwise forward to
        // the caller's handler.
        if (!dismissable) {
          event.preventDefault()
          return
        }
        onCancel?.(event)
      }}
      onClick={(event) => {
        if (dismissable && event.target === event.currentTarget) {
          ref.current?.close()
        }
      }}
    >
      <header className={styles['dialog__header']}>
        <h2 className="text-heading-4">{title}</h2>
        {dismissable ? (
          <button
            type="button"
            className={styles['dialog__close']}
            onClick={() => ref.current?.close()}
          >
            &#215;
          </button>
        ) : null}
      </header>
      <div className={styles['dialog__body']}>{children}</div>
    </dialog>
  )
}

export { Dialog, type DialogProps }
