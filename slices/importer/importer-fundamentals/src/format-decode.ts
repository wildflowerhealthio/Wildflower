import { type ParseResult } from 'effect'
import { type FhirResource } from 'fhir-r4/resources'
import type * as DecodedFile from './decoded-file.ts'
import { type PickedFile } from './picked-file.ts'

const makeId = (format: string, files: readonly PickedFile[]): string =>
  `${format}/${files.map((f) => f.fileName).join(',')}`

interface Result<TFormat extends string> {
  readonly id: string
  readonly title: string
  readonly files: readonly PickedFile[]
  readonly format: TFormat
  readonly decoded: DecodedFile.DecodedFile<FhirResource>
  readonly unreadableFiles: readonly UnreadableFile[]
}

interface UnreadableFile {
  readonly id: string
  readonly title: string
  readonly pickedFile: PickedFile
  readonly error: ParseResult.ParseError
}

/** A format with no claimed files — the seed for unclaimed format slots. */
const emptyResult = <K extends string>(kind: K): Result<K> => ({
  id: makeId(kind, []),
  title: '',
  files: [],
  format: kind,
  decoded: { sections: [], notes: [] },
  unreadableFiles: [],
})

export { makeId, emptyResult }
export type { Result, UnreadableFile }
