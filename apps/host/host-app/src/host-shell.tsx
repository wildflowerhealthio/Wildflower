import {
  Link,
  Outlet,
  useLoaderData,
  useNavigate,
  useRouteContext,
  useRouterState,
} from '@tanstack/react-router'
import { PendingConsent } from '@wildflowerhealthio/servers-core-js'
import { Either, Option } from 'effect'
import { useEffect, useEffectEvent, useState, type JSX } from 'react'

import { RecorderSession } from './recorder-session.tsx'
import styles from './host-shell.module.css'

/** The id of the layout route the base's screens render under. */
const BASE_LAYOUT_ID = '/_servers'

/**
 * The path of the base's screen the router has matched, or none when the
 * location is the Recorder's or no route's.
 */
const useBasePathname = (): Option.Option<string> =>
  Option.fromNullable(
    useRouterState({
      select: ({ matches }) =>
        matches.some(({ routeId }) => routeId === BASE_LAYOUT_ID)
          ? matches.at(-1)?.pathname
          : undefined,
    })
  )

/**
 * Where the Servers link goes: the base's screen while it shows, or else its
 * last, `/` until the base has had one, so coming back finds the base where it
 * was left.
 */
const useServersPath = (basePathname: Option.Option<string>): string => {
  const [lastBasePathname, setLastBasePathname] = useState('/')
  const serversPath = Option.getOrElse(basePathname, () => lastBasePathname)
  if (serversPath !== lastBasePathname) setLastBasePathname(serversPath)
  return serversPath
}

/**
 * Navigate to `serversPath` whenever a consent comes to wait on a server
 * while the base isn't showing, so the base's consent sheet is on screen to
 * answer.
 */
const useServersForPendingConsents = (onBase: boolean, serversPath: string): void => {
  const listen = useRouteContext({
    from: '__root__',
    select: (context) => context.listenToHostEvent,
  })
  const navigate = useNavigate()
  const showServers = useEffectEvent(() => {
    if (!onBase) void navigate({ to: serversPath })
  })
  useEffect(() => {
    let unmounted = false
    let stopListening: (() => void) | undefined
    void listen(PendingConsent.EVENT, ({ payload }) => {
      Either.map(PendingConsent.decodeEvent(payload), ({ head }) => {
        if (Option.isSome(head)) showServers()
      })
    }).then((stop) => {
      if (unmounted) {
        stop()
        return
      }
      stopListening = stop
    })
    return () => {
      unmounted = true
      stopListening?.()
    }
  }, [listen])
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
 * location rather than `/`.
 *
 * **A recording outlives the Recorder route.** `RecorderSession` runs it
 * around every route, so it keeps going while the base shows.
 *
 * **A consent navigates to the base.** The base's consent sheet is in its
 * layout, so when the host emits a consent waiting on a server while the base
 * isn't showing, the shell navigates to the Servers link's location.
 */
function HostShell(): JSX.Element {
  const recorderConnection = useLoaderData({ from: '__root__' })
  const basePathname = useBasePathname()
  const serversPath = useServersPath(basePathname)
  useServersForPendingConsents(Option.isSome(basePathname), serversPath)
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
