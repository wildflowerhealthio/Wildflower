import { Array, Option, Schema } from 'effect'
import * as Bridge from './bridge.ts'

/**
 * URL-param wire-format helpers. The page-side bundle reads initial
 * messages from `window.location.search`; the host builds those params
 * onto the WebView's source URL. Each bridge owns the projection from a
 * typed message to its URL value via {@link Bridge.UrlParamSchemas} —
 * see {@link singleStringMessageSchema} for the common single-string-field case.
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
 * const HostRequestedWebNavigationUrl = singleStringMessageSchema(
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
const singleStringMessageSchema = <const Tag extends string, const FieldName extends string>(
  tag: Tag,
  field: FieldName
): Schema.Schema<SingleStringMessage<Tag, FieldName>, string> => {
  // oxlint-disable typescript/no-unsafe-type-assertion
  const decoded = Schema.Struct({
    _tag: Schema.Literal(tag),
    [field]: Schema.String,
  }) as unknown as Schema.Schema<SingleStringMessage<Tag, FieldName>>
  // oxlint-enable typescript/no-unsafe-type-assertion

  return Schema.transform(Schema.String, decoded, {
    strict: true,
    decode: (raw) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      ({ _tag: tag, [field]: raw }) as SingleStringMessage<Tag, FieldName>,
    encode: (msg) => msg[field],
  })
}

/** Type of the decoded message produced by {@link singleStringMessageSchema}. */
type SingleStringMessage<Tag extends string, FieldName extends string> = Readonly<
  { readonly _tag: Tag } & Readonly<Record<FieldName, string>>
>

/**
 * Build a URL-param schema for a payload-less tagged struct (e.g.,
 * `HostBackRequested`). The encoded form is the empty string; the
 * URL serializer drops the `=` so the param renders as `?<Tag>`.
 */
const tagOnlyMessageSchema = <const Tag extends string>(
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
  const newEntries = Array.map(messages, (message): [string, string] => {
    const schema = Bridge.findUrlParamSchema(bridges, message._tag)
    if (schema === undefined) {
      throw new Error(
        `[effect-messaging] no urlParams schema for tag "${message._tag}"; cannot encode as URL param`
      )
    }
    const encoded = Schema.encodeSync(schema)(message)
    return [message._tag, encoded] as const
  })
  const out = new URL(url.toString())
  // Re-serialize the existing params (so trailing `=` semantics are
  // consistent with what we write below) plus the new message ones.
  out.search = serializeParams([...out.searchParams.entries(), ...newEntries])
  return out
}

/**
 * Decode `?<Tag>=<value>` URL params into wire-JSON-encoded message
 * strings ready for the dispatch queue. Tags without a matching
 * `urlParams` schema are silently skipped — they're either non-message
 * params the consumer wants preserved, or unknown tags. The matching
 * wire schema (`hostToWeb` member) is used to re-encode for dispatch.
 */
const reEncodeMessagesFromParams = (
  search: string,
  bridges: ReadonlyArray<Bridge.AnyBridge>
): ReadonlyArray<string> =>
  Array.filterMap([...new URLSearchParams(search)], ([key, value]) =>
    Option.gen(function* () {
      const urlSchema = yield* Option.fromNullable(Bridge.findUrlParamSchema(bridges, key))
      const wireSchema = yield* Option.fromNullable(Bridge.findWireSchema(bridges, key))
      return yield* Option.flatMap(
        Schema.decodeOption(urlSchema)(value),
        Schema.encodeOption(wireSchema)
      )
    })
  )

/**
 * Strip every URL param whose key has a `urlParams` schema on any of
 * the supplied bridges. Used after `reEncodeMessagesFromParams` so a
 * Fast Refresh / HMR cycle doesn't re-dispatch them. Non-bridge params
 * (e.g., third-party tracking) are preserved.
 */
const stripMessageParams = (search: string, bridges: ReadonlyArray<Bridge.AnyBridge>): string => {
  const params = new URLSearchParams(search)
  const remaining: Array<readonly [string, string]> = []
  for (const [key, value] of params) {
    if (Bridge.findUrlParamSchema(bridges, key) !== undefined) continue
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
  const parts = entries.map(([k, v]) => {
    if (v === '') {
      return encodeURIComponent(k)
    } else {
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
    }
  })
  return parts.join('&')
}

export {
  appendMessagesToUrl,
  reEncodeMessagesFromParams,
  stripMessageParams,
  singleStringMessageSchema,
  tagOnlyMessageSchema,
}
