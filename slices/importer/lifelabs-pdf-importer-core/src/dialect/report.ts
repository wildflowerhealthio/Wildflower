/**
 * The report model the LifeLabs positioned-text dialect parses to — one
 * value per lab report (one `Lab No`), as the PDF prints it, before any FHIR
 * vocabulary is applied. Every field is the report's own text; nothing here
 * is interpreted (a result of `<0.1` is the string `<0.1`, a date of service
 * is the printed `Aug 13 2026 13:02`). Interpretation belongs to `fhir/`.
 *
 * @packageDocumentation
 */

/** The patient block at the top of every page. */
interface ReportPatient {
  /** The printed name, as `FAMILY, GIVEN GIVEN`. */
  readonly name: string
  /** The `Age:` value (`45 years`), or `''`. */
  readonly age: string
  /** The `Sex:` value (`F`, `M`), or `''`. */
  readonly sex: string
  /** The `Date of Birth:` value as printed (`Aug 13 1981`), or `''`. */
  readonly dateOfBirth: string
  /** The `HC #:` health card number as printed, version code included, or `''`. */
  readonly healthCardNumber: string
  /** The `Patient's Phone:` value, or `''`. */
  readonly phone: string
  /** The `Patient ID:` value, or `''`. */
  readonly patientId: string
}

/** The laboratory block at the top right of every page. */
interface ReportLab {
  /** The `Address:` lines, one entry per printed line (`[]` when none). */
  readonly addressLines: readonly string[]
  /** The `Telephone:` value, or `''`. */
  readonly telephone: string
  /** The `Toll Free:` value, or `''`. */
  readonly tollFree: string
  /** The `Fax:` value, or `''`. */
  readonly fax: string
}

/** One test row of the results grid, with the comment lines printed under it. */
interface ReportRow {
  /** The `Test` column — the test's name as printed. */
  readonly name: string
  /** The `Flag` column (`HI`, `LO`), or `''`. */
  readonly flag: string
  /** The `Result` column as printed (`8.0`, `<0.1`, `NEGATIVE`), or `''`. */
  readonly result: string
  /** The reference range as printed (`4.0 - 11.0`, `<36`, `See below`), or `''`. */
  readonly referenceRange: string
  /** The unit as printed (`x E9/L`, `%`), or `''`. */
  readonly unit: string
  /** The `Lab Lic. #` in force for this row (`#5687`), or `''`. */
  readonly labLicence: string
  /** The comment lines printed under the row, one entry per printed line. */
  readonly comments: readonly string[]
}

/** A named sub-group of rows inside a section (`Differential`, `Lithium`). */
interface ReportGroup {
  /** The group heading, or `''` for a section's ungrouped leading rows. */
  readonly name: string
  readonly rows: readonly ReportRow[]
}

/** One discipline section of the results grid (`Hematology`, `Lipids`). */
interface ReportSection {
  readonly name: string
  /** The section's comment lines printed before any row. */
  readonly comments: readonly string[]
  readonly groups: readonly ReportGroup[]
}

/** One lab report — every page carrying the same `Lab No`. */
interface LifeLabsReport {
  /** The `Lab No:` value (`2024-JJ6330780`). The report's identity. */
  readonly labNo: string
  /** The `Reference #:` value, or `''`. */
  readonly referenceNumber: string
  /** The `Referring Site ID:` value, or `''`. */
  readonly referringSiteId: string
  readonly patient: ReportPatient
  /** The `Ordered by:` value, or `''`. */
  readonly orderedBy: string
  /** The `Copy To:` values, one per printed name. */
  readonly copyTo: readonly string[]
  /** The `Date of Service:` value as printed (`Aug 13 2026 13:02`), or `''`. */
  readonly dateOfService: string
  /** The `Reported on:` value as printed, or `''`. */
  readonly reportedOn: string
  readonly lab: ReportLab
  /** The footer status line (`FINAL RESULTS`), or `''`. */
  readonly status: string
  /** The 1-based page numbers of the source document the report spans. */
  readonly pageNumbers: readonly number[]
  readonly sections: readonly ReportSection[]
}

export type { LifeLabsReport, ReportGroup, ReportLab, ReportPatient, ReportRow, ReportSection }
