/**
 * DICOM Person Name (PN): the parsed form of a `family^given^…` value.
 *
 * @packageDocumentation
 */

/**
 * DICOM Person Name: `family^given` from the PN grammar.
 *
 * `text` is always non-empty — `parsePersonName` returns `undefined` rather
 * than a name with nothing in it, so a delimiters-only PN (`"^^^"`) reads as an
 * absent name. `family` and `given` may each still be empty.
 */
interface PersonName {
  readonly family: string
  readonly given: string
  readonly text: string
}

export type { PersonName }
