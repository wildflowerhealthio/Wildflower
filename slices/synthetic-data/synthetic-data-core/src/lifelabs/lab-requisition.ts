/**
 * Who a person's lab work is ordered by and copied to, as a LifeLabs report
 * prints them in its `Ordered by:` and `Copy To:` fields (`OKAFOR DR. NKECHI`,
 * family name first) — the clinicians on the requisition the person brings to
 * the lab.
 */
interface LabRequisition {
  readonly orderedBy: string
  /** One entry per clinician copied, in the order printed; `[]` when none. */
  readonly copyTo: readonly string[]
}

export type { LabRequisition }
