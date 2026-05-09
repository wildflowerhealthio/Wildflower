import type { JSX } from 'react'
import { Dialog } from 'react-tundraish'

import pageLayout from '../styles/page-layout.module.css'

interface RevokeGrantDialogProps {
  readonly clientId: string | null
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

/** Confirm-revoke modal. Open iff `clientId !== null`. */
const RevokeGrantDialog = ({
  clientId,
  onConfirm,
  onCancel,
}: RevokeGrantDialogProps): JSX.Element => (
  <Dialog open={clientId !== null} onClose={onCancel} title="Revoke Access">
    <p className="text-body-2">
      Are you sure you want to revoke access for &quot;{clientId ?? ''}&quot;?
    </p>
    <div className={pageLayout['buttons']}>
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
