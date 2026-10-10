import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { MAX_FILE_NAME_LENGTH, recordingFileName } from './file-name.ts'

/** What the host accepts: one segment, `.har`, and nothing exotic in between. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+\.har$/

const instantArbitrary = fc
  .date({ min: new Date('1970-01-01T00:00:00Z'), max: new Date('9999-12-31T23:59:59Z') })
  .map((date) => DateTime.unsafeFromDate(date))

describe('recordingFileName', () => {
  it('should name the file after the instant and the host', () => {
    // Arrange
    const startedAt = DateTime.unsafeMake('2026-09-13T14:02:11.523Z')

    // Act
    const name = recordingFileName(startedAt, 'https://portal.example.org/patients?q=ada')

    // Assert
    expect(name).toBe('2026-09-13T14-02-11Z-portal.example.org.har')
  })

  it('should fall back to "recording" when the URL has no usable host', () => {
    // Arrange
    const startedAt = DateTime.unsafeMake('2026-09-13T14:02:11Z')

    // Act / Assert
    expect(recordingFileName(startedAt, 'not a url at all')).toBe(
      '2026-09-13T14-02-11Z-recording.har'
    )
    expect(recordingFileName(startedAt, 'https://[2001:db8::1]/x')).toBe(
      '2026-09-13T14-02-11Z-2001db81.har'
    )
  })

  it('should always produce one safe path segment, for any URL', () => {
    fc.assert(
      fc.property(instantArbitrary, fc.string(), (startedAt, startUrl) => {
        // Act
        const name = recordingFileName(startedAt, startUrl)

        // Assert
        expect(name).toMatch(SAFE_SEGMENT)
        expect(name.length).toBeLessThanOrEqual(MAX_FILE_NAME_LENGTH)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('should never produce a separator, a drive letter or a traversal, for any web URL', () => {
    fc.assert(
      fc.property(instantArbitrary, fc.webUrl(), (startedAt, startUrl) => {
        // Act
        const name = recordingFileName(startedAt, startUrl)

        // Assert
        expect(name).toMatch(SAFE_SEGMENT)
        expect(name).not.toContain('/')
        expect(name).not.toContain('\\')
        expect(name).not.toContain(':')
        expect(name.split('-').includes('..')).toBe(false)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('should stay within the length limit even for an absurdly long host', () => {
    fc.assert(
      fc.property(
        instantArbitrary,
        fc.stringMatching(/^[a-z0-9]+$/).filter((label) => label.length > 0),
        (startedAt, label) => {
          // Arrange — a host far past the limit on its own.
          const host = Array.from({ length: 40 }, () => label).join('.')

          // Act
          const name = recordingFileName(startedAt, `https://${host}/`)

          // Assert
          expect(name).toMatch(SAFE_SEGMENT)
          expect(name.length).toBeLessThanOrEqual(MAX_FILE_NAME_LENGTH)
          // The instant is never what gets trimmed.
          expect(name.startsWith(`${DateTime.formatIsoDateUtc(startedAt)}T`)).toBe(true)
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should order chronologically when sorted as text', () => {
    fc.assert(
      fc.property(instantArbitrary, instantArbitrary, fc.webUrl(), (first, second, startUrl) => {
        // Arrange — the name states whole seconds, so only instants that differ
        // in seconds are ordered by it.
        const seconds = (instant: DateTime.Utc): number =>
          Math.floor(DateTime.toEpochMillis(instant) / 1000)
        fc.pre(seconds(first) !== seconds(second))
        const [earlierInstant, laterInstant] =
          seconds(first) < seconds(second) ? [first, second] : [second, first]

        // Act — the same host, so only the timestamp decides.
        const earlier = recordingFileName(earlierInstant, startUrl)
        const later = recordingFileName(laterInstant, startUrl)

        // Assert
        expect(earlier < later).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
