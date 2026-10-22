import { useNavigate, useSearch } from '@tanstack/react-router'
import type { WalkthroughStep } from '@wildflowerhealthio/walkthrough-core'
import { useWalkthrough, type WalkthroughPrompt } from '@wildflowerhealthio/walkthrough-react'
import { Schema } from 'effect'

/** The launcher's walkthrough's id, naming its record in the page's `localStorage`. */
const LAUNCHER_WALKTHROUGH_ID = 'launcher'

/** The version of {@link LAUNCHER_WALKTHROUGH_STEPS}; raising it shows the walkthrough again. */
const LAUNCHER_WALKTHROUGH_VERSION = 1

/** The `data-walkthrough` values of the home screen's controls the walkthrough points at. */
const LauncherWalkthroughAnchor = {
  appTiles: 'app-tiles',
  appTile: 'app-tile',
  settings: 'settings',
} as const

/**
 * The launcher's walkthrough, in page order. With no apps on the home screen,
 * only the Settings gear is on the page, so only its step shows.
 */
const LAUNCHER_WALKTHROUGH_STEPS: ReadonlyArray<WalkthroughStep> = [
  {
    anchor: LauncherWalkthroughAnchor.appTiles,
    title: 'Apps',
    body: 'These are the apps on your home screen. Select a tile to open its app.',
  },
  {
    anchor: LauncherWalkthroughAnchor.appTile,
    title: 'Choosing a Patient',
    body: "Wildflower Authorization may ask you to approve an app before it opens. For an app that works with one patient's records, you choose the patient there.",
  },
  {
    anchor: LauncherWalkthroughAnchor.appTiles,
    title: 'Arrange home screen',
    body: 'In Settings, Arrange home screen lets you drag these tiles into a new order, or hide them.',
  },
  {
    anchor: LauncherWalkthroughAnchor.settings,
    title: 'Settings',
    body: 'Apps, Your data, Requests and Manage access are here, and Show walkthrough again brings these steps back.',
  },
]

/**
 * The home screen's `walkthrough` search value: `show` is Settings' Show
 * walkthrough again, which shows the walkthrough whatever its record says.
 */
const ShowWalkthroughAgain = Schema.Literal('show')

/** The home screen's search that shows the walkthrough again. */
const SHOW_WALKTHROUGH_AGAIN_SEARCH: { readonly walkthrough: typeof ShowWalkthroughAgain.Type } = {
  walkthrough: 'show',
}

/**
 * Whether the home screen shows the launcher's walkthrough, kept in the page's
 * `localStorage`, and how the visitor leaves it.
 *
 * @remarks
 * It shows on a first visit, while no record for {@link LAUNCHER_WALKTHROUGH_VERSION}
 * is kept, and whenever the home screen's search asks for it. Finishing,
 * skipping, or the walkthrough finding nothing to point at drops that search,
 * replacing the history entry, so Back doesn't show it again and the
 * walkthrough isn't held open.
 */
const useHomeWalkthrough = (): Pick<WalkthroughPrompt, 'open' | 'finish' | 'skip' | 'postpone'> => {
  const prompt = useWalkthrough({
    storage: window.localStorage,
    id: LAUNCHER_WALKTHROUGH_ID,
    version: LAUNCHER_WALKTHROUGH_VERSION,
  })
  const showAgain = useSearch({ from: '/_auth/home/', select: (search) => search.walkthrough })
  const navigate = useNavigate({ from: '/home/' })
  const dropShowAgain = (): void => {
    if (showAgain === undefined) return
    void navigate({
      search: (previous) => ({ ...previous, walkthrough: undefined }),
      replace: true,
    })
  }
  return {
    open: prompt.open || showAgain !== undefined,
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
  LAUNCHER_WALKTHROUGH_ID,
  LAUNCHER_WALKTHROUGH_STEPS,
  LAUNCHER_WALKTHROUGH_VERSION,
  LauncherWalkthroughAnchor,
  SHOW_WALKTHROUGH_AGAIN_SEARCH,
  ShowWalkthroughAgain,
  useHomeWalkthrough,
}
