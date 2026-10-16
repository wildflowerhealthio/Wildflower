/**
 * The marker standing in for a `null` field. Unambiguous because
 * {@link escapeField} doubles every backslash, so no escaped field can render
 * as a lone backslash followed by `~`.
 */
const NULL_FIELD = '\\~'

/** The separator between a series id's fields, escaped inside each field. */
const FIELD_SEPARATOR = '|'

/** The separator between a series id's prefix and its fields. */
const PREFIX_SEPARATOR = ':'

/** What an escaped, non-null field may hold: no bare `|` or `\`, only `\|` and `\\`. */
const ESCAPED_FIELD = /^(?:[^\\|]|\\[\\|])*$/

/** Escape `|` and `\` so a field can carry either without splitting the id. */
const escapeField = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll(FIELD_SEPARATOR, '\\|')

/** Render one field of a series id, mapping `null` to {@link NULL_FIELD}. */
const renderField = (value: string | null): string =>
  value === null ? NULL_FIELD : escapeField(value)

/**
 * Split an escaped field list on unescaped {@link FIELD_SEPARATOR}s.
 *
 * @returns The still-escaped fields, or `null` on a dangling escape — which no
 *   {@link escapeField} output can end in
 */
const splitFields = (body: string): readonly string[] | null => {
  const fields: string[] = []
  let current = ''
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (char === '\\') {
      if (index + 1 >= body.length) return null
      current += char + body[index + 1]
      index += 1
    } else if (char === FIELD_SEPARATOR) {
      fields.push(current)
      current = ''
    } else {
      current += char
    }
  }
  fields.push(current)
  return fields
}

/**
 * Whether {@link renderField} could have written `field`: the null marker, or
 * text whose only escapes are `\|` and `\\`.
 */
const isRenderedField = (field: string): boolean =>
  field === NULL_FIELD || ESCAPED_FIELD.test(field)

/** Reverse {@link renderField}; the null marker reads back as `null`. */
const parseField = (field: string): string | null =>
  field === NULL_FIELD ? null : field.replaceAll(/\\([\\|])/g, '$1')

/**
 * The series id `<prefix>:<field>|<field>|…`, each field escaped and a `null`
 * one written as the null marker.
 *
 * @param prefix - The domain source's `idPrefix`, which says whose grammar the
 *   fields are in
 *
 * @remarks
 * External contract: a shared link carries these, so changing the escaping
 * invalidates every link already saved.
 */
const fromFields = (prefix: string, fields: readonly (string | null)[]): string =>
  `${prefix}${PREFIX_SEPARATOR}${fields.map(renderField).join(FIELD_SEPARATOR)}`

/**
 * Read back the fields {@link fromFields} wrote under `prefix`. Never throws —
 * ids arrive from a user-editable URL.
 *
 * @returns The unescaped fields, or `null` for another prefix, a dangling
 *   escape, or any spelling {@link fromFields} would not have produced — so
 *   an id that parses renders back to exactly itself
 *
 * @remarks
 * Field count and which fields may be `null` are the domain grammar's to
 * check; this only undoes the escaping.
 */
const toFields = (prefix: string, id: string): readonly (string | null)[] | null => {
  const head = `${prefix}${PREFIX_SEPARATOR}`
  if (!id.startsWith(head)) return null
  const escaped = splitFields(id.slice(head.length))
  if (escaped === null) return null
  return escaped.every(isRenderedField) ? escaped.map(parseField) : null
}

export { fromFields, toFields }
