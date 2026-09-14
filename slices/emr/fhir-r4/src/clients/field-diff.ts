/**
 * The structural leaf-level diff between two wire-form resources — the "what
 * actually differs" behind a `changed` {@link DiffStatus}. Where
 * {@link classifyAgainstServer} collapses the compare to one status, this
 * enumerates each differing leaf as a `path`, the server's value, and the
 * incoming value, so a reviewer can see `name[0].family "Smith" -> "Smyth"`
 * rather than a bare "differs" badge — and, per leaf, reset the incoming value
 * back to the server's ({@link setAtPath}).
 *
 * @remarks
 * Pure JSON, no schema: it diffs the two *already-encoded, normalized* wire
 * objects the classifier compares (see {@link normalizedEncode}), so both
 * sides share the same schema-emitted key set and a diff is almost always a
 * scalar-value delta at a matching path. The schema round-trip (encode a
 * resource, set a leaf, decode it back) lives with the schema in
 * `classify-against-server.ts`; this module is the value-level machinery it
 * builds on.
 *
 * @packageDocumentation
 */

/** One segment of a leaf path: an object key or an array index. */
type PathSegment = string | number

/**
 * One side of a leaf compare: the value present at that path, or `absent`
 * when the path exists on the other side only (a longer array, an extra
 * optional field). `absent` is what makes a per-leaf reset able to *remove*
 * a field rather than only overwrite it.
 */
type DiffSlot = { readonly _tag: 'value'; readonly value: unknown } | { readonly _tag: 'absent' }

/**
 * One differing leaf: the `path` to it (rendered by {@link formatPath}), the
 * `server`'s value there, and the `incoming` value. Read as
 * `formatPath(path): server -> incoming`.
 */
interface FieldDiff {
  readonly path: readonly PathSegment[]
  readonly server: DiffSlot
  readonly incoming: DiffSlot
}

/** A present slot around `value`. */
const present = (value: unknown): DiffSlot => ({ _tag: 'value', value })

/** The absent slot. */
const ABSENT: DiffSlot = { _tag: 'absent' }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Read `key` as an own property, or `undefined` when it is not one — so
 * descending through a `__proto__` segment reads the object's own value rather
 * than the inherited prototype.
 */
const ownValue = (object: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(object, key) ? object[key] : undefined

/**
 * Set `key` to `value` as an own data property and return `object`. A plain
 * `object[key] = value` would hit `Object.prototype`'s `__proto__` setter for
 * that one key (silently dropping a non-object value) rather than writing an
 * own property, so define the property explicitly.
 */
const withKey = (
  object: Record<string, unknown>,
  key: string,
  value: unknown
): Record<string, unknown> => {
  Object.defineProperty(object, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  })
  return object
}

/** `Array.isArray`, narrowing to `readonly unknown[]` rather than `any[]`. */
const isArray = (value: unknown): value is readonly unknown[] => Array.isArray(value)

/** Structural equality via a stable stringify — both sides come from the same schema encode, so key order matches. */
const equalJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * The slot for `key` on a record: its value, or absent when the key is not
 * present. Uses {@link Object.hasOwn} rather than `in` so an inherited key
 * (`__proto__`, `toString`) reads as absent unless it is genuinely present as
 * an own property.
 */
const slotOf = (record: Record<string, unknown>, key: string): DiffSlot =>
  Object.hasOwn(record, key) ? present(record[key]) : ABSENT

/** The slot for `index` on an array: its element, or absent when out of range. */
const slotAt = (array: readonly unknown[], index: number): DiffSlot =>
  index < array.length ? present(array[index]) : ABSENT

/** Server keys first, then any incoming-only keys — a stable, server-led field order. */
const unionKeys = (
  server: Record<string, unknown>,
  incoming: Record<string, unknown>
): string[] => {
  const keys = Object.keys(server)
  for (const key of Object.keys(incoming)) if (!Object.hasOwn(server, key)) keys.push(key)
  return keys
}

/**
 * Recurse the two slots at `path`, pushing one {@link FieldDiff} per differing
 * leaf into `out`. Two records recurse by their key union; two arrays recurse
 * index-wise up to the longer length; anything else (scalars, or a
 * container-vs-scalar / container-vs-absent mismatch) is one leaf.
 */
const diffInto = (
  out: FieldDiff[],
  path: readonly PathSegment[],
  server: DiffSlot,
  incoming: DiffSlot
): void => {
  if (server._tag === 'absent' && incoming._tag === 'absent') return
  if (server._tag === 'value' && incoming._tag === 'value') {
    const s = server.value
    const i = incoming.value
    if (isRecord(s) && isRecord(i)) {
      for (const key of unionKeys(s, i))
        diffInto(out, [...path, key], slotOf(s, key), slotOf(i, key))
      return
    }
    if (isArray(s) && isArray(i)) {
      const length = Math.max(s.length, i.length)
      for (let index = 0; index < length; index += 1) {
        diffInto(out, [...path, index], slotAt(s, index), slotAt(i, index))
      }
      return
    }
    if (!equalJson(s, i)) out.push({ path, server, incoming })
    return
  }
  // Exactly one side present: an added or removed field/element — one leaf.
  out.push({ path, server, incoming })
}

/**
 * The leaf-level diff between two wire-form values, `server` against
 * `incoming`. Empty when they are structurally equal.
 *
 * @param server - The server's normalized wire object
 * @param incoming - The would-be-written resource's normalized wire object
 * @returns One {@link FieldDiff} per differing leaf, in server-led field order
 */
const diffJson = (server: unknown, incoming: unknown): readonly FieldDiff[] => {
  const out: FieldDiff[] = []
  diffInto(out, [], present(server), present(incoming))
  return out
}

/**
 * Render a leaf path as a dotted/indexed string: `name[0].family`, `gender`,
 * `meta.profile[1]`. The empty path renders as `''` (a whole-value diff, which
 * a resource root never produces).
 */
const formatPath = (path: readonly PathSegment[]): string =>
  path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') return `${acc}[${segment}]`
    return acc === '' ? segment : `${acc}.${segment}`
  }, '')

/** Render one side of a diff for display: a JSON literal, or `(absent)`. */
const formatSlot = (slot: DiffSlot): string =>
  slot._tag === 'absent' ? '(absent)' : JSON.stringify(slot.value)

/**
 * Immutably set (or, for an `absent` slot, remove) the value at `path` in a
 * wire object, cloning only the spine along the path. Removing a leaf splices
 * the array element or deletes the object key; setting overwrites it. A
 * missing intermediate container is created as the shape the next segment
 * needs (an array for a numeric segment, else an object) — the schema-symmetric
 * inputs mean this only bites for added array elements.
 *
 * @param root - The wire object to patch
 * @param path - The leaf path to set
 * @param slot - The value to set, or {@link ABSENT} to remove the leaf
 * @returns A new wire object with the one leaf changed; `root` is untouched
 */
const setAtPath = (root: unknown, path: readonly PathSegment[], slot: DiffSlot): unknown => {
  const [head, ...rest] = path
  if (head === undefined) return slot._tag === 'value' ? slot.value : root
  if (typeof head === 'number') {
    const array: unknown[] = isArray(root) ? [...root] : []
    if (rest.length === 0) {
      if (slot._tag === 'absent') {
        array.splice(head, 1)
        return array
      }
      array[head] = slot.value
      return array
    }
    array[head] = setAtPath(array[head], rest, slot)
    return array
  }
  const object: Record<string, unknown> = isRecord(root) ? { ...root } : {}
  if (rest.length === 0) {
    if (slot._tag === 'absent') {
      delete object[head]
      return object
    }
    return withKey(object, head, slot.value)
  }
  return withKey(object, head, setAtPath(ownValue(object, head), rest, slot))
}

export {
  ABSENT,
  diffJson,
  formatPath,
  formatSlot,
  present,
  setAtPath,
  type DiffSlot,
  type FieldDiff,
  type PathSegment,
}
