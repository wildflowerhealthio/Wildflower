import { PositionedTextExtractor, UnreadablePdf } from '@wildflowerhealthio/positioned-text'
import { Effect, Layer } from 'effect'

import { extractPositionedText } from './extract-pdf.ts'

/**
 * {@link PositionedTextExtractor} provided by {@link extractPositionedText}:
 * what a host runs an import's PDF decode under.
 */
const positionedTextExtractorPdfjs: Layer.Layer<PositionedTextExtractor> = Layer.succeed(
  PositionedTextExtractor,
  {
    extract: (bytes) =>
      Effect.tryPromise({
        try: () => extractPositionedText(bytes),
        catch: (cause) => new UnreadablePdf({ cause }),
      }),
  }
)

export { positionedTextExtractorPdfjs }
