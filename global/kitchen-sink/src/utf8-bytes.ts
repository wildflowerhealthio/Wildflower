/**
 * The one `TextEncoder` this module hands out.
 *
 * @remarks
 * `TextEncoder` is stateless and its `encode` is re-entrant, so a single
 * instance serves every caller. Allocating one per call is the easy mistake:
 * `utf8Bytes` sits under hashing and digest code that runs thousands of times
 * per batch, where the allocation is a visible share of the work.
 */
const encoder = new TextEncoder()

/**
 * `text` as its UTF-8 bytes.
 *
 * @param text - The string to encode
 * @returns A fresh `Uint8Array` of the UTF-8 encoding
 *
 * @remarks
 * A named wrapper rather than an inline `new TextEncoder().encode(…)` so the
 * encoder is allocated once for the process — see {@link encoder}. The returned
 * array is freshly allocated per call and is the caller's to keep.
 *
 * Encoding is total: a lone surrogate encodes as U+FFFD rather than throwing,
 * which is `TextEncoder`'s own behaviour and not something this wrapper changes.
 */
const utf8Bytes = (text: string): Uint8Array => encoder.encode(text)

export { utf8Bytes }
