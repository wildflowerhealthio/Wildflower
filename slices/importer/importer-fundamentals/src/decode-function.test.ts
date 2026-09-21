import {
  Array as Arr,
  DateTime,
  Effect,
  Either,
  Option,
  ParseResult,
  Schema,
  TestClock,
  TestContext,
} from 'effect'
import * as fc from 'fast-check'
import { type DocumentReference, type FhirResource, Patient } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as DecodeFunction from './decode-function.ts'
import * as DecodedFile from './decoded-file.ts'
import * as FormatDecode from './format-decode.ts'
import * as PickedFile from './picked-file.ts'
import * as SourceFile from './source-file.ts'

// The source-file schemas themselves — the mint, the encode, the read-back —
// are `source-file.ts`'s and are tested there, directly under the format tag.
// What this file covers is the constructor: how a batch is partitioned into
// sets, what each set contributes, and what a rejecting set does to its
// neighbours.

const SYSTEM = 'https://example.test/fhir/CodeSystem/source-file'

const fakeResource = (id: string): FhirResource =>
  Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', id })

const localFile = (fileName: string, bytes: Uint8Array): PickedFile.Type => ({
  fileName,
  bytes,
  source: PickedFile.Source.local,
})

const emptyFileError = (fileName: string): ParseResult.ParseError =>
  new ParseResult.ParseError({
    issue: new ParseResult.Type(Schema.Unknown.ast, fileName, 'empty file'),
  })

/** One file's bytes as one resource each — the per-file decode every set of one runs. */
const decodeBytes = (
  file: PickedFile.Type
): Effect.Effect<DecodedFile.DecodedFile, ParseResult.ParseError> =>
  file.bytes.length === 0
    ? Effect.fail(emptyFileError(file.fileName))
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
const sourceFileFormat: SourceFile.FormatValue = {
  coding: { system: SYSTEM, code: 'example' },
  contentType: 'application/octet-stream',
  descriptionPrefix: 'Example: ',
}

const decode = DecodeFunction.make({
  format: testFormat,
  sourceFileFormat,
  decodeFileSet: (members) => decodeBytes(members[0].file),
})

/** A second format over the same system, to check that recognition is per-coding. */
const otherSourceFileFormat: SourceFile.FormatValue = {
  ...sourceFileFormat,
  coding: { system: SYSTEM, code: 'other-example' },
}

const otherDecode = DecodeFunction.make({
  format: testFormat,
  sourceFileFormat: otherSourceFileFormat,
  decodeFileSet: (members) => decodeBytes(members[0].file),
})

const fileArbitrary: fc.Arbitrary<PickedFile.Type> = fc.record({
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

/** The source-file row a single-local-pick decode leads with. */
const mintedSourceFile = async (
  batchDecode: DecodeFunction.Type<null, typeof testFormat>,
  file: PickedFile.Type
): Promise<DocumentReference.Type> => {
  const result = await atFixedInstant(batchDecode([file], null))
  const resource = result.decoded.sections[0]?.resources[0]?.resource
  if (resource?.resourceType !== 'DocumentReference')
    throw expect.fail('Expected a source-file DocumentReference')
  return resource
}

const readBack = (
  format: SourceFile.FormatValue,
  resource: DocumentReference.Type
): Promise<SourceFile.Type> =>
  Effect.runPromise(
    Schema.decode(SourceFile.FromDocumentReference)(resource).pipe(
      Effect.provideService(SourceFile.Format, format)
    )
  )

describe('the archives a decode mints', () => {
  it('reads its own minted source file back, bytes and name recovered', async () => {
    const file = localFile('scan.bin', new Uint8Array([1, 2]))
    const resource = await mintedSourceFile(decode, file)

    expect(SourceFile.isSourceFile(sourceFileFormat)(resource)).toBe(true)
    const back = await readBack(sourceFileFormat, resource)
    expect(back.fileName).toBe('scan.bin')
    expect(back.bytes).toEqual(file.bytes)
  })

  it("does not claim another format's source file, though they share a system", async () => {
    const file = localFile('scan.bin', new Uint8Array([1, 2]))
    const theirs = await mintedSourceFile(otherDecode, file)

    expect(SourceFile.isSourceFile(sourceFileFormat)(theirs)).toBe(false)
    const outcome = await Effect.runPromise(
      Effect.either(
        Schema.decode(SourceFile.FromDocumentReference)(theirs).pipe(
          Effect.provideService(SourceFile.Format, sourceFileFormat)
        )
      )
    )
    expect(outcome._tag).toBe('Left')
  })

  it('should mint a local pick into a labeled row keyed by its file name', async () => {
    const result = await atFixedInstant(
      decode([localFile('scan.bin', new Uint8Array([1, 2]))], null)
    )
    const sourceSection = result.decoded.sections[0]
    expect(sourceSection?.title).toBe('Source file')
    const labeled = sourceSection?.resources[0]

    expect(labeled?.key).toBe(
      `${FormatDecode.keyPrefix(0, localFile('scan.bin', new Uint8Array()))}source-file/scan.bin`
    )
    expect(labeled?.title).toBe('scan.bin')

    if (labeled?.resource.resourceType !== 'DocumentReference')
      throw expect.fail('Incorrect resource type')
    expect(labeled.resource.date).toEqual(ONE_INSTANT)
  })

  it('should resolve a server pick to its existing reference and mint nothing', async () => {
    const result = await Effect.runPromise(
      decode(
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
    expect(result.decoded.sections.every((s) => s.title !== 'Source file')).toBe(true)
  })

  it('should link the minted archive to what archiveLinks named', async () => {
    const linkingDecode = DecodeFunction.make({
      format: testFormat,
      sourceFileFormat,
      decodeFileSet: (members) => decodeBytes(members[0].file),
      // The decode's own resources name the links, so a format never parses
      // its file twice to derive one.
      archiveLinks: (decoded) => {
        const first = DecodedFile.resources(decoded)[0]
        return first === undefined
          ? { subject: Option.none(), related: [] }
          : {
              subject: Option.some({ reference: `Patient/${first.resource.id}` }),
              related: [{ reference: `Patient/${first.resource.id}` }],
            }
      },
    })
    const result = await Effect.runPromise(
      linkingDecode([localFile('scan.bin', new Uint8Array([9]))], null)
    )
    const sourceRow = result.decoded.sections[0]?.resources[0]?.resource
    if (sourceRow?.resourceType !== 'DocumentReference')
      throw expect.fail('Expected a source-file DocumentReference')
    expect(sourceRow.subject?.reference).toBe('Patient/9')
    expect(sourceRow.context?.related.map((one) => one.reference)).toEqual(['Patient/9'])
  })

  it('should re-stamp the upload instant from the clock on each decode, keeping the id', async () => {
    const file = localFile('scan.bin', new Uint8Array([7]))
    const sourceRowOf = (
      result: FormatDecode.Result<string>
    ): DocumentReference.Type | undefined => {
      const resource = result.decoded.sections[0]?.resources[0]?.resource
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

describe('decode (batch behavior)', () => {
  it('property: readable files produce sections, unreadable files are collected, in pick order', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fileArbitrary, { maxLength: 6 }), async (files) => {
        const result = await Effect.runPromise(decode(files, null))
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
          const result = await Effect.runPromise(decode([file], null))
          const sections = result.decoded.sections
          if (file.source._tag === 'local') {
            expect(sections[0]?.title).toBe('Source file')
            expect(sections[0]?.resources.map((entry) => entry.key)).toEqual([
              `${FormatDecode.keyPrefix(0, file)}source-file/${file.fileName}`,
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

  it('should hand the set decode the resolved source reference', async () => {
    const seen: string[] = []
    const spyDecode = DecodeFunction.make({
      format: testFormat,
      sourceFileFormat,
      decodeFileSet: (members) => {
        seen.push(members[0].sourceFile)
        return decodeBytes(members[0].file)
      },
    })
    const result = await Effect.runPromise(
      spyDecode(
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
          const result = await Effect.runPromise(decode(files, null))
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
      decode(
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
      decode([localFile('same.bin', empty), localFile('same.bin', empty)], null)
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
})

// ---------------------------------------------------------------------------
// A format that states which of its files are decoded together
// ---------------------------------------------------------------------------

/** A pick with the set it belongs to: everything named `<set>-<n>.bin`. */
interface Grouped extends DecodeFunction.Member {
  readonly group: string
}

/** The prefix before the first `-`; a file with no `-` belongs to no set. */
const groupOf = (fileName: string): string | undefined => {
  const [group, rest] = fileName.split('-')
  return group === undefined || rest === undefined || group === '' ? undefined : group
}

const partitionByGroup = (
  files: readonly DecodeFunction.Member[]
): DecodeFunction.Partition<Grouped> => {
  const [unplaceable, placed] = Arr.partitionMap(
    files,
    (member): Either.Either<Grouped, DecodeFunction.UnreadableMember> => {
      const group = groupOf(member.file.fileName)
      return group === undefined
        ? Either.left({ member, error: emptyFileError(member.file.fileName) })
        : Either.right({ ...member, group })
    }
  )
  return {
    fileSets: Object.values(Arr.groupBy(placed, (member) => member.group)),
    unreadable: unplaceable,
  }
}

/** One section per set, one resource per member; a set with an empty file rejects whole. */
const decodeGroup = (
  members: Arr.NonEmptyReadonlyArray<Grouped>
): Effect.Effect<DecodedFile.DecodedFile, ParseResult.ParseError> =>
  members.some((member) => member.file.bytes.length === 0)
    ? Effect.fail(emptyFileError(members[0].file.fileName))
    : Effect.succeed({
        sections: [
          {
            title: members[0].group,
            resources: members.map((member) => ({
              key: `member/${member.index}`,
              title: member.file.fileName,
              resource: fakeResource(`${member.index}`),
            })),
          },
        ],
        notes: [`${members[0].group}: ${members.length} files`],
      })

const groupedDecode = DecodeFunction.make({
  format: testFormat,
  sourceFileFormat,
  partition: partitionByGroup,
  decodeFileSet: decodeGroup,
})

const groupedFile = (fileName: string): PickedFile.Type => localFile(fileName, new Uint8Array([1]))

const stampsOf = (result: FormatDecode.Result<string>): ReadonlySet<string> =>
  new Set(
    DecodedFile.resources(result.decoded).flatMap((entry) => {
      const source = entry.resource.meta?.source
      return source === null || source === undefined ? [] : [source]
    })
  )

/** The key namespaces the *extracted* resources carry — one per set. */
const keyNamespacesOf = (result: FormatDecode.Result<string>): ReadonlySet<string> =>
  new Set(
    DecodedFile.resources(result.decoded)
      .filter((entry) => entry.resource.resourceType !== 'DocumentReference')
      .map((entry) => entry.key.split('/')[0] ?? entry.key)
  )

describe('a partitioned decode', () => {
  it('property: N sets yield N key namespaces and N stamps', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.stringMatching(/^[a-z]{1,4}$/u), { minLength: 1, maxLength: 4 }),
        fc.integer({ min: 1, max: 3 }),
        async (groups, perGroup) => {
          const files = groups.flatMap((group) =>
            Arr.makeBy(perGroup, (n) => groupedFile(`${group}-${n}.bin`))
          )
          const result = await Effect.runPromise(groupedDecode(files, null))
          expect(result.unreadableFiles).toEqual([])
          expect(keyNamespacesOf(result).size).toBe(groups.length)
          expect(stampsOf(result).size).toBe(groups.length)
          expect(result.decoded.notes).toHaveLength(groups.length)
        }
      ),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('namespaces a set by its first member and stamps it with that one archive', async () => {
    const result = await Effect.runPromise(
      groupedDecode([groupedFile('s-1.bin'), groupedFile('s-2.bin')], null)
    )
    const prefix = FormatDecode.keyPrefix(0, groupedFile('s-1.bin'))
    const extracted = result.decoded.sections
      .filter((section) => section.title === 's')
      .flatMap((section) => section.resources)
    expect(extracted.map((entry) => entry.key)).toEqual([`${prefix}member/0`, `${prefix}member/1`])
    expect(stampsOf(result).size).toBe(1)
    // Both archives are listed, each keyed by its own pick.
    expect(result.decoded.sections[0]?.title).toBe('Source files')
    expect(result.decoded.sections[0]?.resources.map((entry) => entry.key)).toEqual([
      `${prefix}source-file/s-1.bin`,
      `${FormatDecode.keyPrefix(1, groupedFile('s-2.bin'))}source-file/s-2.bin`,
    ])
  })

  it('rejects exactly the members of a failing set, leaving its neighbours readable', async () => {
    const result = await Effect.runPromise(
      groupedDecode(
        [
          groupedFile('a-1.bin'),
          localFile('b-1.bin', new Uint8Array()),
          groupedFile('b-2.bin'),
          groupedFile('a-2.bin'),
        ],
        null
      )
    )
    expect(result.unreadableFiles.map((one) => one.id)).toEqual([
      'test/1:b-1.bin',
      'test/2:b-2.bin',
    ])
    expect(result.decoded.notes).toEqual(['a: 2 files'])
  })

  it('reports the picks no set claimed in pick order, ahead of the sets that rejected', async () => {
    const result = await Effect.runPromise(
      groupedDecode(
        [
          localFile('b-1.bin', new Uint8Array()),
          groupedFile('loose.bin'),
          groupedFile('alsoloose.bin'),
        ],
        null
      )
    )
    expect(result.unreadableFiles.map((one) => one.title)).toEqual([
      'loose.bin',
      'alsoloose.bin',
      'b-1.bin',
    ])
  })
})
