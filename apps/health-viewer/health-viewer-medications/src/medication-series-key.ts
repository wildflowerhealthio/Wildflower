import { SeriesId } from '@wildflowerhealthio/health-viewer-fundamentals'
import type { DoseBasis } from '@wildflowerhealthio/medication-core/fhir'

/**
 * Identity of a medication series: which medication, the unit its doses are
 * in, and what each dose is stated per.
 *
 * - `medication`: the regimen's `normalizedName`, or `#<requestId>` when that
 *   normalises to nothing — `normalizeName` only writes `[a-z0-9 ]`, so the
 *   fallback never collides with a real drug's name.
 * - `doseUnit`: the dose's unit, `null` when the request stated none.
 * - `doseBasis`: per `administration`, or a daily total (`d`).
 *
 * @remarks
 * `doseUnit` and `doseBasis` are identity, not metadata: 500 mg per dose and
 * 1000 mg per day of one drug are two lines on two scales, never one line that
 * silently changes meaning mid-plot.
 */
interface MedicationSeriesKey {
  readonly medication: string
  readonly doseUnit: string | null
  readonly doseBasis: DoseBasis
}

/** The prefix every medication series id starts with: `m:<medication>|<doseUnit>|<doseBasis>`. */
const MEDICATION_ID_PREFIX = 'm'

/** Every {@link DoseBasis}, as the id's last field spells it. */
const DOSE_BASES: readonly DoseBasis[] = ['administration', 'd']

/** Whether `field` is a {@link DoseBasis} — the only spellings the id's last field may hold. */
const isDoseBasis = (field: string | null): field is DoseBasis =>
  DOSE_BASES.some((doseBasis) => doseBasis === field)

/**
 * The stable string form of a medication series key,
 * `m:<medication>|<doseUnit>|<doseBasis>` — safe as a URL value, React key or
 * catalogue row id.
 *
 * @remarks
 * External contract: this is what a shared link carries, so changing the
 * field order, the basis spellings or the escaping invalidates every link
 * already saved.
 */
const medicationSeriesIdOf = (key: MedicationSeriesKey): string =>
  SeriesId.fromFields(MEDICATION_ID_PREFIX, [key.medication, key.doseUnit, key.doseBasis])

/**
 * Parse the string form {@link medicationSeriesIdOf} produces. Never throws —
 * ids arrive from a user-editable URL, so a bad one is dropped, not raised.
 *
 * @returns `null` for another prefix, the wrong field count, any spelling
 *   {@link medicationSeriesIdOf} would not write, a null marker in the
 *   never-nullable `medication` slot, or a basis other than `administration`
 *   or `d`
 */
const parseMedicationSeriesId = (id: string): MedicationSeriesKey | null => {
  const fields = SeriesId.toFields(MEDICATION_ID_PREFIX, id)
  if (fields === null || fields.length !== 3) return null
  const [medication, doseUnit, doseBasis] = fields
  return medication === null || !isDoseBasis(doseBasis) ? null : { medication, doseUnit, doseBasis }
}

export { DOSE_BASES, MEDICATION_ID_PREFIX, medicationSeriesIdOf, parseMedicationSeriesId }
export type { MedicationSeriesKey }
