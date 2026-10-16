import { Link, Outlet, useLoaderData, useRouterState } from '@tanstack/react-router'
import { isBaseScreen } from '@wildflowerhealthio/servers-react'
import { Option } from 'effect'
import { useState, type JSX } from 'react'

import { RecorderSession } from './recorder-session.tsx'
import styles from './host-shell.module.css'

/**
 * The path of the base's screen the router has matched, a match marked as
 * one in its route's `staticData` (`isBaseScreen`), or none when the
 * location is the Recorder's or no route's.
 */
const useBasePathname = (): Option.Option<string> =>
  Option.fromNullable(
    useRouterState({
      select: ({ matches }) =>
        matches.some(({ staticData }) => isBaseScreen(staticData))
          ? matches.at(-1)?.pathname
          : undefined,
    })
  )

/**
 * Where the Servers link goes: the base's screen while it shows, or else its
 * last, `/servers` until the base has had one, so coming back finds the base
 * where it was left.
 */
const useServersPath = (basePathname: Option.Option<string>): string => {
  const [lastBasePathname, setLastBasePathname] = useState('/servers')
  const serversPath = Option.getOrElse(basePathname, () => lastBasePathname)
  if (serversPath !== lastBasePathname) setLastBasePathname(serversPath)
  return serversPath
}

/**
 * The host's layout, the root route's component: a bar of two links,
 * Servers (the base's routes) and Recorder (`/recorder`), over the matched
 * route, or the not-found page.
 *
 * @remarks
 * **The router marks the current link.** Each is a TanStack `<Link>`, which
 * sets `aria-current="page"` on the one whose path is the location's; neither
 * is current on the not-found page. The Servers link goes to the base's last
 * location rather than `/servers`.
 *
 * **A recording outlives the Recorder route.** `RecorderSession` runs it
 * around every route, so it keeps going while the base shows.
 */
function HostShell(): JSX.Element {
  const recorderConnection = useLoaderData({ from: '__root__' })
  const basePathname = useBasePathname()
  const serversPath = useServersPath(basePathname)
  const linkClassName = `text-label-2 ${styles['host-shell__link']}`
  const activeProps = { className: styles['host-shell__link--current'] }
  return (
    <RecorderSession connection={recorderConnection}>
      <div className={styles['host-shell']}>
        <nav className={styles['host-shell__nav']} aria-label="Wildflower Host">
          <Link
            to={serversPath}
            activeOptions={{ exact: true }}
            className={linkClassName}
            activeProps={activeProps}
          >
            Servers
          </Link>
          <Link to="/recorder" className={linkClassName} activeProps={activeProps}>
            Recorder
          </Link>
        </nav>
        <div className={styles['host-shell__page']}>
          <Outlet />
        </div>
      </div>
    </RecorderSession>
  )
}

export { HostShell }
