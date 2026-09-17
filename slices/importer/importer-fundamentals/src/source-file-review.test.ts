import { DateTime, Effect, ParseResult, Schema, TestClock, TestContext } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import type {
  DecodedFile,
  DecodeOutcome,
  DocumentReferenceType,
} from './file-importer-descriptor.ts'
import * as MetaSource from './meta-source.ts'
import * as PickedFileSource from './picked-file-source.ts'
import type { PickedFile } from './picked-file.ts'
import { sourceFileCodec } from './source-file-codec.ts'
import * as SourceFileFhirReference from './source-file-fhir-reference.ts'
import { perFileDecode, SECTION_TITLE, resolve, key, withSections } from './source-file-review.ts'

/**
 * The generic source-file pieces a format's `decode` composes, tested against
 * a synthetic codec and a synthetic per-file decode — the behaviour every
 * binding inherits: a local pick mints a review row and stamps its reference,
 * a server pick mints nothing and stamps the existing one, a malformed file
 * folds to its own `unreadable` unit without touching the batch's other
 * files, and the upload instant is read off the clock.
 */

const codec = sourceFileCodec({
  coding: { system: 'https://example.test/fhir/CodeSystem/source-file', code: 'example' },
  contentType: 'application/octet-stream',
  descriptionPrefix: 'Example: ',
  sourceFileName: 'ExampleSourceFile',
  label: 'One uploaded example file',
  idDescription: 'FHIR resource id of an uploaded example file.',
})

/** A minimal resource in the `MetaSource.Sourceable` shape; `meta` starts unset. */
interface Marker {
  readonly resourceType: 'Basic'
  readonly id: string
  readonly meta: DocumentReferenceType['meta']
}

const marker = (id: string): Marker => ({ resourceType: 'Basic', id, meta: null })

const localFile = (fileName: string, bytes: Uint8Array): PickedFile => ({
  fileName,
  bytes,
  source: PickedFileSource.local,
})

/** A decode that yields one resource per byte, keyed by index — or refuses an empty file. */
const decodeBytes = (
  file: PickedFile,
  _settings: null
): Effect.Effect<DecodedFile<Marker>, ParseResult.ParseError> =>
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
              title: `Basic/${byte}`,
              resource: marker(`${byte}`),
            })),
          },
        ],
        notes: [],
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

/** Run under the test clock, set to one fixed instant. */
const atFixedInstant = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(ONE_INSTANT))
      return yield* effect
    }).pipe(Effect.provide(TestContext.TestContext))
  )

describe('resolve', () => {
  it('should mint a local pick into a labeled row keyed by its file name', async () => {
    const { ref, labeled } = await atFixedInstant(
      resolve(codec, localFile('scan.bin', new Uint8Array([1, 2])))
    )
    expect(labeled).toBeDefined()
    expect(labeled?.key).toBe(key('scan.bin'))
    expect(labeled?.title).toBe('scan.bin')
    expect(labeled?.resource.id).toBe(ref.id)
    expect(labeled?.resource.date).toEqual(ONE_INSTANT)
  })

  it('should resolve a server pick to its existing reference and mint nothing', async () => {
    const { ref, labeled } = await Effect.runPromise(
      resolve(codec, {
        fileName: 'old.bin',
        bytes: new Uint8Array(),
        source: PickedFileSource.server('doc-1'),
      })
    )
    expect(labeled).toBeUndefined()
    expect(ref).toEqual({ id: 'doc-1' })
  })

  it('should pass a subject through to the minted resource', async () => {
    const { labeled } = await Effect.runPromise(
      resolve(codec, localFile('scan.bin', new Uint8Array([1])), {
        subject: { reference: 'Patient/p-1' },
      })
    )
    expect(labeled?.resource.subject?.reference).toBe('Patient/p-1')
  })
})

describe('withSections', () => {
  it('property: prepends one titled section per source file, in order, and leaves the rest intact', () => {
    const labeledArbitrary = fc.record({
      key: fc.string(),
      title: fc.string(),
      resource: fc.integer(),
    })
    const sectionArbitrary = fc.record({
      title: fc.string(),
      resources: fc.array(labeledArbitrary),
    })
    fc.assert(
      fc.property(
        fc.record({ sections: fc.array(sectionArbitrary), notes: fc.array(fc.string()) }),
        fc.array(labeledArbitrary),
        (decoded, sourceFiles) => {
          const result = withSections(decoded, sourceFiles)
          expect(result.notes).toBe(decoded.notes)
          expect(result.sections.slice(sourceFiles.length)).toEqual(decoded.sections)
          expect(result.sections.slice(0, sourceFiles.length)).toEqual(
            sourceFiles.map((sourceFile) => ({
              title: SECTION_TITLE,
              resources: [sourceFile],
            }))
          )
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should return the decoded file itself when there is no source file', () => {
    const decoded: DecodedFile<number> = { sections: [], notes: ['n'] }
    expect(withSections(decoded, [])).toBe(decoded)
  })
})

describe('MetaSource.stamp / MetaSource.stampDecoded', () => {
  it('should set meta.source and keep the rest of an existing meta', () => {
    const before: Marker = {
      ...marker('m'),
      meta: {
        lastUpdated: null,
        profile: ['p'],
        security: [],
        tag: [],
        versionId: '3',
        source: null,
      },
    }
    const after = MetaSource.stamp(before, 'DocumentReference/d')
    expect(after.meta?.source).toBe('DocumentReference/d')
    expect(after.meta?.profile).toEqual(['p'])
    expect(after.meta?.versionId).toBe('3')
  })

  it('property: stamping links every resource in every section and changes nothing else', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            title: fc.string(),
            resources: fc.array(
              fc.record({ key: fc.string(), title: fc.string(), resource: fc.string().map(marker) })
            ),
          })
        ),
        fc.string({ minLength: 1 }),
        (sections, source) => {
          const stamped = MetaSource.stampDecoded({ sections, notes: [] }, source)
          expect(stamped.sections.map((section) => section.title)).toEqual(
            sections.map((section) => section.title)
          )
          for (const [index, section] of stamped.sections.entries()) {
            expect(section.resources.map((entry) => entry.key)).toEqual(
              sections[index]?.resources.map((entry) => entry.key)
            )
            for (const entry of section.resources) expect(entry.resource.meta?.source).toBe(source)
          }
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('perFileDecode', () => {
  const decode = perFileDecode(codec, decodeBytes)

  it('property: one unit per file, in pick order, each titled by its file name — unreadable for an empty file, read otherwise', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fileArbitrary, { maxLength: 6 }), async (files) => {
        const units = await Effect.runPromise(decode(files, null))
        expect(units.map((unit) => unit.title)).toEqual(files.map((file) => file.fileName))
        for (const [index, unit] of units.entries()) {
          const file = files[index]
          expect(unit.files).toEqual([file])
          expect(unit._tag).toBe(
            file !== undefined && file.bytes.length === 0 ? 'unreadable' : 'read'
          )
        }
      }),
      { numRuns: numRunsFor({ base: 40 }) }
    )
  })

  it('property: a local pick leads with its Source file row and every extracted resource points at it; a server pick has no row and points at the existing reference', async () => {
    await fc.assert(
      fc.asyncProperty(
        fileArbitrary.filter((file) => file.bytes.length > 0),
        async (file) => {
          const [unit] = await Effect.runPromise(decode([file], null))
          if (unit?._tag !== 'read') throw new Error('expected a read unit')
          const [first, ...rest] = unit.decoded.sections
          const extracted = rest.flatMap((section) => section.resources)
          if (file.source._tag === 'local') {
            expect(first?.title).toBe(SECTION_TITLE)
            expect(first?.resources.map((entry) => entry.key)).toEqual([key(file.fileName)])
            const sourceId = first?.resources[0]?.resource.id
            expect(extracted.length).toBe(file.bytes.length)
            for (const entry of extracted) {
              expect(entry.resource.meta?.source).toBe(`DocumentReference/${sourceId}`)
            }
          } else {
            expect(first?.title).toBe(file.fileName)
            expect(unit.decoded.sections.length).toBe(1)
            for (const entry of first?.resources ?? []) {
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
    const spying = perFileDecode(codec, (file, settings: null, source) => {
      seen.push(SourceFileFhirReference.make(source.id))
      return decodeBytes(file, settings)
    })
    const units = await Effect.runPromise(
      spying(
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
    const sourceRow =
      units[0]?._tag === 'read' ? units[0].decoded.sections[0]?.resources[0] : undefined
    expect(seen.toSorted()).toEqual(
      [`DocumentReference/${sourceRow?.resource.id}`, 'DocumentReference/doc-b'].toSorted()
    )
  })

  it('should re-stamp the upload instant from the clock on each decode, keeping the id', async () => {
    const file = localFile('scan.bin', new Uint8Array([7]))
    const sourceRowOf = (
      units: readonly DecodeOutcome<Marker | DocumentReferenceType>[]
    ): DocumentReferenceType | undefined => {
      const resource =
        units[0]?._tag === 'read' ? units[0].decoded.sections[0]?.resources[0]?.resource : undefined
      return resource?.resourceType === 'DocumentReference' ? resource : undefined
    }
    const [first, second] = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(ONE_INSTANT))
        const a = sourceRowOf(yield* decode([file], null))
        yield* TestClock.setTime(DateTime.toEpochMillis(ONE_INSTANT) + 60_000)
        const b = sourceRowOf(yield* decode([file], null))
        return [a, b]
      }).pipe(Effect.provide(TestContext.TestContext))
    )
    expect(first?.id).toBe(second?.id)
    expect(first?.date).toEqual(ONE_INSTANT)
    expect(second?.date).toEqual(DateTime.unsafeMake(DateTime.toEpochMillis(ONE_INSTANT) + 60_000))
  })
})
