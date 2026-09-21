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
 * Parse a DICOM PN (Person Name) value. The PN grammar is
 * `family^given^middle^prefix^suffix` with `^` separating components.
 * Only family and given are extracted; the rest folds into `text`.
 *
 * @remarks
 * Returns `undefined` for a value that carries no name at all — both the empty
 * string and a delimiters-only value like `"^^^"`, which DICOM writers emit for
 * an anonymized or absent name. Those are not a name with empty parts: a
 * {@link Type} this returns always has a non-empty `text`, which is the
 * invariant `dicom-importer-core`'s FHIR synthesis leans on (FHIR `string`
 * forbids an empty value, and an id derived from an empty name would collide
 * across every such file).
 */
const tryFromPnString = (raw: string): Type | undefined => {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const components = trimmed.split('^')
  const family = (components[0] ?? '').trim()
  const given = (components[1] ?? '').trim()
  const text = components
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .join(' ')
  if (text === '') return undefined
  return { family, given, text }
}

export { tryFromPnString, type Type }
