import {
  useId,
  useLayoutEffect,
  useRef,
  type JSX,
  type ReactNode,
  type SyntheticEvent,
} from 'react'
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
   * Whether the user may dismiss the dialog without an explicit
   * action. Defaults to `true` (regular dialog behaviour: backdrop
   * click closes, the × button is shown, the native `cancel` event —
   * including ESC — closes the dialog).
   *
   * `false` is for blocking flows where the host needs an answer
   * before the user can move on (the telemetry consent dialog in
   * particular). The × button is hidden, backdrop clicks are ignored,
   * the element carries `closedby="none"` so ESC is not a close
   * request, `cancel` is `preventDefault`'d, and `onCancel` is *not*
   * invoked — a non-dismissable dialog has nothing meaningful to do on
   * cancel, so forwarding the event would invite consumers to wire
   * deny/close logic into it accidentally. If the browser closes the
   * dialog anyway while `open` is still `true` (Chrome does on a second
   * ESC where `closedby` is unsupported), it is shown again and
   * `onClose` is not called: only the consumer setting `open` to
   * `false` closes it.
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
  const titleId = useId()
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
      aria-labelledby={title === undefined ? undefined : titleId}
      closedby={dismissable ? undefined : 'none'}
      onClose={() => {
        // A blocking dialog the browser closed on its own, while the
        // consumer still holds it open: show it again, as if nothing
        // happened. `open` here is this render's prop, so a close the
        // consumer asked for (`open` now false) passes through.
        if (!dismissable && open) {
          if (ref.current?.open === false) ref.current.showModal()
          return
        }
        previouslyFocusedRef.current?.focus()
        previouslyFocusedRef.current = null
        onClose()
      }}
      onCancel={(event) => {
        // ESC / native cancel: blocking dialogs swallow it; regular
        // dialogs forward it to the consumer (which typically closes).
        if (!dismissable) {
          event.preventDefault()
          return
        }
        onCancel?.(event)
      }}
      onClick={(event) => {
        // Backdrop click closes only when dismissable; the × button
        // (when shown) routes here via its own `close()` call.
        if (dismissable && event.target === event.currentTarget) {
          ref.current?.close()
        }
      }}
    >
      <header className={styles['dialog__header']}>
        <h2 id={titleId} className={cn('text-heading-4', styles['dialog__title'])}>
          {title}
        </h2>
        {dismissable ? (
          <button
            type="button"
            aria-label="Close"
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
