# Bridge Schemas Reference

How to declare wire schemas for an `effect-messaging` `Bridge` without falling into the transforms-get-stripped trap. Companion to the source-level comments in `bridge-transport.ts` and the per-bridge files (`browser-sniffer-core/messages.ts`, `collector-core/bridge.ts`).

## The constraint

`BridgeTransport.make({bridges, layers, side})` calls `Schema.typeSchema(schema)` on **every** inbound message schema before wiring it into dispatch. `typeSchema` strips transforms — it returns the _output_ (`Type`) side of the schema with any decode/encode steps removed. The result is the schema the transport expects after a single `JSON.parse` over the wire.

Concretely, if you declare a field as:

```ts
data: Schema.Uint8ArrayFromBase64
```

`Schema.typeSchema` strips the base64 → bytes transform and the transport now expects `data` to _already be a `Uint8Array`_ after `JSON.parse`. The wire (a base64 `string`) cannot satisfy that, and decoding fails.

## The convention

When a bridge field needs a wire form that differs from its consumer-facing type, **declare the wire form on the schema and decode at the consumer boundary**.

For base64 bytes:

```ts
// Wire: base64 string. Consumers that need bytes apply
// `Schema.decode(Schema.Uint8ArrayFromBase64)` (or `atob`) at their
// own boundary.
data: Schema.String
```

For a date that travels as an ISO string:

```ts
// Wire: ISO 8601 string.
timestamp: Schema.String
// Consumer: Schema.decode(Schema.DateFromString)(msg.timestamp)
```

For a `Map` that travels as an array of pairs:

```ts
// Wire: array of tuples.
headers: Schema.Array(Schema.Tuple(Schema.String, Schema.String))
// Consumer: new Map(msg.headers)
```

## What `typeSchema` does and doesn't preserve

| Schema construct                                                                        | `typeSchema` output                                   | Safe to use as a bridge wire field?                         |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------- |
| `Schema.String` / `Number` / `Boolean` / `Null`                                         | Same                                                  | Yes                                                         |
| `Schema.Int`, `Schema.NonEmptyString`, `Schema.Literal(...)`                            | Same (refinement preserved)                           | Yes                                                         |
| `Schema.between`, `Schema.pattern`, `Schema.minLength`, etc.                            | Same (refinement preserved)                           | Yes                                                         |
| `Schema.Array(T)`, `Schema.Tuple(...)`, `Schema.Record(...)`                            | Same shape with inner `typeSchema`d                   | Yes                                                         |
| `Schema.Struct({...})`, `Schema.TaggedStruct(...)`                                      | Same                                                  | Yes                                                         |
| `Schema.Union(...)`                                                                     | Same                                                  | Yes                                                         |
| `Schema.parseJson(inner)`                                                               | The `inner` schema                                    | **Yes — required at the top level of every bridge message** |
| `Schema.transform(...)`, `Schema.transformOrFail(...)`                                  | The _Type_ side; the encode/decode functions are gone | **No** — the wire will never produce the Type side directly |
| `Schema.DateFromString`, `Schema.Uint8ArrayFromBase64`, `Schema.BigIntFromString`, etc. | The Type side (`Date`, `Uint8Array`, `bigint`)        | **No**                                                      |
| `Schema.brand('X')` over a primitive                                                    | Same (refinement preserved)                           | Yes — branding doesn't affect runtime decoding              |

## The top-level `parseJson` wrap

Every bridge message _should_ be wrapped in `Schema.parseJson` at declaration. The bridge transport runs each inbound wire string through one `JSON.parse`, and `parseJson`'s structure is what tells the transport "this came from a JSON string." `Schema.typeSchema` peels off the `parseJson` wrap, leaving the inner `TaggedStruct` — that's the post-`JSON.parse` shape the transport dispatches against.

```ts
const FooMessageBody = Schema.TaggedStruct('Foo', { x: Schema.Int })
const FooMessage = Schema.parseJson(FooMessageBody)
// Use `FooMessage` in the bridge declaration.
// Export `FooMessageBody` for code that needs the post-JSON-parse type
// (e.g. injected scripts that JSON.stringify their own messages and need
// the JSON-stringifiable shape via `Schema.Schema.Encoded<typeof FooMessageBody>`).
```

## Decoding at the consumer

Once a message dispatches to a handler, the payload type is the result of `Schema.typeSchema(MessageSchema)` — the post-`JSON.parse` shape. Wire-vs-domain transforms happen inside the handler:

```ts
ResponseData: (msg) =>
  Effect.gen(function* () {
    // msg.data is a base64 string. If we need bytes:
    const bytes = yield* Schema.decode(Schema.Uint8ArrayFromBase64)(msg.data)
    // ...
  })
```

This keeps the bridge contract narrow (every wire field is JSON-primitive) and pushes the policy choice (do I want bytes? a Date? a Map?) to the consumer that actually cares.

## When you need a transform anyway

If the _wire form itself_ needs a transform — e.g. you want to accept either a string or an integer for a field — write a `Schema.Union(Schema.String, Schema.Int)` rather than a `Schema.transformOrFail(...)`. The transport sees both Union branches as valid post-`JSON.parse` shapes; transforms it does not.

If you genuinely need to refuse certain values at the dispatch boundary (rather than in the handler), use refinements (`Schema.filter`, `Schema.pattern`, `Schema.between`) — those _are_ preserved through `typeSchema`.

## Worked example

The browser-sniffer `ResponseDataMessage` carries response chunks. The natural type is `Uint8Array`; the wire is base64. Wire schema:

```ts
const ResponseDataMessageBody = Schema.TaggedStruct('ResponseData', {
  id: SnifferRequestId, // NonEmptyString refinement — preserved
  data: Schema.String, // wire form; not Uint8ArrayFromBase64
})
const ResponseDataMessage = Schema.parseJson(ResponseDataMessageBody)
```

Consumer (collector handler):

```ts
ResponseData: (event) =>
  Effect.gen(function* () {
    const decoded = Encoding.decodeBase64(event.data)
    if (Either.isLeft(decoded)) {
      /* emit Left(...) and drop */ return
    }
    response.appendChunk(decoded.right)
  })
```

The bridge stays in lockstep with `JSON.parse`; the consumer policy (how to handle bad base64) is local.

## Tests that pin the convention

`slices/browser-sniffer/browser-sniffer-core/tests/bridge.test.ts` round-trips arbitrary instances of every message through `BridgeTransport` + `TestPlatformAdapterLayer`. If anyone slips a `Schema.transform` into a bridge field, the property test fails — either the arbitrary generates a Type-side value that doesn't survive `JSON.stringify` / `JSON.parse`, or the round-trip decode rejects the wire-side string.
