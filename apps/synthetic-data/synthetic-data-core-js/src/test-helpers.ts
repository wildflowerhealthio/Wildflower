import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { defaultHarSettings, harImporter } from '@wildflowerhealthio/har-importer-core'
import { sha256Base64 } from '@wildflowerhealthio/importer-fundamentals'
import type { DateTime } from 'effect'
import { Effect, Either } from 'effect'
import * as fc from 'fast-check'

import { DicomImage } from '@wildflowerhealthio/synthetic-data-dicom'
import { deidentifiedFileArbitrary } from '@wildflowerhealthio/synthetic-data-dicom/test-helpers'
import type { Story } from '@wildflowerhealthio/synthetic-data-fundamentals/story'
import {
  asOfArbitrary,
  storyCaseArbitrary,
} from '@wildflowerhealthio/synthetic-data-fundamentals/test-helpers'
import {
  type RexallAccount,
  RexallHar,
  rexallPatientReferenceOf,
} from '@wildflowerhealthio/synthetic-data-rexall-be-well'
import { rexallAccountArbitrary } from '@wildflowerhealthio/synthetic-data-rexall-be-well/test-helpers'
import {
  type ShoppersAccount,
  ShoppersHar,
} from '@wildflowerhealthio/synthetic-data-shoppers-drugmart'
import { shoppersCaseArbitrary } from '@wildflowerhealthio/synthetic-data-shoppers-drugmart/test-helpers'

import type * as SnapshotFile from './snapshot-file.ts'
import * as Reader from './snapshot-reader.ts'

/**
 * Generated records run through the real importers, whole — the source-file
 * `DocumentReference` included — as a snapshot lays them out, and a
 * snapshot's files served to a reader from memory.
 */

/** Every resource `bytes` imports to through `harImporter.decode`, picked as `fileName`. */
const importHar = (bytes: Uint8Array, fileName: string): Promise<readonly FhirResource[]> =>
  Effect.runPromise(
    harImporter.decode([{ id: `0:${fileName}`, fileName, bytes }], defaultHarSettings)
  ).then((result) =>
    result.decoded.sections.flatMap((section) => section.resources.map((entry) => entry.resource))
  )

/** A generated person's Rexall records, and a chest image re-identified as them. */
interface RexallPersonCase {
  readonly asOf: DateTime.Utc
  readonly story: Story.Story
  readonly account: RexallAccount
  readonly deidentifiedImage: Uint8Array
  readonly studyDay: number
}

const rexallPersonCaseArbitrary: fc.Arbitrary<RexallPersonCase> = fc.record({
  asOf: asOfArbitrary,
  story: storyCaseArbitrary('person-1').map((storyCase) => storyCase.story),
  account: rexallAccountArbitrary,
  deidentifiedImage: deidentifiedFileArbitrary,
  studyDay: fc.integer({ min: -730, max: 0 }),
})

/** What a {@link RexallPersonCase} imports to, and the files the imports read. */
interface ImportedPerson {
  readonly resources: readonly FhirResource[]
  readonly har: Uint8Array
  readonly image: Uint8Array
}

const HAR_FILE_NAME = 'rexall.har'

const IMAGE_FILE_NAME = 'chest-x-ray.dcm'

/**
 * The person's Rexall HAR through the HAR importer, then the image,
 * re-identified as them, through the DICOM importer onto their Rexall Patient.
 */
const importRexallPerson = async (personCase: RexallPersonCase): Promise<ImportedPerson> => {
  const { asOf, story, account } = personCase
  const har = new TextEncoder().encode(
    await Effect.runPromise(RexallHar.render(asOf, story, account))
  )
  const image = Either.getOrThrow(
    DicomImage.reidentify(asOf, personCase.deidentifiedImage, {
      person: story.person,
      patientId: 'MRN1',
      studyDay: personCase.studyDay,
      accessionNumber: undefined,
      imageKey: 'chest-x-ray',
    })
  )
  const imaging = await Effect.runPromise(
    DicomImage.importWithSubject(image, IMAGE_FILE_NAME, rexallPatientReferenceOf(account))
  )
  return { resources: [...(await importHar(har, HAR_FILE_NAME)), ...imaging], har, image }
}

/** A generated Shoppers family account. */
interface ShoppersFamilyCase {
  readonly asOf: DateTime.Utc
  readonly account: ShoppersAccount
}

const shoppersFamilyCaseArbitrary: fc.Arbitrary<ShoppersFamilyCase> = fc.record({
  asOf: asOfArbitrary,
  account: shoppersCaseArbitrary.map((shoppersCase) => shoppersCase.account),
})

/** The family's Shoppers HAR, and everything the HAR importer makes of it. */
const importShoppersFamily = async (
  familyCase: ShoppersFamilyCase,
  fileName: string
): Promise<{ readonly har: Uint8Array; readonly resources: readonly FhirResource[] }> => {
  const har = new TextEncoder().encode(
    await Effect.runPromise(ShoppersHar.render(familyCase.asOf, familyCase.account))
  )
  return { har, resources: await importHar(har, fileName) }
}

/** FHIR's `Attachment.hash` as the importers write it: base64 SHA-256. */
const hashOf = (bytes: Uint8Array): Promise<string> =>
  Effect.runPromise(sha256Base64(new Uint8Array(bytes)))

/**
 * A snapshot's files as the `Snapshot.Reader.FileFetcher` a reader fetches them
 * through: a path among `files` serves its text or bytes, and any other path
 * fails as an `UnreadableFile`, as a missing file on a static host does.
 */
const fetcherOf = (files: readonly SnapshotFile.Any[]): Reader.FileFetcher => {
  const byPath = new Map(files.map((file) => [file.path, file]))
  const fileAt = (path: string): Effect.Effect<SnapshotFile.Any, Reader.UnreadableFile> => {
    const file = byPath.get(path)
    return file === undefined
      ? Effect.fail(new Reader.UnreadableFile({ path, reason: 'Not found.' }))
      : Effect.succeed(file)
  }
  return {
    text: (path) =>
      fileAt(path).pipe(
        Effect.map((file) =>
          file._tag === 'Text' ? file.text : new TextDecoder().decode(file.bytes)
        )
      ),
    bytes: (path) =>
      fileAt(path).pipe(
        Effect.map((file) =>
          file._tag === 'Bytes' ? file.bytes : new TextEncoder().encode(file.text)
        )
      ),
  }
}

export {
  fetcherOf,
  HAR_FILE_NAME,
  hashOf,
  IMAGE_FILE_NAME,
  importRexallPerson,
  importShoppersFamily,
  rexallPersonCaseArbitrary,
  shoppersFamilyCaseArbitrary,
}
export type { ImportedPerson, RexallPersonCase, ShoppersFamilyCase }
