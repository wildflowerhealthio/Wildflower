import { Data, type Effect } from 'effect'

import type { PickedFile } from './picked-file.ts'

/**
 * "An anonymizable file format" as one first-class value: everything the shell
 * needs to accept, identify, and decode a picked file — format-agnostic in this
 * package, bound to a concrete format (HAR, PDF) in its own binding packages.
 *
 * @packageDocumentation
 */

/**
 * Raised when a picked file identified as this format cannot actually be
 * decoded.
 *
 * @remarks
 * Carries the format's own user-facing sentence, so the shell renders the
 * failure next to the picker without knowing the format. Deliberately not a
 * `ParseError`: what went wrong inside the decode is the binding's business;
 * what the user can do about it is the only part that crosses this seam.
 */
class DecodeFailure extends Data.TaggedError('DecodeFailure')<{
  /** The user-facing sentence the shell shows (`'That archive could not be read as a HAR.'`). */
  readonly message: string
}> {}

/**
 * One file format the anonymizer shell can route a picked file to.
 *
 * @typeParam T - The decoded value this format's panel consumes (an
 *   `HttpArchive.Log` for HAR)
 *
 * @remarks
 * The anonymize mirror of the importer slice's `FileImporterDescriptor` — one
 * value a closed, compile-time registry lists. {@link detect} is cheap and
 * syntactic (magic bytes, an extension) so the shell can try every format on
 * one picked file; {@link decode} is the real parse, effectful because a
 * format may decode asynchronously (PDF text extraction). Neither requires
 * services: identification and decoding are functions of the bytes alone, and
 * nothing behind this contract may write.
 */
interface AnonymizerFormatDescriptor<T> {
  /** The format tag this descriptor binds (`'har'`); the registry's key. */
  readonly format: string
  /** User-facing strings the shell shows for this format. */
  readonly display: { readonly title: string; readonly description: string }
  /**
   * Tokens for the picker's `accept` attribute (`'.har'`,
   * `'application/json'`). A hint to the OS dialog only — {@link detect} is
   * the decision.
   */
  readonly accept: readonly string[]
  /**
   * Whether the picked file looks like this format — a cheap syntactic test
   * (magic bytes, an extension), never a full parse. The shell asks each
   * registered format in registry order and routes to the first `true`.
   */
  readonly detect: (file: PickedFile) => boolean
  /**
   * Decode the picked file into the value this format's panel consumes. Fails
   * only with a {@link DecodeFailure} naming what the user can do; requires no
   * services and writes nothing.
   */
  readonly decode: (file: PickedFile) => Effect.Effect<T, DecodeFailure>
}

export { type AnonymizerFormatDescriptor, DecodeFailure }
