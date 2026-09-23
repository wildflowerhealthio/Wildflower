import type { JSX } from 'react'
import { Dialog } from 'react-tundraish'

import pageLayout from '../styles/page-layout.module.css'

interface DisableClientDialogProps {
  /** The app's display name; the dialog is open iff this is non-null. */
  readonly clientName: string | null
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

/** Confirm-disable modal for a trusted app. Open iff `clientName !== null`. */
const DisableClientDialog = ({
  clientName,
  onConfirm,
  onCancel,
}: DisableClientDialogProps): JSX.Element => (
  <Dialog open={clientName !== null} onClose={onCancel} title="Disable App">
    <p className="text-body-2">
      Disable &quot;{clientName ?? ''}&quot;? It won&apos;t be able to sign in or refresh its access
      until you enable it again.
    </p>
    <div className={pageLayout['buttons']}>
      <button type="button" className="button-2 filled accent-red" onClick={onConfirm}>
        Disable
      </button>
      <button type="button" className="button-2 outline" onClick={onCancel}>
        Cancel
      </button>
    </div>
  </Dialog>
)

export { DisableClientDialog }
export type { DisableClientDialogProps }
