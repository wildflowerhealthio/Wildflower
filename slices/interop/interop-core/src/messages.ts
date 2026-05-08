/* oxlint-disable no-console -- diagnostic warnings inside the buffered
   dispatcher; they surface lifecycle bugs (re-registration after dispose,
   un-consumed buffers) that would otherwise be silent. */
import type { Schema } from 'effect'

/**
 * A schema for a single Message: encoded form is a `string` (typically JSON
 * via {@link Schema.parseJson}); decoded form has a literal `_tag`. Messages
 * are fire-and-forget — sender and receiver are loosely coupled, with no
 * request/response correlation.
 */
type MessageSchema<Tag extends string, A extends { readonly _tag: Tag }> = Schema.Schema<A, string>

/**
 * The value type used for entries inside a {@link MessageSchemaRecord}.
 *
 * Effect's `Schema<in out A, in out I, out R>` is **invariant** in `A` and
 * `I` — a `Schema<{_tag: 'X'}, string>` is *not* assignable to
 * `Schema<{_tag: string}, string>` even though the decoded types are
 * compatible. That bites any attempt to constrain a record's values to
 * `Schema<{_tag: string}, string>`. Using `any` for `A` sidesteps the
 * invariance (TS exempts `any` from variance checks) while keeping the
 * encoded form pinned to `string` — so `encodeSync(schema)(msg)` still
 * returns `string`, not `any`, downstream.
 */
// oxlint-disable-next-line typescript-eslint/no-explicit-any
type AnyTaggedJsonSchema = Schema.Schema<any, string, never>

/**
 * A record of {@link MessageSchema}s keyed by their `_tag`. The "key matches
 * the schema's `_tag` literal" invariant is enforced at construction time
 * by {@link makeMessageRecord}'s tuple-pair input (and a drift test), not
 * in this record type itself — so this constraint stays a plain `Record`
 * shape that any concrete record (e.g. `{ readonly Foo: typeof Foo }`)
 * trivially extends.
 */
type MessageSchemaRecord = Readonly<Record<string, AnyTaggedJsonSchema>>

/**
 * Tuple form accepted by {@link makeMessageRecord}. The schema in position 1
 * is the loose {@link AnyTaggedJsonSchema} (Schema<any, string, never>) for
 * the variance reason described above. The "key in position 0 matches the
 * schema's `_tag`" invariant is enforced by:
 *
 * - The drift test in `makeMessageRecord`'s test suite.
 * - Each schema's `Schema.parseJson(Schema.TaggedStruct(<tag>, ...))`
 *   already locks the `_tag` literal at construction time.
 */
type MessageSchemaPair<Tag extends string = string> = readonly [Tag, AnyTaggedJsonSchema]

/**
 * Build a {@link MessageSchemaRecord} from an array of `[tag, schema]` pairs.
 *
 * Use `as const` on the call-site array so TypeScript preserves the literal
 * tag types and produces a record whose keys exactly match the supplied tags:
 *
 * ```ts
 * const NavigationRequested = Schema.parseJson(
 *   Schema.TaggedStruct('NavigationRequested', { path: Schema.String })
 * )
 * const Record = makeMessageRecord([['NavigationRequested', NavigationRequested]] as const)
 * // Record: { readonly NavigationRequested: typeof NavigationRequested }
 * ```
 */
const makeMessageRecord = <const Pairs extends ReadonlyArray<MessageSchemaPair>>(
  pairs: Pairs
): { readonly [P in Pairs[number] as P[0]]: P[1] } => {
  const record: Record<string, AnyTaggedJsonSchema> = {}
  for (const [tag, schema] of pairs) record[tag] = schema
  // The runtime structure is exactly `{ [tag]: schema }` for every input pair,
  // matching the mapped-type cast. TS can't see the connection between the
  // tuple's first element and the resulting key, so the cast is unavoidable.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return record as { readonly [P in Pairs[number] as P[0]]: P[1] }
}

/**
 * Read side of a {@link MessageHandler}: register tag-keyed listeners and
 * synchronously drain previously-buffered messages without subscribing.
 */
/**
 * The decoded message type for a given `Tag` in a record. The intersection
 * with `{readonly _tag: Tag}` ensures the `_tag` field is typed as the
 * literal `Tag` even when `Schema.Schema.Type<Receive[Tag]>` widens to `any`
 * (because `MessageSchemaRecord`'s value type is `Schema<any, string, never>`
 * — see {@link AnyTaggedJsonSchema}).
 */
type DecodedMessage<R extends MessageSchemaRecord, Tag extends keyof R & string> = {
  readonly _tag: Tag
} & Schema.Schema.Type<R[Tag]>

interface MessageReader<Receive extends MessageSchemaRecord> {
  /**
   * Register a single listener for `tag`. Drains any messages buffered while
   * no listener was registered. Returns a disposer; once the disposer runs,
   * subsequent messages of that tag are dropped with a warning.
   *
   * Single-listener-per-tag: re-registering a tag whose previous listener
   * has not been disposed warns and replaces.
   */
  setMessageListener<Tag extends keyof Receive & string>(
    tag: Tag,
    listener: (message: DecodedMessage<Receive, Tag>) => void
  ): () => void
  /**
   * Drain and return any messages buffered for `tag` without registering a
   * listener. Useful for synchronously seeding pre-React state (e.g. the
   * initial route from {@link AppNavigationRequested}). Subsequent messages
   * of `tag` continue to buffer until a listener is registered or the
   * handler is disposed.
   */
  consumeBuffered<Tag extends keyof Receive & string>(
    tag: Tag
  ): ReadonlyArray<DecodedMessage<Receive, Tag>>
}

/** Write side of a {@link MessageHandler}: send a tagged message across the transport. */
interface MessageWriter<Send extends MessageSchemaRecord> {
  sendMessage<Tag extends keyof Send & string>(message: DecodedMessage<Send, Tag>): void
}

/**
 * A bidirectional cross-process bridge. `Receive` is the record of messages
 * that may arrive from the other side; `Send` is the record of messages that
 * may be sent. The two records are typically distinct so the type system
 * enforces direction (e.g. the web side cannot send `NativeBackRequested`).
 */
interface MessageHandler<
  Receive extends MessageSchemaRecord,
  Send extends MessageSchemaRecord = Receive,
>
  extends MessageReader<Receive>, MessageWriter<Send> {
  /**
   * Tear down the handler: detach any transport-level listeners, mark all
   * tags disposed (subsequent receives drop with a warning), and warn if any
   * tag's buffer is still non-empty.
   */
  dispose(): void
}

/**
 * Per-tag dispatcher state.
 *
 * - `idle` — no listener has ever been registered. Incoming messages buffer.
 * - `live` — a listener is registered. Incoming messages dispatch directly.
 * - `disposed` — the listener has been disposed (or the dispatcher disposed
 *   wholesale). Incoming messages are dropped with a warning.
 */
type TagState<A> =
  | { readonly kind: 'idle'; readonly queue: ReadonlyArray<A> }
  | { readonly kind: 'live'; readonly listener: (m: A) => void }
  | { readonly kind: 'disposed' }

interface BufferedDispatcher<Receive extends MessageSchemaRecord> extends MessageReader<Receive> {
  receive<Tag extends keyof Receive & string>(message: DecodedMessage<Receive, Tag>): void
  dispose(): void
}

/**
 * Transport-free per-tag buffer + listener registry. Both the web and Expo
 * platform handlers wrap one of these to bridge their respective postMessage
 * surfaces to the {@link MessageReader} contract.
 *
 * Lifecycle per tag: `idle` → `live` (on first listener) → `disposed` (on
 * disposer). Re-registration after disposal is rejected.
 */
const makeBufferedDispatcher = <
  Receive extends MessageSchemaRecord,
>(): BufferedDispatcher<Receive> => {
  type AnyMessage = Schema.Schema.Type<Receive[keyof Receive & string]>
  const states = new Map<string, TagState<AnyMessage>>()

  const stateOf = (tag: string): TagState<AnyMessage> =>
    states.get(tag) ?? { kind: 'idle', queue: [] }

  const receive: BufferedDispatcher<Receive>['receive'] = (message) => {
    // Inside generic dispatcher code, `Schema.Schema.Type<Receive[Tag]>`
    // collapses to `any` (because `AnyTaggedJsonSchema` uses `any` for `A`
    // to dodge Schema's invariance), and `{_tag: Tag} & any` collapses to
    // `any`. The runtime guarantee — every value in the record is a
    // tagged-struct schema — lets us narrow safely.
    const tag = (message as { readonly _tag: string })._tag
    const state = stateOf(tag)
    if (state.kind === 'live') {
      state.listener(message)
      return
    }
    if (state.kind === 'disposed') {
      console.warn(`[interop] received "${tag}" after listener disposed; dropping`)
      return
    }
    states.set(tag, { kind: 'idle', queue: [...state.queue, message] })
  }

  const setMessageListener: BufferedDispatcher<Receive>['setMessageListener'] = (tag, listener) => {
    const previous = stateOf(tag)
    if (previous.kind === 'disposed') {
      throw new Error(
        `[interop] cannot register listener for "${tag}": previously disposed. ` +
          `Re-registration after dispose is not supported.`
      )
    }
    if (previous.kind === 'live') {
      console.warn(
        `[interop] replacing existing listener for "${tag}"; previous registration was not disposed`
      )
    }
    // The dispatcher's external API is keyed by `Tag extends keyof Receive`;
    // internally we store `AnyMessage` (the union over all receive tags) to
    // avoid a per-tag map type. The listener is only ever invoked with
    // messages whose `_tag === tag` (see receive), so widening here is safe.
    const widenedListener = listener as (m: AnyMessage) => void
    states.set(tag, { kind: 'live', listener: widenedListener })

    if (previous.kind === 'idle') {
      for (const queued of previous.queue) widenedListener(queued)
    }

    let active = true
    return (): void => {
      if (!active) return
      active = false
      const current = stateOf(tag)
      // Identity-check: only this listener clears state. If a later
      // setMessageListener replaced ours, the disposer is a no-op.
      if (current.kind === 'live' && current.listener === widenedListener) {
        states.set(tag, { kind: 'disposed' })
      }
    }
  }

  const consumeBuffered: BufferedDispatcher<Receive>['consumeBuffered'] = (tag) => {
    const state = stateOf(tag)
    if (state.kind !== 'idle') return []
    if (state.queue.length === 0) return []
    states.set(tag, { kind: 'idle', queue: [] })
    // Same `Tag extends keyof Receive` widening as in setMessageListener.
    return state.queue as ReadonlyArray<Schema.Schema.Type<Receive[typeof tag]>>
  }

  const dispose: BufferedDispatcher<Receive>['dispose'] = () => {
    const stranded: Array<{ tag: string; count: number }> = []
    for (const [tag, state] of states.entries()) {
      if (state.kind === 'idle' && state.queue.length > 0) {
        stranded.push({ tag, count: state.queue.length })
      }
      states.set(tag, { kind: 'disposed' })
    }
    if (stranded.length > 0) {
      const summary = stranded.map((s) => `${s.tag} (${s.count})`).join(', ')
      console.warn(`[interop] disposed with un-consumed messages: ${summary}`)
    }
  }

  return { receive, setMessageListener, consumeBuffered, dispose }
}

export { makeBufferedDispatcher, makeMessageRecord }
export type {
  BufferedDispatcher,
  MessageHandler,
  MessageReader,
  MessageSchema,
  MessageSchemaPair,
  MessageSchemaRecord,
  MessageWriter,
}
