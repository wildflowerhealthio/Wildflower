import type { PickedFile } from '@wildflowerhealthio/importer-fundamentals'
import { PositionedTextExtractor } from '@wildflowerhealthio/positioned-text'
import { Effect, Layer, TestClock, TestContext } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { chromeFhirCapturePick, rexallFixturePick } from './fixture-picks.ts'
import {
  AS_OF,
  dicomPick,
  LATER_AS_OF,
  lifeLabsPick,
  printedDocumentOf,
  rexallPick,
  shoppersPick,
} from './generated-picks.ts'
import { goldenTextOf, importWithDefaults } from './import-with-defaults.ts'

/**
 * The import golden pin: every source kind `importer-core` reads, imported
 * with every default accepted, written as JSON and compared byte for byte
 * with its committed golden under `__golden__/`. A golden that changes is a
 * change to what an import writes. `vp test -u` rewrites them.
 */

/**
 * An extractor that reads a picked "PDF" as the positioned text it carries:
 * pdfjs is the one step not run.
 */
const extractorReadingPrintedText = Layer.succeed(PositionedTextExtractor, {
  extract: (bytes) => Effect.sync(() => printedDocumentOf(bytes)),
})

/** One golden: its file's name, and the batch it picks. */
interface GoldenCase {
  readonly name: string
  readonly picks: Effect.Effect<readonly PickedFile.NamedBytes[], unknown>
}

const CASES: readonly GoldenCase[] = [
  { name: 'fhir-har', picks: Effect.succeed([chromeFhirCapturePick()]) },
  { name: 'rexall-fixtures-har', picks: Effect.all([rexallFixturePick()]) },
  { name: 'rexall-har', picks: Effect.all([rexallPick('rexall.har', AS_OF)]) },
  { name: 'shoppers-har', picks: Effect.all([shoppersPick()]) },
  { name: 'lifelabs-pdf', picks: Effect.all([lifeLabsPick()]) },
  { name: 'dicom', picks: Effect.all([dicomPick()]) },
  {
    // Two exports of one Rexall account carry the same Patient, beside a file
    // of every other format.
    name: 'multi-file',
    picks: Effect.all([
      rexallPick('rexall.har', AS_OF),
      rexallPick('rexall-later.har', LATER_AS_OF),
      Effect.succeed(chromeFhirCapturePick()),
      lifeLabsPick(),
      dicomPick(),
    ]),
  },
]

/**
 * `picks` imported with every default accepted, the clock at the as-of and
 * the extractor reading the printed text.
 */
const goldenTextFor = (
  picks: Effect.Effect<readonly PickedFile.NamedBytes[], unknown>
): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(AS_OF.epochMillis)
      return goldenTextOf(yield* importWithDefaults(yield* picks))
    }).pipe(Effect.provide(extractorReadingPrintedText), Effect.provide(TestContext.TestContext))
  )

describe('an import with every default accepted', () => {
  it.each(CASES)('writes what the $name golden pins', async ({ name, picks }) => {
    await expect(await goldenTextFor(picks)).toMatchFileSnapshot(`./__golden__/${name}.json`)
  })
})
