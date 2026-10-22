import { createMemoryHistory } from '@tanstack/react-router'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  readSeenWalkthrough,
  WALKTHROUGH_ANCHOR_ATTRIBUTE,
  writeSeenWalkthrough,
} from '@wildflowerhealthio/walkthrough-core'
import { DateTime } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import golden from '../../servers-wire-golden.json' with { type: 'json' }
import {
  HOST_WALKTHROUGH_ID,
  HOST_WALKTHROUGH_STEPS,
  HOST_WALKTHROUGH_VERSION,
  HostWalkthroughAnchor,
} from './server-list-walkthrough.ts'
import { hostWith } from './test-utils/host-fakes.ts'
import { renderBase, setUpEachBaseTest, storageAnswered } from './test-utils/render-base.ts'

setUpEachBaseTest()

beforeEach(() => {
  window.localStorage.clear()
  // jsdom lays nothing out, so every element reads as unrendered, and the
  // walkthrough would drop every step. Give each element a box.
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => {
    const boxes = [DOMRect.fromRect({ x: 0, y: 0, width: 40, height: 20 })]
    return Object.assign(boxes, { item: (index: number) => boxes[index] ?? null })
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
  // driver.js leaves its overlay on `body`, outside what `cleanup` unmounts.
  document.body.innerHTML = ''
})

/** The base at `path` on a memory history, over a host listing `servers`; returns the history. */
const renderBaseAt = (
  path: string,
  servers: readonly unknown[] = golden.listedServers
): ReturnType<typeof createMemoryHistory> => {
  const history = createMemoryHistory({ initialEntries: [path] })
  renderBase({
    invoke: hostWith({ servers: () => Promise.resolve(servers) }).invoke,
    storage: storageAnswered({ crashReports: false, performance: false }),
    history,
  })
  return history
}

/** The anchors on the page that a step of the Host's walkthrough points at. */
const anchorsOnPage = (): ReadonlyArray<string> =>
  HOST_WALKTHROUGH_STEPS.map(({ anchor }) => anchor).filter(
    (anchor) => document.querySelector(`[${WALKTHROUGH_ANCHOR_ATTRIBUTE}="${anchor}"]`) !== null
  )

/** The walkthrough's popover while it shows the step titled `title`. */
const findPopover = (title: string): Promise<HTMLElement> =>
  screen.findByRole('dialog', { name: title })

/** Keeps a record of the Host's walkthrough, as a returning visitor has. */
const recordSeen = (): void => {
  writeSeenWalkthrough(window.localStorage, HOST_WALKTHROUGH_ID, {
    version: HOST_WALKTHROUGH_VERSION,
    outcome: 'Skipped',
    decidedAt: DateTime.unsafeMake('2026-10-22T12:00:00.000Z'),
  })
}

const recordedOutcome = (): string | undefined =>
  readSeenWalkthrough(window.localStorage, HOST_WALKTHROUGH_ID, HOST_WALKTHROUGH_VERSION)?.outcome

describe("the Host's walkthrough", () => {
  it("should find every step's control on a server list with servers", async () => {
    // Arrange
    recordSeen()

    // Act
    renderBaseAt('/servers')
    await screen.findByRole('listitem', { name: golden.listedServers[0]?.domain })

    // Assert
    expect(anchorsOnPage()).toStrictEqual(HOST_WALKTHROUGH_STEPS.map(({ anchor }) => anchor))
  })

  it('should keep Add new server and Host Settings on a list with no servers', async () => {
    // Arrange
    recordSeen()

    // Act
    renderBaseAt('/servers', [])
    await screen.findByText('No servers yet')

    // Assert
    expect(anchorsOnPage()).toStrictEqual([
      HostWalkthroughAnchor.addServer,
      HostWalkthroughAnchor.hostSettings,
    ])
  })

  it('should open on a first visit, and stay closed once skipped', async () => {
    // Arrange
    const [firstStep] = HOST_WALKTHROUGH_STEPS
    if (firstStep === undefined) throw new Error('the walkthrough has no steps')
    renderBaseAt('/servers')

    // Act
    const popover = await findPopover(firstStep.title)
    fireEvent.click(within(popover).getByRole('button', { name: 'Skip' }))

    // Assert
    await waitFor(() => {
      expect(recordedOutcome()).toBe('Skipped')
    })
    expect(screen.queryByRole('dialog', { name: firstStep.title })).toBeNull()
  })

  it("should show again from Host Settings' Show walkthrough again, and drop the request once done", async () => {
    // Arrange
    const user = userEvent.setup()
    recordSeen()
    const history = renderBaseAt('/settings', [])

    // Act
    await user.click(await screen.findByRole('link', { name: 'Show walkthrough again' }))

    // Assert
    const addServer = await findPopover('Add new server')
    expect(history.location.pathname).toBe('/servers')
    expect(history.location.search).toBe('?walkthrough=show')

    // Act
    fireEvent.click(within(addServer).getByRole('button', { name: 'Next' }))
    fireEvent.click(
      within(await findPopover('Host Settings')).getByRole('button', { name: 'Done' })
    )

    // Assert
    await waitFor(() => {
      expect(recordedOutcome()).toBe('Finished')
    })
    await waitFor(() => {
      expect(history.location.search).toBe('')
    })
    expect(screen.queryByRole('dialog', { name: 'Host Settings' })).toBeNull()
  })
})
