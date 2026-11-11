/**
 * The walk `ResourceReferences` and `ResourceAttachments` share: every value
 * of one data type a decoded resource carries, at any depth, at its path,
 * found by a schema check rather than a list of field names.
 *
 * @packageDocumentation
 */

/** Whether `value` is a record the decode built — not a `URL` or any other class instance. */
const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const fieldPath = (parent: string, key: string): string =>
  parent.length === 0 ? key : `${parent}.${key}`

/**
 * `value` with `rewrite` applied to every record in it that `isTarget`
 * accepts, each with its path under `path`: fields joined with `.`, array
 * elements indexed with `[n]`. The walk carries on into what `rewrite`
 * returns, so a target nested in a target is reached too. Records and arrays
 * nothing changed in come back as themselves.
 */
const mapTargets = <TTarget extends object>(
  value: unknown,
  path: string,
  isTarget: (record: object) => record is TTarget,
  rewrite: (target: TTarget, path: string) => TTarget
): unknown => {
  if (Array.isArray(value)) {
    const elements: readonly unknown[] = value
    const mapped = elements.map((element, index) =>
      mapTargets(element, `${path}[${index}]`, isTarget, rewrite)
    )
    return mapped.every((element, index) => element === elements[index]) ? value : mapped
  }
  if (!isPlainRecord(value)) return value
  const visited: object = isTarget(value) ? rewrite(value, path) : value
  const fields = Object.entries(visited)
  const mapped = fields.map(
    ([key, field]) => [key, mapTargets(field, fieldPath(path, key), isTarget, rewrite)] as const
  )
  const unchanged =
    visited === value && mapped.every(([, field], index) => field === fields[index]?.[1])
  return unchanged ? value : Object.fromEntries(mapped)
}

export { mapTargets }
