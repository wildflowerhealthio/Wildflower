import { Schema } from 'effect'
import * as fc from 'fast-check'
import { emitHar } from 'har-importer-core/har'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'
import { traceExchange } from 'web-trace-core/test-helpers'

import { HAR_MEDIA_TYPE, harBlob, harFileName } from './download-har.ts'

/**
 * The part of a HAR this file reads back, decoded rather than asserted: a cast
 * over `JSON.parse` would claim a shape the bytes might not have, which is the
 * one thing a round-trip test exists to check.
 */
const ArchiveShape = Schema.Struct({
  log: Schema.Struct({
    version: Schema.String,
    entries: Schema.Array(Schema.Unknown),
  }),
})
const parseArchive = Schema.decodeUnknownSync(Schema.parseJson(ArchiveShape))

describe('harFileName', () => {
  it('should name the archive after the session', () => {
    // Act / Assert
    expect(harFileName('session-2f8c')).toBe('web-trace-session-2f8c.har')
  })

  it('should never produce a path separator, whatever the capture called the session', () => {
    // Arrange — a session id comes from the capture, not from this package, so
    // a `/` in it would read as a directory to the download handler.
    fc.assert(
      fc.property(fc.string(), (sessionId) => {
        // Act
        const fileName = harFileName(sessionId)

        // Assert
        expect(fileName.includes('/')).toBe(false)
        expect(fileName.includes('\\')).toBe(false)
        expect(fileName.startsWith('web-trace-')).toBe(true)
        expect(fileName.endsWith('.har')).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('should never produce a hidden or extensionless file for an id with nothing safe in it', () => {
    // Arrange / Act / Assert — `.har` alone is hidden on Unix and would look
    // like the download silently failed.
    expect(harFileName('')).toBe('web-trace-session.har')
    expect(harFileName('///')).toBe('web-trace-session.har')
    expect(harFileName('  ')).toBe('web-trace-session.har')
  })
})

describe('harBlob', () => {
  it('should carry the archive as JSON of the media type a HAR is served as', async () => {
    // Arrange
    const archive = emitHar([traceExchange({ sessionId: 'morning', requestId: 'a' })], {
      sessionId: 'morning',
    })

    // Act
    const blob = harBlob(archive)

    // Assert — the bytes are the archive, not a description of it
    expect(blob.type).toBe(HAR_MEDIA_TYPE)
    const parsed = parseArchive(await blob.text())
    expect(parsed.log.version).toBe('1.2')
    expect(parsed.log.entries).toHaveLength(1)
  })
})
