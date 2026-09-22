import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { localNetworkAccessHint } from './local-network-hint.ts'

describe('localNetworkAccessHint', () => {
  it('names Chrome’s Local Network Access prompt for a loopback target from a secure page', () => {
    // Arrange / Act — the published https page reaching a desktop host's
    // loopback API: the one case Chrome guards behind that prompt.
    const hint = localNetworkAccessHint('http://127.0.0.1:8080', { pageIsSecure: true })

    // Assert
    expect(hint).toBeDefined()
    expect(hint).toContain('Local Network Access')
  })

  it('covers every loopback form the flow accepts', () => {
    // The same hosts `isLoopbackHost` treats as reachable over plain http, so
    // the hint tracks the reachability rule rather than a second copy of it.
    for (const host of ['localhost', '127.0.0.1', '127.5.6.7', '[::1]']) {
      expect(localNetworkAccessHint(`http://${host}:8080`, { pageIsSecure: true })).toBeDefined()
    }
  })

  it('is silent unless the page itself is secure', () => {
    // A dev page served over plain http (the loopback origin itself) is not
    // making the public→local jump the prompt is about.
    expect(localNetworkAccessHint('http://127.0.0.1:8080', { pageIsSecure: false })).toBeUndefined()
  })

  it('is silent for a remote server, which has no Local Network Access gate', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('my-server.wildflowerhealth.io', 'example.com', 'api.test'),
        (host) => {
          expect(localNetworkAccessHint(`https://${host}`, { pageIsSecure: true })).toBeUndefined()
        }
      ),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })

  it('is silent for a target that is not a URL at all', () => {
    expect(localNetworkAccessHint('not a url', { pageIsSecure: true })).toBeUndefined()
  })
})
