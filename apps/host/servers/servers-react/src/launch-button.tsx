import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { ConfirmDialog } from '@wildflowerhealthio/react-tundraish'
import type { JSX } from 'react'

import type { Launch } from './launch.ts'
import styles from './launch-button.module.css'

/**
 * A server's card's Launch, labelled Apps, as {@link Launch} (`useLaunch`)
 * says it stands: Apps, or Starting… with Cancel while a start-and-launch is
 * under way, and "Start server and launch?" when it asks. The caller shows
 * `launch.reason`, and passes its element's id, or the status's while Launch
 * is disabled for what the status shows, as `describedBy`.
 */
const LaunchButton = ({
  launch,
  domain,
  className,
  describedBy,
}: {
  readonly launch: Launch
  /** The server's domain, which the start question names. */
  readonly domain: string
  /** Sizes the button's block in its parent's layout. */
  readonly className?: string
  /** The id of the element saying why Launch is disabled, while it is. */
  readonly describedBy?: string
}): JSX.Element => (
  <div className={cn(styles['launch-button'], className)}>
    {launch.starting ? (
      <>
        <button
          type="button"
          className={`button-2 filled ${styles['launch-button__launch']}`}
          disabled
          aria-describedby={describedBy}
        >
          Starting…
        </button>
        <button type="button" className="button-2 outline" onClick={launch.cancelWait}>
          Cancel
        </button>
      </>
    ) : (
      <button
        type="button"
        className={`button-2 filled ${styles['launch-button__launch']}`}
        disabled={launch.disabled || launch.isLaunching}
        aria-describedby={describedBy}
        title="Open this server's app launcher"
        onClick={launch.launch}
      >
        Apps
      </button>
    )}
    <ConfirmDialog
      open={launch.confirmingStart}
      title="Start server and launch?"
      confirmLabel="Start and launch"
      pending={launch.isSettingStart}
      onConfirm={launch.confirmStart}
      onCancel={launch.cancelStart}
    >
      {domain} isn't running. Starting it runs it while Wildflower is open; it launches once it can
      be reached.
    </ConfirmDialog>
  </div>
)

export { LaunchButton }
