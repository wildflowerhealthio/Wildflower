/**
 * A routed SMART app's query as flat strings, every value as the address
 * bar holds it: a TanStack router's `parseSearch`.
 *
 * @remarks
 * The router's default JSON-parses each value, so `?patient=123` reads as the
 * number `123`, `?patient=1.50` as `1.5` and `?patient=1e5` as `100000`, and
 * the string `'123'` writes back as `?patient=%22123%22`. A FHIR id is a
 * string that can look like a number, so an app whose query is `?patient=`
 * (a FHIR id or `*`, `patientChoiceKeyOf`'s form) reads and writes it
 * with `URLSearchParams` as it stands.
 */
const parsePlainSearch = (searchStr: string): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(searchStr))

/**
 * The inverse of {@link parsePlainSearch}, a TanStack router's
 * `stringifySearch`: every string value, leaving out unset keys.
 */
const stringifyPlainSearch = (search: Record<string, unknown>): string => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === 'string') params.set(key, value)
  }
  const query = params.toString()
  return query === '' ? '' : `?${query}`
}

export { parsePlainSearch, stringifyPlainSearch }
