import { Schema } from 'effect'
import type * as Bridge from './bridge.ts'
import type * as Message from './message.ts'

/**
 * URL-param wire-format helpers. The page-side bundle reads initial
 * messages from `window.location.search`; the host builds those params
 * onto the WebView's source URL. Each bridge owns the projection from a
 * typed message to its URL value via {@link Bridge.UrlParamSchemas} —
 * see {@link tagAndField} for the common single-string-field case.
 *
 * @remarks
 * Param shape: `?<Tag>=<value>` (one param per message). The tag is the
 * URL key, the encoded form is the URL value. Empty values omit the
 * `=` (`?<Tag>` instead of `?<Tag>=`) so payload-less messages render
 * as bare flags.
 */

/**
 * Build a URL-param schema for a single-string-field tagged struct.
 *
 * @example
 * ```ts
 * const HostRequestedWebNavigationUrl = tagAndField(
 *   'HostRequestedWebNavigation',
 *   'path'
 * )
 * // Schema<{ _tag: 'HostRequestedWebNavigation'; path: string }, string>
 * ```
 *
 * @remarks
 * The decoded form has `_tag` defaulted to the supplied literal — the
 * URL value carries only the field. The runtime-key cast is bounded
 * to the helper internals; the function signature restores precise
 * types for callers (the dynamic-key shape can't be expressed in
 * `Schema.Struct`'s input type alone).
 */
const tagAndField = <const Tag extends string, const Field extends string>(
  tag: Tag,
  field: Field
): Schema.Schema<TagAndFieldType<Tag, Field>, string> => {
  type Decoded = TagAndFieldType<Tag, Field>
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const decoded = Schema.Struct({
    _tag: Schema.Literal(tag),
    [field]: Schema.String,
  } as never) as unknown as Schema.Schema<Decoded>

  return Schema.transform(Schema.String, decoded, {
    strict: true,
    decode: (raw) =>
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      ({ _tag: tag, [field]: raw }) as never as Decoded,
    encode: (msg) => (msg as Record<Field, string>)[field],
  })
}

/** Type of the decoded message produced by {@link tagAndField}. */
type TagAndFieldType<Tag extends string, Field extends string> = Readonly<
  { readonly _tag: Tag } & Readonly<Record<Field, string>>
>

/**
 * Build a URL-param schema for a payload-less tagged struct (e.g.,
 * `HostBackRequested`). The encoded form is the empty string; the
 * URL serializer drops the `=` so the param renders as `?<Tag>`.
 */
const tagOnly = <const Tag extends string>(
  tag: Tag
): Schema.Schema<{ readonly _tag: Tag }, string> => {
  const decoded = Schema.Struct({ _tag: Schema.Literal(tag) })
  return Schema.transform(Schema.String, decoded, {
    strict: true,
    decode: () => ({ _tag: tag }),
    encode: () => '',
  })
}

/**
 * Look up the URL-param schema for a tag across a list of bridges.
 * Throws on duplicate-tag conflicts so wiring drift fails synchronously.
 */
const findUrlParamSchema = (
  bridges: ReadonlyArray<Bridge.AnyBridge>,
  tag: string
  // oxlint-disable-next-line typescript/no-explicit-any
): Schema.Schema<any, string, never> | undefined => {
  // oxlint-disable-next-line typescript/no-explicit-any
  let found: Schema.Schema<any, string, never> | undefined
  for (const bridge of bridges) {
    const schema = bridge.urlParams[tag]
    if (schema === undefined) continue
    if (found !== undefined) {
      throw new Error(`[effect-messaging] duplicate urlParams tag "${tag}" across bridges`)
    }
    found = schema
  }
  return found
}

/**
 * Encode a list of typed messages onto an existing URL's search params,
 * using each bridge's `urlParams` schemas. Empty-value params are
 * serialized without an `=` suffix.
 *
 * @throws if a message's tag has no `urlParams` schema among the supplied bridges.
 */
const appendMessagesToUrl = (
  url: URL,
  bridges: ReadonlyArray<Bridge.AnyBridge>,
  messages: ReadonlyArray<{ readonly _tag: string } & Readonly<Record<string, unknown>>>
): URL => {
  const out = new URL(url.toString())
  // Re-serialize the existing params (so trailing `=` semantics are
  // consistent with what we write below) plus the new message ones.
  const existing: Array<readonly [string, string]> = [...out.searchParams.entries()]
  out.search = ''
  const buffer: Array<readonly [string, string]> = [...existing]
  for (const message of messages) {
    const schema = findUrlParamSchema(bridges, message._tag)
    if (schema === undefined) {
      throw new Error(
        `[effect-messaging] no urlParams schema for tag "${message._tag}"; cannot encode as URL param`
      )
    }
    const encoded = Schema.encodeSync(schema)(message)
    buffer.push([message._tag, encoded])
  }
  out.search = serializeParams(buffer)
  return out
}

/**
 * Decode `?<Tag>=<value>` URL params into wire-JSON-encoded message
 * strings ready for the dispatch queue. Tags without a matching
 * `urlParams` schema are skipped (with a warning via `console.warn`)
 * — they're either non-message params the consumer should preserve, or
 * unknown tags. The matching wire schema (`hostToWeb` member) is used
 * to re-encode for dispatch.
 */
const decodeMessagesFromParams = (
  search: string,
  bridges: ReadonlyArray<Bridge.AnyBridge>
): ReadonlyArray<string> => {
  const params = new URLSearchParams(search)
  const result: string[] = []
  for (const [key, value] of params) {
    const urlSchema = findUrlParamSchema(bridges, key)
    if (urlSchema === undefined) continue
    const wireSchema = findWireSchema(bridges, key)
    if (wireSchema === undefined) continue
    let decoded: unknown
    try {
      decoded = Schema.decodeSync(urlSchema)(value)
    } catch {
      continue
    }
    let wire: string
    try {
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      wire = Schema.encodeSync(wireSchema)(decoded as never)
    } catch {
      continue
    }
    result.push(wire)
  }
  return result
}

/**
 * Look up the wire (host→web) schema for a tag across the bridges.
 * Used by the URL decoder to re-encode the decoded message as the
 * canonical wire JSON the dispatch fiber consumes.
 */
const findWireSchema = (
  bridges: ReadonlyArray<Bridge.AnyBridge>,
  tag: string
): Message.StringEncodedSchema | undefined => {
  for (const bridge of bridges) {
    const schema = bridge.Web.InboundSchemas[tag]
    if (schema !== undefined) return schema
  }
  return undefined
}

/**
 * Strip every URL param whose key has a `urlParams` schema on any of
 * the supplied bridges. Used after `decodeMessagesFromParams` so a
 * Fast Refresh / HMR cycle doesn't re-dispatch them. Non-bridge params
 * (e.g., third-party tracking) are preserved.
 */
const stripMessageParams = (search: string, bridges: ReadonlyArray<Bridge.AnyBridge>): string => {
  const params = new URLSearchParams(search)
  const remaining: Array<readonly [string, string]> = []
  for (const [key, value] of params) {
    if (findUrlParamSchema(bridges, key) !== undefined) continue
    remaining.push([key, value])
  }
  return serializeParams(remaining)
}

/**
 * Serialize an entry list to a search string. Empty values produce a
 * bare key (`?Tag` instead of `?Tag=`) — the asymmetry stays on the
 * write side; `URLSearchParams` reads either form back identically.
 */
const serializeParams = (entries: ReadonlyArray<readonly [string, string]>): string => {
  if (entries.length === 0) return ''
  const parts = entries.map(([k, v]) =>
    v === '' ? encodeURIComponent(k) : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
  )
  return parts.join('&')
}

export { appendMessagesToUrl, decodeMessagesFromParams, stripMessageParams, tagAndField, tagOnly }
