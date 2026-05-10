/**
 * Wire-format helpers for encoding pre-encoded message strings as URL
 * query parameters and decoding them back.
 *
 * @remarks
 * The web side reads initial messages from `window.location.search`
 * instead of an injected script global; the host side encodes them
 * onto the WebView's source URL. The transport reuses the existing
 * `parseJson(TaggedStruct(...))` schemas — the URL is just another
 * channel for the same encoded JSON string.
 *
 * Param shape: `?msg.<Tag>=<base64url(JSON)>`. The tag is duplicated
 * in the key for human-readable URLs; the decoder ignores the key
 * payload (the JSON it encloses owns the canonical tag). Multiple
 * messages with the same tag are supported via `URLSearchParams`'
 * multi-value semantics.
 */

/** Reserved URL-param key prefix for transport-level initial messages. */
const PARAM_KEY_PREFIX = 'msg.' as const

/** UTF-8 base64url encode of a string. No padding. */
const toBase64Url = (s: string): string => {
  const bytes = new TextEncoder().encode(s)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** UTF-8 base64url decode back to the original string. */
const fromBase64Url = (s: string): string => {
  const swapped = s.replaceAll('-', '+').replaceAll('_', '/')
  const padded = swapped + '='.repeat((4 - (swapped.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

/**
 * Build URL params from an array of pre-encoded message strings.
 * Each entry must be a JSON-encoded tagged struct (the wire format
 * `parseJson(TaggedStruct(...))` produces).
 *
 * @throws if any entry is not a parseable JSON tagged struct.
 */
const encodeMessagesAsParams = (encodedMessages: ReadonlyArray<string>): URLSearchParams => {
  const params = new URLSearchParams()
  for (const raw of encodedMessages) {
    const tag = readTagFromEncoded(raw)
    params.append(`${PARAM_KEY_PREFIX}${tag}`, toBase64Url(raw))
  }
  return params
}

/**
 * Decode message strings from a URL's `search` portion (e.g.
 * `window.location.search`). Returns `[]` if no `msg.*` keys are
 * present. Malformed param values are skipped silently — the dispatch
 * core warns on any downstream decode failure.
 */
const decodeMessagesFromParams = (search: string): ReadonlyArray<string> => {
  const params = new URLSearchParams(search)
  const result: string[] = []
  for (const [key, value] of params) {
    if (!key.startsWith(PARAM_KEY_PREFIX)) continue
    try {
      result.push(fromBase64Url(value))
    } catch {
      // Malformed base64; skip.
    }
  }
  return result
}

const readTagFromEncoded = (raw: string): string => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`[effect-messaging] cannot encode initial message; not valid JSON: ${raw}`)
  }
  if (typeof parsed !== 'object' || parsed === null || !('_tag' in parsed)) {
    throw new Error(`[effect-messaging] cannot encode initial message; not a tagged struct: ${raw}`)
  }
  // `'_tag' in parsed` narrows `parsed._tag` to the property's declared type
  // (`unknown` for an open record); the typeof check then narrows to string.
  const tag: unknown = parsed._tag
  if (typeof tag !== 'string') {
    throw new Error(`[effect-messaging] cannot encode initial message; not a tagged struct: ${raw}`)
  }
  return tag
}

export { decodeMessagesFromParams, encodeMessagesAsParams, PARAM_KEY_PREFIX }
