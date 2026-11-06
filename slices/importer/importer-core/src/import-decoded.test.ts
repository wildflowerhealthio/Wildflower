import { adopt, DetachedResource, ReferencePlan } from '@wildflowerhealthio/fhir-r4-adoption'
import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { localResourceId } from '@wildflowerhealthio/fhir-r4/identity'
import {
  DocumentReferenceContext,
  type FhirResource,
  type FhirResourceWithId,
  Observation,
  Patient,
} from '@wildflowerhealthio/fhir-r4/resources'
import {
  type DecodedFileSet,
  DecodeFunction,
  FileImporter,
  FormatDecode,
  MetaSource,
  PickedFile,
  ResourcePlan,
  type Section,
  SectionedList,
} from '@wildflowerhealthio/importer-fundamentals'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Array as Arr, Effect, Either, Option, ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { importDecoded, type ImportingFormat } from './import-decoded.ts'

// The source file schema itself — the mint, the encode, the read-back — is
// `importer-fundamentals`' `picked-file.ts`'s and is tested there. What this
// file covers is a decode through the import stage: what each set contributes,
// the source files it mints, and what a rejecting set does to its neighbours.

const SYSTEM = 'https://example.test/fhir/CodeSystem/source-file'

/** The FHIR server the test decoders' Patients are detached from. */
const FAKE_BASE_URL = 'https://example.test/fhir'

/** A Patient its source calls `id`, detached as a decoder hands it over. */
const fakeResource = (id: string): DetachedResource.Type =>
  DetachedResource.fromServerRecord(FAKE_BASE_URL)(
    Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', id })
  )

/** The id the import stores {@link fakeResource}`(id)` under. */
const fakeResourceId = (id: string): string =>
  localResourceId(`${FAKE_BASE_URL}/Patient`, 'Patient', id)

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
): Effect.Effect<DecodeFunction.FileSetDecode, ParseResult.ParseError> =>
  file.bytes.length === 0
    ? Effect.fail(emptyFileError(file.fileName))
    : Effect.succeed({
        sections: [
          {
            title: file.fileName,
            rows: [...file.bytes].map((byte, index) => ({
              fullUrl: `${file.fileName}:${index}`,
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

/** A format's batch decode, then the import stage over it, as `readBatch` runs them. */
type DecodeAndImport = (
  files: readonly PickedFile.Type[],
  settings: null
) => Effect.Effect<FormatDecode.Result<typeof testFormat>>

const decodeAndImport =
  (
    importer: ImportingFormat,
    decode: DecodeFunction.Type<null, typeof testFormat>
  ): DecodeAndImport =>
  (files, settings) =>
    Effect.flatMap(decode(files, settings), (decoded) => importDecoded(importer, decoded))

const decodeEachByte = DecodeFunction.make({
  format: testFormat,
  decodeFileSet: (pickedFiles) => decodeBytes(pickedFiles[0]),
})

const decode = decodeAndImport({ sourceFileFormat }, decodeEachByte)

/** A second format over the same system, to check that recognition is per-coding. */
const otherSourceFileFormat: PickedFile.FormatValue = {
  ...sourceFileFormat,
  coding: { system: SYSTEM, code: 'other-example' },
}

const otherDecode = decodeAndImport({ sourceFileFormat: otherSourceFileFormat }, decodeEachByte)

const fileArbitrary: fc.Arbitrary<PickedFile.Type> = fc
  .record({
    fileName: fc.stringMatching(/^[a-z0-9]{1,12}\.bin$/u),
    bytes: fc.uint8Array({ maxLength: 6 }),
  })
  .map((one) => oneFile(one.fileName, one.bytes))

/** The same files re-slotted as one batch, the way `readBatch` numbers a pick. */
const asBatch = (files: readonly PickedFile.Type[]): readonly PickedFile.Type[] =>
  files.map((file, index) => pickedFile(index, file.fileName, file.bytes))

/** The source file row a single-pick decode leads with. */
const mintedSourceFile = async (
  batchDecode: DecodeAndImport,
  file: PickedFile.Type
): Promise<PickedFile.SourceFile> => {
  const result = await Effect.runPromise(batchDecode([file], null))
  const resource = result.decoded.rows.sections[0]?.rows[0]?.resource
  if (resource?.resourceType !== 'DocumentReference')
    throw expect.fail('Expected a source file DocumentReference')
  return resource
}

const readBack = (
  format: PickedFile.FormatValue,
  resource: PickedFile.SourceFile
): Promise<PickedFile.Type> =>
  Effect.runPromise(
    Schema.decode(PickedFile.FromDocumentReference)(resource).pipe(
      Effect.provideService(PickedFile.Format, format)
    )
  )

describe('the source files the import mints', () => {
  it('reads its own minted source file back, bytes and name recovered', async () => {
    const file = oneFile('scan.bin', new Uint8Array([1, 2]))
    const resource = await mintedSourceFile(decode, file)

    expect(PickedFile.isSourceFile(sourceFileFormat)(resource)).toBe(true)
    const back = await readBack(sourceFileFormat, resource)
    expect(back.fileName).toBe('scan.bin')
    expect(back.bytes).toEqual(file.bytes)
    expect(back.id).toBe(resource.id)
  })

  it("does not claim another format's source file, though they share a system", async () => {
    const file = oneFile('scan.bin', new Uint8Array([1, 2]))
    const theirs = await mintedSourceFile(otherDecode, file)

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
    const sourceSection = result.decoded.rows.sections[0]
    expect(sourceSection?.title).toBe('Source file')
    const labeled = sourceSection?.rows[0]

    expect(labeled?.reviewable.key).toBe(`${FormatDecode.keyPrefix(file)}source-file/scan.bin`)
    expect(labeled?.reviewable.title).toBe('scan.bin')
  })

  it('should carry no upload instant on the source file it mints', async () => {
    const resource = await mintedSourceFile(decode, oneFile('scan.bin', new Uint8Array([1, 2])))
    expect(resource.date).toBeNull()
    expect(resource.content[0]?.attachment.creation).toBeNull()
  })

  it('should mint a source file for every pick, however it was picked', async () => {
    const result = await Effect.runPromise(
      decode(
        asBatch([oneFile('a.bin', new Uint8Array([1])), oneFile('b.bin', new Uint8Array([2]))]),
        null
      )
    )
    const titles = result.decoded.rows.sections.map((section) => section.title)
    expect(titles.filter((title) => title === 'Source file')).toHaveLength(2)
  })

  it('should mint the same id for the same bytes and name on every import', async () => {
    const file = oneFile('scan.bin', new Uint8Array([7]))
    const first = await mintedSourceFile(decode, file)
    const second = await mintedSourceFile(decode, file)
    expect(first.id).toBe(second.id)
  })
})

/** A `Reference` naming one resource, built from the schema's own empty value. */
const referenceValue = (reference: string): typeof IdentifierAndReference.ReferenceSchema.Type => ({
  ...IdentifierAndReference.emptyReference,
  reference,
})

const emptyContext = Schema.decodeSync(DocumentReferenceContext.Schema)({})

/** A format whose source files name the first resource the set decoded to. */
const linkingDecode = decodeAndImport(
  {
    sourceFileFormat,
    // The decode's own resources name the links, so a format never parses its
    // file twice to derive one.
    linkSourceFile: (sourceFile, decoded): PickedFile.SourceFile => {
      const first = SectionedList.rows(decoded.rows)[0]
      if (first === undefined) return sourceFile
      const reference = referenceValue(`Patient/${first.resource.id}`)
      return {
        ...sourceFile,
        subject: reference,
        context: { ...(sourceFile.context ?? emptyContext), related: [reference] },
      }
    },
  },
  decodeEachByte
)

describe('the source file a format links off its import', () => {
  it('should list the source file the format returned, links and all', async () => {
    const sourceRow = await mintedSourceFile(
      linkingDecode,
      oneFile('scan.bin', new Uint8Array([9]))
    )
    expect(sourceRow.subject?.reference).toBe(`Patient/${fakeResourceId('9')}`)
    expect(sourceRow.context?.related.map((one) => one.reference)).toEqual([
      `Patient/${fakeResourceId('9')}`,
    ])
  })

  it('should keep the minted id, and stamp meta.source with it', async () => {
    const file = oneFile('scan.bin', new Uint8Array([9]))
    const minted = await mintedSourceFile(decode, file)
    const linked = await mintedSourceFile(linkingDecode, file)
    expect(linked.id).toBe(minted.id)

    const result = await Effect.runPromise(linkingDecode([file], null))
    const extracted = result.decoded.rows.sections
      .slice(1)
      .flatMap((section) => section.rows)
      .map((row) => row.resource.meta?.source)
    expect(extracted).toEqual([`DocumentReference/${minted.id}`])
  })
})

describe('decode and import (batch behavior)', () => {
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
        // Each readable file contributes its source file's section plus a content
        // section — every pick mints, whatever it came from.
        expect(result.decoded.rows.sections.length).toBe(readable.length * 2)
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
          const sections = result.decoded.rows.sections
          expect(sections[0]?.title).toBe('Source file')
          expect(sections[0]?.rows.map((row) => row.reviewable.key)).toEqual([
            `${FormatDecode.keyPrefix(file)}source-file/${file.fileName}`,
          ])
          const sourceFileId = sections[0]?.rows[0]?.resource.id
          const extracted = sections.slice(1).flatMap((section) => section.rows)
          expect(extracted.length).toBe(file.bytes.length)
          for (const entry of extracted) {
            expect(entry.resource.meta?.source).toBe(`DocumentReference/${sourceFileId}`)
          }
        }
      ),
      { numRuns: numRunsFor({ base: 40 }) }
    )
  })

  it("should link every record to each picked file of its set and that file's source file", async () => {
    const seen: (readonly FileImporter.PickedSourceFile[])[] = []
    const linking = decodeAndImport(
      {
        sourceFileFormat,
        linkToSourceFiles: (resource, sourceFiles) => {
          seen.push(sourceFiles)
          return Effect.succeed(resource)
        },
      },
      decodeEachByte
    )
    const files = asBatch([
      oneFile('a.bin', new Uint8Array([1])),
      oneFile('b.bin', new Uint8Array([2])),
    ])
    const result = await Effect.runPromise(linking(files, null))
    const listed = result.decoded.rows.sections
      .filter((section) => section.title === 'Source file')
      .map((section) => section.rows[0]?.resource)
    // Sets are linked concurrently, so the hook sees them in no fixed order.
    expect(seen).toHaveLength(2)
    expect(seen).toEqual(
      expect.arrayContaining([
        [{ pickedFile: files[0], sourceFile: listed[0] }],
        [{ pickedFile: files[1], sourceFile: listed[1] }],
      ])
    )
  })

  it("should write what a picked file identifies itself as as its source file's masterIdentifier", async () => {
    const identifierOf = (file: PickedFile.Type): IdentifierAndReference.IdentifierType =>
      Schema.decodeSync(IdentifierAndReference.IdentifierSchema)({
        system: 'urn:ietf:rfc:3986',
        value: `urn:oid:1.2.${file.bytes[0] ?? 0}`,
      })
    const identifying = DecodeFunction.make({
      format: testFormat,
      decodeFileSet: (pickedFiles) =>
        Effect.map(decodeBytes(pickedFiles[0]), (decoded) => ({
          ...decoded,
          pickedFiles: Arr.map(pickedFiles, (file) => ({
            pickedFile: file,
            identifiedAs: Option.some(identifierOf(file)),
          })),
        })),
    })
    const file = oneFile('a.bin', new Uint8Array([7]))
    const identified = await mintedSourceFile(
      decodeAndImport({ sourceFileFormat }, identifying),
      file
    )
    const unidentified = await mintedSourceFile(decode, file)
    expect(identified).toEqual({ ...unidentified, masterIdentifier: identifierOf(file) })
    expect(unidentified.masterIdentifier).toBeNull()
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
          const keys = result.decoded.rows.sections.flatMap((section) =>
            section.rows.map((row) => row.reviewable.key)
          )
          expect(new Set(keys).size).toBe(keys.length)
        }
      ),
      { numRuns: numRunsFor({ base: 40 }) }
    )
  })

  it('should keep two files that decode to the same key apart', async () => {
    // Both files decode to a `<fileName>:0` key, and both mint a source file row —
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
    const keys = result.decoded.rows.sections.flatMap((section) =>
      section.rows.map((row) => row.reviewable.key)
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

/** One section per set, one resource per file; a set with an empty file rejects whole. */
const decodeGroup = (
  pickedFiles: Arr.NonEmptyReadonlyArray<PickedFile.Type>
): Effect.Effect<DecodeFunction.FileSetDecode, ParseResult.ParseError> =>
  pickedFiles.some((file) => file.bytes.length === 0)
    ? Effect.fail(emptyFileError(pickedFiles[0].fileName))
    : Effect.succeed({
        sections: [
          {
            title: groupOf(pickedFiles[0].fileName) ?? pickedFiles[0].fileName,
            rows: pickedFiles.map((file) => ({
              fullUrl: `file/${file.id}`,
              resource: fakeResource(`${file.bytes[0] ?? 0}`),
            })),
          },
        ],
        notes: [`${groupOf(pickedFiles[0].fileName) ?? '?'}: ${pickedFiles.length} files`],
      })

const groupedDecode = decodeAndImport(
  { sourceFileFormat },
  DecodeFunction.make({ format: testFormat, groupBy: groupByName, decodeFileSet: decodeGroup })
)

const stampsOf = (result: FormatDecode.Result<string>): ReadonlySet<string> =>
  new Set(
    SectionedList.rows(result.decoded.rows).flatMap((row) => {
      const source = row.resource.meta?.source
      return source === null || source === undefined ? [] : [source]
    })
  )

/** The key namespaces the *extracted* resources carry — one per set. */
const keyNamespacesOf = (result: FormatDecode.Result<string>): ReadonlySet<string> =>
  new Set(
    SectionedList.rows(result.decoded.rows)
      .filter((row) => row.resource.resourceType !== 'DocumentReference')
      .map((row) => row.reviewable.key.split('/')[0] ?? row.reviewable.key)
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

  it('namespaces a set by its first picked file and stamps it with one source file', async () => {
    const files = asBatch([
      oneFile('s-1.bin', new Uint8Array([1])),
      oneFile('s-2.bin', new Uint8Array([2])),
    ])
    const [first, second] = files
    if (first === undefined || second === undefined) throw expect.fail('two files expected')
    const result = await Effect.runPromise(groupedDecode(files, null))
    const prefix = FormatDecode.keyPrefix(first)
    const extracted = result.decoded.rows.sections
      .filter((section) => section.title === 's')
      .flatMap((section) => section.rows)
    expect(extracted.map((row) => row.reviewable.key)).toEqual([
      `${prefix}file/${first.id}`,
      `${prefix}file/${second.id}`,
    ])
    expect(stampsOf(result).size).toBe(1)
    // Both source files are listed, each keyed by its own pick.
    expect(result.decoded.rows.sections[0]?.title).toBe('Source files')
    expect(result.decoded.rows.sections[0]?.rows.map((row) => row.reviewable.key)).toEqual([
      `${prefix}source-file/s-1.bin`,
      `${FormatDecode.keyPrefix(second)}source-file/s-2.bin`,
    ])
  })

  it('property: a set stamps the smallest of its source file ids, whatever order it was picked in', async () => {
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

  it('keeps sets in pick order when their keys look like array indices', async () => {
    // A plain object would hoist integer-like keys ahead of the rest, sorted
    // numerically, whatever order the files were picked in.
    const result = await Effect.runPromise(
      groupedDecode(
        asBatch([
          oneFile('b-1.bin', new Uint8Array([1])),
          oneFile('10-1.bin', new Uint8Array([1])),
          oneFile('2-1.bin', new Uint8Array([1])),
          oneFile('b-2.bin', new Uint8Array([1])),
        ]),
        null
      )
    )
    expect(result.decoded.notes).toEqual(['b: 2 files', '10: 1 files', '2: 1 files'])
  })

  it('rejects exactly the picked files of a failing set, leaving its neighbours readable', async () => {
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

  it('reports the picked files of a set whose records name no source file as unreadable', async () => {
    const identifier = Schema.decodeSync(IdentifierAndReference.IdentifierSchema)({
      system: 'urn:ietf:rfc:3986',
      value: 'urn:oid:1.2.9',
    })
    const notFound = new FileImporter.SourceFileNotFound({ identifier })
    const unlinkable = decodeAndImport(
      {
        sourceFileFormat,
        // Set `b`'s records name a file none of its picked files identifies as.
        linkToSourceFiles: (resource, sourceFiles) =>
          sourceFiles.some((linked) => linked.pickedFile.fileName.startsWith('b-'))
            ? Effect.fail(notFound)
            : Effect.succeed(resource),
      },
      DecodeFunction.make({ format: testFormat, groupBy: groupByName, decodeFileSet: decodeGroup })
    )
    const result = await Effect.runPromise(
      unlinkable(
        asBatch([
          oneFile('a-1.bin', new Uint8Array([1])),
          oneFile('b-1.bin', new Uint8Array([2])),
          oneFile('b-2.bin', new Uint8Array([3])),
        ]),
        null
      )
    )
    expect(result.unreadableFiles.map((one) => [one.id, one.error])).toEqual([
      ['test/1:b-1.bin', notFound],
      ['test/2:b-2.bin', notFound],
    ])
    expect(result.decoded.notes).toEqual(['a: 1 files'])
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

// ---------------------------------------------------------------------------
// Records the stage adopts
// ---------------------------------------------------------------------------

const SOURCE_BASE_URL = 'https://example.test/fhir/source'

const sourcePatient: FhirResource = Schema.decodeUnknownSync(Patient.Schema)({
  resourceType: 'Patient',
  id: 'p1',
})

const sourceObservation: FhirResource = Schema.decodeUnknownSync(Observation.Schema)({
  resourceType: 'Observation',
  status: 'final',
  code: { text: 'weight' },
  subject: { reference: 'Patient/p1' },
})

const scan = oneFile('scan.bin', new Uint8Array([1]))

/** One file set of `scan`, holding `sections`, as a format's decode returns it. */
const decodedOf = (
  sections: readonly Section.Type<DecodedFileSet.Entry>[]
): FormatDecode.Decoded<typeof testFormat> => ({
  format: testFormat,
  files: [scan],
  fileSets: [
    { pickedFiles: [{ pickedFile: scan, identifiedAs: Option.none() }], sections, notes: [] },
  ],
  unreadableFiles: [],
})

/** The records `decoded` imports to, the source file section left out. */
const importedRecords = async (
  decoded: FormatDecode.Decoded<typeof testFormat>
): Promise<readonly FhirResourceWithId[]> => {
  const result = await Effect.runPromise(importDecoded({ sourceFileFormat }, decoded))
  return SectionedList.rows(SectionedList.make(result.decoded.rows.sections.slice(1))).map(
    (row) => row.resource
  )
}

/** The ids of the source files `decoded` imports to. */
const importedSourceFileIds = async (
  decoded: FormatDecode.Decoded<typeof testFormat>
): Promise<readonly string[]> => {
  const result = await Effect.runPromise(importDecoded({ sourceFileFormat }, decoded))
  return (result.decoded.rows.sections[0]?.rows ?? []).map((row) => row.resource.id)
}

describe('the records the import adopts', () => {
  it('adopts each detached record under the id its key derives, its references to records of the set resolved', async () => {
    const detachSource = DetachedResource.fromServerRecord(SOURCE_BASE_URL)
    const patientEntry = { fullUrl: 'patient', resource: detachSource(sourcePatient) }
    const observationEntry = { fullUrl: 'observation', resource: detachSource(sourceObservation) }
    const [sourceFileId] = await importedSourceFileIds(decodedOf([]))

    const imported = await importedRecords(
      decodedOf([
        { title: 'records', rows: [patientEntry] },
        { title: 'results', rows: [observationEntry] },
      ])
    )
    // The Observation is keyless, so the stage minted its id: the expectation
    // reuses it.
    const mintedObservationId = imported[1]?.id ?? ''
    const patientPlan = ResourcePlan.make(patientEntry.resource, () => mintedObservationId)
    const observationPlan = ResourcePlan.make(observationEntry.resource, () => mintedObservationId)
    if (patientPlan._tag !== 'Derived') {
      throw new Error('unreachable: the Patient is keyed by its source id')
    }
    const adoptRecord = adopt(
      ReferencePlan.of([
        {
          logicalReference: patientPlan,
          literalReference: ResourcePlan.literalReference(patientPlan),
        },
      ])
    )
    expect(imported).toEqual(
      [
        adoptRecord(patientEntry.resource, patientPlan.id),
        adoptRecord(observationEntry.resource, observationPlan.id),
      ].map((record) => MetaSource.stamp(record, MetaSource.makeReference(sourceFileId ?? '')))
    )
  })

  it("resolves a reference by the target's type under the server's base URL", async () => {
    const baseUrl = 'https://r4.example.test/fhir'
    const [observation] = await importedRecords(
      decodedOf([
        {
          title: 'records',
          rows: [
            {
              fullUrl: 'patient',
              resource: DetachedResource.fromServerRecord(baseUrl)(sourcePatient),
            },
            {
              fullUrl: 'observation',
              resource: DetachedResource.fromServerRecord(baseUrl)(sourceObservation),
            },
          ],
        },
      ])
    ).then((records) => records.filter((record) => record.resourceType === 'Observation'))
    expect(observation?.resourceType === 'Observation' && observation.subject?.reference).toBe(
      `Patient/${localResourceId(`${baseUrl}/Patient`, 'Patient', 'p1')}`
    )
  })

  // The source gave the Observation no id and no identifier, so nothing names
  // it: it is stored under an id of its own, a fresh one on every import.
  it('stores a keyless record under a fresh random id', async () => {
    const detached = DetachedResource.fromServerRecord(SOURCE_BASE_URL)(sourceObservation)
    expect(DetachedResource.keyOf(detached)).toEqual(Option.none())
    const imported = await Promise.all(
      [1, 2].map(() =>
        importedRecords(
          decodedOf([
            {
              title: 'records',
              rows: [{ fullUrl: 'observation', resource: detached }],
            },
          ])
        )
      )
    )
    const [[first], [second]] = imported
    expect(first?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(second?.id).not.toBe(first?.id)
  })
})
