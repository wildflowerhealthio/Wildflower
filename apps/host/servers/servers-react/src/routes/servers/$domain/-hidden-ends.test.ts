import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { readHiddenEnds, useHiddenEnds } from './-hidden-ends.ts'

describe('readHiddenEnds', () => {
  it.each([
    ['content that fits', { scrollLeft: 0, clientWidth: 200, scrollWidth: 200 }, false, false],
    [
      'the start of wider content',
      { scrollLeft: 0, clientWidth: 200, scrollWidth: 300 },
      false,
      true,
    ],
    [
      'the middle of wider content',
      { scrollLeft: 50, clientWidth: 200, scrollWidth: 300 },
      true,
      true,
    ],
    [
      'the end of wider content',
      { scrollLeft: 100, clientWidth: 200, scrollWidth: 300 },
      true,
      false,
    ],
    [
      'a pixel short of the end, as a zoomed page reports it',
      { scrollLeft: 99, clientWidth: 200, scrollWidth: 300 },
      true,
      false,
    ],
    [
      'two pixels short of the end',
      { scrollLeft: 98, clientWidth: 200, scrollWidth: 300 },
      true,
      true,
    ],
  ] as const)('should read %s', (_, scroll, before, after) => {
    // Act
    const hiddenEnds = readHiddenEnds(scrolledElement(scroll))

    // Assert
    expect(hiddenEnds).toStrictEqual({ before, after })
  })
})

describe('useHiddenEnds', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('should read the ends again as the element scrolls', () => {
    // Arrange
    vi.stubGlobal('ResizeObserver', InertResizeObserver)
    const element = scrolledElement({ scrollLeft: 0, clientWidth: 200, scrollWidth: 300 })
    const { result } = renderHook(() => useHiddenEnds({ current: element }))
    expect(result.current).toStrictEqual({ before: false, after: true })

    // Act
    act(() => {
      element.scrollLeft = 100
      element.dispatchEvent(new Event('scroll'))
    })

    // Assert
    expect(result.current).toStrictEqual({ before: true, after: false })
  })
})

// Helpers

/** A `ResizeObserver` that never fires: jsdom has no layout. */
class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/**
 * A `<div>` reporting `scroll`'s widths, which jsdom leaves at 0, and
 * `scroll.scrollLeft` until it is set.
 */
const scrolledElement = (scroll: {
  readonly scrollLeft: number
  readonly clientWidth: number
  readonly scrollWidth: number
}): HTMLElement => {
  const element = document.createElement('div')
  Object.defineProperty(element, 'clientWidth', { value: scroll.clientWidth })
  Object.defineProperty(element, 'scrollWidth', { value: scroll.scrollWidth })
  element.scrollLeft = scroll.scrollLeft
  return element
}
