import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  readSeenWalkthrough,
  walkthroughAnchor,
  type WalkthroughStep,
  type WalkthroughStorage,
  writeSeenWalkthrough,
} from '@wildflowerhealthio/walkthrough-core'
import { DateTime } from 'effect'
import type { JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { useWalkthrough } from './use-walkthrough.ts'
import { mapWalkthroughStorage } from './walkthrough.test-helpers.ts'
import { Walkthrough } from './walkthrough.tsx'

const WALKTHROUGH_ID = 'home'
const VERSION = 1
/** The longest the walkthrough waits for the page to settle. */
const ANCHOR_WAIT_MS = 2_000
/** How long the visible anchors must stay unchanged for the page to count as settled. */
const ANCHOR_QUIET_MS = 200

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
  walkthroughId = WALKTHROUGH_ID,
  pageKey,
}: {
  readonly storage: WalkthroughStorage
  readonly steps: ReadonlyArray<WalkthroughStep>
  readonly anchors: ReadonlyArray<string>
  readonly hiddenAnchors?: ReadonlyArray<string>
  readonly walkthroughId?: string
  /** A new key remounts the page, replacing every anchor element. */
  readonly pageKey?: string
}): JSX.Element => {
  const { open, finish, skip, postpone, reopen } = useWalkthrough({
    storage,
    id: walkthroughId,
    version: VERSION,
  })
  return (
    <>
      <Page key={pageKey} anchors={anchors} hiddenAnchors={hiddenAnchors} />
      <button type="button" onClick={reopen}>
        Show {walkthroughId} walkthrough again
      </button>
      <Walkthrough
        steps={steps}
        open={open}
        onFinish={finish}
        onSkip={skip}
        onPostpone={postpone}
      />
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

    // Act: two of the four anchors never render, so it starts once the page settles.
    act(() => {
      vi.advanceTimersByTime(ANCHOR_QUIET_MS)
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

  it('should not start, and record nothing, when no anchor renders in time, and start on reopen once one does', async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const storage = mapWalkthroughStorage()
    const steps = [step('settings')]
    const { rerender } = render(
      <PageWithWalkthrough
        storage={storage}
        steps={steps}
        anchors={[]}
        hiddenAnchors={['settings']}
      />
    )

    // Act
    act(() => {
      vi.advanceTimersByTime(ANCHOR_WAIT_MS)
    })
    vi.useRealTimers()

    // Assert
    expect(popoverIsShowing()).toBe(false)
    expect(recordedOutcome(storage)).toBeUndefined()

    // Act
    rerender(<PageWithWalkthrough storage={storage} steps={steps} anchors={['settings']} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show home walkthrough again' }))

    // Assert
    expect(await findPopover('About settings')).toBeDefined()
  })

  it('should postpone a second walkthrough while one is showing', async () => {
    // Arrange
    const storage = mapWalkthroughStorage()
    render(
      <>
        <PageWithWalkthrough storage={storage} steps={[step('servers')]} anchors={['servers']} />
        <PageWithWalkthrough
          storage={storage}
          steps={[step('apps')]}
          anchors={['apps']}
          walkthroughId="apps"
        />
      </>
    )
    const first = await findPopover('About servers')

    // Act
    fireEvent.click(within(first).getByRole('button', { name: 'Done' }))
    await waitFor(() => {
      expect(recordedOutcome(storage)).toBe('Finished')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Show apps walkthrough again' }))

    // Assert
    expect(await findPopover('About apps')).toBeDefined()
    expect(readSeenWalkthrough(storage, 'apps', VERSION)).toBeUndefined()
  })

  it('should drop a step whose anchor is invisible to checkVisibility', async () => {
    // Arrange: a browser with checkVisibility, reading inline visibility.
    Object.defineProperty(Element.prototype, 'checkVisibility', {
      configurable: true,
      value: function (this: Element) {
        return this.closest('[style*="visibility: hidden"]') === null
      },
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const storage = mapWalkthroughStorage()
    try {
      render(
        <>
          <div style={{ visibility: 'hidden' }}>
            <button type="button" {...walkthroughAnchor('drawer')}>
              drawer
            </button>
          </div>
          <PageWithWalkthrough
            storage={storage}
            steps={[step('drawer'), step('servers')]}
            anchors={['servers']}
          />
        </>
      )

      // Act
      act(() => {
        vi.advanceTimersByTime(ANCHOR_WAIT_MS)
      })
      vi.useRealTimers()

      // Assert
      const popover = await findPopover('About servers')
      expect(within(popover).getByText('1 of 1')).toBeDefined()
    } finally {
      Reflect.deleteProperty(Element.prototype, 'checkVisibility')
    }
  })

  it('should never parse step text as HTML', async () => {
    // Arrange: an element that reports being put on the page, even for a moment.
    const connectedProbes = vi.fn()
    customElements.define(
      'walkthrough-probe',
      class extends HTMLElement {
        connectedCallback(): void {
          connectedProbes()
        }
      }
    )
    const markup = '<walkthrough-probe>injected</walkthrough-probe>'

    // Act
    render(
      <PageWithWalkthrough
        storage={mapWalkthroughStorage()}
        steps={[{ anchor: 'servers', title: markup, body: markup }]}
        anchors={['servers']}
      />
    )

    // Assert
    const popover = await findPopover(markup)
    expect(within(popover).getAllByText(markup)).toHaveLength(2)
    expect(connectedProbes).not.toHaveBeenCalled()
  })

  it('should point a later step at the control the page re-rendered since it started', async () => {
    // Arrange
    const storage = mapWalkthroughStorage()
    const steps = [step('servers'), step('apps')]
    const { rerender } = render(
      <PageWithWalkthrough storage={storage} steps={steps} anchors={['servers', 'apps']} />
    )
    const first = await findPopover('About servers')

    // Act
    rerender(
      <PageWithWalkthrough
        storage={storage}
        steps={steps}
        anchors={['servers', 'apps']}
        pageKey="refetched"
      />
    )
    fireEvent.click(within(first).getByRole('button', { name: 'Next' }))
    await findPopover('About apps')

    // Assert
    const apps = screen.getByRole('button', { name: 'apps' })
    await waitFor(() => {
      expect(apps.classList.contains('driver-active-element')).toBe(true)
    })
  })

  it('should record Finished on the right arrow key on the last step', async () => {
    // Arrange
    const storage = renderTwoStepWalkthrough()
    await findPopover('About servers')

    // Act: driver.js ignores the arrow keys while it moves between steps, so
    // press until each press lands.
    await waitFor(() => {
      fireEvent.keyUp(window, { key: 'ArrowRight' })
      expect(screen.getByRole('dialog', { name: 'About apps' })).toBeDefined()
    })
    await waitFor(() => {
      fireEvent.keyUp(window, { key: 'ArrowRight' })
      expect(recordedOutcome(storage)).toBe('Finished')
    })

    // Assert
    expect(popoverIsShowing()).toBe(false)
  })

  it('should start once the visible anchors stop changing, without waiting for the missing ones', async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const storage = mapWalkthroughStorage()
    const steps = [step('servers'), step('apps'), step('missing')]
    const { rerender } = render(
      <PageWithWalkthrough storage={storage} steps={steps} anchors={['servers']} />
    )

    // Act: a second anchor renders partway through the quiet period, restarting it.
    act(() => {
      vi.advanceTimersByTime(ANCHOR_QUIET_MS - 50)
    })
    // The async act lets the MutationObserver see the new anchor.
    await act(async () => {
      rerender(
        <PageWithWalkthrough storage={storage} steps={steps} anchors={['servers', 'apps']} />
      )
    })
    act(() => {
      vi.advanceTimersByTime(ANCHOR_QUIET_MS - 50)
    })

    // Assert
    expect(popoverIsShowing()).toBe(false)

    // Act
    act(() => {
      vi.advanceTimersByTime(50)
    })

    // Assert
    const popover = screen.getByRole('dialog', { name: 'About servers' })
    expect(within(popover).getByText('1 of 2')).toBeDefined()
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
      decidedAt: DateTime.unsafeMake('2026-10-01T08:00:00.000Z'),
    })

    // Act
    render(
      <PageWithWalkthrough storage={storage} steps={[step('servers')]} anchors={['servers']} />
    )

    // Assert
    expect(popoverIsShowing()).toBe(false)
  })
})
