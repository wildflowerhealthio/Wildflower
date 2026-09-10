import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import type { PositionedTextDocument } from 'pdf-anonymizer-core'
import { describe, expect, it } from 'vite-plus/test'

import { layoutDocument, layoutReport } from '../test-helpers.ts'
import { parseReports } from './parse-report.ts'
import { reportArbitrary } from './report-arbitrary.ts'
import type { LifeLabsReport } from './report.ts'

/**
 * The dialect is pinned as the inverse of the printed layout: any report the
 * print can carry, laid out and parsed back, is the same report. The example
 * tests below then document the layout facts the property leans on — the
 * page break inside a section, the shared footer line, the masked lab numbers
 * an anonymized export prints.
 */

const document = (pages: PositionedTextDocument['pages']): PositionedTextDocument => ({
  format: 'wildflower-positioned-text',
  version: 1,
  fileName: 'Reports.pdf',
  pages,
})

/** A report with everything filled in, for the example tests. */
const sample: LifeLabsReport = {
  labNo: '2024-JJ6330780',
  referenceNumber: '',
  referringSiteId: '',
  patient: {
    name: 'OKAFOR, DANA MARIE',
    age: '45 years',
    sex: 'F',
    dateOfBirth: 'Aug 13 1981',
    healthCardNumber: '1234567890 AB',
    phone: '(416) 555-0100',
    patientId: '',
  },
  orderedBy: 'HAMILTON-REYES DR. SAM',
  copyTo: ['NGUYEN DR. LEE'],
  dateOfService: 'Aug 13 2026 13:02',
  reportedOn: 'Aug 14 2026 18:21',
  lab: {
    addressLines: ['100 International Blvd.', 'Toronto, Ontario', 'Canada M9W 6J6'],
    telephone: '(416) 849-3637',
    tollFree: '(877) 849-3637',
    fax: '(905) 795-9891',
  },
  status: 'FINAL RESULTS',
  pageNumbers: [1],
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
              result: '8.0',
              referenceRange: '4.0 - 11.0',
              unit: 'x E9/L',
              labLicence: '#5687',
              comments: [],
            },
            {
              name: 'Hemoglobin',
              flag: 'LO',
              result: '118',
              referenceRange: '120- 160',
              unit: 'g/L',
              labLicence: '#5687',
              comments: [],
            },
          ],
        },
        {
          name: 'Differential',
          rows: [
            {
              name: 'Neutrophils',
              flag: '',
              result: '5.5',
              referenceRange: '2.0 - 7.5',
              unit: 'x E9/L',
              labLicence: '#5687',
              comments: [],
            },
          ],
        },
      ],
    },
    {
      name: 'General Chemistry',
      comments: [],
      groups: [
        {
          name: '',
          rows: [
            {
              name: 'Glomerular Filtration Rate (eGFR)',
              flag: '',
              result: '100',
              referenceRange: 'See below',
              unit: '',
              labLicence: '#5687',
              comments: [
                'Results rule out CKD stage 3-5.',
                'Reference interval: =>60 mL/min/1.73m2',
              ],
            },
          ],
        },
      ],
    },
  ],
}

/** The parsed report with `pageNumbers` set aside — the layout decides those. */
const withoutPages = (report: LifeLabsReport): Omit<LifeLabsReport, 'pageNumbers'> => {
  const { pageNumbers: _pageNumbers, ...rest } = report
  return rest
}

describe('parseReports', () => {
  it('property: is the inverse of the printed layout, report by report', () => {
    fc.assert(
      fc.property(fc.array(reportArbitrary, { minLength: 1, maxLength: 3 }), (reports) => {
        const parsed = parseReports(layoutDocument(reports))

        expect(parsed.map(withoutPages)).toEqual(reports.map(withoutPages))
        // Pages are numbered consecutively across the document, none skipped.
        expect(parsed.flatMap((report) => report.pageNumbers)).toEqual(
          Array.from({ length: parsed.flatMap((r) => r.pageNumbers).length }, (_, i) => i + 1)
        )
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('reads the sample report back, header and grid alike', () => {
    const [report, ...rest] = parseReports(document(layoutReport(sample)))

    expect(rest).toEqual([])
    expect(report).toEqual(sample)
  })

  it('continues a section across a page break, attaching a carried-over comment to its row', () => {
    // Enough rows to push the eGFR comments onto a second page.
    const padding = Array.from({ length: 44 }, (_, i) => ({
      name: `Analyte ${i}`,
      flag: '',
      result: String(i),
      referenceRange: '',
      unit: '',
      labLicence: '#5687',
      comments: [],
    }))
    const long: LifeLabsReport = {
      ...sample,
      sections: [
        { name: 'Hematology', comments: [], groups: [{ name: '', rows: padding }] },
        ...sample.sections.slice(1),
      ],
    }
    const pages = layoutReport(long)

    const [report] = parseReports(document(pages))

    expect(pages.length).toBeGreaterThan(1)
    expect(report?.pageNumbers).toEqual(pages.map((page) => page.pageNumber))
    expect(report?.sections).toEqual(long.sections)
  })

  it('splits reports whose lab numbers an anonymizer masked to the same digits, by the page footer', () => {
    const masked = { ...sample, labNo: '0000-XX0000000' }
    const first = { ...masked, dateOfService: 'May 20 2026 13:25' }
    const second = { ...masked, dateOfService: 'Oct 10 2025 12:34' }

    const reports = parseReports(layoutDocument([first, second]))

    expect(reports.map((report) => report.dateOfService)).toEqual([
      'May 20 2026 13:25',
      'Oct 10 2025 12:34',
    ])
  })

  it('keeps a left-column value out of the laboratory block sharing its line', () => {
    // `HC #:` and the address's second line print on one line; the health
    // card number must not swallow `Toronto, Ontario`.
    const [report] = parseReports(document(layoutReport(sample)))

    expect(report?.patient.healthCardNumber).toBe('1234567890 AB')
    expect(report?.lab.addressLines).toEqual([
      '100 International Blvd.',
      'Toronto, Ontario',
      'Canada M9W 6J6',
    ])
  })

  it('reads the footer status off the line it shares with the page index', () => {
    const [withStatus] = parseReports(document(layoutReport(sample, { withStatus: true })))
    const [without] = parseReports(document(layoutReport(sample, { withStatus: false })))

    expect(withStatus?.status).toBe('FINAL RESULTS')
    expect(without?.status).toBe('')
  })

  it('yields a report with no sections for a page with no grid, and nothing for no pages', () => {
    const headerOnly = layoutReport({ ...sample, sections: [] })

    expect(parseReports(document(headerOnly))[0]?.sections).toEqual([])
    expect(parseReports(document([]))).toEqual([])
  })
})
