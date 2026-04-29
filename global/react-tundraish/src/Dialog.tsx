import { useEffect, useRef, type JSX, type ReactNode } from 'react'

type DialogProps = {
  readonly open: boolean
  readonly onClose: () => void
  readonly title?: ReactNode
  readonly children: ReactNode
  readonly className?: string
}

const Dialog = ({ open, onClose, title, children, className }: DialogProps): JSX.Element => {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const node = ref.current
    if (node === null) return
    if (open && !node.open) {
      node.showModal()
    } else if (!open && node.open) {
      node.close()
    }
  }, [open])

  const classes = ['dialog', className].filter((c) => c !== undefined).join(' ')

  return (
    <dialog
      ref={ref}
      className={classes}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      {title !== undefined ? <h2 className="text-heading-4 dialog__title">{title}</h2> : null}
      <div className="dialog__body">{children}</div>
    </dialog>
  )
}

export { Dialog, type DialogProps }
