import { DateTime, Effect, Either, Encoding, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, test } from 'vite-plus/test'

import { LIFELABS_SYSTEM } from '../source-system.ts'
import type { LifeLabsPdfArchive } from './lifelabs-pdf-archive-codec.ts'
import {
  isLifeLabsPdfArchive,
  LIFELABS_PDF_ARCHIVE_CATEGORY_TOKEN,
  LIFELABS_PDF_ARCHIVE_CODE,
  LIFELABS_PDF_ARCHIVE_CONTENT_TYPE,
  LifeLabsPdfArchiveFromDocumentReference,
  lifeLabsPdfArchiveFromDocumentReference,
  lifeLabsPdfArchiveToDocumentReference,
  lifeLabsPdfArchiveToWire,
} from './lifelabs-pdf-archive-codec.ts'

/**
 * The codec is one `Schema.transformOrFail` — the round-trip is what pins
 * behaviour. The property tests exercise arbitrary bytes (a PDF is binary
 * and the codec must not silently UTF-8 round trip); the example tests pin
 * the wire shape (content type, coding on both `type` and `category`,
 * `subject` deliberately absent, hash matches the bytes).
 */

const UPLOAD_FLOOR = Date.UTC(2026, 0, 1)

const uuid = fc.uuid().map(String)

/** Arbitrary uploads of arbitrary binary bytes — PDFs are not UTF-8. */
const archiveArbitrary: fc.Arbitrary<LifeLabsPdfArchive> = fc.record({
  id: uuid,
  fileName: fc
    .stringMatching(/^[A-Za-z0-9 _.-]{1,40}$/u)
    .filter((name) => name.length > 0)
    .map((name) => `${name}.pdf`),
  uploadedAt: fc
    .integer({ min: UPLOAD_FLOOR, max: UPLOAD_FLOOR + 60 * 60 * 1000 })
    .map((millis) => DateTime.unsafeMake(millis)),
  bytes: fc.uint8Array({ maxLength: 512 }),
})

const lifeLabsArchive = (overrides: Partial<LifeLabsPdfArchive> = {}): LifeLabsPdfArchive => ({
  id: '0c0f6e5a-2b2f-4a55-9a1e-0a1b2c3d4e5f',
  fileName: 'lab-report.pdf',
  uploadedAt: DateTime.unsafeMake(UPLOAD_FLOOR),
  // A real PDF starts `%PDF-`; the bytes here are only a placeholder — the
  // codec stores whatever it's handed.
  bytes: new TextEncoder().encode('%PDF-1.7\n%\xff\xfa\ntest'),
  ...overrides,
})

const roundTrip = (archive: LifeLabsPdfArchive): Promise<LifeLabsPdfArchive> =>
  Effect.runPromise(
    lifeLabsPdfArchiveToDocumentReference(archive).pipe(
      Effect.flatMap(lifeLabsPdfArchiveFromDocumentReference)
    )
  )

/** `DateTime.Utc` values compare by identity; compare the instants instead. */
const comparable = (
  archive: LifeLabsPdfArchive
): Omit<LifeLabsPdfArchive, 'uploadedAt'> & { readonly uploadedAtMillis: number } => {
  const { uploadedAt, ...rest } = archive
  return { ...rest, uploadedAtMillis: DateTime.toEpochMillis(uploadedAt) }
}

/**
 * The base64 SHA-256 of `bytes`, derived here rather than through the
 * package's own `sha256Base64` — a property about the attachment's hash
 * that called the function that wrote it would pass no matter what.
 */
const digestOf = async (bytes: Uint8Array): Promise<string> => {
  // Copy into a fresh ArrayBuffer view so the digest input is unambiguously
  // an ArrayBuffer (jsdom's SubtleCrypto is picky about buffer types).
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer)
  return Encoding.encodeBase64(new Uint8Array(digest))
}

describe('LifeLabsPdfArchiveFromDocumentReference', () => {
  test('property: encode ↔ decode is the identity on arbitrary archives', async () => {
    await fc.assert(
      fc.asyncProperty(archiveArbitrary, async (archive) => {
        const back = await roundTrip(archive)
        expect(comparable(back)).toEqual(comparable(archive))
      }),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })

  it('encodes a PDF archive with the LifeLabs coding on both type and category', async () => {
    const archive = lifeLabsArchive()

    const resource = await Effect.runPromise(lifeLabsPdfArchiveToDocumentReference(archive))

    // `system` is a URI-typed value on the decoded schema (URL, not string);
    // compare via toString to keep the assertion resilient to that.
    expect(resource.type?.coding[0]?.system?.toString()).toBe(LIFELABS_SYSTEM)
    expect(resource.type?.coding[0]?.code).toBe(LIFELABS_PDF_ARCHIVE_CODE)
    expect(resource.category[0]?.coding[0]?.system?.toString()).toBe(LIFELABS_SYSTEM)
    expect(resource.category[0]?.coding[0]?.code).toBe(LIFELABS_PDF_ARCHIVE_CODE)
    expect(isLifeLabsPdfArchive(resource)).toBe(true)
  })

  it('writes the bytes verbatim on the attachment, with matching hash and size', async () => {
    const archive = lifeLabsArchive()

    const resource = await Effect.runPromise(lifeLabsPdfArchiveToDocumentReference(archive))
    const attachment = resource.content[0]?.attachment

    expect(attachment?.contentType).toBe(LIFELABS_PDF_ARCHIVE_CONTENT_TYPE)
    expect(attachment?.size).toBe(archive.bytes.length)
    expect(attachment?.hash).toBe(await digestOf(archive.bytes))
    expect(attachment?.title).toBe(archive.fileName)
  })

  it('omits `subject` — a lab-report archive is an engineering artifact', async () => {
    const archive = lifeLabsArchive()

    const resource = await Effect.runPromise(lifeLabsPdfArchiveToDocumentReference(archive))

    // The decoded resource schema initialises `subject` to `null`; the wire
    // form omits it. Either way it does not point at a Patient.
    expect(resource.subject ?? null).toBeNull()
  })

  it('rejects a resource without the LifeLabs-PDF coding as a ParseError', async () => {
    // A well-formed DocumentReference with different coding — say, HAR.
    const outcome = await Effect.runPromise(
      Effect.either(
        Schema.decodeUnknown(LifeLabsPdfArchiveFromDocumentReference)({
          resourceType: 'DocumentReference',
          id: 'x',
          status: 'current',
          type: { coding: [{ system: 'wrong-system', code: 'wrong-code' }] },
          category: [{ coding: [{ system: 'wrong-system', code: 'wrong-code' }] }],
          content: [
            {
              attachment: {
                contentType: 'application/pdf',
                data: Encoding.encodeBase64(new Uint8Array([0x25, 0x50, 0x44, 0x46])),
              },
            },
          ],
        })
      )
    )

    expect(Either.isLeft(outcome)).toBe(true)
  })

  it('exposes the category search token in `system|code` form', () => {
    expect(LIFELABS_PDF_ARCHIVE_CATEGORY_TOKEN).toBe(
      `${LIFELABS_SYSTEM}|${LIFELABS_PDF_ARCHIVE_CODE}`
    )
  })

  it('lifeLabsPdfArchiveToWire mirrors the codec output for a known hash', () => {
    const archive = lifeLabsArchive()
    const hash = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

    const wire = lifeLabsPdfArchiveToWire(archive, hash)

    expect(wire.content?.[0]?.attachment?.hash).toBe(hash)
    expect(wire.description).toBe(`LifeLabs report PDF: ${archive.fileName}`)
  })
})
