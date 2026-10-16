import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  RouterProvider,
} from '@tanstack/react-router'
import type { RouterHistory } from '@tanstack/react-router'
import { act, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { RouteTabs } from './route-tabs.tsx'
import styles from './route-tabs.module.css'

/** The server page's child routes, in strip order: path segment and label. */
const serverTabs = [
  { segment: 'status', label: 'Status' },
  { segment: 'access', label: 'Access' },
  { segment: 'relay', label: 'Relay' },
  { segment: 'certificate', label: 'Certificate' },
] as const

interface ServerPageOptions {
  readonly initialEntries: readonly string[]
  readonly wideFromOwnWidth?: number
}

/**
 * Mount the `example` server's page at `/servers/$id` beside a `/` home
 * page: its route renders the tabs, each tab's child route fills the panel with a line
 * naming it, and its index route redirects to the first tab. `history`
 * holds `initialEntries`, open on the last.
 */
const renderServerPage = ({
  initialEntries,
  wideFromOwnWidth,
}: ServerPageOptions): RouterHistory => {
  const history = createMemoryHistory({
    initialEntries: [...initialEntries],
    initialIndex: initialEntries.length - 1,
  })
  const rootRoute = createRootRoute()
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <p>Home</p>,
  })
  const serverRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/servers/$id',
    component: () => (
      <RouteTabs
        tabs={serverTabs.map((tab) => ({
          to: `/servers/$id/${tab.segment}`,
          params: { id: 'example' },
          label: tab.label,
        }))}
        aria-label="Server details"
        wideFromOwnWidth={wideFromOwnWidth}
      />
    ),
  })
  const serverIndexRoute = createRoute({
    getParentRoute: () => serverRoute,
    path: '/',
    beforeLoad: ({ params }) => {
      throw redirect({ to: '/servers/$id/status', params, replace: true })
    },
  })
  const tabRoutes = serverTabs.map((tab) =>
    createRoute({
      getParentRoute: () => serverRoute,
      path: tab.segment,
      component: () => <p>{`${tab.segment} panel`}</p>,
    })
  )
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      homeRoute,
      serverRoute.addChildren([serverIndexRoute, ...tabRoutes]),
    ]),
    history,
  })
  render(<RouterProvider router={router} />)
  return history
}

/** The callbacks of every live `ResizeObserver`, for {@link fireResize} to call. */
const resizeCallbacks = new Set<() => void>()

/** A `ResizeObserver` that fires only when a test calls {@link fireResize}: jsdom has no layout. */
class TestResizeObserver {
  readonly #callback: () => void
  constructor(callback: () => void) {
    this.#callback = callback
  }
  observe(): void {
    resizeCallbacks.add(this.#callback)
  }
  unobserve(): void {}
  disconnect(): void {
    resizeCallbacks.delete(this.#callback)
  }
}

/** Fire every live `ResizeObserver`, as a browser does after a resize. */
const fireResize = (): void => {
  act(() => {
    for (const callback of resizeCallbacks) {
      callback()
    }
  })
}

/** Each `scrollTo` the component asks of an element, in order. */
const scrollToCalls: { readonly left: number; readonly behavior: ScrollBehavior | undefined }[] = []

const stubReducedMotion = (reduced: boolean): void => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduced && query === '(prefers-reduced-motion: reduce)',
  }))
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  stubReducedMotion(false)
  // jsdom has no `Element.scrollTo`; this one lands at once, as an instant
  // scroll does, so a test can read `scrollLeft` straight after.
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: function scrollTo(this: HTMLElement, options: ScrollToOptions) {
      scrollToCalls.push({ left: options.left ?? 0, behavior: options.behavior })
      this.scrollLeft = options.left ?? 0
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
  resizeCallbacks.clear()
  scrollToCalls.length = 0
  document.body.innerHTML = ''
})

const findStrip = (): Promise<HTMLElement> =>
  screen.findByRole('navigation', { name: 'Server details' })

/** The labels of every link marked as the current page. */
const currentPageLinks = (): (string | null)[] =>
  screen
    .getAllByRole('link')
    .filter((link) => link.getAttribute('aria-current') === 'page')
    .map((link) => link.textContent)

const hasClass = (element: HTMLElement, className: string | undefined): boolean =>
  className !== undefined && element.classList.contains(className)

describe('RouteTabs', () => {
  it('marks the open child route’s tab, and only it, as the current page', async () => {
    // Arrange / Act
    renderServerPage({ initialEntries: ['/servers/example/relay'] })

    // Assert
    expect(await screen.findByText('relay panel')).toBeDefined()
    expect(currentPageLinks()).toEqual(['Relay'])
  })

  it('links each tab to its child route', async () => {
    // Arrange / Act
    renderServerPage({ initialEntries: ['/servers/example/status'] })

    // Assert
    await findStrip()
    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'))
    expect(hrefs).toEqual(serverTabs.map((tab) => `/servers/example/${tab.segment}`))
  })

  it('opens on the first tab through the index route’s redirect, keeping no bare entry', async () => {
    // Arrange / Act
    const history = renderServerPage({ initialEntries: ['/', '/servers/example'] })

    // Assert
    expect(await screen.findByText('status panel')).toBeDefined()
    expect(currentPageLinks()).toEqual(['Status'])
    expect(history.length).toBe(2)
    history.back()
    expect(await screen.findByText('Home')).toBeDefined()
  })

  it('navigates with `replace`, so Back leaves the page instead of stepping through tabs', async () => {
    // Arrange
    const history = renderServerPage({ initialEntries: ['/', '/servers/example/status'] })
    const user = userEvent.setup()

    // Act
    await user.click(await screen.findByRole('link', { name: 'Relay' }))

    // Assert
    expect(await screen.findByText('relay panel')).toBeDefined()
    expect(currentPageLinks()).toEqual(['Relay'])
    expect(history.length).toBe(2)
    history.back()
    expect(await screen.findByText('Home')).toBeDefined()
  })

  it('leaves a strip that fits unscrolled and unfaded', async () => {
    // Arrange / Act: jsdom has no layout, so every tab already fits.
    renderServerPage({ initialEntries: ['/servers/example/certificate'] })

    // Assert
    const strip = await findStrip()
    expect(strip.scrollLeft).toBe(0)
    expect(hasClass(strip, styles['route-tabs__strip--hidden-before'])).toBe(false)
    expect(hasClass(strip, styles['route-tabs__strip--hidden-after'])).toBe(false)
  })

  describe('in a strip too narrow for its tabs', () => {
    // A strip 200px wide (until a test narrows it) with 28px of scroll
    // padding a side, holding four 120px tabs side by side from its padding
    // edge: 480px of content.
    const tabWidth = 120
    const contentWidth = serverTabs.length * tabWidth
    const scrollPadding = 28
    const stripWidth = { current: 200 }

    const tabIndexOf = (link: Element): number =>
      serverTabs.findIndex((tab) => tab.label === link.textContent)

    beforeEach(() => {
      stripWidth.current = 200
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: Element
      ) {
        const strip = this.closest('nav')
        if (this.tagName === 'A' && strip !== null) {
          const left = tabIndexOf(this) * tabWidth - strip.scrollLeft
          return DOMRect.fromRect({ x: left, y: 0, width: tabWidth, height: 40 })
        }
        return DOMRect.fromRect({ x: 0, y: 0, width: stripWidth.current, height: 40 })
      })
      vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (
        this: Element
      ) {
        return this.tagName === 'NAV' ? stripWidth.current : 0
      })
      vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (
        this: Element
      ) {
        return this.tagName === 'NAV' ? contentWidth : 0
      })
      const realGetComputedStyle = window.getComputedStyle.bind(window)
      vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
        const computed = realGetComputedStyle(element)
        if (element.tagName !== 'NAV') {
          return computed
        }
        return new Proxy(computed, {
          get: (target, property) => {
            if (property === 'scrollPaddingInlineStart' || property === 'scrollPaddingInlineEnd') {
              return `${scrollPadding}px`
            }
            const value: unknown = Reflect.get(target, property)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
      })
    })

    it('scrolls the current tab clear of the fade at once on the first render', async () => {
      // Arrange / Act
      renderServerPage({ initialEntries: ['/servers/example/relay'] })

      // Assert: Relay spans 240–360px, so its end lands one scroll padding
      // short of the strip's end.
      const strip = await findStrip()
      expect(scrollToCalls[0]).toEqual({ left: 360 + scrollPadding - 200, behavior: 'instant' })
      expect(strip.scrollLeft).toBe(360 + scrollPadding - 200)
      expect(hasClass(strip, styles['route-tabs__strip--hidden-before'])).toBe(true)
      expect(hasClass(strip, styles['route-tabs__strip--hidden-after'])).toBe(true)
    })

    it('scrolls smoothly to each newly opened tab, to the very start for the first', async () => {
      // Arrange
      renderServerPage({ initialEntries: ['/servers/example/relay'] })
      const strip = await findStrip()
      const user = userEvent.setup()

      // Act
      await user.click(screen.getByRole('link', { name: 'Certificate' }))
      await screen.findByText('certificate panel')
      const scrollAtCertificate = strip.scrollLeft
      await user.click(screen.getByRole('link', { name: 'Status' }))
      await screen.findByText('status panel')

      // Assert: Certificate is the last tab, so the strip scrolls to its
      // end; Status is the first, so it scrolls back to 0, unfaded.
      expect(scrollAtCertificate).toBe(contentWidth - 200)
      expect(strip.scrollLeft).toBe(0)
      expect(scrollToCalls.slice(1).map((call) => call.behavior)).toEqual(['smooth', 'smooth'])
      expect(hasClass(strip, styles['route-tabs__strip--hidden-before'])).toBe(false)
      expect(hasClass(strip, styles['route-tabs__strip--hidden-after'])).toBe(true)
    })

    it('scrolls at once to a newly opened tab when motion is reduced', async () => {
      // Arrange
      stubReducedMotion(true)
      renderServerPage({ initialEntries: ['/servers/example/relay'] })
      await findStrip()
      const user = userEvent.setup()

      // Act
      await user.click(screen.getByRole('link', { name: 'Status' }))
      await screen.findByText('status panel')

      // Assert
      expect(scrollToCalls.map((call) => call.behavior)).toEqual(['instant', 'instant'])
    })

    it('re-reveals the current tab when the strip resizes', async () => {
      // Arrange: Access spans 120–240px.
      renderServerPage({ initialEntries: ['/servers/example/access'] })
      const strip = await findStrip()
      const scrollBeforeResize = strip.scrollLeft

      // Act
      stripWidth.current = 160
      fireResize()

      // Assert
      expect(scrollBeforeResize).toBe(240 + scrollPadding - 200)
      await waitFor(() => {
        expect(strip.scrollLeft).toBe(240 + scrollPadding - 160)
      })
      expect(scrollToCalls.at(-1)?.behavior).toBe('instant')
    })
  })

  describe('shape', () => {
    const rootOf = (strip: HTMLElement): HTMLElement => {
      const root = strip.parentElement
      if (root === null) {
        throw new Error('the strip sits in the component’s root')
      }
      return root
    }

    it('leaves the shape to the viewport media query by default', async () => {
      // Arrange / Act
      renderServerPage({ initialEntries: ['/servers/example/status'] })

      // Assert
      const root = rootOf(await findStrip())
      expect(hasClass(root, styles['route-tabs--sized-by-viewport'])).toBe(true)
      expect(hasClass(root, styles['route-tabs--wide'])).toBe(false)
    })

    it('is wide from `wideFromOwnWidth` of its own width, re-measuring on resize', async () => {
      // Arrange
      const rootWidth = { current: 600 }
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() =>
        DOMRect.fromRect({ x: 0, y: 0, width: rootWidth.current, height: 40 })
      )
      renderServerPage({ initialEntries: ['/servers/example/status'], wideFromOwnWidth: 600 })
      const root = rootOf(await findStrip())
      const wideAtThreshold = hasClass(root, styles['route-tabs--wide'])

      // Act
      rootWidth.current = 599
      fireResize()

      // Assert
      expect(wideAtThreshold).toBe(true)
      expect(hasClass(root, styles['route-tabs--wide'])).toBe(false)
      expect(hasClass(root, styles['route-tabs--sized-by-viewport'])).toBe(false)
    })
  })
})
