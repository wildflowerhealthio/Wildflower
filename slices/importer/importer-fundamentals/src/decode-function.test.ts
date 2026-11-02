import { IdentifierAndReference, withMandatoryId } from '@wildflowerhealthio/fhir-r4/data-types'
import { type FhirResourceWithId, Patient } from '@wildflowerhealthio/fhir-r4/resources'
import { Effect, Either, Option, ParseResult, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as DecodeFunction from './decode-function.ts'
import * as DecodedFileSet from './decoded-file-set.ts'
import * as FormatDecode from './format-decode.ts'
import type * as PickedFile from './picked-file.ts'

// A decode through `importer-core`'s import stage, source files and all, is
// tested there (`import-decoded.test.ts`). What this file covers is what the
// constructor itself returns: the file sets, apart, and their records.

const fakeResource = (id: string): FhirResourceWithId =>
  Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))({ resourceType: 'Patient', id })

const pickedFile = (index: number, fileName: string, bytes: number[]): PickedFile.Type => ({
  id: `${index}:${fileName}`,
  fileName,
  bytes: new Uint8Array(bytes),
})

/** A picked file that identifies itself as nothing, as every set of `decode` holds it. */
const unidentified = (file: PickedFile.Type): DecodedFileSet.PickedFileIdentity => ({
  pickedFile: file,
  identifiedAs: Option.none(),
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
          sections: [
            {
              title: pickedFiles[0].fileName,
              resources: pickedFiles.map((file) => ({
                key: file.fileName,
                title: file.fileName,
                resource: fakeResource(`${file.bytes[0]}`),
              })),
            },
          ],
          notes: [`${pickedFiles.length} files`],
        }),
})

describe('DecodeFunction.make', () => {
  it('returns each set apart, its picked files in the order they were picked and its sections Adopted under namespaced keys', async () => {
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
          pickedFiles: [a1, a2].map(unidentified),
          sections: [
            DecodedFileSet.Section.Adopted({
              title: 'a-1.bin',
              entries: [a1, a2].map((file) => ({
                key: `${FormatDecode.keyPrefix(a1)}${file.fileName}`,
                title: file.fileName,
                resource: fakeResource(`${file.bytes[0]}`),
              })),
            }),
          ],
          notes: ['2 files'],
        },
        {
          pickedFiles: [b1].map(unidentified),
          sections: [
            DecodedFileSet.Section.Adopted({
              title: 'b-1.bin',
              entries: [
                {
                  key: `${FormatDecode.keyPrefix(b1)}b-1.bin`,
                  title: 'b-1.bin',
                  resource: fakeResource('2'),
                },
              ],
            }),
          ],
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

  it('pairs each picked file with what its decode says it identifies itself as', async () => {
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
          sections: [],
          notes: [],
          identifiedAs: new Map([[pickedFiles[0].id, identifier]]),
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
