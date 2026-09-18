import { DateTime, Effect, ParseResult, Schema, TestClock, TestContext } from 'effect'
import * as fc from 'fast-check'
import { type FhirResource, type DocumentReference, Patient } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'
import * as DecodeFunction from './decode-function.ts'
import * as DecodedFile from './decoded-file.ts'
import * as FileImporter from './file-importer.ts'
import * as FormatDecode from './format-decode.ts'
import * as PickedFile from './picked-file.ts'
import * as SourceFile from './source-file.ts'

type DocumentReferenceType = typeof DocumentReference.Schema.Type

// The source-file codec itself — the mint, the encode, the read-back — is
// `source-file.ts`'s and is tested there, directly under a `FormatContext`.
// What this file covers is the factory: what `fileImporter` derives from a
// binding's config, and the batch `decode` it assembles.

const SYSTEM = 'https://example.test/fhir/CodeSystem/source-file'

// ---------------------------------------------------------------------------
// resolve / decode — the batch decode pipeline
// ---------------------------------------------------------------------------

const fakeResource = (id: string): FhirResource =>
  Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', id })

const localFile = (fileName: string, bytes: Uint8Array): PickedFile.PickedFile => ({
  fileName,
  bytes,
  source: PickedFile.Source.local,
})

const decodeBytes = (
  file: PickedFile.PickedFile,
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

const testFormat = 'test'
const display = { title: 'Example', description: 'Test format' }
const sourceFileFormat = {
  coding: { system: SYSTEM, code: 'example' },
  contentType: 'application/octet-stream',
  descriptionPrefix: `${display.title}: `,
}
const decodeFunctionConfig = {
  format: testFormat,
  decodeOne: decodeBytes,
} as const

const importer = FileImporter.make({
  format: testFormat,
  display,
  sourceFileFormat,
  decode: DecodeFunction.fromCombinableDecodeConfig(decodeFunctionConfig, sourceFileFormat),
  detect: () => false,
  defaultSettings: null,
})

const fileArbitrary: fc.Arbitrary<PickedFile.PickedFile> = fc.record({
  fileName: fc.stringMatching(/^[a-z0-9]{1,12}\.bin$/u),
  bytes: fc.uint8Array({ maxLength: 6 }),
  source: fc.oneof(
    fc.constant(PickedFile.Source.local),
    fc.stringMatching(/^[a-z0-9]{1,8}$/u).map(PickedFile.Source.server)
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

const otherDisplay = { title: 'Other', description: 'Test format' }
const otherSourceFileFormat = {
  ...sourceFileFormat,
  coding: { system: SYSTEM, code: 'other-example' },
}
const otherDecodeFunctionConfig = { ...decodeFunctionConfig, format: 'other' } as const

/** A second format over the same system, to check that recognition is per-coding. */
const otherImporter = FileImporter.make({
  format: testFormat,
  display: otherDisplay,
  sourceFileFormat: otherSourceFileFormat,
  decode: DecodeFunction.fromCombinableDecodeConfig(
    otherDecodeFunctionConfig,
    otherSourceFileFormat
  ),
  detect: () => false,
  defaultSettings: null,
})

/** The source-file row a single-local-pick decode leads with. */
const mintedSourceFile = async <TFormat extends string>(
  format: FileImporter.Type<null, TFormat>,
  file: PickedFile.PickedFile
): Promise<DocumentReferenceType> => {
  const result = await atFixedInstant(format.decode([file], null))
  const resource = result.decoded.sections[0]?.resources[0]?.resource
  if (resource?.resourceType !== 'DocumentReference')
    throw expect.fail('Expected a source-file DocumentReference')
  return resource
}

describe('the fields fileImporter derives from its config', () => {
  it('exposes the category token in system|code form', () => {
    expect(importer.categoryToken).toBe(`${SYSTEM}|example`)
  })

  it('reads its own minted source file back, bytes and name recovered', async () => {
    const file = localFile('scan.bin', new Uint8Array([1, 2]))
    const resource = await mintedSourceFile(importer, file)

    expect(importer.isSourceFile(resource)).toBe(true)
    const back = await Effect.runPromise(importer.sourceFileFromDocumentReference(resource))
    expect(back.fileName).toBe('scan.bin')
    expect(back.bytes).toEqual(file.bytes)
  })

  it("does not claim another format's source file, though they share a system", async () => {
    const file = localFile('scan.bin', new Uint8Array([1, 2]))
    const theirs = await mintedSourceFile(otherImporter, file)

    expect(importer.isSourceFile(theirs)).toBe(false)
    const outcome = await Effect.runPromise(
      Effect.either(importer.sourceFileFromDocumentReference(theirs))
    )
    expect(outcome._tag).toBe('Left')
  })
})

describe('resolve (tested through decode)', () => {
  it('should mint a local pick into a labeled row keyed by its file name', async () => {
    const result = await atFixedInstant(
      importer.decode([localFile('scan.bin', new Uint8Array([1, 2]))], null)
    )
    const sourceSection = result.decoded.sections[0]
    expect(sourceSection?.title).toBe(SourceFile.SECTION_TITLE)
    const labeled = sourceSection?.resources[0]

    expect(labeled?.key).toBe(
      `${FormatDecode.keyPrefix(0, localFile('scan.bin', new Uint8Array()))}${SourceFile.key('scan.bin')}`
    )
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
            source: PickedFile.Source.server('doc-1'),
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
              `${FormatDecode.keyPrefix(0, file)}${SourceFile.key(file.fileName)}`,
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

  it('should hand the per-file decode the resolved source reference', async () => {
    const seen: string[] = []
    const format = 'test'
    const spyDecodeFunctionConfig = {
      format,
      decodeOne: (
        file: PickedFile.PickedFile,
        settings: null,
        sourceFile: SourceFile.Reference
      ) => {
        seen.push(sourceFile)
        return decodeBytes(file, settings)
      },
    } as const
    const spyImporter = FileImporter.make({
      format,
      display,
      sourceFileFormat,
      decode: DecodeFunction.fromCombinableDecodeConfig(spyDecodeFunctionConfig, sourceFileFormat),
      detect: () => false,
      defaultSettings: null,
    })
    const result = await Effect.runPromise(
      spyImporter.decode(
        [
          localFile('a.bin', new Uint8Array([1])),
          {
            fileName: 'b.bin',
            bytes: new Uint8Array([2]),
            source: PickedFile.Source.server('doc-b'),
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

  it('property: every review key across a multi-file batch is distinct', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fileArbitrary.filter((file) => file.bytes.length > 0),
          {
            minLength: 2,
            maxLength: 5,
          }
        ),
        async (files) => {
          const result = await Effect.runPromise(importer.decode(files, null))
          const keys = result.decoded.sections.flatMap((section) =>
            section.resources.map((entry) => entry.key)
          )
          expect(new Set(keys).size).toBe(keys.length)
        }
      ),
      { numRuns: numRunsFor({ base: 40 }) }
    )
  })

  it('should keep two files that decode to the same key apart', async () => {
    // Both files decode to a `<fileName>:0` key, and both mint a source-file
    // row — the collision that let unticking one file's row drop the other's
    // resource, since the selection is keyed by (format, key).
    const result = await Effect.runPromise(
      importer.decode(
        [localFile('scan.bin', new Uint8Array([1])), localFile('scan.bin', new Uint8Array([2]))],
        null
      )
    )
    const keys = result.decoded.sections.flatMap((section) =>
      section.resources.map((entry) => entry.key)
    )
    expect(keys.length).toBe(4)
    expect(new Set(keys).size).toBe(4)
  })

  it('should give two unreadable files of the same name distinct ids', async () => {
    const empty = new Uint8Array()
    const result = await Effect.runPromise(
      importer.decode([localFile('same.bin', empty), localFile('same.bin', empty)], null)
    )
    expect(result.unreadableFiles.map((file) => file.id)).toEqual([
      'test/0:same.bin',
      'test/1:same.bin',
    ])
  })

  it('should give two batches of same-named files distinct result ids', () => {
    const one = FormatDecode.makeId('test', [
      localFile('a.bin', new Uint8Array()),
      localFile('b.bin', new Uint8Array()),
    ])
    const swapped = FormatDecode.makeId('test', [
      localFile('b.bin', new Uint8Array()),
      localFile('a.bin', new Uint8Array()),
    ])
    const duplicated = FormatDecode.makeId('test', [
      localFile('a.bin', new Uint8Array()),
      localFile('a.bin', new Uint8Array()),
    ])
    expect(new Set([one, swapped, duplicated]).size).toBe(3)
  })

  it('should file the minted source file under the subject the decode named', async () => {
    const subjectDecodeFunctionConfig = {
      ...decodeFunctionConfig,
      // The decode's own resources name the subject, so a format never parses
      // its file twice to derive one.
      subjectFor: (_file: PickedFile.PickedFile, decoded: DecodedFile.DecodedFile) => {
        const first = DecodedFile.resources(decoded)[0]
        return first === undefined ? undefined : { reference: `Patient/${first.resource.id}` }
      },
    }
    const subjectImporter = FileImporter.make({
      format: subjectDecodeFunctionConfig.format,
      display,
      sourceFileFormat,
      decode: DecodeFunction.fromCombinableDecodeConfig(
        subjectDecodeFunctionConfig,
        sourceFileFormat
      ),
      detect: () => false,
      defaultSettings: null,
    })
    const result = await Effect.runPromise(
      subjectImporter.decode([localFile('scan.bin', new Uint8Array([9]))], null)
    )
    const sourceRow = result.decoded.sections[0]?.resources[0]?.resource
    if (sourceRow?.resourceType !== 'DocumentReference')
      throw expect.fail('Expected a source-file DocumentReference')
    expect(sourceRow.subject?.reference).toBe('Patient/9')
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
