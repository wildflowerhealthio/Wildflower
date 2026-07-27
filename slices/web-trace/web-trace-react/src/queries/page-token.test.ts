import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { nextPageToken, type PageLink } from './page-token.ts'

describe('nextPageToken', () => {
  it('should read the cursor out of the next link', () => {
    // Arrange
    const links = [nextLink('https://device.local/fhir-r4/DocumentReference?_pageToken=abc123')]

    // Act
    const token = nextPageToken(links)

    // Assert
    expect(token).toBe('abc123')
  })

  it('should return undefined when the bundle has no next link', () => {
    // Arrange
    const links: readonly PageLink[] = [
      { relation: 'self', url: 'https://device.local/fhir-r4/DocumentReference?_pageToken=self' },
    ]

    // Act
    const token = nextPageToken(links)

    // Assert
    expect(token).toBeUndefined()
  })

  it('should return undefined when the next link carries no cursor', () => {
    // Arrange
    const links = [nextLink('https://device.local/fhir-r4/DocumentReference?category=web-trace')]

    // Act
    const token = nextPageToken(links)

    // Assert
    expect(token).toBeUndefined()
  })

  it('should read a cursor out of a server-relative next link', () => {
    // Arrange — HFS is free to return either an absolute or a relative link.
    const links = [nextLink('/fhir-r4/DocumentReference?category=web-trace&_pageToken=relative-1')]

    // Act
    const token = nextPageToken(links)

    // Assert
    expect(token).toBe('relative-1')
  })

  it('should return undefined when the next link is not a URL', () => {
    // Arrange
    const links = [nextLink('::not a url::')]

    // Act
    const token = nextPageToken(links)

    // Assert
    expect(token).toBeUndefined()
  })

  it('should always recover whatever cursor the next link carries', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (cursor) => {
        // Arrange
        const links = [
          nextLink(
            `https://device.local/fhir-r4/DocumentReference?category=web-trace&_pageToken=${encodeURIComponent(cursor)}`
          ),
        ]

        // Act
        const token = nextPageToken(links)

        // Assert
        expect(token).toBe(cursor)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should never read a cursor off a link that is not the next one', () => {
    fc.assert(
      fc.property(
        fc.string().filter((relation) => relation !== 'next'),
        fc.string({ minLength: 1 }),
        (relation, cursor) => {
          // Arrange
          const links: readonly PageLink[] = [
            {
              relation,
              url: `https://device.local/fhir-r4/DocumentReference?_pageToken=${cursor}`,
            },
          ]

          // Act
          const token = nextPageToken(links)

          // Assert
          expect(token).toBeUndefined()
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

const nextLink = (url: string): PageLink => ({ relation: 'next', url })
