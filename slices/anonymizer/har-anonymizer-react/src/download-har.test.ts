import { DateTime, Schema } from 'effect'
import * as fc from 'fast-check'
import { emitHarFromLog, type HttpArchive } from 'har-importer-core/har'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { anonymizedFileName, HAR_MEDIA_TYPE, harBlob } from './download-har.ts'

/**
 * The part of a HAR this file reads back, decoded rather than asserted: a cast
 * over `JSON.parse` would claim a shape the bytes might not have, which is the
 * one thing a round-trip test exists to check.
 */
const ArchiveShape = Schema.Struct({
  log: Schema.Struct({
    version: Schema.String,
    entries: Schema.Array(Schema.Unknown),
    comment: Schema.optional(Schema.String),
  }),
})
const parseArchive = Schema.decodeUnknownSync(Schema.parseJson(ArchiveShape))

const oneEntry = (): HttpArchive.Log => ({
  version: '1.2',
  entries: [
    {
      id: 'har-entry-0',
      url: 'https://example.org/api',
      method: 'GET',
      status: 200,
      statusText: 'OK',
      headers: [['content-type', 'application/json']],
      startedAt: DateTime.unsafeMake('2026-09-04T00:00:00Z'),
      body: new TextEncoder().encode('{"ok":true}'),
      bodyAbsent: false,
    },
  ],
})

describe('anonymizedFileName', () => {
  it('should append .anonymized.har to the source stem', () => {
    // Act / Assert
    expect(anonymizedFileName('chrome-fhir-capture.har')).toBe('chrome-fhir-capture.anonymized.har')
    expect(anonymizedFileName('capture.HAR')).toBe('capture.anonymized.har')
  })

  it('should keep a source name that is already anonymized-looking as-is', () => {
    // Arrange / Act / Assert — `example.har.har` is a name only a machine
    // wrote; strip one `.har` extension and treat the rest as the stem.
    expect(anonymizedFileName('example.har.har')).toBe('example.har.anonymized.har')
  })

  it('should never produce a path separator, whatever the picker called the file', () => {
    // Arrange — a source file name comes from the picker, not from this
    // package, so a `/` or `\` in it would read as a directory to the download
    // handler.
    fc.assert(
      fc.property(fc.string(), (fileName) => {
        // Act
        const output = anonymizedFileName(fileName)

        // Assert
        expect(output.includes('/')).toBe(false)
        expect(output.includes('\\')).toBe(false)
        expect(output.endsWith('.anonymized.har')).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('should never produce a hidden or extensionless file for a name with nothing safe in it', () => {
    // Arrange / Act / Assert — `.anonymized.har` alone is hidden on Unix and
    // would look like the download silently failed.
    expect(anonymizedFileName('')).toBe('archive.anonymized.har')
    expect(anonymizedFileName('///')).toBe('archive.anonymized.har')
    expect(anonymizedFileName('  ')).toBe('archive.anonymized.har')
    expect(anonymizedFileName('.har')).toBe('archive.anonymized.har')
  })
})

describe('harBlob', () => {
  it('should carry the archive as JSON of the media type a HAR is served as', async () => {
    // Arrange
    const archive = emitHarFromLog(oneEntry(), { comment: 'Anonymized: nothing verbatim' })

    // Act
    const blob = harBlob(archive)

    // Assert — the bytes are the archive, not a description of it
    expect(blob.type).toBe(HAR_MEDIA_TYPE)
    const parsed = parseArchive(await blob.text())
    expect(parsed.log.version).toBe('1.2')
    expect(parsed.log.entries).toHaveLength(1)
    expect(parsed.log.comment).toBe('Anonymized: nothing verbatim')
  })
})
