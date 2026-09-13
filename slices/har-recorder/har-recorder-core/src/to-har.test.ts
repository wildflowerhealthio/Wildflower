import { DateTime, Effect, Encoding, Schema } from 'effect'
import * as fc from 'fast-check'
import { HarFromJson, HttpArchive, harToJson } from 'http-archive'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { Recording } from './recording.ts'
import { CREATOR_NAME, REQUEST_COMMENT, toHar } from './to-har.ts'

/** The archive as the text of a `.har` file — the sync twin of `harToJson`. */
const encodeHar = Schema.encodeSync(HarFromJson)
const readLog = Schema.decodeUnknownSync(HttpArchive.LogFromHarJson)
/** The same text read as a whole archive, which is what validates the format. */
const readHar = Schema.decodeUnknownSync(HarFromJson)

/** A recording built from a list of `(content type, body)` responses. */
const recordingOf = (
  responses: readonly (readonly [contentType: string, body: Uint8Array])[]
): Recording => {
  const recording = Recording.empty()
  responses.forEach(([contentType, body], index) => {
    const id = `req-${index}`
    recording.onResponseStart(
      {
        _tag: 'ResponseStart',
        id,
        url: `https://portal.example.org/api/${index}`,
        method: 'GET',
        status: 200,
        statusText: 'OK',
        headers: [['content-type', contentType]],
      },
      DateTime.unsafeMake(Date.UTC(2026, 8, 13, 14, 0, index))
    )
    recording.onResponseData({ _tag: 'ResponseData', id, data: Encoding.encodeBase64(body) })
    recording.onResponseFinished({ _tag: 'ResponseFinished', id })
  })
  return recording
}

const meta = {
  startUrl: 'https://portal.example.org/login',
  startedAt: DateTime.unsafeMake('2026-09-13T14:00:00Z'),
  stoppedAt: DateTime.unsafeMake('2026-09-13T14:05:30Z'),
} as const

/** A response body and the content type it was served as. */
const responseArbitrary = fc.tuple(
  fc.constantFrom('application/json', 'text/html', 'text/javascript', 'application/octet-stream'),
  fc.uint8Array()
)

describe('toHar', () => {
  it('should name the recorder and say the request side was never observed', () => {
    // Arrange
    const recording = recordingOf([['application/json', new TextEncoder().encode('{"ok":true}')]])

    // Act
    const archive = toHar(recording, meta)

    // Assert
    expect(archive.log.creator.name).toBe(CREATOR_NAME)
    expect(archive.log.entries[0]?.request.method).toBe('UNKNOWN')
    expect(archive.log.entries[0]?.request.comment).toBe(REQUEST_COMMENT)
    expect(REQUEST_COMMENT).toContain('response side only')
  })

  it('should state the run and what the recording left out on log.comment', () => {
    // Arrange
    const recording = recordingOf([])

    // Act
    const comment = toHar(recording, meta).log.comment

    // Assert
    expect(comment).toContain('https://portal.example.org/login')
    expect(comment).toContain('2026-09-13T14:00:00.000Z')
    expect(comment).toContain('2026-09-13T14:05:30.000Z')
    expect(comment).toContain('css/image/video/audio/font omitted')
    expect(comment).toContain('5242880 bytes omitted')
  })

  it('should default the creator version and take an override', () => {
    // Arrange
    const recording = recordingOf([])

    // Act / Assert
    expect(toHar(recording, meta).log.creator.version).toBe('0')
    expect(toHar(recording, { ...meta, creatorVersion: '1.4.0' }).log.creator.version).toBe('1.4.0')
  })

  it('should round-trip every recorded response back through the archive reader', () => {
    fc.assert(
      fc.property(fc.array(responseArbitrary), (responses) => {
        // Arrange
        const recording = recordingOf(responses)

        // Act — encode as the text of a `.har` file, then read it back the way
        // an importer does.
        const text = encodeHar(toHar(recording, meta))
        const log = readLog(text)

        // Assert — the text is a well-formed archive, and every response the
        // recording settled is still in it.
        expect(readHar(text).log.entries).toHaveLength(recording.count)
        expect(log.entries.map((entry) => entry.url)).toEqual(
          recording.entries().map((entry) => entry.url)
        )
        expect(log.entries.map((entry) => entry.status)).toEqual(
          recording.entries().map((entry) => entry.status)
        )
        expect(log.entries.map((entry) => entry.headers)).toEqual(
          recording.entries().map((entry) => entry.headers)
        )
        expect(log.entries.map((entry) => entry.body)).toEqual(
          recording.entries().map((entry) => entry.body)
        )
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should read back a body that is not valid UTF-8, byte for byte', () => {
    // Arrange — a lone 0xFF is not decodable as UTF-8, so a text round-trip
    // would mangle it.
    const body = new Uint8Array([0x00, 0xff, 0xfe, 0x42])
    const recording = recordingOf([['application/octet-stream', body]])

    // Act
    const log = readLog(encodeHar(toHar(recording, meta)))

    // Assert
    expect(log.entries[0]?.body).toEqual(body)
    expect(log.entries[0]?.bodyAbsent).toBe(false)
  })

  it('should keep entries in settle order through the archive', () => {
    // Arrange — three responses that settle in an order the URLs make visible.
    const recording = recordingOf([
      ['application/json', new TextEncoder().encode('a')],
      ['application/json', new TextEncoder().encode('b')],
      ['application/json', new TextEncoder().encode('c')],
    ])

    // Act
    const log = readLog(encodeHar(toHar(recording, meta)))

    // Assert
    expect(log.entries.map((entry) => entry.url)).toEqual([
      'https://portal.example.org/api/0',
      'https://portal.example.org/api/1',
      'https://portal.example.org/api/2',
    ])
  })
})

describe('toHar, through harToJson', () => {
  it('should produce text an archive reader accepts', async () => {
    // Arrange
    const recording = recordingOf([['application/json', new TextEncoder().encode('{"ok":true}')]])

    // Act
    const text = await Effect.runPromise(harToJson(toHar(recording, meta)))

    // Assert
    expect(readLog(text).entries).toHaveLength(1)
    expect(JSON.parse(text)).toMatchObject({ log: { version: '1.2' } })
  })
})
