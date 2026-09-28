import * as Plot from '@observablehq/plot'
import { act, cleanup, render } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { FALLBACK_WIDTH, usePlot } from './use-plot.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const Harness = ({ options }: { readonly options: Plot.PlotOptions | null }): JSX.Element => {
  const { containerRef } = usePlot(options)
  return <div ref={containerRef} data-testid="container" />
}

const dotsAt = (values: readonly number[]): Plot.PlotOptions => ({
  marks: [Plot.dotX(values)],
})

describe('usePlot', () => {
  test('mounts one figure, replaces it when the options change, and removes it on unmount', () => {
    const first = dotsAt([1, 2, 3])
    const { container, rerender, unmount } = render(<Harness options={first} />)
    expect(container.querySelectorAll('svg')).toHaveLength(1)
    expect(container.querySelectorAll('circle')).toHaveLength(3)

    rerender(<Harness options={dotsAt([1, 2, 3, 4, 5])} />)
    expect(container.querySelectorAll('svg')).toHaveLength(1)
    expect(container.querySelectorAll('circle')).toHaveLength(5)

    unmount()
    expect(container.querySelector('svg')).toBeNull()
  })

  test('keeps the same figure while the options object is unchanged', () => {
    const options = dotsAt([1, 2])
    const { container, rerender } = render(<Harness options={options} />)
    const mounted = container.querySelector('svg')

    rerender(<Harness options={options} />)
    expect(container.querySelector('svg')).toBe(mounted)
  })

  test('mounts nothing for null options', () => {
    const { container, rerender } = render(<Harness options={dotsAt([1])} />)
    rerender(<Harness options={null} />)
    expect(container.querySelector('svg')).toBeNull()
  })

  test('draws at the fallback width where nothing can measure the container', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const { container } = render(<Harness options={dotsAt([1])} />)
    expect(container.querySelector('svg')?.getAttribute('width')).toBe(String(FALLBACK_WIDTH))
  })

  test('redraws at the container width the observer reports, ignoring a collapsed zero', () => {
    const observers: {
      readonly callback: ResizeObserverCallback
      readonly observer: ResizeObserver
    }[] = []
    const disconnect = vi.fn()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          observers.push({ callback, observer: this })
        }
        observe(): void {}
        unobserve(): void {}
        disconnect = disconnect
      }
    )
    /** An entry reporting `width`; the hook reads only `contentRect.width`. */
    const entry = (width: number): ResizeObserverEntry => ({
      target: document.body,
      contentRect: {
        x: 0,
        y: 0,
        width,
        height: 0,
        top: 0,
        left: 0,
        right: width,
        bottom: 0,
        toJSON: () => ({}),
      },
      borderBoxSize: [],
      contentBoxSize: [],
      devicePixelContentBoxSize: [],
    })
    const report = (width: number): void =>
      act(() => {
        for (const { callback, observer } of observers) callback([entry(width)], observer)
      })

    const { container, unmount } = render(<Harness options={dotsAt([1])} />)
    report(812.6)
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('812')

    report(0)
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('812')

    unmount()
    expect(disconnect).toHaveBeenCalled()
  })
})
