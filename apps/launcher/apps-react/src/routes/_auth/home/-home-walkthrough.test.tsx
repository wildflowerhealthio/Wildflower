import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  readSeenWalkthrough,
  WALKTHROUGH_ANCHOR_ATTRIBUTE,
  writeSeenWalkthrough,
} from '@wildflowerhealthio/walkthrough-core'
import { DateTime, Layer } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { APPS_LIST_QUERY_KEY, type AppRegistration } from '../../../queries.ts'
import type { RunAuthed } from '../../../router-context.ts'
import { routeTree } from '../../../routeTree.gen.ts'
import {
  appTileAnchor,
  LAUNCHER_WALKTHROUGH_ID,
  LAUNCHER_WALKTHROUGH_STEPS,
  LAUNCHER_WALKTHROUGH_VERSION,
  LauncherWalkthroughAnchor,
} from './-home-walkthrough.ts'

beforeEach(() => {
  window.localStorage.clear()
  // jsdom lays nothing out, so every element reads as unrendered, and the
  // walkthrough would drop every step. Give each element a box.
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => {
    const boxes = [DOMRect.fromRect({ x: 0, y: 0, width: 40, height: 20 })]
    return Object.assign(boxes, { item: (index: number) => boxes[index] ?? null })
  })
  // The router restores scroll on navigation, which jsdom doesn't implement.
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
  // driver.js leaves its overlay on `body`, outside what `cleanup` unmounts.
  document.body.innerHTML = ''
})

/** A home-screen app registered as `id`, its tile named `name`. */
const appRegisteredAs = (id: string, name: string): AppRegistration => ({
  id,
  name,
  onHomescreen: true,
  url: `https://example.com/${id}`,
  isSmart: true,
})

/** The four apps the walkthrough points at, and one it doesn't. */
const APPS: readonly AppRegistration[] = [
  appRegisteredAs('plots', 'Plots'),
  appRegisteredAs('strength', 'Wildflower Strength'),
  appRegisteredAs('medications', 'Medications'),
  appRegisteredAs('importer', 'Importer'),
  appRegisteredAs('synthetic-data', 'Synthetic Data Loader'),
]

/**
 * The slice's routes at `path` on a memory history, over a server whose apps
 * list is `apps`; returns the history.
 */
const renderHomeAt = (
  path: string,
  apps: readonly AppRegistration[] = APPS
): ReturnType<typeof createMemoryHistory> => {
  const history = createMemoryHistory({ initialEntries: [path] })
  // Home's only read is the apps list, which its loader finds already read.
  const queryClient = new QueryClient()
  queryClient.setQueryData(APPS_LIST_QUERY_KEY, apps)
  const runAuthed: RunAuthed = () => Promise.reject(new Error('the apps list is already read'))
  const router = createRouter({
    routeTree,
    history,
    context: {
      queryClient,
      runAuthed,
      runtimeLayer: Layer.die('the runtime is not used by the home screen'),
    },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  return history
}

/** The anchors on the page that a step of the launcher's walkthrough points at. */
const anchorsOnPage = (): ReadonlyArray<string> =>
  LAUNCHER_WALKTHROUGH_STEPS.map(({ anchor }) => anchor).filter(
    (anchor) => document.querySelector(`[${WALKTHROUGH_ANCHOR_ATTRIBUTE}="${anchor}"]`) !== null
  )

/**
 * How long a popover may take to show: the walkthrough waits up to two
 * seconds for anchors a home screen without apps never renders.
 */
const POPOVER_TIMEOUT_MS = 3_000

/** The walkthrough's popover while it shows the step titled `title`. */
const findPopover = (title: string): Promise<HTMLElement> =>
  screen.findByRole('dialog', { name: title }, { timeout: POPOVER_TIMEOUT_MS })

/** Keeps a record of the launcher's walkthrough, as a returning visitor has. */
const recordSeen = (): void => {
  writeSeenWalkthrough(window.localStorage, LAUNCHER_WALKTHROUGH_ID, {
    version: LAUNCHER_WALKTHROUGH_VERSION,
    outcome: 'Skipped',
    decidedAt: DateTime.unsafeMake('2026-10-22T12:00:00.000Z'),
  })
}

const recordedOutcome = (): string | undefined =>
  readSeenWalkthrough(window.localStorage, LAUNCHER_WALKTHROUGH_ID, LAUNCHER_WALKTHROUGH_VERSION)
    ?.outcome

const [firstStep] = LAUNCHER_WALKTHROUGH_STEPS
if (firstStep === undefined) {
  throw new Error('the walkthrough has no steps')
}

describe("the launcher's walkthrough", () => {
  it("should find every step's control on a home screen with apps", async () => {
    // Arrange
    recordSeen()

    // Act
    renderHomeAt('/home')
    await screen.findByRole('link', { name: 'Plots' })

    // Assert
    expect(anchorsOnPage()).toStrictEqual(LAUNCHER_WALKTHROUGH_STEPS.map(({ anchor }) => anchor))
  })

  it("should drop the steps of apps that aren't on the home screen", async () => {
    // Arrange
    recordSeen()

    // Act
    renderHomeAt('/home', [appRegisteredAs('plots', 'Plots')])
    await screen.findByRole('link', { name: 'Plots' })

    // Assert
    const missingAnchors = [
      appTileAnchor('synthetic-data'),
      appTileAnchor('importer'),
      appTileAnchor('medications'),
    ]
    expect(anchorsOnPage()).toStrictEqual(
      LAUNCHER_WALKTHROUGH_STEPS.map(({ anchor }) => anchor).filter(
        (anchor) => !missingAnchors.includes(anchor)
      )
    )
    expect(anchorsOnPage()).toContain(appTileAnchor('plots'))
  })

  it('should keep only Settings on a home screen with no apps', async () => {
    // Arrange
    recordSeen()

    // Act
    renderHomeAt('/home', [])
    await screen.findByText(/No apps on your home screen/)

    // Assert
    expect(anchorsOnPage()).toStrictEqual([LauncherWalkthroughAnchor.settings])
  })

  it('should open on a first visit, and stay closed once skipped', async () => {
    // Arrange
    renderHomeAt('/home')

    // Act
    const popover = await findPopover(firstStep.title)
    fireEvent.click(within(popover).getByRole('button', { name: 'Skip' }))

    // Assert
    await waitFor(() => {
      expect(recordedOutcome()).toBe('Skipped')
    })
    expect(screen.queryByRole('dialog', { name: firstStep.title })).toBeNull()
  })

  it('should not open while the home screen is being arranged', async () => {
    // Arrange / Act
    renderHomeAt('/home?edit=true')
    await screen.findByRole('button', { name: 'Done' })

    // Assert: past the walkthrough's longest wait for its anchors.
    await new Promise((resolve) => setTimeout(resolve, 2_200))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(recordedOutcome()).toBeUndefined()
  })

  it("should show again from Settings' Show walkthrough again, and drop the request once done", async () => {
    // Arrange
    recordSeen()

    // Act
    const history = renderHomeAt('/home?walkthrough=show')
    const lastPopover = await LAUNCHER_WALKTHROUGH_STEPS.slice(1).reduce(
      async (shown, { title }) => {
        fireEvent.click(within(await shown).getByRole('button', { name: 'Next' }))
        return findPopover(title)
      },
      findPopover(firstStep.title)
    )
    fireEvent.click(within(lastPopover).getByRole('button', { name: 'Done' }))

    // Assert
    await waitFor(() => {
      expect(recordedOutcome()).toBe('Finished')
    })
    await waitFor(() => {
      expect(history.location.search).toBe('')
    })
    expect(history.location.pathname).toBe('/home')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
