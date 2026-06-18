import { useState } from 'react'
import { Dialog } from 'react-tundraish'

/**
 * A confirm dialog, open on mount — the canonical destructive-action prompt
 * (collector "Delete Account"). `Dialog` renders a native `<dialog>` via
 * `showModal()`, so the preview holds `open` true to show the modal surface a
 * static cell would otherwise miss. Dismissable: the × button shows, backdrop
 * clicks and ESC close it.
 */
export const Confirm = () => {
  const [open, setOpen] = useState(true)
  return (
    <div style={{ minHeight: 240 }}>
      <Dialog open={open} onClose={() => setOpen(false)} title="Delete Account">
        <p className="text-body-2">Are you sure you want to delete &quot;Demo FHIR Server&quot;?</p>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button type="button" className="button-2 filled accent-red" onClick={() => setOpen(false)}>
            Delete
          </button>
          <button type="button" className="button-2 outline" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      </Dialog>
    </div>
  )
}

/**
 * The blocking variant (`dismissable={false}`) — no × button, backdrop clicks
 * and ESC are swallowed; the host needs an explicit answer before the user can
 * move on (gatekeeper device-authorization consent).
 */
export const Blocking = () => (
  <div style={{ minHeight: 240 }}>
    <Dialog open dismissable={false} onClose={() => {}} title="Device Authorization">
      <p className="text-body-2">
        A device is requesting access with code <code>WDJB-MJHT</code>. Approve only if you started
        this sign-in.
      </p>
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button type="button" className="button-2 filled">
          Approve
        </button>
        <button type="button" className="button-2 outline">
          Deny
        </button>
      </div>
    </Dialog>
  </div>
)
