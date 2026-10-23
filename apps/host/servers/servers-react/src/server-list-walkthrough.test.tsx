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
  type HostWalkthrough,
  NO_SERVERS_WALKTHROUGH,
  SERVERS_WALKTHROUGH,
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

/** The anchors of `walkthrough`'s steps, in step order. */
const anchorsOf = (walkthrough: HostWalkthrough): ReadonlyArray<string> =>
  walkthrough.steps.map(({ anchor }) => anchor)

/** The anchors on the page that a step of `walkthrough` points at. */
const anchorsOnPage = (walkthrough: HostWalkthrough): ReadonlyArray<string> =>
  anchorsOf(walkthrough).filter(
    (anchor) => document.querySelector(`[${WALKTHROUGH_ANCHOR_ATTRIBUTE}="${anchor}"]`) !== null
  )

/** The walkthrough's popover while it shows the step titled `title`. */
const findPopover = (title: string): Promise<HTMLElement> =>
  screen.findByRole('dialog', { name: title })

/** Keeps a record of `walkthrough`, as a visitor who has been through it has. */
const recordSeen = (walkthrough: HostWalkthrough): void => {
  writeSeenWalkthrough(window.localStorage, walkthrough.id, {
    version: walkthrough.version,
    outcome: 'Skipped',
    decidedAt: DateTime.unsafeMake('2026-10-22T12:00:00.000Z'),
  })
}

const recordedOutcome = (walkthrough: HostWalkthrough): string | undefined =>
  readSeenWalkthrough(window.localStorage, walkthrough.id, walkthrough.version)?.outcome

/** The title of `walkthrough`'s first step. */
const firstStepTitle = (walkthrough: HostWalkthrough): string => {
  const [firstStep] = walkthrough.steps
  if (firstStep === undefined) throw new Error(`walkthrough ${walkthrough.id} has no steps`)
  return firstStep.title
}

describe("the Host's walkthrough", () => {
  it("should find every step's control of the servers walkthrough on a list with servers", async () => {
    // Arrange
    recordSeen(SERVERS_WALKTHROUGH)

    // Act
    renderBaseAt('/servers')
    await screen.findByRole('listitem', { name: golden.listedServers[0]?.domain })

    // Assert
    expect(anchorsOnPage(SERVERS_WALKTHROUGH)).toStrictEqual(anchorsOf(SERVERS_WALKTHROUGH))
  })

  it("should find every step's control of the no-servers walkthrough on a list with no servers", async () => {
    // Arrange
    recordSeen(NO_SERVERS_WALKTHROUGH)

    // Act
    renderBaseAt('/servers', [])
    await screen.findByText('No servers yet')

    // Assert
    expect(anchorsOnPage(NO_SERVERS_WALKTHROUGH)).toStrictEqual(anchorsOf(NO_SERVERS_WALKTHROUGH))
  })

  it('should open the servers walkthrough on a first visit, and keep it closed once skipped', async () => {
    // Arrange
    const title = firstStepTitle(SERVERS_WALKTHROUGH)
    renderBaseAt('/servers')

    // Act
    const popover = await findPopover(title)
    fireEvent.click(within(popover).getByRole('button', { name: 'Skip' }))

    // Assert
    await waitFor(() => {
      expect(recordedOutcome(SERVERS_WALKTHROUGH)).toBe('Skipped')
    })
    expect(recordedOutcome(NO_SERVERS_WALKTHROUGH)).toBeUndefined()
    expect(screen.queryByRole('dialog', { name: title })).toBeNull()
  })

  it('should open the no-servers walkthrough on a first visit to a list with no servers', async () => {
    // Act
    renderBaseAt('/servers', [])

    // Assert
    await findPopover(firstStepTitle(NO_SERVERS_WALKTHROUGH))
  })

  it('should open the servers walkthrough once there are servers, after the no-servers one', async () => {
    // Arrange
    recordSeen(NO_SERVERS_WALKTHROUGH)
    renderBaseAt('/servers')

    // Act: past the welcome both walkthroughs open with
    fireEvent.click(
      within(await findPopover('Welcome to Wildflower')).getByRole('button', { name: 'Next' })
    )
    fireEvent.click(
      within(await findPopover('Reaching Your Server')).getByRole('button', { name: 'Next' })
    )

    // Assert
    await findPopover('Your Server')
  })

  it("should show again from Host Settings' Show walkthrough again, and drop the request once done", async () => {
    // Arrange
    const user = userEvent.setup()
    recordSeen(NO_SERVERS_WALKTHROUGH)
    const history = renderBaseAt('/settings', [])

    // Act
    await user.click(await screen.findByRole('link', { name: 'Show walkthrough again' }))

    // Assert
    const welcome = await findPopover('Welcome to Wildflower')
    expect(history.location.pathname).toBe('/servers')
    expect(history.location.search).toBe('?walkthrough=show')

    // Act: through to the last step, Add new server
    fireEvent.click(within(welcome).getByRole('button', { name: 'Next' }))
    fireEvent.click(
      within(await findPopover('Reaching Your Server')).getByRole('button', { name: 'Next' })
    )
    fireEvent.click(
      within(await findPopover('Host Settings')).getByRole('button', { name: 'Next' })
    )
    fireEvent.click(
      within(await findPopover('Add new server')).getByRole('button', { name: 'Done' })
    )

    // Assert
    await waitFor(() => {
      expect(recordedOutcome(NO_SERVERS_WALKTHROUGH)).toBe('Finished')
    })
    await waitFor(() => {
      expect(history.location.search).toBe('')
    })
    expect(screen.queryByRole('dialog', { name: 'Add new server' })).toBeNull()
  })
})
