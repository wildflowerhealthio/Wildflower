import type { ReferenceType } from '@wildflowerhealthio/fhir-r4/data-types'
import { type FhirResourceWithId, ResourceReferences } from '@wildflowerhealthio/fhir-r4/resources'
import {
  DecodedFileSet,
  type FormatDecode,
  ImportPlan,
  ImportWrite,
  type PickedFile,
  type PlanResolution,
  RecordChoice,
  resolvePlan,
  Section,
  SectionedList,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, Effect, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { fileCopiesOf } from './file-copies-of.ts'
import { findStoredMatch } from './find-stored-match.ts'
import {
  detached,
  observationWire,
  prescriptionWire,
  runAgainst,
  SOURCE,
  sourceFileFormat,
  tyraWire,
} from './plan-import.test-helpers.ts'
import { planImport } from './plan-import.ts'

/**
 * Covers a stored record linked by a later import: a reference the store
 * holds by type and identifier alone, a stub "don't add" left or a reference
 * whose target no file held, gains its link when a later import brings its
 * target, through `fileCopiesOf`, `planImport`, `resolvePlan` and
 * `ImportWrite.of` against the store the first import wrote.
 */

/** A decode of the test format holding one file set per entry, each from its own picked file. */
const decodedOf = (
  fileSets: readonly (readonly [string, readonly (readonly [string, object])[]])[]
): FormatDecode.Decoded<string> => {
  const pickedFiles = fileSets.map(([fileName], index): PickedFile.Type => ({
    id: `${index}:${fileName}`,
    fileName,
    bytes: new TextEncoder().encode(fileName),
  }))
  return {
    format: 'test',
    files: pickedFiles,
    fileSets: Arr.zipWith(
      pickedFiles,
      fileSets,
      (pickedFile, [, records]): DecodedFileSet.Type => ({
        pickedFiles: [DecodedFileSet.unidentified(pickedFile)],
        sectionedList: SectionedList.make([
          Section.make(
            'records',
            records.map(([localKey, fields]) => ({
              localKey,
              resource: detached(fields),
              sourceUrl: Option.none(),
            }))
          ),
        ]),
        notes: [],
      })
    ),
    unreadableFiles: [],
  }
}

/** One import: its plan against `stored`, the reviewer's `choose` over it, resolved, and what it writes. */
const importOnto = async (
  decoded: FormatDecode.Decoded<string>,
  stored: readonly FhirResourceWithId[],
  choose: (plan: ImportPlan.Type) => ImportPlan.Type = (plan) => plan
): Promise<{
  readonly resolution: PlanResolution.Type
  readonly written: readonly FhirResourceWithId[]
}> => {
  const { copies } = await Effect.runPromise(fileCopiesOf({ sourceFileFormat }, decoded))
  const { result: resolution } = await runAgainst(
    Effect.flatMap(planImport(copies, findStoredMatch), (plan) => resolvePlan(choose(plan))),
    stored
  )
  return {
    resolution,
    written: ImportWrite.match(ImportWrite.of(resolution), {
      Ready: ({ resources }) => resources,
      Blocked: () => [],
    }),
  }
}

/** The stored resources once `written` is written over `stored`, each under its literal reference. */
const storedAfter = (
  stored: readonly FhirResourceWithId[],
  written: readonly FhirResourceWithId[]
): readonly FhirResourceWithId[] => {
  const literalOf = ({ resourceType, id }: FhirResourceWithId): string => `${resourceType}/${id}`
  const replaced = new Set(written.map(literalOf))
  return [...stored.filter((resource) => !replaced.has(literalOf(resource))), ...written]
}

/** The one resource of `resourceType` in `resources`. */
const onlyOf = (
  resources: readonly FhirResourceWithId[],
  resourceType: string
): FhirResourceWithId => {
  const [found, ...others] = resources.filter((resource) => resource.resourceType === resourceType)
  if (found === undefined || others.length > 0) throw new Error(`Not one ${resourceType}`)
  return found
}

/** The reference `resource` holds at `path`. */
const referenceAt = (resource: FhirResourceWithId, path: string): ReferenceType | undefined =>
  ResourceReferences.collect(resource).find((at) => at.path === path)?.reference

/** The resolved label of the record of `resourceType` in `resolution`. */
const labelOf = (resolution: PlanResolution.Type, resourceType: string): string | undefined =>
  resolution.records.find(
    ({ planned }) => planned.record.copies[0].resource.resourceType === resourceType
  )?.label

const observation = {
  ...observationWire,
  subject: { type: 'Patient', identifier: { system: SOURCE, value: 'tyra' } },
}

describe('a stored record’s unlinked reference on a later import', () => {
  it('should link a stub "don’t add" left to the Patient a second import adds, the referrer an update', async () => {
    // Arrange
    const decoded = decodedOf([
      [
        'report.test',
        [
          ['tyra', tyraWire],
          ['a1c-1', observation],
        ],
      ],
    ])
    const first = await importOnto(decoded, [], (plan) =>
      ImportPlan.choose(
        plan,
        plan.records
          .filter(({ record }) => record.copies[0].resource.resourceType === 'Patient')
          .map(({ record }) => record.key),
        RecordChoice.DontAdd()
      )
    )
    const afterFirst = storedAfter([], first.written)

    // Act
    const second = await importOnto(decoded, afterFirst)
    const afterSecond = storedAfter(afterFirst, second.written)

    // Assert
    expect({
      stubbed: referenceAt(onlyOf(afterFirst, 'Observation'), 'subject'),
      label: labelOf(second.resolution, 'Observation'),
      linked: referenceAt(onlyOf(afterSecond, 'Observation'), 'subject'),
    }).toMatchObject({
      stubbed: { reference: null, display: 'Tyra Ashford' },
      label: 'Update',
      linked: {
        reference: `Patient/${onlyOf(afterSecond, 'Patient').id}`,
        identifier: { value: 'tyra' },
        display: 'Tyra Ashford',
      },
    })
  })

  it('should link a dispense to the prescription a second import brings with it, the dispense an update', async () => {
    // Arrange
    const dispense = {
      resourceType: 'MedicationDispense',
      identifier: [{ system: SOURCE, value: 'fill-1' }],
      status: 'completed',
      medicationCodeableConcept: { text: 'Metformin' },
      authorizingPrescription: [
        { type: 'MedicationRequest', identifier: { system: SOURCE, value: 'rx-1' } },
      ],
    }
    const prescription = { ...prescriptionWire, requester: null }
    const fills: readonly [string, readonly (readonly [string, object])[]] = [
      'fills.test',
      [['fill-1', dispense]],
    ]
    const first = await importOnto(decodedOf([fills]), [])
    const afterFirst = storedAfter([], first.written)

    // Act
    const second = await importOnto(
      decodedOf([fills, ['prescriptions.test', [['rx-1', prescription]]]]),
      afterFirst
    )
    const afterSecond = storedAfter(afterFirst, second.written)

    // Assert
    expect({
      unlinked: referenceAt(onlyOf(afterFirst, 'MedicationDispense'), 'authorizingPrescription[0]'),
      label: labelOf(second.resolution, 'MedicationDispense'),
      linked: referenceAt(onlyOf(afterSecond, 'MedicationDispense'), 'authorizingPrescription[0]'),
    }).toMatchObject({
      unlinked: { reference: null },
      label: 'Update',
      linked: {
        reference: `MedicationRequest/${onlyOf(afterSecond, 'MedicationRequest').id}`,
        identifier: { value: 'rx-1' },
      },
    })
  })
})
