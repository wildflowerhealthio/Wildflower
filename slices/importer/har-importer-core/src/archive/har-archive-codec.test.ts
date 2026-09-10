import { DateTime, Effect, Encoding, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { emitHar, HarFromJson, HttpArchive } from 'http-archive'
import {
  HAR_ARCHIVE_CODE,
  isWebTrace,
  toDocumentReference,
  WEB_TRACE_CODE_SYSTEM,
  WEB_TRACE_RAW_CODE,
  WEB_TRACE_REDACTION_SYSTEM,
} from 'web-trace-core/codec'
import { arbitraries } from 'web-trace-core/test-helpers'
import type { HarArchive } from './har-archive-codec.ts'
import {
  HAR_ARCHIVE_CONTENT_TYPE,
  HarArchiveFromDocumentReference,
  HarArchiveFromFhirJson,
  harArchiveFromDocumentReference,
  harArchiveToDocumentReference,
  harArchiveToWire,
  isHarArchive,
} from './har-archive-codec.ts'

const { exchange: exchangeArbitrary } = arbitraries(fc)

/** Milliseconds at 2024-01-01T00:00:00Z — the floor for generated upload times. */
const UPLOAD_FLOOR = Date.UTC(2024, 0, 1)

const uuid = fc.uuid().map(String)

/**
 * Uploads of arbitrary **binary** content, not just decodable text.
 *
 * @remarks
 * A real upload is JSON, but the codec stores bytes verbatim and must not
 * quietly become a UTF-8 round trip — which only a byte sequence that is not
 * valid UTF-8 can catch.
 */
const archiveArbitrary: fc.Arbitrary<HarArchive> = fc.record({
  id: uuid,
  fileName: fc
    .stringMatching(/^[A-Za-z0-9 _.-]{1,40}$/u)
    .filter((name) => name.length > 0)
    .map((name) => `${name}.har`),
  uploadedAt: fc
    .integer({ min: UPLOAD_FLOOR, max: UPLOAD_FLOOR + 60 * 60 * 1000 })
    .map((millis) => DateTime.unsafeMake(millis)),
  bytes: fc.uint8Array({ maxLength: 512 }),
})

const harArchive = (overrides: Partial<HarArchive> = {}): HarArchive => ({
  id: '0c0f6e5a-2b2f-4a55-9a1e-0a1b2c3d4e5f',
  fileName: 'portal-session.har',
  uploadedAt: DateTime.unsafeMake(UPLOAD_FLOOR),
  bytes: new TextEncoder().encode('{"log":{"version":"1.2"}}'),
  ...overrides,
})

const roundTrip = (archive: HarArchive): Promise<HarArchive> =>
  Effect.runPromise(
    harArchiveToDocumentReference(archive).pipe(Effect.flatMap(harArchiveFromDocumentReference))
  )

/** `DateTime.Utc` values compare by identity under `toEqual`; compare the instants instead. */
const comparable = (
  archive: HarArchive
): Omit<HarArchive, 'uploadedAt'> & { readonly uploadedAtMillis: number } => {
  const { uploadedAt, ...rest } = archive
  return { ...rest, uploadedAtMillis: DateTime.toEpochMillis(uploadedAt) }
}

/**
 * The base64 SHA-256 of `bytes`, derived here rather than through the package's
 * own `sha256Base64` — a property about the attachment's hash that calls the
 * function that wrote it would pass no matter what either does.
 */
const digestOf = async (bytes: Uint8Array): Promise<string> =>
  Encoding.encodeBase64(
    new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))
  )

describe('HarArchive ⇄ DocumentReference', () => {
  test('property: an upload round-trips — filename, instant and bytes recovered exactly', async () => {
    await fc.assert(
      fc.asyncProperty(archiveArbitrary, async (archive) => {
        expect(comparable(await roundTrip(archive))).toEqual(comparable(archive))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: hash and size describe the attachment bytes', async () => {
    await fc.assert(
      fc.asyncProperty(archiveArbitrary, async (archive) => {
        const attachment = (await Effect.runPromise(harArchiveToDocumentReference(archive)))
          .content[0]?.attachment
        expect(attachment?.size).toBe(archive.bytes.length)
        expect(attachment?.hash).toBe(await digestOf(archive.bytes))
        expect(attachment?.data).toBe(Encoding.encodeBase64(archive.bytes))
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('property: subject is absent, keeping archives out of Patient/$everything', async () => {
    await fc.assert(
      fc.asyncProperty(archiveArbitrary, async (archive) => {
        expect(harArchiveToWire(archive, 'hash=').subject).toBeUndefined()
        expect(
          (await Effect.runPromise(harArchiveToDocumentReference(archive))).subject
        ).toBeUndefined()
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('property: the two document kinds are disjoint — neither predicate sees the other', async () => {
    await fc.assert(
      fc.asyncProperty(archiveArbitrary, exchangeArbitrary, async (archive, exchange) => {
        const archiveResource = await Effect.runPromise(harArchiveToDocumentReference(archive))
        const traceResource = await Effect.runPromise(toDocumentReference(exchange))

        expect(isHarArchive(archiveResource)).toBe(true)
        expect(isWebTrace(archiveResource)).toBe(false)
        expect(isWebTrace(traceResource)).toBe(true)
        expect(isHarArchive(traceResource)).toBe(false)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('property: a trace resource fails to decode as an archive', async () => {
    await fc.assert(
      fc.asyncProperty(exchangeArbitrary, async (exchange) => {
        const outcome = await Effect.runPromise(
          Effect.either(
            harArchiveFromDocumentReference(await Effect.runPromise(toDocumentReference(exchange)))
          )
        )
        expect(outcome._tag).toBe('Left')
        if (outcome._tag === 'Left') expect(outcome.left.message).toContain(HAR_ARCHIVE_CODE)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('bytes that are not valid UTF-8 survive the round trip', async () => {
    const archive = harArchive({ bytes: new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x41]) })
    expect((await roundTrip(archive)).bytes).toEqual(archive.bytes)
  })

  test('type and category carry the har-archive coding, and the attachment names the file', () => {
    const archive = harArchive()
    const wire = harArchiveToWire(archive, 'DEADBEEF/hash+base64=')

    expect(wire.type?.coding).toEqual([{ system: WEB_TRACE_CODE_SYSTEM, code: HAR_ARCHIVE_CODE }])
    expect(wire.category).toEqual([
      { coding: [{ system: WEB_TRACE_CODE_SYSTEM, code: HAR_ARCHIVE_CODE }] },
    ])
    expect(wire.securityLabel).toEqual([
      { coding: [{ system: WEB_TRACE_REDACTION_SYSTEM, code: WEB_TRACE_RAW_CODE }] },
    ])
    expect(wire.status).toBe('current')
    expect(wire.id).toBe(archive.id)
    expect(wire.description).toBe('HAR archive: portal-session.har')
    expect(wire.content[0]?.attachment).toMatchObject({
      contentType: HAR_ARCHIVE_CONTENT_TYPE,
      hash: 'DEADBEEF/hash+base64=',
      size: archive.bytes.length,
      title: 'portal-session.har',
      creation: '2024-01-01T00:00:00.000Z',
    })
    expect(wire.date).toBe('2024-01-01T00:00:00.000Z')
  })

  test('property: stored bytes still parse as an HTTP Archive after the round trip, which is the point of storing them', async () => {
    // The seam between this codec and the `http-archive` package: an archive is only worth
    // storing if what comes back out is still readable as the file that went
    // in. Nothing here parses the archive — `HarFromJson` and
    // `HttpArchive.LogFromHarJson` do, on the bytes this codec hands back.
    await fc.assert(
      fc.asyncProperty(
        fc.array(exchangeArbitrary, { minLength: 1, maxLength: 4 }),
        async (exchanges) => {
          const fileText = await Effect.runPromise(
            Schema.encode(HarFromJson)(emitHar(exchanges, { sessionId: 'session-0' }))
          )
          const stored = await roundTrip(harArchive({ bytes: new TextEncoder().encode(fileText) }))

          const log = await Effect.runPromise(
            Schema.decodeUnknown(HttpArchive.LogFromHarJson)(new TextDecoder().decode(stored.bytes))
          )
          expect(log.entries.map((entry) => entry.url).toSorted()).toEqual(
            exchanges.map((exchange) => exchange.url).toSorted()
          )
        }
      ),
      { numRuns: numRunsFor({ base: 25 }) }
    )
  })

  test('the same file uploaded twice is two documents, told apart by id and alike by hash', async () => {
    const bytes = new TextEncoder().encode('{"log":{"version":"1.2","entries":[]}}')
    const first = await Effect.runPromise(
      harArchiveToDocumentReference(harArchive({ id: 'upload-1', bytes }))
    )
    const second = await Effect.runPromise(
      harArchiveToDocumentReference(
        harArchive({ id: 'upload-2', bytes, uploadedAt: DateTime.unsafeMake(UPLOAD_FLOOR + 5_000) })
      )
    )

    expect(first.id).not.toBe(second.id)
    // Dedupe stays detectable without being forced.
    expect(first.content[0]?.attachment.hash).toBe(second.content[0]?.attachment.hash)
  })

  test('an id outside FHIR’s grammar fails to encode rather than reaching the server', async () => {
    const outcome = await Effect.runPromise(
      Effect.either(harArchiveToDocumentReference(harArchive({ id: 'not a legal id' })))
    )
    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left') expect(outcome.left._tag).toBe('ParseError')
  })

  test('an archive whose attachment carries no data fails to decode', async () => {
    const resource = await Effect.runPromise(harArchiveToDocumentReference(harArchive()))
    const dataless = resource.content.map((entry) => ({
      ...entry,
      attachment: { ...entry.attachment, data: null },
    }))
    const outcome = await Effect.runPromise(
      Effect.either(harArchiveFromDocumentReference({ ...resource, content: dataless }))
    )
    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left') expect(outcome.left.message).toContain('no data')
  })

  test('a decode failure names the offending resource, so a failing list says which one', async () => {
    const resource = await Effect.runPromise(harArchiveToDocumentReference(harArchive()))
    const outcome = await Effect.runPromise(
      Effect.either(harArchiveFromDocumentReference({ ...resource, category: [] }))
    )
    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left') expect(outcome.left.message).toContain(harArchive().id)
  })
})

describe('the archive codec as a schema', () => {
  test('property: HarArchiveFromFhirJson round-trips straight from FHIR JSON', async () => {
    await fc.assert(
      fc.asyncProperty(archiveArbitrary, async (archive) => {
        const json: unknown = JSON.parse(
          JSON.stringify(await Effect.runPromise(Schema.encode(HarArchiveFromFhirJson)(archive)))
        )
        const back = await Effect.runPromise(Schema.decodeUnknown(HarArchiveFromFhirJson)(json))
        expect(comparable(back)).toEqual(comparable(archive))
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('it composes like any other schema: a struct field decodes through it', async () => {
    const Envelope = Schema.Struct({ archive: HarArchiveFromDocumentReference })
    const archive = harArchive()
    const resource = await Effect.runPromise(harArchiveToDocumentReference(archive))
    const decoded = await Effect.runPromise(Schema.decode(Envelope)({ archive: resource }))
    expect(comparable(decoded.archive)).toEqual(comparable(archive))
  })
})
