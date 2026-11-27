/**
 * How the import plan page names a record in a sentence.
 *
 * @packageDocumentation
 */
import { HumanName } from '@wildflowerhealthio/fhir-r4/data-types'
import { ImportedRecord } from '@wildflowerhealthio/importer-fundamentals'
import { type DateTime, Option } from 'effect'

/**
 * The name a Patient or a Practitioner goes by at `now`
 * (`HumanName.displayName`); `None` for any other record, or a person with
 * no name.
 */
const personNameOf = (
  now: DateTime.DateTime,
  record: ImportedRecord.Type
): Option.Option<string> => {
  const resource = ImportedRecord.resourceOf(record)
  return resource.resourceType === 'Patient' || resource.resourceType === 'Practitioner'
    ? Option.fromNullable(HumanName.displayName(resource.name, now))
    : Option.none()
}

/**
 * `record`'s title in a sentence: the name a person goes by at `now`, else
 * the title the plan shows it under (`ImportedRecord.titleOf`).
 */
const titleOf = (now: DateTime.DateTime, record: ImportedRecord.Type): string =>
  Option.getOrElse(personNameOf(now, record), () => ImportedRecord.titleOf(record))

export { titleOf }
