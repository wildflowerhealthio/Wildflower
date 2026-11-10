import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { Patient } from '@wildflowerhealthio/fhir-r4/resources'
import { Array as Arr, Effect, Either, Option, ParseResult, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as DecodeFunction from './decode-function.ts'
import * as DecodedFileSet from './decoded-file-set.ts'
import type * as PickedFile from './picked-file.ts'
import * as Section from './section.ts'
import * as SectionedList from './sectioned-list.ts'

// A decode through `importer-core`'s import stage, source files and all, is
// tested there (`import-decoded.test.ts`). What this file covers is what the
// constructor itself returns: the file sets, apart, and their records.

const BASE_URL = 'https://source.example/fhir'

/** A Patient its source calls `id`, detached from {@link BASE_URL}. */
const fakeResource = (id: string): DetachedResource.Type =>
  DetachedResource.fromServerRecord(BASE_URL)(
    Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', id })
  )

const pickedFile = (index: number, fileName: string, bytes: number[]): PickedFile.Type => ({
  id: `${index}:${fileName}`,
  fileName,
  bytes: new Uint8Array(bytes),
})

/** Files grouped by the prefix before their `-`; a set with an empty file rejects whole. */
const decode = DecodeFunction.make({
  format: 'test',
  groupBy: (file) => Either.right(file.fileName.split('-')[0] ?? ''),
  decodeFileSet: (pickedFiles) =>
    pickedFiles.some((file) => file.bytes.length === 0)
      ? Effect.fail(
          new ParseResult.ParseError({
            issue: new ParseResult.Type(Schema.Unknown.ast, pickedFiles[0].fileName, 'empty file'),
          })
        )
      : Effect.succeed({
          pickedFiles: Arr.map(pickedFiles, DecodedFileSet.unidentified),
          sectionedList: SectionedList.make([
            Section.make(
              pickedFiles[0].fileName,
              pickedFiles.map((file) => ({
                localKey: file.fileName,
                resource: fakeResource(`${file.bytes[0]}`),
              }))
            ),
          ]),
          notes: [`${pickedFiles.length} files`],
        }),
})

describe('DecodeFunction.make', () => {
  it('returns each set apart, its picked files in the order they were picked and its records under their local keys', async () => {
    const files = [
      pickedFile(0, 'a-1.bin', [1]),
      pickedFile(1, 'b-1.bin', [2]),
      pickedFile(2, 'a-2.bin', [3]),
    ]
    const [a1, b1, a2] = files
    const decoded = await Effect.runPromise(decode(files, null))
    expect(decoded).toEqual({
      format: 'test',
      files,
      fileSets: [
        {
          pickedFiles: [a1, a2].map(DecodedFileSet.unidentified),
          sectionedList: SectionedList.make([
            Section.make(
              'a-1.bin',
              [a1, a2].map((file) => ({
                localKey: file.fileName,
                resource: fakeResource(`${file.bytes[0]}`),
              }))
            ),
          ]),
          notes: ['2 files'],
        },
        {
          pickedFiles: [b1].map(DecodedFileSet.unidentified),
          sectionedList: SectionedList.make([
            Section.make('b-1.bin', [{ localKey: 'b-1.bin', resource: fakeResource('2') }]),
          ]),
          notes: ['1 files'],
        },
      ],
      unreadableFiles: [],
    })
  })

  it('reports every file of a set that rejects, leaving its neighbours decoded', async () => {
    const decoded = await Effect.runPromise(
      decode([pickedFile(0, 'a-1.bin', [1]), pickedFile(1, 'b-1.bin', [])], null)
    )
    expect(
      decoded.fileSets.map((fileSet) => fileSet.pickedFiles.map((one) => one.pickedFile.id))
    ).toEqual([['0:a-1.bin']])
    expect(decoded.unreadableFiles.map((one) => one.id)).toEqual(['test/1:b-1.bin'])
  })

  it('keeps each picked file beside what its decode says it identifies itself as', async () => {
    const identifier = Schema.decodeSync(IdentifierAndReference.IdentifierSchema)({
      system: 'urn:ietf:rfc:3986',
      value: 'urn:oid:1.2.3',
    })
    const files = [pickedFile(0, 'a-1.bin', [1]), pickedFile(1, 'a-2.bin', [2])]
    const [first, second] = files
    const identifying = DecodeFunction.make({
      format: 'test',
      groupBy: () => Either.right('a'),
      decodeFileSet: (pickedFiles) =>
        Effect.succeed({
          pickedFiles: Arr.map(pickedFiles, (file, index) => ({
            pickedFile: file,
            identifiedAs: index === 0 ? Option.some(identifier) : Option.none(),
          })),
          sectionedList: SectionedList.empty(),
          notes: [],
        }),
    })
    const decoded = await Effect.runPromise(identifying(files, null))
    expect(decoded.fileSets.map((fileSet) => fileSet.pickedFiles)).toEqual([
      [
        { pickedFile: first, identifiedAs: Option.some(identifier) },
        { pickedFile: second, identifiedAs: Option.none() },
      ],
    ])
  })
})
