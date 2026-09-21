/**
 * What makes a set of picked `.dcm` files one import: a study, and a patient.
 *
 * @packageDocumentation
 */
import { DicomHeader } from 'dicom'
import { Either } from 'effect'
import type { PickedFile } from 'importer-fundamentals'

import { patientOriginalId } from './fhir/to-fhir.ts'

/** A picked file whose header parsed, with the slot it was picked in. */
interface ParsedFile {
  readonly file: PickedFile.Type
  /** The file's position in the batch — what its review keys are namespaced by. */
  readonly index: number
  readonly header: DicomHeader.Type
}

/** A picked file `dicom-parser` rejected, with the reason it gave. */
interface UnparsedFile {
  readonly file: PickedFile.Type
  readonly index: number
  readonly reason: string
}

/** One study's picked files, in pick order. Never empty. */
interface StudyUnit {
  readonly files: readonly ParsedFile[]
}

/** A batch's picks, split into the studies they make up and the files that are none. */
interface Partition {
  /** One unit per study, ordered by the pick that opened it. */
  readonly units: readonly StudyUnit[]
  /** The picks whose headers did not parse, in pick order. */
  readonly unparsed: readonly UnparsedFile[]
}

/**
 * What two files must agree on to be the same import: the study, and the
 * patient it is filed under.
 *
 * @remarks
 * `StudyInstanceUID` alone would be enough for well-formed data, and is not
 * what this keys on. A `PatientID` the files disagree on means one of them is
 * mislabelled or anonymized differently, and merging them would file one
 * patient's images in another's record — so a differing patient splits the
 * unit instead, and the reviewer sees two studies with the same UID rather
 * than one silently merged. Patient identity is the id the synthesis derives
 * (`PatientID` + issuer, else name + birth date), not the raw tag, so two
 * spellings that mint the same `Patient` stay one unit.
 */
const unitKey = (header: DicomHeader.Type): string =>
  `${header.studyInstanceUid}\u0000${patientOriginalId(header) ?? ''}`

/**
 * Split a picked batch into its studies.
 *
 * @param files - Every `.dcm` the format claimed, in pick order
 * @returns One {@link StudyUnit} per study, and the picks whose headers did
 *   not parse
 *
 * @remarks
 * Parses headers and nothing else — cheap enough to run over a whole pick
 * before any synthesis. A file that fails to parse is its own row rather than
 * a member of some study: it states no `StudyInstanceUID`, so there is no
 * study to put it in, and folding it into a neighbour's unit would hide which
 * file failed.
 */
const partition = (files: readonly PickedFile.Type[]): Partition => {
  const byKey = new Map<string, ParsedFile[]>()
  const unparsed: UnparsedFile[] = []

  files.forEach((file, index) => {
    const parsed = DicomHeader.tryFromDicomFile(file.bytes)
    if (Either.isLeft(parsed)) {
      unparsed.push({ file, index, reason: parsed.left.reason })
      return
    }
    const member: ParsedFile = { file, index, header: parsed.right }
    const key = unitKey(parsed.right)
    const members = byKey.get(key)
    if (members === undefined) byKey.set(key, [member])
    else members.push(member)
  })

  // Map iteration is insertion-ordered, so the units come out ordered by the
  // pick that opened each — the order the reviewer picked the files in.
  return { units: [...byKey.values()].map((members): StudyUnit => ({ files: members })), unparsed }
}

export { partition, unitKey }
export type { Partition, ParsedFile, StudyUnit, UnparsedFile }
