import { Extension, IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import { DecodeFunction, FileImporter } from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, Effect, Option, Order, pipe, Predicate } from 'effect'

import {
  decodeStudy,
  linkToPatientAndStudy,
  sopInstanceIdentifier,
  studyGroupKey,
} from './decode.ts'
import { detectDicom } from './detect.ts'
import { defaultDicomSettings, type DicomSettings } from './settings.ts'
import { DICOM_SOURCE_FILE_CODE, DICOM_SYSTEM } from './source-system.ts'

const format = 'dicom'

const display = {
  title: 'DICOM image',
  description: 'Import a DICOM (.dcm) study — pick every file of it, or its folder.',
}
const sourceFileFormat = {
  coding: { system: DICOM_SYSTEM, code: DICOM_SOURCE_FILE_CODE },
  contentType: 'application/dicom',
  descriptionPrefix: `${display.title}: `,
}

/**
 * The extension URL on an `ImagingStudy` instance carrying the id of the
 * source file that stores that instance's DICOM file: the link from each
 * imported instance back to the file it was read from.
 *
 * @remarks
 * Per *instance*, which is why a study spanning many files keeps per-file
 * provenance that `meta.source` alone could not carry: `meta.source` names one
 * source file, and a study has as many source files as it has files. A
 * `valueString`, because the OHIF viewer's FHIR extension reads it to fetch the
 * file's bytes.
 */
const GRIDFS_FILE_ID_EXTENSION_URL = 'gridfsFileId'

/**
 * The id of the source file an instance with SOP Instance UID `uid` was read
 * from: the one whose `masterIdentifier` is that UID, the smallest id when two
 * files carry the same one, so the choice does not depend on the order they
 * were picked in.
 */
const sourceFileIdOf = (
  uid: string,
  sourceFiles: readonly FileImporter.PickedSourceFile[]
): Option.Option<string> => {
  const identifier = sopInstanceIdentifier(uid)
  return pipe(
    sourceFiles,
    Arr.filterMap(({ sourceFile }) =>
      Option.fromNullable(sourceFile.masterIdentifier).pipe(
        Option.filter((master) => IdentifierAndReference.identifierEquivalence(master, identifier)),
        Option.as(sourceFile.id)
      )
    ),
    Arr.match({
      onEmpty: Option.none,
      onNonEmpty: (ids) => Option.some(Arr.min(ids, Order.string)),
    })
  )
}

/**
 * The study's `ImagingStudy` with each instance's `gridfsFileId` set to the
 * source file storing its file; any other resource as it is. The DICOM
 * importer's `linkToSourceFiles`.
 *
 * @param resource - One adopted resource of the study
 * @param sourceFiles - Each picked file of the study and its source file, its
 *   `masterIdentifier` the file's SOP Instance UID
 * @returns The resource, or a `SourceFileNotFound` for the first instance whose
 *   SOP Instance UID no source file carries
 *
 * @remarks
 * Reads only FHIR: an instance's `uid` is its file's SOP Instance UID, which is
 * what that file's source file carries as its `masterIdentifier`. The decode
 * built every instance from one of these files, so an instance no source file
 * matches fails the study, which the import stage reports as unreadable. A
 * `gridfsFileId` already on an instance is replaced; any other extension is
 * kept.
 */
const addGridfsFileIds = (
  resource: FhirResourceWithId,
  sourceFiles: readonly FileImporter.PickedSourceFile[]
): Effect.Effect<FhirResourceWithId, FileImporter.SourceFileNotFound> => {
  if (resource.resourceType !== 'ImagingStudy') return Effect.succeed(resource)
  return Effect.map(
    Effect.forEach(resource.series, (series) =>
      Effect.map(
        Effect.forEach(series.instance, (instance) =>
          Option.match(sourceFileIdOf(instance.uid, sourceFiles), {
            onNone: () =>
              Effect.fail(
                new FileImporter.SourceFileNotFound({
                  identifier: sopInstanceIdentifier(instance.uid),
                })
              ),
            onSome: (sourceFileId) =>
              Effect.succeed({
                ...instance,
                extension: [
                  ...instance.extension.filter(
                    Predicate.not(Extension.hasUrl(GRIDFS_FILE_ID_EXTENSION_URL))
                  ),
                  { ...Extension.emptyAt(GRIDFS_FILE_ID_EXTENSION_URL), valueString: sourceFileId },
                ],
              }),
          })
        ),
        (instance) => ({ ...series, instance })
      )
    ),
    (series) => ({ ...resource, series })
  )
}

/**
 * The DICOM importer: a pick of `.dcm` files in, one `ImagingStudy` per study
 * out.
 *
 * @remarks
 * The one format so far that states a `groupBy`: a study's files are not
 * independent — each states one instance of a study whose counts, modality set
 * and earliest `started` only the whole set knows. Its source files link to what
 * the study decoded to, because a DICOM file is a clinical document and
 * belongs in its patient's record, and its `linkToSourceFiles`
 * ({@link addGridfsFileIds}) points each `ImagingStudy` instance at the source
 * file storing its file.
 */
const dicomImporter: FileImporter.Type<DicomSettings, typeof format> = {
  format,
  display,
  detect: detectDicom,
  defaultSettings: defaultDicomSettings,
  sourceFileFormat,
  linkSourceFile: linkToPatientAndStudy,
  linkToSourceFiles: addGridfsFileIds,
  decode: DecodeFunction.make({
    format,
    groupBy: studyGroupKey,
    decodeFileSet: decodeStudy,
  }),
}

export { addGridfsFileIds, dicomImporter, GRIDFS_FILE_ID_EXTENSION_URL }
