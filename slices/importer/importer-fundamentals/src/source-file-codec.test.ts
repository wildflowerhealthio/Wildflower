import { DateTime, Effect, Encoding, Schema, TestContext } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, test } from 'vite-plus/test'

import * as SourceFileCodec from './source-file-codec.ts'
import type * as SourceFile from './source-file.ts'

const SYSTEM = 'https://example.test/fhir/CodeSystem/source-file'

const exampleFormat: SourceFileCodec.Format = {
  coding: { system: SYSTEM, code: 'example-source-file' },
  contentType: 'application/json',
  securityLabel: [{ system: 'https://example.test/fhir/CodeSystem/redaction', code: 'raw' }],
  descriptionPrefix: 'Example source file: ',
}

/** The same codec bound to a second format — what "another format's document" means below. */
const otherFormat: SourceFileCodec.Format = {
  ...exampleFormat,
  coding: { system: 'https://other.test/fhir/CodeSystem/source-file', code: 'other-source-file' },
}

const runAs = <A, E>(
  format: SourceFileCodec.Format,
  effect: Effect.Effect<A, E, SourceFileCodec.FormatContext>
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(SourceFileCodec.FormatContext, format),
      Effect.provide(TestContext.TestContext)
    )
  )

const run = <A, E>(effect: Effect.Effect<A, E, SourceFileCodec.FormatContext>): Promise<A> =>
  runAs(exampleFormat, effect)

const mint = (fileName: string, bytes: Uint8Array): Promise<SourceFile.Type> =>
  run(SourceFileCodec.tryFromNamedBytes({ fileName, bytes }))

const nameArbitrary = fc.stringMatching(/^[a-z0-9]{1,8}\.bin$/u)

describe('tryFromNamedBytes — the deterministic mint', () => {
  it('property: the id is decided by the bytes and the name together, and by nothing else', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ maxLength: 64 }),
        nameArbitrary,
        fc.uint8Array({ maxLength: 64 }),
        nameArbitrary,
        async (bytesHere, nameHere, bytesThere, nameThere) => {
          const here = await mint(nameHere, bytesHere)
          const there = await mint(nameThere, bytesThere)
          const sameFile =
            nameHere === nameThere &&
            Encoding.encodeBase64(bytesHere) === Encoding.encodeBase64(bytesThere)
          expect(here.id === there.id).toBe(sameFile)
        }
      ),
      { numRuns: numRunsFor({ base: 40 }) }
    )
  })

  it('namespaces the id by the coding system, so two formats never collide', async () => {
    const picked = { fileName: 'report.bin', bytes: new TextEncoder().encode('shared') }
    const here = await runAs(exampleFormat, SourceFileCodec.tryFromNamedBytes(picked))
    const there = await runAs(otherFormat, SourceFileCodec.tryFromNamedBytes(picked))
    expect(here.id).not.toBe(there.id)
  })

  it('keeps the name and the bytes verbatim', async () => {
    const bytes = new Uint8Array([0, 255, 128])
    const sourceFile = await mint('binary.bin', bytes)
    expect(sourceFile.fileName).toBe('binary.bin')
    expect(sourceFile.bytes).toEqual(bytes)
  })
})

// ---------------------------------------------------------------------------
// encode / FromDocumentReferenceSchema — the codec proper
// ---------------------------------------------------------------------------

const UPLOAD_FLOOR = Date.UTC(2026, 0, 1)

const sourceFileArbitrary: fc.Arbitrary<SourceFile.Type> = fc.record({
  id: fc.uuid().map(String),
  fileName: nameArbitrary,
  uploadedAt: fc
    .integer({ min: UPLOAD_FLOOR, max: UPLOAD_FLOOR + 60 * 60 * 1000 })
    .map((millis) => DateTime.unsafeMake(millis)),
  bytes: fc.uint8Array({ maxLength: 512 }),
})

const example = (overrides: Partial<SourceFile.Type> = {}): SourceFile.Type => ({
  id: '0c0f6e5a-2b2f-4a55-9a1e-0a1b2c3d4e5f',
  fileName: 'upload.bin',
  uploadedAt: DateTime.unsafeMake(UPLOAD_FLOOR),
  bytes: new TextEncoder().encode('example bytes'),
  ...overrides,
})

const readBack = Schema.decode(SourceFileCodec.FromDocumentReferenceSchema)

const roundTrip = (sourceFile: SourceFile.Type): Promise<SourceFile.Type> =>
  run(SourceFileCodec.encode(sourceFile).pipe(Effect.flatMap(readBack)))

/** `uploadedAt` is a `DateTime`; compared by its instant so two equal times match. */
const comparable = (
  sourceFile: SourceFile.Type
): Omit<SourceFile.Type, 'uploadedAt'> & { readonly uploadedAtMillis: number } => {
  const { uploadedAt, ...rest } = sourceFile
  return { ...rest, uploadedAtMillis: DateTime.toEpochMillis(uploadedAt) }
}

const digestOf = async (bytes: Uint8Array): Promise<string> => {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer)
  return Encoding.encodeBase64(new Uint8Array(digest))
}

describe('the codec as a schema', () => {
  test('property: an upload round-trips — id, filename, instant and bytes recovered exactly', async () => {
    await fc.assert(
      fc.asyncProperty(sourceFileArbitrary, async (sourceFile) => {
        expect(comparable(await roundTrip(sourceFile))).toEqual(comparable(sourceFile))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: hash and size describe the attachment bytes, stored verbatim', async () => {
    await fc.assert(
      fc.asyncProperty(sourceFileArbitrary, async (sourceFile) => {
        const attachment = (await run(SourceFileCodec.encode(sourceFile))).content[0]?.attachment
        expect(attachment?.size).toBe(sourceFile.bytes.length)
        expect(attachment?.hash).toBe(await digestOf(sourceFile.bytes))
        expect(attachment?.data).toBe(Encoding.encodeBase64(sourceFile.bytes))
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('bytes that are not valid UTF-8 survive the round trip', async () => {
    const sourceFile = example({ bytes: new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x41]) })
    expect((await roundTrip(sourceFile)).bytes).toEqual(sourceFile.bytes)
  })

  test('property: subject is absent unless one is named, keeping source files out of Patient/$everything', async () => {
    await fc.assert(
      fc.asyncProperty(sourceFileArbitrary, async (sourceFile) => {
        expect((await run(SourceFileCodec.encode(sourceFile))).subject).toBeNull()
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('property: the subject-bearing encode files the resource under exactly that reference', async () => {
    await fc.assert(
      fc.asyncProperty(sourceFileArbitrary, fc.uuid(), async (sourceFile, patientId) => {
        const resource = await run(
          SourceFileCodec.encode(sourceFile, { reference: `Patient/${patientId}` })
        )
        expect(resource.subject?.reference).toBe(`Patient/${patientId}`)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('carries the format context coding on both type and category', async () => {
    const resource = await run(SourceFileCodec.encode(example()))
    expect(
      resource.type?.coding.map((one) => ({ system: one.system?.toString(), code: one.code }))
    ).toEqual([exampleFormat.coding])
    expect(
      resource.category.map((category) =>
        category.coding.map((one) => ({ system: one.system?.toString(), code: one.code }))
      )
    ).toEqual([[exampleFormat.coding]])
  })

  it('rejects a resource whose attachment carries no data', async () => {
    const resource = await run(SourceFileCodec.encode(example()))
    const dataless = resource.content.map((entry) => ({
      ...entry,
      attachment: { ...entry.attachment, data: null },
    }))
    const outcome = await run(Effect.either(readBack({ ...resource, content: dataless })))
    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left') expect(outcome.left.message).toContain('no data')
  })

  it('a decode failure names the offending resource, so a failing list says which one', async () => {
    const resource = await run(SourceFileCodec.encode(example()))
    const outcome = await run(Effect.either(readBack({ ...resource, category: [] })))
    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left') expect(outcome.left.message).toContain(resource.id)
  })

  it("another format's document is not this one's source file", async () => {
    const resource = await runAs(otherFormat, SourceFileCodec.encode(example()))
    const outcome = await run(Effect.either(readBack(resource)))
    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left') expect(outcome.left.message).toContain(exampleFormat.coding.code)
  })
})
