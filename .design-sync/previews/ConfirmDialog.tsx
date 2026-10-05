import { useState } from 'react'
import { ConfirmDialog } from 'react-tundraish'

/**
 * The destructive confirm (gatekeeper "Disable App"), open on mount — the
 * dialog is a native `<dialog>` shown via `showModal()`, so the cell holds
 * `open` true. `destructive` paints the confirm button red.
 */
export const Destructive = () => {
  const [open, setOpen] = useState(true)
  return (
    <div style={{ minHeight: 240 }}>
      <ConfirmDialog
        open={open}
        title="Disable App"
        confirmLabel="Disable"
        destructive
        pending={false}
        onConfirm={() => setOpen(false)}
        onCancel={() => setOpen(false)}
      >
        Disable &quot;Medications Viewer&quot;? It will stop being able to sign in until you re-enable it.
      </ConfirmDialog>
    </div>
  )
}

/** A non-destructive confirm with the action in flight — confirm disabled, Cancel live. */
export const Pending = () => (
  <div style={{ minHeight: 240 }}>
    <ConfirmDialog
      open
      title="Enable Tunnel"
      confirmLabel="Enable"
      pending
      onConfirm={() => {}}
      onCancel={() => {}}
    >
      Expose this server through the relay so your other devices can reach it?
    </ConfirmDialog>
  </div>
)
