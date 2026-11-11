import { Dialog, ErrorBanner } from '@wildflowerhealthio/react-tundraish'
import type { JSX } from 'react'

import styles from './settings-dialog.module.css'

/** Props for {@link SettingsDialog}. */
interface SettingsDialogProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly onForgetKey: () => void
  /** The browser refused to remove the key last time. */
  readonly forgetFailed: boolean
}

/** Assistant's settings: where the key is kept, and "Forget key". */
const SettingsDialog = ({
  open,
  onClose,
  onForgetKey,
  forgetFailed,
}: SettingsDialogProps): JSX.Element => (
  <Dialog open={open} onClose={onClose} title="Settings">
    <div className={styles['settings-dialog']}>
      <p className="text-body-2">
        Your Claude API key is kept in this browser, and only sent to Anthropic. Forget it to remove
        it from this browser.
      </p>
      {forgetFailed ? <ErrorBanner error="This browser wouldn't remove the key." /> : null}
      <button type="button" className="button-2 outline accent-red" onClick={onForgetKey}>
        Forget key
      </button>
    </div>
  </Dialog>
)

export { SettingsDialog }
export type { SettingsDialogProps }
