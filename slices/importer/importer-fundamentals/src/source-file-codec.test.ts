import { DateTime, Effect, Encoding } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, test } from 'vite-plus/test'

import {
  FileImporter,
  type DocumentReferenceType,
  type SourceFile,
} from './file-importer-descriptor.ts'

const SYSTEM = 'https://example.test/fhir/CodeSystem/source-file'

const labelled = new FileImporter({
  format: 'example',
  coding: { system: SYSTEM, code: 'example-source-file' },
  contentType: 'application/json',
  securityLabel: [{ system: 'https://example.test/fhir/CodeSystem/redaction', code: 'raw' }],
  display: { title: 'Example source file', description: 'Test format' },
  detect: () => false,
  defaultSettings: undefined,
  decodeOne: () => Effect.succeed({ sections: [], notes: [] }),
})

const UPLOAD_FLOOR = Date.UTC(2026, 0, 1)

const sourceFileArbitrary: fc.Arbitrary<SourceFile> = fc.record({
  id: fc.uuid().map(String),
  fileName: fc
    .stringMatching(/^[A-Za-z0-9 _.-]{1,40}$/u)
    .filter((name) => name.length > 0)
    .map((name) => `${name}.bin`),
  uploadedAt: fc
    .integer({ min: UPLOAD_FLOOR, max: UPLOAD_FLOOR + 60 * 60 * 1000 })
    .map((millis) => DateTime.unsafeMake(millis)),
  bytes: fc.uint8Array({ maxLength: 512 }),
})

const example = (overrides: Partial<SourceFile> = {}): SourceFile => ({
  id: '0c0f6e5a-2b2f-4a55-9a1e-0a1b2c3d4e5f',
  fileName: 'upload.bin',
  uploadedAt: DateTime.unsafeMake(UPLOAD_FLOOR),
  bytes: new TextEncoder().encode('example bytes'),
  ...overrides,
})

const roundTrip = (sourceFile: SourceFile): Promise<SourceFile> =>
  Effect.runPromise(
    labelled
      .sourceFileToDocumentReference(sourceFile)
      .pipe(Effect.flatMap(labelled.sourceFileFromDocumentReference))
  )

const comparable = (
  sourceFile: SourceFile
): Omit<SourceFile, 'uploadedAt'> & { readonly uploadedAtMillis: number } => {
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
        const attachment = (
          await Effect.runPromise(labelled.sourceFileToDocumentReference(sourceFile))
        ).content[0]?.attachment
        expect(attachment?.size).toBe(sourceFile.bytes.length)
        expect(attachment?.hash).toBe(await digestOf(sourceFile.bytes))
        expect(attachment?.data).toBe(Encoding.encodeBase64(sourceFile.bytes))
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('bytes that are not valid UTF-8 survive the round trip', async () => {
    const sourceFile = example({ bytes: new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x41]) })
    expect((await roundTrip(sourceFile)).bytes).toEqual(sourceFile.bytes)
  })

  test('property: subject is absent, keeping source files out of Patient/$everything', async () => {
    await fc.assert(
      fc.asyncProperty(sourceFileArbitrary, async (sourceFile) => {
        expect(
          (await Effect.runPromise(labelled.sourceFileToDocumentReference(sourceFile))).subject
        ).toBeUndefined()
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('carries the coding on both type and category', async () => {
    const resource = await Effect.runPromise(labelled.sourceFileToDocumentReference(example()))
    expect(
      resource.type?.coding.map((c) => ({ system: c.system?.toString(), code: c.code }))
    ).toEqual([{ system: SYSTEM, code: 'example-source-file' }])
    expect(
      resource.category.map((cat) =>
        cat.coding.map((c) => ({ system: c.system?.toString(), code: c.code }))
      )
    ).toEqual([[{ system: SYSTEM, code: 'example-source-file' }]])
  })

  it('exposes the category token in system|code form', () => {
    expect(labelled.categoryToken).toBe(`${SYSTEM}|example-source-file`)
  })

  it('rejects a resource whose attachment carries no data', async () => {
    const resource = await Effect.runPromise(labelled.sourceFileToDocumentReference(example()))
    const dataless = resource.content.map((entry) => ({
      ...entry,
      attachment: { ...entry.attachment, data: null },
    }))
    const outcome = await Effect.runPromise(
      Effect.either(labelled.sourceFileFromDocumentReference({ ...resource, content: dataless }))
    )
    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left') expect(outcome.left.message).toContain('no data')
  })

  it('a decode failure names the offending resource, so a failing list says which one', async () => {
    const resource = await Effect.runPromise(labelled.sourceFileToDocumentReference(example()))
    const outcome = await Effect.runPromise(
      Effect.either(labelled.sourceFileFromDocumentReference({ ...resource, category: [] }))
    )
    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left') expect(outcome.left.message).toContain(resource.id)
  })
})

describe('buildSourceFile — the deterministic mint', () => {
  const mint = (picked: { fileName: string; bytes: Uint8Array }): Promise<DocumentReferenceType> =>
    Effect.runPromise(labelled.buildSourceFile(picked))

  it('derives the id from the bytes and name — the same file mints the same id', async () => {
    const picked = { fileName: 'report.bin', bytes: new TextEncoder().encode('same bytes') }
    const first = await mint(picked)
    const second = await mint(picked)
    expect(first.id).toBe(second.id)
    expect(first.id).toMatch(/^wf-[0-9a-f]{32}$/u)
  })

  it('varies the id when the name changes but the bytes do not', async () => {
    const bytes = new TextEncoder().encode('identical content')
    const first = await mint({ fileName: 'a.bin', bytes })
    const second = await mint({ fileName: 'b.bin', bytes })
    expect(first.id).not.toBe(second.id)
  })

  it('varies the id when the bytes change but the name does not', async () => {
    const first = await mint({ fileName: 'same.bin', bytes: new TextEncoder().encode('one') })
    const second = await mint({ fileName: 'same.bin', bytes: new TextEncoder().encode('two') })
    expect(first.id).not.toBe(second.id)
  })

  it('namespaces the id by coding system — two formats never collide on identical bytes and name', async () => {
    const picked = { fileName: 'report.bin', bytes: new TextEncoder().encode('shared') }
    const other = new FileImporter({
      format: 'other',
      coding: {
        system: 'https://other.test/fhir/CodeSystem/source-file',
        code: 'example-source-file',
      },
      contentType: 'application/json',
      display: { title: 'Other source file', description: 'Test' },
      detect: () => false,
      defaultSettings: undefined,
      decodeOne: () => Effect.succeed({ sections: [], notes: [] }),
    })
    const here = await mint(picked)
    const there = await Effect.runPromise(other.buildSourceFile(picked))
    expect(here.id).not.toBe(there.id)
  })

  it('mints a resource that reads back as its own source file, bytes and name recovered', async () => {
    const bytes = new TextEncoder().encode('round-trip me')
    const resource = await mint({ fileName: 'doc.bin', bytes })
    expect(labelled.isSourceFile(resource)).toBe(true)
    const back = await Effect.runPromise(labelled.sourceFileFromDocumentReference(resource))
    expect(back.fileName).toBe('doc.bin')
    expect(back.bytes).toEqual(bytes)
    expect(back.id).toBe(resource.id)
  })
})
