import { Schema } from 'effect'

/** The web→host `__Ready` handshake constants used by the transport wiring. */

/** The web→host handshake signal tag. Resolves the host's send gate. */
const READY_TAG = '__Ready' as const

/**
 * Inner (post-`parseJson`) schema for the `__Ready` control message.
 * Injected into the inbound dispatcher as an extra schema so `__Ready`
 * decodes like any other message without the dispatcher knowing the tag.
 */
const ReadyMessageSchema = Schema.TaggedStruct(READY_TAG, {})

export { READY_TAG, ReadyMessageSchema }
