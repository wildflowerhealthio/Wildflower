import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { ChunkBar, type ChunkBarPhase } from './chunk-bar.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

const bar = (): HTMLElement => screen.getByRole('img')
const blocksOf = (element: HTMLElement): readonly Element[] => [...element.querySelectorAll('i')]

describe('ChunkBar', () => {
  it('renders nothing under four pages', () => {
    const { container } = render(<ChunkBar phase="loading" pagesReceived={3} loadedCount={30} />)

    expect(container.firstChild).toBeNull()
  })

  it('renders one block per received page when idle', () => {
    render(<ChunkBar phase="idle" pagesReceived={6} loadedCount={60} />)

    expect(blocksOf(bar())).toHaveLength(6)
  })

  it('appends one extra in-flight block while loading', () => {
    render(<ChunkBar phase="loading" pagesReceived={6} loadedCount={60} />)

    expect(blocksOf(bar())).toHaveLength(7)
  })

  it('drops the in-flight block once locked', () => {
    render(<ChunkBar phase="locked" pagesReceived={6} loadedCount={60} />)

    expect(blocksOf(bar())).toHaveLength(6)
  })

  it('labels each phase for assistive tech', () => {
    const labelFor = (phase: ChunkBarPhase): string => {
      const view = render(<ChunkBar phase={phase} pagesReceived={5} loadedCount={50} />)
      const label = screen.getByRole('img').getAttribute('aria-label') ?? ''
      view.unmount()
      return label
    }

    expect(labelFor('idle')).toBe('5 pages loaded so far')
    expect(labelFor('loading')).toBe('Loading — 5 pages in so far')
    expect(labelFor('locked')).toBe('Everything is loaded')
    expect(labelFor('error')).toBe('Loading paused after a failed page — 5 pages in so far')
  })

  it('wraps page blocks into rows of twenty', () => {
    render(<ChunkBar phase="idle" pagesReceived={45} loadedCount={450} />)

    // 45 pages → rows of 20, 20 and 5.
    expect(bar().querySelectorAll('span')).toHaveLength(3)
    expect(blocksOf(bar())).toHaveLength(45)
  })

  it('states the failure and offers a retry in the error phase', async () => {
    const user = userEvent.setup()
    const onLoadAll = vi.fn()
    render(<ChunkBar phase="error" pagesReceived={5} loadedCount={50} onLoadAll={onLoadAll} />)

    await user.tab()
    expect(screen.getByRole('tooltip').textContent).toContain('A page failed to load')

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onLoadAll).toHaveBeenCalledTimes(1)
  })

  it('opens the tooltip on focus and shows the localized count', async () => {
    const user = userEvent.setup()
    render(<ChunkBar phase="idle" pagesReceived={12} loadedCount={1200} />)

    await user.tab()

    expect(document.activeElement).toBe(bar())
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip.textContent).toContain(new Intl.NumberFormat().format(1200))
    expect(tooltip.textContent).toContain('have been loaded')
  })

  it('offers the load-all action while idle and fires it once', async () => {
    const user = userEvent.setup()
    const onLoadAll = vi.fn()
    render(<ChunkBar phase="idle" pagesReceived={5} loadedCount={50} onLoadAll={onLoadAll} />)

    await user.tab()
    await user.click(screen.getByRole('button', { name: 'Load all the rest?' }))

    expect(onLoadAll).toHaveBeenCalledTimes(1)
    // Starting the fetch closes the tooltip.
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('hides the load-all action while loading and once locked', async () => {
    const user = userEvent.setup()
    const tooltipHasNoAction = async (phase: ChunkBarPhase): Promise<void> => {
      const view = render(
        <ChunkBar phase={phase} pagesReceived={5} loadedCount={50} onLoadAll={() => {}} />
      )
      await user.tab()
      expect(screen.queryByRole('button')).toBeNull()
      expect(screen.queryByRole('tooltip')).not.toBeNull()
      view.unmount()
    }

    await tooltipHasNoAction('loading')
    await tooltipHasNoAction('locked')
  })

  it('lets the caller override the tooltip and aria copy', async () => {
    const user = userEvent.setup()
    render(
      <ChunkBar
        phase="idle"
        pagesReceived={4}
        loadedCount={40}
        labels={{
          ariaIdle: (pages) => `${pages} pages of your medication list loaded so far`,
          countSuffix: 'medication requests have been loaded.',
        }}
      />
    )

    await user.tab()

    expect(bar().getAttribute('aria-label')).toBe('4 pages of your medication list loaded so far')
    expect(screen.getByRole('tooltip').textContent).toContain(
      'medication requests have been loaded.'
    )
  })

  it('always renders received-page blocks plus exactly one in-flight block only while loading', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 4, max: 60 }),
        fc.constantFrom<ChunkBarPhase>('idle', 'loading', 'locked', 'error'),
        (pagesReceived, phase) => {
          const view = render(
            <ChunkBar
              phase={phase}
              pagesReceived={pagesReceived}
              loadedCount={pagesReceived * 10}
            />
          )

          const count = blocksOf(screen.getByRole('img')).length

          expect(count).toBe(phase === 'loading' ? pagesReceived + 1 : pagesReceived)
          view.unmount()
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})
