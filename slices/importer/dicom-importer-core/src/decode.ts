import { Effect } from 'effect'
import type { FhirResource } from 'fhir-r4/resources'
import type { DecodedFile } from 'importer-fundamentals'

import type { DicomSettings } from './settings.ts'

/**
 * Decode a DICOM file's raw bytes into zero sections and one diagnostic note —
 * the descriptor's `decode`.
 *
 * @remarks
 * D2 stores the raw `.dcm` as a source archive and makes no attempt to read
 * DICOM tags; D3 fills the sections in. The zero-section decode with a note is
 * honest about what confirm will do: store the file as an archive, nothing
 * more. Settings are accepted for forward compatibility but currently unused.
 */
const decodeDicom = (
  _fileBytes: Uint8Array,
  _settings: DicomSettings
): Effect.Effect<DecodedFile<FhirResource>, never> =>
  Effect.succeed({
    sections: [],
    notes: ['DICOM contents are not extracted yet; confirm stores the file as an archive.'],
  })

export { decodeDicom }
