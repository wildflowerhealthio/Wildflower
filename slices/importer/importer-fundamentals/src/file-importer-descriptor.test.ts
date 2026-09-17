import { DateTime, Effect, Encoding, ParseResult, Schema, TestClock, TestContext } from 'effect'
import * as fc from 'fast-check'
import { type FhirResource, Patient } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, test } from 'vite-plus/test'
import type * as DecodedFile from './decoded-file.ts'
import { FileImporter, type DocumentReferenceType } from './file-importer-descriptor.ts'
import type * as FormatDecode from './format-decode.ts'
import * as PickedFileSource from './picked-file.ts'
import type { PickedFile } from './picked-file.ts'
import * as SourceFile from './source-file.ts'

const SYSTEM = 'https://example.test/fhir/CodeSystem/source-file'

// ---------------------------------------------------------------------------
// The codec as a schema / the deterministic mint
// ---------------------------------------------------------------------------

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

const sourceFileArbitrary: fc.Arbitrary<SourceFile.Type> = fc.record({
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

const example = (overrides: Partial<SourceFile.Type> = {}): SourceFile.Type => ({
  id: '0c0f6e5a-2b2f-4a55-9a1e-0a1b2c3d4e5f',
  fileName: 'upload.bin',
  uploadedAt: DateTime.unsafeMake(UPLOAD_FLOOR),
  bytes: new TextEncoder().encode('example bytes'),
  ...overrides,
})

const roundTrip = (sourceFile: SourceFile.Type): Promise<SourceFile.Type> =>
  Effect.runPromise(
    labelled
      .sourceFileToDocumentReference(sourceFile)
      .pipe(Effect.flatMap(labelled.sourceFileFromDocumentReference))
  )

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

// ---------------------------------------------------------------------------
// resolve / decode — the batch decode pipeline
// ---------------------------------------------------------------------------

const fakeResource = (id: string): FhirResource =>
  Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', id })

const localFile = (fileName: string, bytes: Uint8Array): PickedFile => ({
  fileName,
  bytes,
  source: PickedFileSource.local,
})

const decodeBytes = (
  file: PickedFile,
  _settings: null
): Effect.Effect<DecodedFile.DecodedFile, ParseResult.ParseError> =>
  file.bytes.length === 0
    ? Effect.fail(
        new ParseResult.ParseError({
          issue: new ParseResult.Type(Schema.Unknown.ast, file.fileName, 'empty file'),
        })
      )
    : Effect.succeed({
        sections: [
          {
            title: file.fileName,
            resources: [...file.bytes].map((byte, index) => ({
              key: `${file.fileName}:${index}`,
              title: `Patient/${byte}`,
              resource: fakeResource(`${byte}`),
            })),
          },
        ],
        notes: [],
      })

const importer = new FileImporter({
  format: 'test',
  coding: { system: SYSTEM, code: 'example' },
  contentType: 'application/octet-stream',
  display: { title: 'Example', description: 'Test format' },
  detect: () => false,
  defaultSettings: null,
  decodeOne: decodeBytes,
})

const fileArbitrary: fc.Arbitrary<PickedFile> = fc.record({
  fileName: fc.stringMatching(/^[a-z0-9]{1,12}\.bin$/u),
  bytes: fc.uint8Array({ maxLength: 6 }),
  source: fc.oneof(
    fc.constant(PickedFileSource.local),
    fc.stringMatching(/^[a-z0-9]{1,8}$/u).map(PickedFileSource.server)
  ),
})

const ONE_INSTANT = DateTime.unsafeMake(Date.UTC(2026, 3, 1))

const atFixedInstant = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(ONE_INSTANT))
      return yield* effect
    }).pipe(Effect.provide(TestContext.TestContext))
  )

describe('resolve (tested through decode)', () => {
  it('should mint a local pick into a labeled row keyed by its file name', async () => {
    const result = await atFixedInstant(
      importer.decode([localFile('scan.bin', new Uint8Array([1, 2]))], null)
    )
    const sourceSection = result.decoded.sections[0]
    expect(sourceSection?.title).toBe(SourceFile.SECTION_TITLE)
    const labeled = sourceSection?.resources[0]

    expect(labeled?.key).toBe(SourceFile.key('scan.bin'))
    expect(labeled?.title).toBe('scan.bin')

    if (labeled.resource.resourceType !== 'DocumentReference')
      throw expect.fail('Incorrect resource type')
    expect(labeled?.resource.date).toEqual(ONE_INSTANT)
  })

  it('should resolve a server pick to its existing reference and mint nothing', async () => {
    const result = await Effect.runPromise(
      importer.decode(
        [
          {
            fileName: 'old.bin',
            bytes: new Uint8Array([1]),
            source: PickedFileSource.server('doc-1'),
          },
        ],
        null
      )
    )
    expect(result.decoded.sections.every((s) => s.title !== SourceFile.SECTION_TITLE)).toBe(true)
  })
})

describe('decode (batch behavior)', () => {
  it('property: readable files produce sections, unreadable files are collected, in pick order', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fileArbitrary, { maxLength: 6 }), async (files) => {
        const result = await Effect.runPromise(importer.decode(files, null))
        const readable = files.filter((file) => file.bytes.length > 0)
        const unreadable = files.filter((file) => file.bytes.length === 0)
        expect(result.unreadableFiles.length).toBe(unreadable.length)
        for (const [index, entry] of result.unreadableFiles.entries()) {
          expect(entry.title).toBe(unreadable[index]?.fileName)
        }
        // Each readable file contributes a source-file section (for local picks) plus a content section.
        // Server picks contribute only a content section (no source-file row).
        const localReadable = readable.filter((f) => f.source._tag === 'local')
        const serverReadable = readable.filter((f) => f.source._tag === 'server')
        const expectedSections = localReadable.length * 2 + serverReadable.length
        expect(result.decoded.sections.length).toBe(expectedSections)
      }),
      { numRuns: numRunsFor({ base: 40 }) }
    )
  })

  it('property: a local pick leads with its Source file row and every extracted resource points at it; a server pick has no row and points at the existing reference', async () => {
    await fc.assert(
      fc.asyncProperty(
        fileArbitrary.filter((file) => file.bytes.length > 0),
        async (file) => {
          const result = await Effect.runPromise(importer.decode([file], null))
          const sections = result.decoded.sections
          if (file.source._tag === 'local') {
            expect(sections[0]?.title).toBe(SourceFile.SECTION_TITLE)
            expect(sections[0]?.resources.map((entry) => entry.key)).toEqual([
              SourceFile.key(file.fileName),
            ])
            const sourceId = sections[0]?.resources[0]?.resource.id
            const extracted = sections.slice(1).flatMap((s) => s.resources)
            expect(extracted.length).toBe(file.bytes.length)
            for (const entry of extracted) {
              expect(entry.resource.meta?.source).toBe(`DocumentReference/${sourceId}`)
            }
          } else {
            expect(sections[0]?.title).toBe(file.fileName)
            expect(sections.length).toBe(1)
            for (const entry of sections[0]?.resources ?? []) {
              expect(entry.resource.meta?.source).toBe(file.source.reference)
            }
          }
        }
      ),
      { numRuns: numRunsFor({ base: 40 }) }
    )
  })

  it('should hand the per-file decode the resolved source id', async () => {
    const seen: string[] = []
    const spyImporter = new FileImporter({
      format: 'test',
      coding: { system: SYSTEM, code: 'example' },
      contentType: 'application/octet-stream',
      display: { title: 'Example', description: 'Test format' },
      detect: () => false,
      defaultSettings: null,
      decodeOne: (file, settings: null, source) => {
        seen.push(SourceFile.makeReference(source.id))
        return decodeBytes(file, settings)
      },
    })
    const result = await Effect.runPromise(
      spyImporter.decode(
        [
          localFile('a.bin', new Uint8Array([1])),
          {
            fileName: 'b.bin',
            bytes: new Uint8Array([2]),
            source: PickedFileSource.server('doc-b'),
          },
        ],
        null
      )
    )
    const sourceRow = result.decoded.sections[0]?.resources[0]
    expect(seen.toSorted()).toEqual(
      [`DocumentReference/${sourceRow?.resource.id}`, 'DocumentReference/doc-b'].toSorted()
    )
  })

  it('should re-stamp the upload instant from the clock on each decode, keeping the id', async () => {
    const file = localFile('scan.bin', new Uint8Array([7]))
    const sourceRowOf = (
      result: FormatDecode.Result<string>
    ): DocumentReferenceType | undefined => {
      const resource = result.decoded.sections[0]?.resources[0]?.resource
      return resource?.resourceType === 'DocumentReference' ? resource : undefined
    }
    const [first, second] = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(ONE_INSTANT))
        const a = sourceRowOf(yield* importer.decode([file], null))
        yield* TestClock.setTime(DateTime.toEpochMillis(ONE_INSTANT) + 60_000)
        const b = sourceRowOf(yield* importer.decode([file], null))
        return [a, b]
      }).pipe(Effect.provide(TestContext.TestContext))
    )
    expect(first?.id).toBe(second?.id)
    expect(first?.date).toEqual(ONE_INSTANT)
    expect(second?.date).toEqual(DateTime.unsafeMake(DateTime.toEpochMillis(ONE_INSTANT) + 60_000))
  })
})
