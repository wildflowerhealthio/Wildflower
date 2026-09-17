import type { FhirResource } from 'fhir-r4/resources'
import { FileImporter, SourceFile } from 'importer-fundamentals'

import { decodeLifeLabsPdf } from './decode.ts'
import { detectLifeLabsPdf } from './detect.ts'
import { defaultLifeLabsPdfSettings, type LifeLabsPdfSettings } from './settings.ts'
import { lifeLabsPdfSourceFileCodec } from './source-file/index.ts'

/**
 * The `lifelabs-pdf` importer: a LifeLabs report's positioned text in,
 * FHIR resources out.
 *
 * @remarks
 * `decode` yields one section per report the PDF carries and no notes — this
 * format has no routing decisions (no per-URL kind picks, no source toggles),
 * so every resource the decode yields is a review candidate. It is
 * {@link decodeLifeLabsPdf} lifted through `perFileDecode` with this format's
 * source-file codec, so a `local` pick's source-file `DocumentReference` is
 * minted inside the decode, reviewed as its own "Source file" section, and
 * stamped onto every synthesized resource's `meta.source`; a `server` pick
 * mints nothing and stamps the reference it came with.
 */
const lifeLabsPdfImporter = new FileImporter<'lifelabs-pdf', LifeLabsPdfSettings, FhirResource>({
  codec: lifeLabsPdfSourceFileCodec,
  display: {
    title: 'LifeLabs report',
    description: 'Import lab results from a LifeLabs report PDF.',
  },
  detect: detectLifeLabsPdf,
  defaultSettings: defaultLifeLabsPdfSettings,
  decode: SourceFile.perFileDecode(lifeLabsPdfSourceFileCodec, decodeLifeLabsPdf),
})

export { lifeLabsPdfImporter }
