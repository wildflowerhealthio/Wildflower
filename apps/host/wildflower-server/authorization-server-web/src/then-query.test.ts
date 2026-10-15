import { Option } from 'effect'
import { describe, expect, test, vi } from 'vite-plus/test'

import { goBackOnceDecidedOf, goBackOrClose } from './then-query.ts'

/** A browser window with `historyLength` entries, recording what it was asked to do. */
const browserWindowWith = (
  historyLength: number
): {
  readonly history: Pick<History, 'length' | 'back'>
  readonly close: () => void
  readonly back: ReturnType<typeof vi.fn>
  readonly closed: ReturnType<typeof vi.fn>
} => {
  const back = vi.fn()
  const closed = vi.fn()
  return {
    history: { length: historyLength, back },
    close: closed,
    back,
    closed,
  }
}

describe('goBackOnceDecidedOf', () => {
  test('is Some for then=back, wherever it sits in the query', () => {
    expect(Option.isSome(goBackOnceDecidedOf('?then=back', browserWindowWith(1)))).toBe(true)
    expect(
      Option.isSome(goBackOnceDecidedOf('?user_code=WDJB-MJHT&then=back', browserWindowWith(1)))
    ).toBe(true)
  })

  test('is None for any other then, or none', () => {
    for (const search of ['', '?user_code=WDJB-MJHT', '?then=', '?then=Back', '?then=close']) {
      expect(Option.isNone(goBackOnceDecidedOf(search, browserWindowWith(1)))).toBe(true)
    }
  })

  test('steps back out of the window it was given', () => {
    const browserWindow = browserWindowWith(2)

    Option.getOrThrow(goBackOnceDecidedOf('?then=back', browserWindow))()

    expect(browserWindow.back).toHaveBeenCalledOnce()
    expect(browserWindow.closed).not.toHaveBeenCalled()
  })
})

describe('goBackOrClose', () => {
  test('goes back when there is history to go back to', () => {
    const browserWindow = browserWindowWith(3)

    goBackOrClose(browserWindow)

    expect(browserWindow.back).toHaveBeenCalledOnce()
    expect(browserWindow.closed).not.toHaveBeenCalled()
  })

  test('closes the window when the page is its only entry', () => {
    const browserWindow = browserWindowWith(1)

    goBackOrClose(browserWindow)

    expect(browserWindow.closed).toHaveBeenCalledOnce()
    expect(browserWindow.back).not.toHaveBeenCalled()
  })
})
