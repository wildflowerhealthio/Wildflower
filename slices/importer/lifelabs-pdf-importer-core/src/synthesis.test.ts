import type { DecodeFunction } from '@wildflowerhealthio/importer-fundamentals'
import { Effect } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as LabNumber from './entities/lab-number.ts'
import type * as Report from './entities/report.ts'
import { decodedReportsOf } from './synthesis.ts'

/**
 * `decodedReportsOf` keeps one printing of each `Lab No`, in the section where
 * the `Lab No` is first printed: the latest reported, else the one printed
 * later in the file, with a note saying so.
 */

const SETTINGS = { timeZone: 'America/Toronto' }

const LAB_NO = LabNumber.make('2024-JJ6330780')

/** A one-row report printing {@link LAB_NO}, reported on `reportedOn`, on `pageNumbers`. */
const printing = (
  reportedOn: string,
  pageNumbers: readonly number[],
  orderedBy = 'HAMILTON-REYES DR. SAM'
): Report.Type => ({
  labNo: LAB_NO,
  referenceNumber: '',
  referringSiteId: '',
  patient: {
    name: 'OKAFOR, DANA MARIE',
    age: '45 years',
    sex: 'F',
    dateOfBirth: 'Aug 13 1981',
    healthCardNumber: '1234567890 AB',
    phone: '',
    patientId: '',
  },
  orderedBy,
  copyTo: [],
  dateOfService: 'Aug 13 2026 13:02',
  reportedOn,
  lab: { addressLines: [], telephone: '', tollFree: '', fax: '' },
  status: 'FINAL RESULTS',
  pageNumbers,
  sections: [
    {
      name: 'Hematology',
      comments: [],
      groups: [
        {
          name: '',
          rows: [
            {
              name: 'WBC',
              flag: '',
              result: reportedOn,
              referenceRange: '',
              unit: '',
              labLicence: '',
              comments: [],
            },
          ],
        },
      ],
    },
  ],
})

const decode = (reports: readonly Report.Type[]): DecodeFunction.FileSetDecode =>
  Effect.runSync(decodedReportsOf(reports, SETTINGS))

/** Each section's title and the types of its records, in order. */
const outline = (
  decoded: DecodeFunction.FileSetDecode
): readonly { readonly title: string; readonly types: readonly string[] }[] =>
  decoded.sections.map(({ title, entries }) => ({
    title,
    types: entries.map(({ resource }) => resource.resourceType),
  }))

/** The printed result of every Observation the decode writes: which printing it came from. */
const resultsOf = (decoded: DecodeFunction.FileSetDecode): readonly (string | null)[] =>
  decoded.sections.flatMap(({ entries }) =>
    entries.flatMap(({ resource }) =>
      resource.resourceType === 'Observation' ? [resource.valueString] : []
    )
  )

describe('decodedReportsOf', () => {
  it('keeps only the later-reported of two printings of one Lab No, wherever it is printed', () => {
    const final = printing('Aug 14 2026 18:21', [1, 2])
    const preliminary = printing('Aug 13 2026 18:00', [3])

    const decoded = decode([final, preliminary])

    expect(resultsOf(decoded)).toEqual(['Aug 14 2026 18:21'])
    expect(decoded.notes).toEqual([
      'Lab No 2024-JJ6330780 is printed 2 times, so only printing 1 of 2 was kept: pages 1–2, reported on Aug 14 2026 18:21.',
    ])
  })

  it('keeps the one printed later in the file when the reported times tie or do not read', () => {
    const tied = decode([printing('Aug 14 2026 18:21', [1]), printing('Aug 14 2026 18:21', [2])])
    const masked = decode([
      printing('Xxx 00 0000 00:00', [1]),
      printing('Xxx 00 0000 00:00', [2]),
      printing('', []),
    ])

    expect(tied.notes).toEqual([
      'Lab No 2024-JJ6330780 is printed 2 times, so only printing 2 of 2 was kept: page 2, reported on Aug 14 2026 18:21.',
    ])
    expect(masked.notes).toEqual([
      'Lab No 2024-JJ6330780 is printed 3 times, so only printing 3 of 3 was kept.',
    ])
    expect(resultsOf(masked)).toEqual([null])
  })

  it('keeps a printing whose reported time reads over one whose does not', () => {
    const decoded = decode([printing('Aug 14 2026 18:21', [1]), printing('Xxx 00 0000 00:00', [2])])

    expect(resultsOf(decoded)).toEqual(['Aug 14 2026 18:21'])
  })

  it("writes a Patient and Practitioner a dropped printing named first once each, in its Lab No's section", () => {
    const preliminary = printing('Aug 13 2026 18:00', [1], 'NGUYEN DR. LEE')
    const other = { ...printing('Aug 10 2026 18:00', [2]), labNo: LabNumber.make('2024-JJ0000001') }
    const final = printing('Aug 14 2026 18:21', [3], 'NGUYEN DR. LEE')

    const decoded = decode([preliminary, other, final])

    expect(outline(decoded)).toEqual([
      {
        title: 'Lab No 2024-JJ6330780 — Aug 13 2026 13:02',
        types: ['Practitioner', 'Patient', 'Observation', 'DiagnosticReport'],
      },
      {
        title: 'Lab No 2024-JJ0000001 — Aug 13 2026 13:02',
        types: ['Practitioner', 'Observation', 'DiagnosticReport'],
      },
    ])
    expect(resultsOf(decoded)).toEqual(['Aug 14 2026 18:21', 'Aug 10 2026 18:00'])
  })

  it('writes no note for a Lab No printed once', () => {
    const decoded = decode([
      printing('Aug 14 2026 18:21', [1]),
      { ...printing('Aug 14 2026 18:21', [2]), labNo: LabNumber.make('2024-JJ0000001') },
    ])

    expect(decoded.notes).toEqual([])
    expect(decoded.sections).toHaveLength(2)
  })
})
