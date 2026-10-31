import { Context, Data, type Effect } from 'effect'

import type * as Document from './document.ts'

/**
 * The bytes were not a PDF the extractor could open.
 *
 * @remarks
 * `cause` is whatever the extraction library threw, kept for logging; the
 * message is its message when it has one.
 */
class UnreadablePdf extends Data.TaggedError('UnreadablePdf')<{ readonly cause: unknown }> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : 'PDF extraction failed'
  }
}

/**
 * Turns a PDF's raw bytes into its positioned-text {@link Document.Type}.
 *
 * @remarks
 * The service a PDF dialect's decode requires, so the dialect stays pure and
 * the extraction library is chosen by whoever runs the decode.
 * `positioned-text-web` provides it with pdfjs; tests provide a fake that hands
 * back a hand-written fixture document.
 */
class PositionedTextExtractor extends Context.Tag('positioned-text/PositionedTextExtractor')<
  PositionedTextExtractor,
  {
    readonly extract: (bytes: Uint8Array) => Effect.Effect<Document.Type, UnreadablePdf>
  }
>() {}

export { PositionedTextExtractor, UnreadablePdf }
