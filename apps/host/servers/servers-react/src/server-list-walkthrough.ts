import { useNavigate, useSearch } from '@tanstack/react-router'
import type { WalkthroughStep } from '@wildflowerhealthio/walkthrough-core'
import { useWalkthrough, type WalkthroughPrompt } from '@wildflowerhealthio/walkthrough-react'
import { Schema } from 'effect'

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
 * One of the server list's walkthroughs: its steps, the id naming its record
 * in the webview's `localStorage`, and the version of its steps, which,
 * raised, shows it again.
 */
interface HostWalkthrough {
  readonly id: string
  readonly version: number
  readonly steps: ReadonlyArray<WalkthroughStep>
}

/** The Host Settings step, last in both walkthroughs. */
const HOST_SETTINGS_STEP: WalkthroughStep = {
  anchor: HostWalkthroughAnchor.hostSettings,
  title: 'Host Settings',
  body: 'Notifications, Telemetry and Legal are here, and Show walkthrough again brings these steps back.',
}

/**
 * The walkthrough for a list with no servers, where only Add new server and
 * Host Settings are on the page.
 */
const NO_SERVERS_WALKTHROUGH: HostWalkthrough = {
  id: 'host-no-servers',
  version: 1,
  steps: [
    {
      anchor: HostWalkthroughAnchor.addServer,
      title: 'Add new server',
      body: 'A server keeps your health records on this device. You can add more than one.',
    },
    HOST_SETTINGS_STEP,
  ],
}

/**
 * The walkthrough for a list with servers, in page order. It has its own
 * record, so a visitor who went through {@link NO_SERVERS_WALKTHROUGH} sees it
 * once their first server is on the list.
 */
const SERVERS_WALKTHROUGH: HostWalkthrough = {
  id: 'host-servers',
  version: 1,
  steps: [
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
      body: 'You can add more than one server, each keeping its own health records on this device.',
    },
    HOST_SETTINGS_STEP,
  ],
}

/** The server list's walkthrough for a list of `serverCount` servers. */
const hostWalkthroughFor = (serverCount: number): HostWalkthrough =>
  serverCount === 0 ? NO_SERVERS_WALKTHROUGH : SERVERS_WALKTHROUGH

/**
 * The server list's search: `walkthrough=show` is Host Settings' Show
 * walkthrough again, which shows the walkthrough whatever its record says.
 */
const ServerListSearch = Schema.Struct({ walkthrough: Schema.optional(Schema.Literal('show')) })
type ServerListSearch = typeof ServerListSearch.Type

/** The server list's search that shows the walkthrough again. */
const SHOW_WALKTHROUGH_AGAIN_SEARCH: ServerListSearch = { walkthrough: 'show' }

/**
 * Whether the server list shows `walkthrough`, kept in the webview's
 * `localStorage`, and how the visitor leaves it.
 *
 * @remarks
 * It shows while no record for the walkthrough's version is kept, and
 * whenever the list's search asks for it. Finishing or skipping
 * records the outcome, and postponing (no step's control on the page) records
 * nothing; each drops that search, replacing the history entry, so Back
 * doesn't show it again.
 */
const useServerListWalkthrough = (
  walkthrough: HostWalkthrough
): Pick<WalkthroughPrompt, 'open' | 'finish' | 'skip' | 'postpone'> => {
  const prompt = useWalkthrough({
    storage: window.localStorage,
    id: walkthrough.id,
    version: walkthrough.version,
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
  hostWalkthroughFor,
  HostWalkthroughAnchor,
  NO_SERVERS_WALKTHROUGH,
  SERVERS_WALKTHROUGH,
  ServerListSearch,
  SHOW_WALKTHROUGH_AGAIN_SEARCH,
  useServerListWalkthrough,
}
export type { HostWalkthrough }
