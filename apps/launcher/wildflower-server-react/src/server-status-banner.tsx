import { useMatchRoute } from '@tanstack/react-router'
import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { Array as Arr, Option } from 'effect'
import type { JSX } from 'react'

import { useServerServiceStatus } from './server-service-status-store.ts'
import type { ServerDisplayState } from './server-status-text.ts'
import { serverDisplayState, STOP_REASON_DESCRIPTION } from './server-status-text.ts'
import { useRestartServer } from './use-restart-server.ts'
import styles from './server-status-banner.module.css'

/** The displayed states the banner shows: every one but `running`. */
type BannerState = Exclude<ServerDisplayState, 'running'>

/** The banner's headline for each state it shows. */
const BANNER_TITLE: Readonly<Record<BannerState, string>> = {
  starting: 'Server starting…',
  restarting: 'Server restarting…',
  stopped: 'Server stopped',
}

/**
 * A strip across the top of the app while the Wildflower server isn't running:
 * one row with a status dot, what the server is doing, why it stopped and the
 * error it stopped with, and, for a stop, a Restart button.
 *
 * @remarks
 * Shows no strip before the host's first status snapshot and while the server
 * runs. Starting and restarting are a calm neutral strip with neither a reason
 * nor Restart: the server is already on its way back, and a starting run still
 * carries the previous run's reason (a restart's own `appStop`), which says
 * nothing about this one. The stop half of a restart counts as restarting (see
 * `serverDisplayState`). A stop takes the warning surface; the server page
 * offers Restart in every state.
 *
 * Hidden on `/settings/server` itself, which shows the same status in full
 * with its own Restart. Renders inside the router, as the app shell's
 * `platformBanner`. Only the Tauri entry mounts the banner, since only its
 * host runs the server.
 *
 * Snapshots arrive unprompted, so a visually hidden `status` live region
 * announces the strip's text. It stays mounted while there is no strip, since
 * a region mounted along with its text isn't reliably announced. The strip
 * itself holds no live region, so nothing is announced twice.
 */
const ServerStatusBanner = (): JSX.Element => {
  const status = Option.fromNullable(useServerServiceStatus())
  const restartServer = useRestartServer()
  const isOnServerPage = useMatchRoute()({ to: '/settings/server' }) !== false
  const bannerState = status.pipe(
    Option.filter(() => !isOnServerPage),
    Option.map(serverDisplayState),
    Option.filter((state): state is BannerState => state !== 'running')
  )
  const title = bannerState.pipe(Option.map((state) => BANNER_TITLE[state]))
  const stopped = status.pipe(Option.filter(() => Option.contains(bannerState, 'stopped')))
  const reason = stopped.pipe(
    Option.flatMapNullable((stoppedStatus) => stoppedStatus.stopReason),
    Option.map((stopReason) => STOP_REASON_DESCRIPTION[stopReason])
  )
  const lastError = stopped.pipe(Option.flatMapNullable((stoppedStatus) => stoppedStatus.lastError))
  const announcement = stopped.pipe(
    Option.map(() =>
      Arr.getSomes([Option.some(`${BANNER_TITLE.stopped}.`), reason, lastError]).join(' ')
    ),
    Option.orElse(() => title),
    Option.getOrNull
  )
  return (
    <>
      <p className="sr-only" role="status">
        {announcement}
      </p>
      {title.pipe(
        Option.map((bannerTitle) => (
          <section
            key="banner"
            aria-label="Wildflower server"
            className={cn(
              styles['server-status-banner'],
              stopped.pipe(
                Option.map(() => styles['server-status-banner--stopped']),
                Option.getOrNull
              )
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                styles['server-status-banner__dot'],
                lastError.pipe(
                  Option.map(() => styles['server-status-banner__dot--error']),
                  Option.getOrNull
                )
              )}
            />
            <div className={styles['server-status-banner__text']}>
              <p className={styles['server-status-banner__title']}>{bannerTitle}</p>
              {reason.pipe(
                Option.map((description) => (
                  <p key="reason" className={styles['server-status-banner__detail']}>
                    {description}
                  </p>
                )),
                Option.getOrNull
              )}
              {lastError.pipe(
                Option.map((error) => (
                  <p key="error" className={styles['server-status-banner__error']}>
                    {error}
                  </p>
                )),
                Option.getOrNull
              )}
            </div>
            {stopped.pipe(
              Option.map(() => (
                <button
                  key="restart"
                  type="button"
                  className={cn('button-3 outline', styles['server-status-banner__action'])}
                  onClick={restartServer}
                >
                  Restart
                </button>
              )),
              Option.getOrNull
            )}
          </section>
        )),
        Option.getOrNull
      )}
    </>
  )
}

export { ServerStatusBanner }
