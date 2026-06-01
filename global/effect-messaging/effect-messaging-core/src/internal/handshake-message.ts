import { Schema } from 'effect'

/**
 * The web→host `__Ready` handshake, consolidated.
 *
 * @remarks
 * Previously these constants were smeared across `bridge-transport.ts`.
 * Gathering them here lets the registry (tag), the inbound dispatcher
 * (schema), and the transport wiring (wire string) each import the one
 * they need without a `bridge-transport` → unit → `bridge-transport`
 * import cycle. **Temporary:** Leap C (Phase 3) evicts the handshake from
 * the core transport entirely, at which point this whole module is
 * deleted.
 */

/** The web→host handshake signal tag. Resolves the host's send gate. */
const READY_TAG = '__Ready' as const

/**
 * Inner (post-`parseJson`) schema for the `__Ready` control message.
 * Composed into the inbound dispatch union so `__Ready` decodes like any
 * other message.
 */
const ReadyMessageSchema = Schema.TaggedStruct(READY_TAG, {})

/** Wire-format schema for `__Ready`: encoded as a JSON tagged struct. */
const ReadyMessageWireSchema = Schema.parseJson(ReadyMessageSchema)

/**
 * Pre-encoded `__Ready` wire string. Schema-encoded so the wire form
 * stays in lockstep with the inbound dispatch's union member.
 */
const READY_RAW = Schema.encodeSync(ReadyMessageWireSchema)({ _tag: READY_TAG })

export { READY_TAG, ReadyMessageSchema, READY_RAW }
