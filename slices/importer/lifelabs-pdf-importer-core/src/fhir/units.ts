/**
 * The LifeLabs display-unit → UCUM mapping the FHIR synthesis stamps onto
 * `Quantity.code` / `Quantity.system` beside the printed unit spelling.
 *
 * @remarks
 * Copied verbatim (the `UCUM_BY_DISPLAY` half) from the LIVE collector's
 * `slices/http-extraction/lifelabs-source/src/units.ts` on a separate branch;
 * the two consumers hold local copies rather than sharing a third package
 * until a third caller lands. The reference's `LOINC_UNITS` half — recovering
 * a missing unit from a LOINC code — is not copied: PDF observations carry
 * `code: { text: row.name }` with no LOINC and print their units already, so
 * there is nothing to recover from a code.
 *
 * A spelling not listed here is carried as `Quantity.unit` alone — never
 * guess a UCUM code, because a wrong code is worse than none.
 *
 * @packageDocumentation
 */

/** The UCUM code system. */
const UCUM_SYSTEM = 'http://unitsofmeasure.org'

/**
 * LifeLabs display unit → UCUM code, for the spellings the portal (and, on
 * this side, the printed PDF) uses. A spelling not listed here is carried
 * as `Quantity.unit` alone.
 */
const UCUM_BY_DISPLAY: Readonly<Record<string, string>> = {
  'x E9/L': '10*9/L',
  'x E12/L': '10*12/L',
  'g/L': 'g/L',
  'mg/L': 'mg/L',
  'ug/L': 'ug/L',
  'ng/L': 'ng/L',
  'mmol/L': 'mmol/L',
  'umol/L': 'umol/L',
  'nmol/L': 'nmol/L',
  'pmol/L': 'pmol/L',
  'U/L': 'U/L',
  'IU/L': '[IU]/L',
  'mIU/L': 'm[IU]/L',
  'kU/L': 'kU/L',
  fL: 'fL',
  pg: 'pg',
  '%': '%',
  'L/L': 'L/L',
  'mm/h': 'mm/h',
  'mL/min/1.73m2': 'mL/min/{1.73_m2}',
  'mmol/mol': 'mmol/mol',
  'g/mol': 'g/mol',
  s: 's',
  h: 'h',
}

/**
 * The UCUM code for a LifeLabs display unit, or `undefined` for an unlisted
 * spelling. The spelling is trimmed before lookup so a stray space does not
 * turn a known unit into a bare display string.
 */
const ucumCodeFor = (display: string): string | undefined => UCUM_BY_DISPLAY[display.trim()]

export { UCUM_SYSTEM, ucumCodeFor }
