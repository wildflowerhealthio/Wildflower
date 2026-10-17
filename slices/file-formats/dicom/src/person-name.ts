/**
 * DICOM Person Name (PN): the parsed form of a `family^given^…` value.
 *
 * @packageDocumentation
 */

/**
 * DICOM Person Name: `family^given` from the PN grammar.
 *
 * `text` is always non-empty — {@link tryFromPnString} returns `undefined`
 * rather than a name with nothing in it, so a delimiters-only PN (`"^^^"`)
 * reads as an absent name. `family` and `given` may each still be empty.
 */
interface Type {
  readonly family: string
  readonly given: string
  readonly text: string
}

/**
 * Parse a DICOM PN (Person Name) value. The PN grammar is up to three
 * component groups separated by `=` — alphabetic, ideographic, phonetic — each
 * `family^given^middle^prefix^suffix` with `^` separating components. The
 * first group with a non-blank component is read; only its family and given
 * are extracted, and the rest of it folds into `text`.
 *
 * @remarks
 * One group, because a FHIR `HumanName` holds one spelling: the alphabetic
 * group when there is one, which is the one other systems match on. A value
 * with only an ideographic group (`=山田^太郎`) reads that group.
 *
 * Returns `undefined` for a value that carries no name at all — both the empty
 * string and a delimiters-only value like `"^^^"` or `"^^=^"`, which DICOM
 * writers emit for an anonymized or absent name. Those are not a name with
 * empty parts: a {@link Type} this returns always has a non-empty `text`,
 * which is the invariant `dicom-importer-core`'s FHIR synthesis leans on (FHIR
 * `string` forbids an empty value, and an id derived from an empty name would
 * collide across every such file).
 *
 * @param raw - The PN value, already decoded under the file's Specific
 *   Character Set
 */
const tryFromPnString = (raw: string): Type | undefined => {
  const components = raw
    .split('=')
    .map((group) => group.split('^').map((component) => component.trim()))
    .find((group) => group.some((component) => component !== ''))
  if (components === undefined) return undefined
  const family = components[0] ?? ''
  const given = components[1] ?? ''
  const text = components.filter((component) => component !== '').join(' ')
  return { family, given, text }
}

export { tryFromPnString, type Type }
