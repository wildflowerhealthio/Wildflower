import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  readSeenWalkthrough,
  walkthroughAnchor,
  type WalkthroughStep,
  type WalkthroughStorage,
  writeSeenWalkthrough,
} from '@wildflowerhealthio/walkthrough-core'
import type { JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { useWalkthrough } from './use-walkthrough.ts'
import { mapWalkthroughStorage } from './walkthrough.test-helpers.ts'
import { Walkthrough } from './walkthrough.tsx'

const WALKTHROUGH_ID = 'home'
const VERSION = 1
/** How long the walkthrough waits for its anchors before starting with those rendered. */
const ANCHOR_WAIT_MS = 2_000

const step = (anchor: string): WalkthroughStep => ({
  anchor,
  title: `About ${anchor}`,
  body: `What ${anchor} does.`,
})

beforeEach(() => {
  // jsdom lays nothing out, so every element reads as unrendered. Give each
  // one a box unless it sits inside a `hidden` element, as a browser would.
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    const box = DOMRect.fromRect({ x: 0, y: 0, width: 40, height: 20 })
    const boxes = this.closest('[hidden]') === null ? [box] : []
    return Object.assign(boxes, { item: (index: number) => boxes[index] ?? null })
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

/** A page carrying one button per anchor; `hiddenAnchors` are inside a `hidden` section. */
const Page = ({
  anchors,
  hiddenAnchors = [],
}: {
  readonly anchors: ReadonlyArray<string>
  readonly hiddenAnchors?: ReadonlyArray<string>
}): JSX.Element => (
  <main>
    {anchors.map((anchor) => (
      <button key={anchor} type="button" {...walkthroughAnchor(anchor)}>
        {anchor}
      </button>
    ))}
    <section hidden>
      {hiddenAnchors.map((anchor) => (
        <button key={anchor} type="button" {...walkthroughAnchor(anchor)}>
          {anchor}
        </button>
      ))}
    </section>
  </main>
)

/** The page with its walkthrough, kept through `useWalkthrough` in `storage`. */
const PageWithWalkthrough = ({
  storage,
  steps,
  anchors,
  hiddenAnchors,
}: {
  readonly storage: WalkthroughStorage
  readonly steps: ReadonlyArray<WalkthroughStep>
  readonly anchors: ReadonlyArray<string>
  readonly hiddenAnchors?: ReadonlyArray<string>
}): JSX.Element => {
  const { open, finish, skip } = useWalkthrough({ storage, id: WALKTHROUGH_ID, version: VERSION })
  return (
    <>
      <Page anchors={anchors} hiddenAnchors={hiddenAnchors} />
      <Walkthrough steps={steps} open={open} onFinish={finish} onSkip={skip} />
    </>
  )
}

/** The popover while it shows the step titled `title`. */
const findPopover = (title: string): Promise<HTMLElement> =>
  screen.findByRole('dialog', { name: title })

const recordedOutcome = (storage: WalkthroughStorage): string | undefined =>
  readSeenWalkthrough(storage, WALKTHROUGH_ID, VERSION)?.outcome

/** Renders a two-step walkthrough over a page showing both anchors; returns its storage. */
const renderTwoStepWalkthrough = (): WalkthroughStorage => {
  const storage = mapWalkthroughStorage()
  render(
    <PageWithWalkthrough
      storage={storage}
      steps={[step('servers'), step('apps')]}
      anchors={['servers', 'apps']}
    />
  )
  return storage
}

const popoverIsShowing = (): boolean => document.querySelector('.driver-popover') !== null

describe('Walkthrough', () => {
  it('should step through every anchored step with Next and Back, and record Finished on Done', async () => {
    // Arrange
    const storage = renderTwoStepWalkthrough()

    // Assert
    const first = await findPopover('About servers')
    expect(within(first).getByText('What servers does.')).toBeDefined()
    expect(within(first).getByText('1 of 2')).toBeDefined()

    // Act
    fireEvent.click(within(first).getByRole('button', { name: 'Next' }))

    // Assert
    const second = await findPopover('About apps')
    expect(within(second).getByText('2 of 2')).toBeDefined()

    // Act
    fireEvent.click(within(second).getByRole('button', { name: 'Back' }))
    fireEvent.click(
      within(await findPopover('About servers')).getByRole('button', { name: 'Next' })
    )
    fireEvent.click(within(await findPopover('About apps')).getByRole('button', { name: 'Done' }))

    // Assert
    await waitFor(() => {
      expect(recordedOutcome(storage)).toBe('Finished')
    })
    expect(popoverIsShowing()).toBe(false)
  })

  it('should drop the steps whose anchor is missing or hidden', async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const storage = mapWalkthroughStorage()
    render(
      <PageWithWalkthrough
        storage={storage}
        steps={[step('servers'), step('missing'), step('settings'), step('apps')]}
        anchors={['servers', 'apps']}
        hiddenAnchors={['settings']}
      />
    )

    // Act: two of the four anchors never render, so it starts once the wait runs out.
    act(() => {
      vi.advanceTimersByTime(ANCHOR_WAIT_MS)
    })
    vi.useRealTimers()
    const first = await findPopover('About servers')
    expect(within(first).getByText('1 of 2')).toBeDefined()
    fireEvent.click(within(first).getByRole('button', { name: 'Next' }))

    // Assert
    const second = await findPopover('About apps')
    expect(within(second).getByText('2 of 2')).toBeDefined()
    expect(within(second).getByRole('button', { name: 'Done' })).toBeDefined()
  })

  it('should not start, and record nothing, when no anchor renders in time', () => {
    // Arrange
    vi.useFakeTimers()
    const storage = mapWalkthroughStorage()
    render(
      <PageWithWalkthrough
        storage={storage}
        steps={[step('missing'), step('settings')]}
        anchors={[]}
        hiddenAnchors={['settings']}
      />
    )

    // Act
    act(() => {
      vi.advanceTimersByTime(ANCHOR_WAIT_MS)
    })

    // Assert
    expect(popoverIsShowing()).toBe(false)
    expect(recordedOutcome(storage)).toBeUndefined()
  })

  it('should wait for anchors that render after it opens', async () => {
    // Arrange
    const storage = mapWalkthroughStorage()
    const steps = [step('servers')]
    const { rerender } = render(
      <PageWithWalkthrough storage={storage} steps={steps} anchors={[]} />
    )

    // Act
    rerender(<PageWithWalkthrough storage={storage} steps={steps} anchors={['servers']} />)

    // Assert
    expect(await findPopover('About servers')).toBeDefined()
  })

  it.each([
    {
      label: 'Skip',
      leave: (popover: HTMLElement) => {
        fireEvent.click(within(popover).getByRole('button', { name: 'Skip' }))
      },
    },
    {
      label: 'Escape',
      leave: () => {
        fireEvent.keyUp(window, { key: 'Escape' })
      },
    },
  ])('should record Skipped on $label', async ({ leave }) => {
    // Arrange
    const storage = renderTwoStepWalkthrough()

    // Act
    leave(await findPopover('About servers'))

    // Assert
    await waitFor(() => {
      expect(recordedOutcome(storage)).toBe('Skipped')
    })
    expect(popoverIsShowing()).toBe(false)
  })

  it('should record Skipped on a click on the overlay', async () => {
    // Arrange
    const storage = renderTwoStepWalkthrough()
    await findPopover('About servers')
    // driver.js draws the overlay on the next animation frame.
    const overlay = await waitFor(() => {
      const path = document.querySelector('.driver-overlay path')
      if (path === null) throw new Error('No overlay is showing')
      return path
    })

    // Act
    fireEvent.click(overlay)

    // Assert
    await waitFor(() => {
      expect(recordedOutcome(storage)).toBe('Skipped')
    })
    expect(popoverIsShowing()).toBe(false)
  })

  it('should close without recording anything when unmounted', async () => {
    // Arrange
    const storage = mapWalkthroughStorage()
    const { unmount } = render(
      <PageWithWalkthrough storage={storage} steps={[step('servers')]} anchors={['servers']} />
    )
    await findPopover('About servers')

    // Act
    unmount()

    // Assert
    expect(popoverIsShowing()).toBe(false)
    expect(recordedOutcome(storage)).toBeUndefined()
  })

  it('should not show while the current version is recorded', () => {
    // Arrange
    const storage = mapWalkthroughStorage()
    writeSeenWalkthrough(storage, WALKTHROUGH_ID, {
      version: VERSION,
      outcome: 'Skipped',
      decidedAt: '2026-10-01T08:00:00.000Z',
    })

    // Act
    render(
      <PageWithWalkthrough storage={storage} steps={[step('servers')]} anchors={['servers']} />
    )

    // Assert
    expect(popoverIsShowing()).toBe(false)
  })
})
