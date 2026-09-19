/**
 * The shared lookup behind the UID name tables.
 *
 * @packageDocumentation
 */

/**
 * Look a UID up in a name table.
 *
 * @remarks
 * `Object.hasOwn` rather than a bare index: these tables are object literals,
 * so a bare lookup answers inherited keys — `'constructor'` would come back as
 * a function that a caller would then render as a transfer syntax name. The
 * UID is untrusted input read straight out of a file.
 */
const lookupUidName = (table: Readonly<Record<string, string>>, uid: string): string | undefined =>
  Object.hasOwn(table, uid) ? table[uid] : undefined

export { lookupUidName }
