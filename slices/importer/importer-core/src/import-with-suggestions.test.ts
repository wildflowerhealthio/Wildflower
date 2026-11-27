import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import type { ResourceMatch } from '@wildflowerhealthio/fhir-r4/clients'
import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  FhirResourceSchema,
  literalReferenceOf,
  StoredResourceSchema,
} from '@wildflowerhealthio/fhir-r4/resources'
import {
  DecodedFileSet,
  DecodeFunction,
  differencesInPlan,
  FileImporter,
  ImportedRecord,
  ImportPlan,
  ImportWrite,
  type PickedFile,
  PlannedRecord,
  type PlanResolution,
  RecordChoice,
  Section,
  SectionedList,
  StoredMatch,
} from '@wildflowerhealthio/importer-fundamentals'
import { Cause, Effect, Either, Exit, Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { type FindStoredMatch, findStoredMatch, noStore } from './find-stored-match.ts'
import { importWithSuggestions, UndecidedRecords } from './import-with-suggestions.ts'
import { runAgainst } from './plan-import.test-helpers.ts'
import type { ReadRegistry } from './read-batch.ts'
import { defaultFormatSettings } from './registry.ts'

/**
 * Covers the import with every suggestion taken over a fake registry: each
 * pick a HAR of one person and one result, read as copies, planned against a
 * store the test names, resolved and written.
 */

const SOURCE = 'https://source.example/id'

const detached = (fields: object): DetachedResource.Type =>
  Either.getOrThrow(DetachedResource.decodeUnknownEither(FhirResourceSchema)(fields))

const tyra = detached({
  resourceType: 'Patient',
  identifier: [{ system: SOURCE, value: 'tyra' }],
  name: [{ family: 'Ashford', given: ['Tyra'] }],
  birthDate: '1990-01-02',
})

/** A result for Tyra keyed by `value`. */
const resultFor = (value: string): DetachedResource.Type =>
  detached({
    resourceType: 'Observation',
    identifier: [{ system: SOURCE, value }],
    status: 'final',
    code: { text: 'A1c' },
    subject: { type: 'Patient', identifier: { system: SOURCE, value: 'tyra' } },
  })

const sourceFileFormat: PickedFile.FormatValue = {
  coding: { system: 'https://example.test/fhir/CodeSystem/source-file', code: 'har' },
  contentType: 'application/octet-stream',
  descriptionPrefix: 'har: ',
}

/** A fake HAR decode: each pick Tyra and a result keyed by the pick's name. */
const decodeHar = DecodeFunction.make({
  format: 'har',
  decodeFileSet: ([file]) =>
    Effect.succeed({
      pickedFiles: [DecodedFileSet.unidentified(file)],
      sectionedList: SectionedList.make([
        Section.make('records', [
          { localKey: 'tyra', resource: tyra, sourceUrl: Option.none() },
          { localKey: 'result', resource: resultFor(file.fileName), sourceUrl: Option.none() },
        ]),
      ]),
      notes: [],
    }),
})

/** Claims nothing: the formats the test does not pick. */
const claimsNothing = {
  detect: () => false,
  decode: () => Effect.die('never claimed'),
  sourceFileFormat,
}

/**
 * The fake registry: HAR claims `.har` picks, and its `linkToSourceFiles`
 * fails a pick named `lost.har`, as a record naming a file its set lacks.
 */
const registry: ReadRegistry<never> = {
  har: {
    format: 'har',
    detect: (_bytes, name) => name.endsWith('.har'),
    decode: decodeHar,
    sourceFileFormat,
    linkToSourceFiles: (resource, sourceFiles) =>
      sourceFiles.some(({ pickedFile }) => pickedFile.fileName === 'lost.har')
        ? Effect.fail(
            new FileImporter.SourceFileNotFound({
              identifier: Schema.decodeUnknownSync(IdentifierAndReference.IdentifierSchema)({
                system: SOURCE,
                value: 'missing-file',
              }),
            })
          )
        : Effect.succeed(resource),
  },
  'lifelabs-pdf': { format: 'lifelabs-pdf', ...claimsNothing },
  dicom: { format: 'dicom', ...claimsNothing },
}

const pick = (fileName: string): PickedFile.NamedBytes => ({
  fileName,
  bytes: new TextEncoder().encode(fileName),
})

/** A stored Patient that matches Tyra by name, under `id`. */
const namesake = (id: string): ResourceMatch.Candidate => ({
  resource: Schema.decodeUnknownSync(StoredResourceSchema)({
    resourceType: 'Patient',
    id,
    name: [{ family: 'Ashford', given: ['Tyra'] }],
    birthDate: '1990-01-02',
  }),
  grade: 'probable',
  by: 'name',
})

/** A store in which two Patients match every Patient of the import by name, and nothing else matches. */
const twoNamesakes: FindStoredMatch<never, never> = (records) =>
  Effect.succeed(
    StoredMatch.make({
      records: records
        .filter((record) => ImportedRecord.resourceOf(record).resourceType === 'Patient')
        .map(({ key }) => ({
          key,
          entry: StoredMatch.makeEntry([namesake('p-1'), namesake('p-2')], Option.none()),
        })),
      externalReferences: [],
    })
  )

/** The title of every record `exit`'s failure names, or how else it ended. */
const undecidedTitlesOf = <A, E>(exit: Exit.Exit<A, E>): unknown =>
  Exit.match(exit, {
    onSuccess: () => 'written',
    onFailure: (cause) =>
      Option.match(Cause.failureOption(cause), {
        onNone: () => 'died',
        onSome: (error) =>
          error instanceof UndecidedRecords
            ? error.records.map(({ title }) => title)
            : 'another failure',
      }),
  })

/**
 * Each record of `resolution` as its reason, and its differences from the
 * existing record its effective choice merges it into (`differencesInPlan`);
 * `None` for a record that merges into none.
 *
 * @remarks
 * The plan is rebuilt from the resolved records and their stored matches,
 * which is all the comparison reads of what the store holds.
 */
const reasonsAndDifferencesOf = (resolution: PlanResolution.Type): readonly unknown[] => {
  const records = resolution.records.map(({ planned }) => planned)
  const plan = ImportPlan.make(
    records,
    StoredMatch.make({
      records: records.map(({ record, storedMatch }) => ({ key: record.key, entry: storedMatch })),
      externalReferences: [],
    })
  )
  return records.map((planned) => ({
    reason: planned.suggestion.reason._tag,
    differences: Option.map(
      Option.filter(
        PlannedRecord.effectiveChoice(planned),
        RecordChoice.is('MergeIntoExistingRecord')
      ),
      ({ existing }) => differencesInPlan(plan, planned, existing).differences
    ),
  }))
}

describe('importWithSuggestions', () => {
  it('should save every record as new with no store, writing each', async () => {
    // Arrange / Act
    const imported = await Effect.runPromise(
      importWithSuggestions(registry, defaultFormatSettings, [pick('a.har')], noStore)
    )

    // Assert
    expect({
      labels: imported.resolution.records.map(({ label }) => label),
      written: imported.resources.map(({ resourceType }) => resourceType),
    }).toEqual({
      labels: ['Create', 'Create', 'Create'],
      written: ['DocumentReference', 'Patient', 'Observation'],
    })
  })

  it('should fail naming a record two stored namesakes leave undecided, Tyra referenced by her result', async () => {
    // Arrange / Act
    const exit = await Effect.runPromiseExit(
      importWithSuggestions(registry, defaultFormatSettings, [pick('a.har')], twoNamesakes)
    )

    // Assert
    expect(undecidedTitlesOf(exit)).toEqual([expect.stringMatching(/^Patient\//u)])
  })

  it('should report a file set the import stage cannot import as unreadable, the other sets written', async () => {
    // Arrange / Act
    const imported = await Effect.runPromise(
      importWithSuggestions(
        registry,
        defaultFormatSettings,
        [pick('a.har'), pick('lost.har')],
        noStore
      )
    )

    // Assert
    expect({
      unreadable: imported.formats.flatMap(({ unreadableFiles }) =>
        unreadableFiles.map(({ title }) => title)
      ),
      keys: imported.resolution.records.flatMap(({ planned }) =>
        planned.record.copies.map(({ reviewKey }) => reviewKey)
      ),
    }).toEqual({
      unreadable: ['lost.har'],
      keys: ['0:a.har/source-file/a.har', '0:a.har/tyra', '0:a.har/result'],
    })
  })

  it('should report the picks no format claimed beside what the claimed formats read', async () => {
    // Arrange / Act
    const imported = await Effect.runPromise(
      importWithSuggestions(
        registry,
        defaultFormatSettings,
        [pick('a.har'), pick('notes.txt')],
        noStore
      )
    )

    // Assert
    expect({
      formats: imported.formats.map(({ format }) => format),
      unrecognized: imported.unrecognizedFiles.map(({ title }) => title),
    }).toEqual({ formats: ['har'], unrecognized: ['notes.txt'] })
  })

  it('should find every record the same as existing, results naming their Patient, when run again against a store holding the first run’s writes', async () => {
    // Arrange
    const picks = [pick('a.har'), pick('b.har')]
    const first = await Effect.runPromise(
      importWithSuggestions(registry, defaultFormatSettings, picks, noStore)
    )

    // Act
    const { result: again } = await runAgainst(
      importWithSuggestions(registry, defaultFormatSettings, picks, findStoredMatch),
      first.resources
    )

    // Assert
    expect({
      nothingToImport: ImportWrite.isNothingToImport(ImportWrite.of(again.resolution)),
      written: again.resources.map(literalReferenceOf),
      records: reasonsAndDifferencesOf(again.resolution),
    }).toEqual({
      nothingToImport: true,
      written: [],
      records: first.resolution.records.map(() => ({
        reason: 'OneIdentifierMatch',
        differences: Option.some([]),
      })),
    })
  })
})
