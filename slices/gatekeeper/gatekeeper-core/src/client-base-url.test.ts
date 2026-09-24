import { readFileSync } from 'node:fs'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'
import { CLIENT_BASE_URL_PARAM, pageOnClientCopy, parseClientBaseUrl } from './client-base-url.ts'

// The server reads the parameter under the name `client_base_url.rs` spells.
// Rust can't import it, so this reads the Rust source and holds both sides to
// one value.
describe('CLIENT_BASE_URL_PARAM', () => {
  it('should be spelled the way gatekeeper-rust reads it', () => {
    // Arrange
    const source = readFileSync(
      new URL('../../gatekeeper-rust/src/domain/client_base_url.rs', import.meta.url),
      'utf8'
    )

    // Act
    const rustParam = /const CLIENT_BASE_URL_PARAM: &str = "([^"]*)";/.exec(source)?.[1]

    // Assert
    expect(rustParam).toBe(CLIENT_BASE_URL_PARAM)
  })
})

describe('parseClientBaseUrl', () => {
  it('should normalize to a slash-terminated base without query or fragment', () => {
    // Arrange
    const raw = 'https://wildflowerhealthio.github.io/staging/pr-736/app?x=1#y'

    // Act
    const clientBase = parseClientBaseUrl(raw)

    // Assert
    expect(clientBase?.href).toBe('https://wildflowerhealthio.github.io/staging/pr-736/app/')
  })

  it.each(['/staging/app/', '', 'javascript:alert(1)', 'data:text/html,hi', 'ftp://example.com/'])(
    'should reject %j, which is not an absolute http or https URL',
    (raw) => {
      // Act
      const clientBase = parseClientBaseUrl(raw)

      // Assert
      expect(clientBase).toBeUndefined()
    }
  )

  it('should only ever return an http or https base', () => {
    fc.assert(
      fc.property(fc.oneof(fc.webUrl(), fc.string()), (raw) => {
        // Act
        const clientBase = parseClientBaseUrl(raw)

        // Assert
        if (clientBase !== undefined) {
          expect(['http:', 'https:']).toContain(clientBase.protocol)
          expect(clientBase.pathname.endsWith('/')).toBe(true)
        }
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})

describe('pageOnClientCopy', () => {
  it('should put the route under the copy and drop only the confirmation param', () => {
    // Arrange
    const clientBase = new URL('https://wildflowerhealthio.github.io/staging/pr-736/app/')
    const search = `?server=http%3A%2F%2F127.0.0.1&user_code=WXYZ-2345&${CLIENT_BASE_URL_PARAM}=${encodeURIComponent(clientBase.href)}`

    // Act
    const page = pageOnClientCopy(clientBase, '/gatekeeper/devices', search)

    // Assert
    expect(page).toBe(
      'https://wildflowerhealthio.github.io/staging/pr-736/app/gatekeeper/devices?server=http%3A%2F%2F127.0.0.1&user_code=WXYZ-2345'
    )
  })

  it.each(['/a:b/c', '\\\\evil.example/x', '//evil.example/x'])(
    'should keep the route %j on the copy',
    (route) => {
      // Arrange
      const clientBase = new URL('https://example.test/app/')

      // Act
      const page = new URL(pageOnClientCopy(clientBase, route, ''))

      // Assert
      expect(page.origin).toBe(clientBase.origin)
    }
  )

  it('should always land on the copy it names', () => {
    fc.assert(
      fc.property(
        fc.webUrl({ withQueryParameters: true, withFragments: true }),
        fc.oneof(fc.webPath(), fc.string()),
        fc.string(),
        (rawBase, route, search) => {
          // Arrange
          const clientBase = parseClientBaseUrl(rawBase)
          if (clientBase === undefined) return

          // Act
          const page = new URL(pageOnClientCopy(clientBase, route, search))

          // Assert
          expect(page.origin).toBe(clientBase.origin)
          expect(page.searchParams.has(CLIENT_BASE_URL_PARAM)).toBe(false)
        }
      ),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })
})
