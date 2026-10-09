import { describe, expect, it } from 'vite-plus/test'
import { deepLinkRedirect } from './deep-link-redirect.ts'

const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,*/*;q=0.8'

describe('deepLinkRedirect', () => {
  it('should send a browser deep link to the app root with the route in ?redirect=', () => {
    // Arrange — the link a debug Tauri host hands out for its device-flow page.
    const request = {
      method: 'GET',
      url: '/gatekeeper/devices?server=https%3A%2F%2Fruth.wildflowerhealth.io&user_code=WXYZ-2345',
      accept: BROWSER_ACCEPT,
    }

    // Act
    const location = deepLinkRedirect(request)

    // Assert
    expect(location).toBe(
      '/?server=https%3A%2F%2Fruth.wildflowerhealth.io&user_code=WXYZ-2345&redirect=%2Fgatekeeper%2Fdevices'
    )
  })

  it('should let Vite serve the app root itself', () => {
    expect(deepLinkRedirect({ method: 'GET', url: '/?server=x', accept: BROWSER_ACCEPT })).toBe(
      undefined
    )
  })

  it('should never redirect modules, assets, Vite internals or non-page requests', () => {
    // Each would break the page if bounced to the app root.
    const passThrough = [
      { method: 'GET', url: '/src/main-web.tsx', accept: '*/*' },
      { method: 'GET', url: '/@vite/client', accept: BROWSER_ACCEPT },
      { method: 'GET', url: '/favicon.svg', accept: BROWSER_ACCEPT },
      { method: 'GET', url: '/gatekeeper/devices', accept: 'application/json' },
      { method: 'POST', url: '/gatekeeper/devices', accept: BROWSER_ACCEPT },
      { method: 'GET', url: undefined, accept: BROWSER_ACCEPT },
    ]
    for (const request of passThrough) {
      expect(deepLinkRedirect(request), JSON.stringify(request)).toBeUndefined()
    }
  })
})
