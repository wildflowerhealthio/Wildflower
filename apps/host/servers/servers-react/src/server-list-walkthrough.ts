import { useNavigate, useSearch } from '@tanstack/react-router'
import type { WalkthroughStep } from '@wildflowerhealthio/walkthrough-core'
import { useWalkthrough, type WalkthroughPrompt } from '@wildflowerhealthio/walkthrough-react'
import { Schema } from 'effect'

/** The Host's walkthrough's id, naming its record in the webview's `localStorage`. */
const HOST_WALKTHROUGH_ID = 'host'

/** The version of {@link HOST_WALKTHROUGH_STEPS}; raising it shows the walkthrough again. */
const HOST_WALKTHROUGH_VERSION = 1

/** The `data-walkthrough` values of the server list's controls the walkthrough points at. */
const HostWalkthroughAnchor = {
  serverCard: 'server-card',
  runPolicy: 'run-policy',
  apps: 'apps',
  authorization: 'authorization',
  addServer: 'add-server',
  hostSettings: 'host-settings',
} as const

/**
 * The Host's walkthrough, in page order. With no servers, only Add new server
 * and Host Settings are on the page, so only their steps show.
 */
const HOST_WALKTHROUGH_STEPS: ReadonlyArray<WalkthroughStep> = [
  {
    anchor: HostWalkthroughAnchor.serverCard,
    title: 'Your Server',
    body: "Each server on this device has a card, headed by its address. The dot beside it shows the server's status.",
  },
  {
    anchor: HostWalkthroughAnchor.runPolicy,
    title: 'When It Runs',
    body: 'This says when the server runs. Select it to choose Off, While Wildflower is open, a set time, or Always.',
  },
  {
    anchor: HostWalkthroughAnchor.apps,
    title: 'Apps',
    body: "Open this server's app launcher, where you pick an app to open.",
  },
  {
    anchor: HostWalkthroughAnchor.authorization,
    title: 'Authorization',
    body: "Open this server's Authorization app. It lists the apps and devices with access to this server.",
  },
  {
    anchor: HostWalkthroughAnchor.addServer,
    title: 'Add new server',
    body: 'A server keeps your health records on this device. You can add more than one.',
  },
  {
    anchor: HostWalkthroughAnchor.hostSettings,
    title: 'Host Settings',
    body: 'Notifications, Telemetry and Legal are here, and Show walkthrough again brings these steps back.',
  },
]

/**
 * The server list's search: `walkthrough=show` is Host Settings' Show
 * walkthrough again, which shows the walkthrough whatever its record says.
 */
const ServerListSearch = Schema.Struct({ walkthrough: Schema.optional(Schema.Literal('show')) })
type ServerListSearch = typeof ServerListSearch.Type

/** The server list's search that shows the walkthrough again. */
const SHOW_WALKTHROUGH_AGAIN_SEARCH: ServerListSearch = { walkthrough: 'show' }

/**
 * Whether the server list shows the Host's walkthrough, kept in the webview's
 * `localStorage`, and how the visitor leaves it.
 *
 * @remarks
 * It shows on a first visit, while no record for {@link HOST_WALKTHROUGH_VERSION}
 * is kept, and whenever the list's search asks for it. Finishing or skipping
 * records the outcome, and postponing (no step's control on the page) records
 * nothing; each drops that search, replacing the history entry, so Back
 * doesn't show it again.
 */
const useServerListWalkthrough = (): Pick<
  WalkthroughPrompt,
  'open' | 'finish' | 'skip' | 'postpone'
> => {
  const prompt = useWalkthrough({
    storage: window.localStorage,
    id: HOST_WALKTHROUGH_ID,
    version: HOST_WALKTHROUGH_VERSION,
  })
  const showAgain = useSearch({ from: '/servers/', select: (search) => search.walkthrough })
  const navigate = useNavigate()
  const dropShowAgain = (): void => {
    if (showAgain === undefined) return
    void navigate({ to: '/servers', search: {}, replace: true })
  }
  return {
    open: prompt.open || showAgain === 'show',
    finish: () => {
      prompt.finish()
      dropShowAgain()
    },
    skip: () => {
      prompt.skip()
      dropShowAgain()
    },
    postpone: () => {
      prompt.postpone()
      dropShowAgain()
    },
  }
}

export {
  HOST_WALKTHROUGH_ID,
  HOST_WALKTHROUGH_STEPS,
  HOST_WALKTHROUGH_VERSION,
  HostWalkthroughAnchor,
  ServerListSearch,
  SHOW_WALKTHROUGH_AGAIN_SEARCH,
  useServerListWalkthrough,
}
