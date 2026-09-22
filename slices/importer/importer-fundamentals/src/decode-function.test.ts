import { Array as Arr, Effect, Either, ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { IdentifierAndReference } from 'fhir-r4/data-types'
import {
  type DocumentReference,
  DocumentReferenceContext,
  type FhirResource,
  Patient,
} from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as DecodeFunction from './decode-function.ts'
import * as DecodedFile from './decoded-file.ts'
import * as FormatDecode from './format-decode.ts'
import * as PickedFile from './picked-file.ts'

// The archive schema itself — the mint, the encode, the read-back — is
// `picked-file.ts`'s and is tested there, directly under the format tag. What
// this file covers is the constructor: how a batch is grouped into sets, what
// each set contributes, and what a rejecting set does to its neighbours.

const SYSTEM = 'https://example.test/fhir/CodeSystem/source-file'

const fakeResource = (id: string): FhirResource =>
  Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', id })

/** A pick as `readBatch` stamps it: its slot in the batch, then its name. */
const pickedFile = (index: number, fileName: string, bytes: Uint8Array): PickedFile.Type => ({
  id: `${index}:${fileName}`,
  fileName,
  bytes,
})

/** One pick, in slot 0 — what a single-file decode is handed. */
const oneFile = (fileName: string, bytes: Uint8Array): PickedFile.Type =>
  pickedFile(0, fileName, bytes)

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
const sourceFileFormat: PickedFile.FormatValue = {
  coding: { system: SYSTEM, code: 'example' },
  contentType: 'application/octet-stream',
  descriptionPrefix: 'Example: ',
}

const decode = DecodeFunction.make({
  format: testFormat,
  sourceFileFormat,
  decodeFileSet: (members) => decodeBytes(members[0]),
})

/** A second format over the same system, to check that recognition is per-coding. */
const otherSourceFileFormat: PickedFile.FormatValue = {
  ...sourceFileFormat,
  coding: { system: SYSTEM, code: 'other-example' },
}

const otherDecode = DecodeFunction.make({
  format: testFormat,
  sourceFileFormat: otherSourceFileFormat,
  decodeFileSet: (members) => decodeBytes(members[0]),
})

const fileArbitrary: fc.Arbitrary<PickedFile.Type> = fc
  .record({
    fileName: fc.stringMatching(/^[a-z0-9]{1,12}\.bin$/u),
    bytes: fc.uint8Array({ maxLength: 6 }),
  })
  .map((one) => oneFile(one.fileName, one.bytes))

/** The same files re-slotted as one batch, the way `readBatch` numbers a pick. */
const asBatch = (files: readonly PickedFile.Type[]): readonly PickedFile.Type[] =>
  files.map((file, index) => pickedFile(index, file.fileName, file.bytes))

/** The archive row a single-pick decode leads with. */
const mintedArchive = async (
  batchDecode: DecodeFunction.Type<null, typeof testFormat>,
  file: PickedFile.Type
): Promise<DocumentReference.Type> => {
  const result = await Effect.runPromise(batchDecode([file], null))
  const resource = result.decoded.sections[0]?.resources[0]?.resource
  if (resource?.resourceType !== 'DocumentReference')
    throw expect.fail('Expected an archive DocumentReference')
  return resource
}

const readBack = (
  format: PickedFile.FormatValue,
  resource: DocumentReference.Type
): Promise<PickedFile.Type> =>
  Effect.runPromise(
    Schema.decode(PickedFile.FromDocumentReference)(resource).pipe(
      Effect.provideService(PickedFile.Format, format)
    )
  )

describe('the archives a decode mints', () => {
  it('reads its own minted archive back, bytes and name recovered', async () => {
    const file = oneFile('scan.bin', new Uint8Array([1, 2]))
    const resource = await mintedArchive(decode, file)

    expect(PickedFile.isSourceFile(sourceFileFormat)(resource)).toBe(true)
    const back = await readBack(sourceFileFormat, resource)
    expect(back.fileName).toBe('scan.bin')
    expect(back.bytes).toEqual(file.bytes)
    expect(back.id).toBe(resource.id)
  })

  it("does not claim another format's archive, though they share a system", async () => {
    const file = oneFile('scan.bin', new Uint8Array([1, 2]))
    const theirs = await mintedArchive(otherDecode, file)

    expect(PickedFile.isSourceFile(sourceFileFormat)(theirs)).toBe(false)
    const outcome = await Effect.runPromise(
      Effect.either(
        Schema.decode(PickedFile.FromDocumentReference)(theirs).pipe(
          Effect.provideService(PickedFile.Format, sourceFileFormat)
        )
      )
    )
    expect(outcome._tag).toBe('Left')
  })

  it('should mint a pick into a labeled row keyed by the pick', async () => {
    const file = oneFile('scan.bin', new Uint8Array([1, 2]))
    const result = await Effect.runPromise(decode([file], null))
    const sourceSection = result.decoded.sections[0]
    expect(sourceSection?.title).toBe('Source file')
    const labeled = sourceSection?.resources[0]

    expect(labeled?.key).toBe(`${FormatDecode.keyPrefix(file)}source-file/scan.bin`)
    expect(labeled?.title).toBe('scan.bin')
  })

  it('should carry no upload instant on the archive it mints', async () => {
    const resource = await mintedArchive(decode, oneFile('scan.bin', new Uint8Array([1, 2])))
    expect(resource.date).toBeNull()
    expect(resource.content[0]?.attachment.creation).toBeNull()
  })

  it('should mint an archive for every pick, however it was picked', async () => {
    const result = await Effect.runPromise(
      decode(
        asBatch([oneFile('a.bin', new Uint8Array([1])), oneFile('b.bin', new Uint8Array([2]))]),
        null
      )
    )
    const titles = result.decoded.sections.map((section) => section.title)
    expect(titles.filter((title) => title === 'Source file')).toHaveLength(2)
  })

  it('should mint the same id for the same bytes and name on every decode', async () => {
    const file = oneFile('scan.bin', new Uint8Array([7]))
    const first = await mintedArchive(decode, file)
    const second = await mintedArchive(decode, file)
    expect(first.id).toBe(second.id)
  })
})

/** A `Reference` naming one resource, built from the schema's own empty value. */
const referenceValue = (reference: string): typeof IdentifierAndReference.ReferenceSchema.Type => ({
  ...IdentifierAndReference.emptyReference,
  reference,
})

const emptyContext = Schema.decodeSync(DocumentReferenceContext.Schema)({})

/** A decode whose archives name the first resource the set decoded to. */
const linkingDecode = DecodeFunction.make({
  format: testFormat,
  sourceFileFormat,
  decodeFileSet: (members) => decodeBytes(members[0]),
  // The decode's own resources name the links, so a format never parses its
  // file twice to derive one.
  archive: (minted, decoded): DocumentReference.Type => {
    const first = DecodedFile.resources(decoded)[0]
    if (first === undefined) return minted
    const reference = referenceValue(`Patient/${first.resource.id}`)
    return {
      ...minted,
      subject: reference,
      context: { ...(minted.context ?? emptyContext), related: [reference] },
    }
  },
})

describe('the archive a format finishes off its decode', () => {
  it('should list the archive the format returned, links and all', async () => {
    const sourceRow = await mintedArchive(linkingDecode, oneFile('scan.bin', new Uint8Array([9])))
    expect(sourceRow.subject?.reference).toBe('Patient/9')
    expect(sourceRow.context?.related.map((one) => one.reference)).toEqual(['Patient/9'])
  })

  it('should keep the minted id, and stamp meta.source with it', async () => {
    const file = oneFile('scan.bin', new Uint8Array([9]))
    const minted = await mintedArchive(decode, file)
    const finished = await mintedArchive(linkingDecode, file)
    expect(finished.id).toBe(minted.id)

    const result = await Effect.runPromise(linkingDecode([file], null))
    const extracted = result.decoded.sections
      .slice(1)
      .flatMap((section) => section.resources)
      .map((entry) => entry.resource.meta?.source)
    expect(extracted).toEqual([`DocumentReference/${minted.id}`])
  })
})

describe('decode (batch behavior)', () => {
  it('property: readable files produce sections, unreadable files are collected, in pick order', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fileArbitrary, { maxLength: 6 }), async (picked) => {
        const files = asBatch(picked)
        const result = await Effect.runPromise(decode(files, null))
        const readable = files.filter((file) => file.bytes.length > 0)
        const unreadable = files.filter((file) => file.bytes.length === 0)
        expect(result.unreadableFiles.length).toBe(unreadable.length)
        for (const [index, entry] of result.unreadableFiles.entries()) {
          expect(entry.title).toBe(unreadable[index]?.fileName)
        }
        // Each readable file contributes its archive's section plus a content
        // section — every pick mints, whatever it came from.
        expect(result.decoded.sections.length).toBe(readable.length * 2)
      }),
      { numRuns: numRunsFor({ base: 40 }) }
    )
  })

  it('property: a pick leads with its Source file row and every extracted resource points at it', async () => {
    await fc.assert(
      fc.asyncProperty(
        fileArbitrary.filter((file) => file.bytes.length > 0),
        async (file) => {
          const result = await Effect.runPromise(decode([file], null))
          const sections = result.decoded.sections
          expect(sections[0]?.title).toBe('Source file')
          expect(sections[0]?.resources.map((entry) => entry.key)).toEqual([
            `${FormatDecode.keyPrefix(file)}source-file/${file.fileName}`,
          ])
          const archiveId = sections[0]?.resources[0]?.resource.id
          const extracted = sections.slice(1).flatMap((section) => section.resources)
          expect(extracted.length).toBe(file.bytes.length)
          for (const entry of extracted) {
            expect(entry.resource.meta?.source).toBe(`DocumentReference/${archiveId}`)
          }
        }
      ),
      { numRuns: numRunsFor({ base: 40 }) }
    )
  })

  it('should hand the set decode the archive minted for each member', async () => {
    const seen: (string | null)[] = []
    const spyDecode = DecodeFunction.make({
      format: testFormat,
      sourceFileFormat,
      decodeFileSet: (members) => {
        seen.push(members[0].archive.id)
        return decodeBytes(members[0])
      },
    })
    const result = await Effect.runPromise(
      spyDecode(
        asBatch([oneFile('a.bin', new Uint8Array([1])), oneFile('b.bin', new Uint8Array([2]))]),
        null
      )
    )
    const listed = result.decoded.sections
      .filter((section) => section.title === 'Source file')
      .flatMap((section) => section.resources.map((entry) => entry.resource.id))
    const byText = (left: string | null, right: string | null): number =>
      String(left).localeCompare(String(right))
    expect(seen.toSorted(byText)).toEqual(listed.toSorted(byText))
  })

  it('property: every review key across a multi-file batch is distinct', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fileArbitrary.filter((file) => file.bytes.length > 0),
          { minLength: 2, maxLength: 5 }
        ),
        async (picked) => {
          const result = await Effect.runPromise(decode(asBatch(picked), null))
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
    // Both files decode to a `<fileName>:0` key, and both mint an archive row —
    // the collision that let unticking one file's row drop the other's
    // resource, since the selection is keyed by (format, key).
    const result = await Effect.runPromise(
      decode(
        asBatch([
          oneFile('scan.bin', new Uint8Array([1])),
          oneFile('scan.bin', new Uint8Array([2])),
        ]),
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
      decode(asBatch([oneFile('same.bin', empty), oneFile('same.bin', empty)]), null)
    )
    expect(result.unreadableFiles.map((file) => file.id)).toEqual([
      'test/0:same.bin',
      'test/1:same.bin',
    ])
  })

  it('should give two batches of same-named files distinct result ids', () => {
    const one = FormatDecode.makeId(
      'test',
      asBatch([oneFile('a.bin', new Uint8Array()), oneFile('b.bin', new Uint8Array())])
    )
    const swapped = FormatDecode.makeId(
      'test',
      asBatch([oneFile('b.bin', new Uint8Array()), oneFile('a.bin', new Uint8Array())])
    )
    const duplicated = FormatDecode.makeId(
      'test',
      asBatch([oneFile('a.bin', new Uint8Array()), oneFile('a.bin', new Uint8Array())])
    )
    expect(new Set([one, swapped, duplicated]).size).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// A format that states which of its files are decoded together
// ---------------------------------------------------------------------------

/** The prefix before the first `-`; a file with no `-` belongs to no set. */
const groupOf = (fileName: string): string | undefined => {
  const [group, rest] = fileName.split('-')
  return group === undefined || rest === undefined || group === '' ? undefined : group
}

const groupByName = (file: PickedFile.Type): Either.Either<string, ParseResult.ParseError> => {
  const group = groupOf(file.fileName)
  return group === undefined ? Either.left(emptyFileError(file.fileName)) : Either.right(group)
}

/** One section per set, one resource per member; a set with an empty file rejects whole. */
const decodeGroup = (
  members: Arr.NonEmptyReadonlyArray<DecodeFunction.ArchivedFile>
): Effect.Effect<DecodedFile.DecodedFile, ParseResult.ParseError> =>
  members.some((member) => member.bytes.length === 0)
    ? Effect.fail(emptyFileError(members[0].fileName))
    : Effect.succeed({
        sections: [
          {
            title: groupOf(members[0].fileName) ?? members[0].fileName,
            resources: members.map((member) => ({
              key: `member/${member.id}`,
              title: member.fileName,
              resource: fakeResource(`${member.bytes[0] ?? 0}`),
            })),
          },
        ],
        notes: [`${groupOf(members[0].fileName) ?? '?'}: ${members.length} files`],
      })

const groupedDecode = DecodeFunction.make({
  format: testFormat,
  sourceFileFormat,
  groupBy: groupByName,
  decodeFileSet: decodeGroup,
})

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

describe('a grouped decode', () => {
  it('property: N sets yield N key namespaces and N stamps', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.stringMatching(/^[a-z]{1,4}$/u), { minLength: 1, maxLength: 4 }),
        fc.integer({ min: 1, max: 3 }),
        async (groups, perGroup) => {
          const files = asBatch(
            groups.flatMap((group) =>
              Arr.makeBy(perGroup, (n) => oneFile(`${group}-${n}.bin`, new Uint8Array([n + 1])))
            )
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

  it('namespaces a set by its first picked member and stamps it with one archive', async () => {
    const files = asBatch([
      oneFile('s-1.bin', new Uint8Array([1])),
      oneFile('s-2.bin', new Uint8Array([2])),
    ])
    const [first, second] = files
    if (first === undefined || second === undefined) throw expect.fail('two files expected')
    const result = await Effect.runPromise(groupedDecode(files, null))
    const prefix = FormatDecode.keyPrefix(first)
    const extracted = result.decoded.sections
      .filter((section) => section.title === 's')
      .flatMap((section) => section.resources)
    expect(extracted.map((entry) => entry.key)).toEqual([
      `${prefix}member/${first.id}`,
      `${prefix}member/${second.id}`,
    ])
    expect(stampsOf(result).size).toBe(1)
    // Both archives are listed, each keyed by its own pick.
    expect(result.decoded.sections[0]?.title).toBe('Source files')
    expect(result.decoded.sections[0]?.resources.map((entry) => entry.key)).toEqual([
      `${prefix}source-file/s-1.bin`,
      `${FormatDecode.keyPrefix(second)}source-file/s-2.bin`,
    ])
  })

  it('property: a set stamps the smallest of its archive ids, whatever order it was picked in', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 1, max: 40 }), { minLength: 2, maxLength: 4 }),
        async (bytes) => {
          const files = bytes.map((byte) => oneFile(`s-${byte}.bin`, new Uint8Array([byte])))
          const straight = await Effect.runPromise(groupedDecode(asBatch(files), null))
          const reversed = await Effect.runPromise(groupedDecode(asBatch(files.toReversed()), null))
          expect(stampsOf(straight).size).toBe(1)
          expect(stampsOf(reversed)).toEqual(stampsOf(straight))
        }
      ),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('rejects exactly the members of a failing set, leaving its neighbours readable', async () => {
    const result = await Effect.runPromise(
      groupedDecode(
        asBatch([
          oneFile('a-1.bin', new Uint8Array([1])),
          oneFile('b-1.bin', new Uint8Array()),
          oneFile('b-2.bin', new Uint8Array([1])),
          oneFile('a-2.bin', new Uint8Array([1])),
        ]),
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
        asBatch([
          oneFile('b-1.bin', new Uint8Array()),
          oneFile('loose.bin', new Uint8Array([1])),
          oneFile('alsoloose.bin', new Uint8Array([1])),
        ]),
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
