/**
 * How the import plan page names a record or a resource in a sentence, and
 * which of its identity fields it states.
 *
 * @packageDocumentation
 */
import { HumanName } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  type FhirResource,
  type FhirResourceWithId,
  literalReferenceOf,
} from '@wildflowerhealthio/fhir-r4/resources'
import { FormatDecode, ImportedRecord } from '@wildflowerhealthio/importer-fundamentals'
import { type DateTime, Option, Record } from 'effect'

import * as FieldValueText from './field-value-text.ts'

/**
 * The name a Patient or a Practitioner goes by at `now`
 * (`HumanName.displayName`); `None` for any other resource, or a person with
 * no name.
 */
const personNameOf = (now: DateTime.DateTime, resource: FhirResource): Option.Option<string> =>
  resource.resourceType === 'Patient' || resource.resourceType === 'Practitioner'
    ? Option.fromNullable(HumanName.displayName(resource.name, now))
    : Option.none()

/**
 * `record`'s title in a sentence: the name a person goes by at `now`, else
 * the title the plan shows it under (`ImportedRecord.titleOf`).
 */
const titleOf = (now: DateTime.DateTime, record: ImportedRecord.Type): string =>
  Option.getOrElse(personNameOf(now, ImportedRecord.resourceOf(record)), () =>
    ImportedRecord.titleOf(record)
  )

/**
 * A stored resource's title in a sentence: the name a person goes by at
 * `now`, else its literal reference, `<Type>/<id>`.
 */
const titleOfResource = (now: DateTime.DateTime, resource: FhirResourceWithId): string =>
  Option.getOrElse(personNameOf(now, resource), () => literalReferenceOf(resource))

/** The title of the file set `record` is listed under: its picked files' names. */
const fileTitleOf = (record: ImportedRecord.Type): string =>
  FormatDecode.titleOf(ImportedRecord.originOf(record).pickedFiles)

/**
 * The fields that say who a resource of each type is, in the order a reader
 * names them.
 */
const IDENTITY_FIELDS: Record.ReadonlyRecord<string, readonly string[]> = {
  Patient: ['name', 'birthDate', 'gender'],
  Practitioner: ['name'],
}

/**
 * The identity fields of `resource`'s type ({@link IDENTITY_FIELDS}) it has
 * a value for, in that order; none for a type with no identity fields.
 */
const statedIdentityFieldsOf = (resource: FhirResource): readonly string[] =>
  Record.get(IDENTITY_FIELDS, resource.resourceType).pipe(
    Option.getOrElse((): readonly string[] => []),
    (fields) => fields.filter((field) => Option.isSome(FieldValueText.valueOf(resource, field)))
  )

export { fileTitleOf, statedIdentityFieldsOf, titleOf, titleOfResource }
