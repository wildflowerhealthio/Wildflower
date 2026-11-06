import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import {
  DecodedFile,
  DecodedFileSet,
  type DecodeFunction,
  Referent,
} from '@wildflowerhealthio/importer-fundamentals'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { PositionedTextExtractor, UnreadablePdf } from '@wildflowerhealthio/positioned-text'
import { Effect, Either, Layer, Option, ParseResult } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { decodeLifeLabsPdf, decodeLifeLabsPdfDocument } from './decode.ts'
import * as LabNumber from './entities/lab-number.ts'
import { arbitrary as reportArbitrary } from './entities/report-arbitrary.ts'
import type * as Report from './entities/report.ts'
import { patientKeyOf } from './fhir/to-fhir.ts'
import { LifeLabsIdentifierSystem } from './source-system.ts'
import { reportSectionTitle } from './synthesis.ts'
import { layoutDocument } from './test-helpers.ts'

/**
 * `decodeLifeLabsPdfDocument` is the "positioned-text document ↦ per-report
 * sections of labeled FHIR resources" leg of the LifeLabs importer's
 * `decode`. The outer `decodeLifeLabsPdf(file, ...)` runs it on what the
 * `PositionedTextExtractor` read off the bytes; the property tests here drive
 * `decodeLifeLabsPdfDocument` directly against `layoutDocument`'s printed
 * inverse, and `decodeLifeLabsPdf` under a fake extractor.
 */

const SETTINGS = { timeZone: 'America/Vancouver', healthCardProvince: 'ON' } as const

/** A one-page report with no results: its header is all a page-level test reads. */
const headerOnly: Report.Type = {
  labNo: LabNumber.make('2024-JJ6330780'),
  referenceNumber: '',
  referringSiteId: '',
  patient: {
    name: 'OKAFOR, DANA MARIE',
    age: '45 years',
    sex: 'F',
    dateOfBirth: 'Aug 13 1981',
    healthCardNumber: '',
    phone: '',
    patientId: '',
  },
  orderedBy: '',
  copyTo: [],
  dateOfService: 'Aug 13 2026 13:02',
  reportedOn: 'Aug 14 2026 18:21',
  lab: { addressLines: [], telephone: '', tollFree: '', fax: '' },
  status: 'FINAL RESULTS',
  pageNumbers: [1],
  sections: [],
}

/**
 * Every system the synthesis keys a record in: LifeLabs' own, and the health
 * card system of {@link SETTINGS}' province, which keys a Patient printing only
 * an `HC #`.
 */
const KEY_SYSTEMS: readonly string[] = [
  ...Object.values(LifeLabsIdentifierSystem),
  Effect.runSync(
    patientKeyOf(
      { ...headerOnly.patient, healthCardNumber: '9123456789' },
      SETTINGS.healthCardProvince
    )
  ).system,
]

/** Every record of a decode, detached. */
const entriesOf = (decoded: DecodeFunction.FileSetDecode): readonly DecodedFileSet.Entry[] =>
  decoded.sections.flatMap(({ entries }) => entries)

/** One or two reports, each printing its own Lab No. */
const reportsArbitrary = fc.uniqueArray(reportArbitrary, {
  minLength: 1,
  maxLength: 2,
  selector: (report) => report.labNo,
})

describe('decodeLifeLabsPdfDocument', () => {
  it('property: a document with LifeLabs reports decodes to one titled section per report', () => {
    fc.assert(
      fc.property(reportsArbitrary, (reports) => {
        const document = layoutDocument(reports)

        const decoded = Effect.runSync(decodeLifeLabsPdfDocument(document, SETTINGS))

        expect(decoded.notes).toEqual([])
        expect(decoded.sections.map((section) => section.title)).toEqual(
          reports.map(reportSectionTitle)
        )
        expect(entriesOf(decoded).length).toBeGreaterThan(0)
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('property: each entry fullUrl is {resourceType}/{key value}, and its row titled by the reference it is written under', () => {
    fc.assert(
      fc.property(reportsArbitrary, (reports) => {
        const document = layoutDocument(reports)

        const decoded = Effect.runSync(decodeLifeLabsPdfDocument(document, SETTINGS))

        const entries = entriesOf(decoded)
        expect(entries.map(({ fullUrl }) => Option.some(fullUrl))).toEqual(
          entries.map(({ resource }) =>
            Option.map(
              DetachedResource.keyOf(resource),
              ({ value }) => `${resource.resourceType}/${value}`
            )
          )
        )
        const written = DecodedFile.resources(Either.getOrThrow(DecodedFileSet.adopt(decoded)))
        expect(written.map(({ title }) => title)).toEqual(
          written.map(({ key, resource }) =>
            Option.isSome(DetachedResource.keyOf({ ...resource, id: null }))
              ? `${resource.resourceType}/${resource.id}`
              : `${resource.resourceType} (${key})`
          )
        )
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('property: each record is detached and keyed in a LifeLabs identifier system', () => {
    fc.assert(
      fc.property(reportsArbitrary, (reports) => {
        const document = layoutDocument(reports)

        const decoded = Effect.runSync(decodeLifeLabsPdfDocument(document, SETTINGS))

        for (const { resource } of entriesOf(decoded)) {
          expect(resource.id).toBeNull()
          const keySystem = Option.map(DetachedResource.keyOf(resource), ({ system }) => system)
          expect(Option.isSome(keySystem) && KEY_SYSTEMS.includes(keySystem.value)).toBe(true)
        }
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('property: each keyed record adopts under the id its key derives', () => {
    fc.assert(
      fc.property(reportsArbitrary, (reports) => {
        const document = layoutDocument(reports)

        const decoded = Effect.runSync(decodeLifeLabsPdfDocument(document, SETTINGS))
        const keyedReferences = entriesOf(decoded).flatMap(({ resource }) =>
          Option.toArray(
            Option.map(DetachedResource.keyOf(resource), (key) =>
              DetachedResource.storedReferenceOf(resource.resourceType, key)
            )
          )
        )

        const adoptedReferences = DecodedFile.resources(
          Either.getOrThrow(DecodedFileSet.adopt(decoded))
        ).map(({ resource }) => `${resource.resourceType}/${resource.id}`)
        for (const reference of keyedReferences) {
          expect(reference).toMatch(/^[A-Za-z]+\/wf-[0-9a-f]{32}$/)
          expect(adoptedReferences).toContain(reference)
        }
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('property: its referents are each Patient and each provider it names, each provider implied once', () => {
    fc.assert(
      fc.property(reportsArbitrary, (reports) => {
        const document = layoutDocument(reports)
        const providerNames = reports
          .flatMap((report) => [report.orderedBy, ...report.copyTo])
          .map((name) => name.trim())
          .filter((name) => name !== '')
        const expected = [
          ...new Set(
            reports.map((report) => {
              const { system, value } = Effect.runSync(
                patientKeyOf(report.patient, SETTINGS.healthCardProvince)
              )
              return `Patient|${system}|${value}`
            })
          ),
          ...new Set(
            providerNames.map(
              (name) =>
                `Practitioner|${LifeLabsIdentifierSystem.PractitionerName}|${name.replaceAll(/\s+/g, ' ')}`
            )
          ),
        ]

        const decoded = Effect.runSync(decodeLifeLabsPdfDocument(document, SETTINGS))
        const adopted = Either.getOrThrow(DecodedFileSet.adopt(decoded))
        const referents = Effect.runSync(Referent.discover([adopted]))

        const practitioners = DecodedFile.resources(adopted).flatMap(({ resource }) =>
          resource.resourceType === 'Practitioner' ? [resource] : []
        )
        for (const { resource } of DecodedFile.resources(adopted)) {
          if (resource.resourceType !== 'DiagnosticReport') continue
          for (const interpreter of resource.resultsInterpreter) {
            const practitioner = practitioners.find(
              ({ id }) => interpreter.reference === `Practitioner/${id}`
            )
            // Named by the display of the first report naming it.
            expect([practitioner?.identifier[0]?.value, practitioner?.name.length]).toEqual([
              interpreter.identifier?.value,
              1,
            ])
          }
        }
        expect(
          referents
            .map(
              ({ logicalReference }) =>
                `${logicalReference.resourceType}|${logicalReference.identifier[0].system.href}|${logicalReference.identifier[0].value}`
            )
            .toSorted()
        ).toEqual(expected.toSorted())
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('skips a page that prints no Lab No, with a note naming it', () => {
    const secondLabNo = LabNumber.make('2024-JJ0000001')
    const [first, second] = layoutDocument([
      headerOnly,
      { ...headerOnly, labNo: secondLabNo },
    ]).pages
    if (first === undefined || second === undefined) throw new Error('two one-page reports')
    const unnumbered = {
      ...second,
      runs: second.runs.filter((printed) => printed.text !== secondLabNo),
    }
    const document = { ...layoutDocument([]), pages: [first, unnumbered] }

    const decoded = Effect.runSync(decodeLifeLabsPdfDocument(document, SETTINGS))

    expect(decoded.notes).toEqual(['Page 2 prints no Lab No, so it was skipped.'])
    expect(decoded.sections.map(({ title }) => title)).toEqual([
      'Lab No 2024-JJ6330780 — Aug 13 2026 13:02',
    ])
  })

  it('fails with a ParseError for a document with no LifeLabs report markers', () => {
    // A well-formed positioned-text document with no page runs — no `Lab No`,
    // no grid heading — is rejected as an unrecognized LifeLabs document.
    const document = {
      format: 'wildflower-positioned-text' as const,
      version: 1 as const,
      pages: [
        {
          pageNumber: 1,
          width: 612,
          height: 792,
          runs: [{ text: 'hello', x: 100, y: 100, width: 20, fontSize: 10 }],
        },
      ],
    }

    const outcome = Effect.runSync(Effect.either(decodeLifeLabsPdfDocument(document, SETTINGS)))

    expect(Either.isLeft(outcome)).toBe(true)
    if (Either.isLeft(outcome)) expect(ParseResult.isParseError(outcome.left)).toBe(true)
  })

  it('fails with a ParseError for an invalid time zone', () => {
    const document = layoutDocument([])
    const outcome = Effect.runSync(
      Effect.either(decodeLifeLabsPdfDocument(document, { ...SETTINGS, timeZone: 'Not/A_Zone' }))
    )
    expect(Either.isLeft(outcome)).toBe(true)
    if (Either.isLeft(outcome)) expect(ParseResult.isParseError(outcome.left)).toBe(true)
  })
})

describe('reportSectionTitle', () => {
  it('property: is the Lab No, joined to the date of service when the report prints one', () => {
    fc.assert(
      fc.property(reportArbitrary, (report) => {
        expect(reportSectionTitle(report)).toBe(
          report.dateOfService === ''
            ? `Lab No ${report.labNo}`
            : `Lab No ${report.labNo} — ${report.dateOfService}`
        )
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

describe('decodeLifeLabsPdf', () => {
  const file = { fileName: 'Reports.pdf', bytes: new TextEncoder().encode('%PDF-1.7 stand-in') }

  it('property: decodes the document the extractor reads off the bytes', () => {
    fc.assert(
      fc.property(fc.array(reportArbitrary, { minLength: 1, maxLength: 2 }), (reports) => {
        const document = layoutDocument(reports)
        const extractor = Layer.succeed(PositionedTextExtractor, {
          extract: (bytes) =>
            bytes === file.bytes
              ? Effect.succeed(document)
              : Effect.fail(new UnreadablePdf({ cause: 'other bytes' })),
        })

        const decoded = Effect.runSync(
          decodeLifeLabsPdf(file, SETTINGS).pipe(Effect.provide(extractor))
        )

        expect(decoded).toEqual(Effect.runSync(decodeLifeLabsPdfDocument(document, SETTINGS)))
      }),
      { numRuns: numRunsFor({ base: 10 }) }
    )
  })

  it('fails with a ParseError carrying the message of a PDF the extractor cannot open', () => {
    const extractor = Layer.succeed(PositionedTextExtractor, {
      extract: () => Effect.fail(new UnreadablePdf({ cause: new Error('Invalid PDF structure.') })),
    })

    const result = Effect.runSync(
      Effect.either(decodeLifeLabsPdf(file, SETTINGS).pipe(Effect.provide(extractor)))
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(ParseResult.isParseError(result.left)).toBe(true)
      expect(result.left.message).toContain('Invalid PDF structure.')
    }
  })
})
