/**
 * Who a person's lab work is ordered by and copied to, as a LifeLabs report
 * prints them in its `Ordered by:` and `Copy To:` fields (`OKAFOR DR. NKECHI`,
 * family name first) — the clinicians on the requisition the person brings to
 * the lab.
 */
interface LabRequisition {
  readonly orderedBy: string
  /**
   * The clinician copied, or `[]` when none. At most one: the importer reads
   * the whole `Copy To:` field as a single clinician, so a second could never
   * come back off a printed report.
   */
  readonly copyTo: readonly [] | readonly [string]
}

export type { LabRequisition }
