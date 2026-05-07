import type { JSX } from 'react'
import { Dialog } from 'react-tundraish'

interface RevokeGrantDialogProps {
  readonly clientId: string | null
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

/**
 * Confirm-revoke modal lifted out of the access index so the
 * top-level screen reads as a list of `Section`s. The dialog is open
 * iff `clientId !== null` — passing `null` from the parent dismisses
 * it without an extra `open` prop.
 */
const RevokeGrantDialog = ({
  clientId,
  onConfirm,
  onCancel,
}: RevokeGrantDialogProps): JSX.Element => (
  <Dialog open={clientId !== null} onClose={onCancel} title="Revoke Access">
    <p className="text-body-2">
      Are you sure you want to revoke access for &quot;{clientId ?? ''}&quot;?
    </p>
    <div className="gk-buttons">
      <button type="button" className="button-2 filled accent-red" onClick={onConfirm}>
        Revoke
      </button>
      <button type="button" className="button-2 outline" onClick={onCancel}>
        Cancel
      </button>
    </div>
  </Dialog>
)

export { RevokeGrantDialog }
export type { RevokeGrantDialogProps }
