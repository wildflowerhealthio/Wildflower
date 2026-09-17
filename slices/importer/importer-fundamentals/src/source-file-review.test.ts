import { DateTime, Effect, Either, ParseResult, Schema, TestClock, TestContext } from 'effect'
import * as fc from 'fast-check'
import { type FhirResource, Patient } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  FileImporter,
  SOURCE_FILE_SECTION_TITLE,
  sourceFileKey,
  type DecodedFile,
  type DocumentReferenceType,
  type ReadUnit,
} from './file-importer-descriptor.ts'
import * as MetaSource from './meta-source.ts'
import * as PickedFileSource from './picked-file-source.ts'
import type { PickedFile } from './picked-file.ts'
import * as SourceFileFhirReference from './source-file-fhir-reference.ts'

const SYSTEM = 'https://example.test/fhir/CodeSystem/source-file'

const fakeResource = (id: string): FhirResource =>
  Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', id })

interface Marker {
  readonly resourceType: 'Basic'
  readonly id: string
  readonly meta: {
    source: string | null
    lastUpdated: null
    profile: readonly string[]
    security: readonly never[]
    tag: readonly never[]
    versionId: string | null
  } | null
}

const marker = (id: string): Marker => ({ resourceType: 'Basic', id, meta: null })

const localFile = (fileName: string, bytes: Uint8Array): PickedFile => ({
  fileName,
  bytes,
  source: PickedFileSource.local,
})

const decodeBytes = (
  file: PickedFile,
  _settings: null
): Effect.Effect<DecodedFile<FhirResource>, ParseResult.ParseError> =>
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
    const units = await atFixedInstant(
      importer.decode([localFile('scan.bin', new Uint8Array([1, 2]))], null)
    )
    const unit = units[0]
    expect(unit).toBeDefined()
    expect(Either.isRight(unit!)).toBe(true)
    if (!Either.isRight(unit!)) return
    const sourceSection = unit.right.decoded.sections[0]
    expect(sourceSection?.title).toBe(SOURCE_FILE_SECTION_TITLE)
    const labeled = sourceSection?.resources[0]
    expect(labeled?.key).toBe(sourceFileKey('scan.bin'))
    expect(labeled?.title).toBe('scan.bin')
    expect(labeled?.resource.date).toEqual(ONE_INSTANT)
  })

  it('should resolve a server pick to its existing reference and mint nothing', async () => {
    const units = await Effect.runPromise(
      importer.decode(
        [{ fileName: 'old.bin', bytes: new Uint8Array([1]), source: PickedFileSource.server('doc-1') }],
        null
      )
    )
    const unit = units[0]
    expect(unit).toBeDefined()
    expect(Either.isRight(unit!)).toBe(true)
    if (!Either.isRight(unit!)) return
    expect(unit.right.decoded.sections.every((s) => s.title !== SOURCE_FILE_SECTION_TITLE)).toBe(true)
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

describe('decode (batch behavior)', () => {
  it('property: one unit per file, in pick order, each titled by its file name — left for an empty file, right otherwise', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fileArbitrary, { maxLength: 6 }), async (files) => {
        const units = await Effect.runPromise(importer.decode(files, null))
        const titles = units.map((unit) =>
          Either.isRight(unit) ? unit.right.title : unit.left.title
        )
        expect(titles).toEqual(files.map((file) => file.fileName))
        for (const [index, unit] of units.entries()) {
          const file = files[index]
          const inner = Either.isRight(unit) ? unit.right : unit.left
          expect(inner.files).toEqual([file])
          if (file !== undefined && file.bytes.length === 0) {
            expect(Either.isLeft(unit)).toBe(true)
          } else {
            expect(Either.isRight(unit)).toBe(true)
          }
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
          const [unit] = await Effect.runPromise(importer.decode([file], null))
          if (unit === undefined || !Either.isRight(unit)) throw new Error('expected a read unit')
          const [first, ...rest] = unit.right.decoded.sections
          const extracted = rest.flatMap((section) => section.resources)
          if (file.source._tag === 'local') {
            expect(first?.title).toBe(SOURCE_FILE_SECTION_TITLE)
            expect(first?.resources.map((entry) => entry.key)).toEqual([sourceFileKey(file.fileName)])
            const sourceId = first?.resources[0]?.resource.id
            expect(extracted.length).toBe(file.bytes.length)
            for (const entry of extracted) {
              expect(entry.resource.meta?.source).toBe(`DocumentReference/${sourceId}`)
            }
          } else {
            expect(first?.title).toBe(file.fileName)
            expect(unit.right.decoded.sections.length).toBe(1)
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
    const spyImporter = new FileImporter({
      format: 'test',
      coding: { system: SYSTEM, code: 'example' },
      contentType: 'application/octet-stream',
      display: { title: 'Example', description: 'Test format' },
      detect: () => false,
      defaultSettings: null,
      decodeOne: (file, settings: null, source) => {
        seen.push(SourceFileFhirReference.make(source.id))
        return decodeBytes(file, settings)
      },
    })
    const units = await Effect.runPromise(
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
    const sourceRow =
      units[0] !== undefined && Either.isRight(units[0])
        ? units[0].right.decoded.sections[0]?.resources[0]
        : undefined
    expect(seen.toSorted()).toEqual(
      [`DocumentReference/${sourceRow?.resource.id}`, 'DocumentReference/doc-b'].toSorted()
    )
  })

  it('should re-stamp the upload instant from the clock on each decode, keeping the id', async () => {
    const file = localFile('scan.bin', new Uint8Array([7]))
    const sourceRowOf = (
      units: readonly Either.Either<ReadUnit<string>, unknown>[]
    ): DocumentReferenceType | undefined => {
      const unit = units[0]
      if (unit === undefined || !Either.isRight(unit)) return undefined
      const resource = unit.right.decoded.sections[0]?.resources[0]?.resource
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
