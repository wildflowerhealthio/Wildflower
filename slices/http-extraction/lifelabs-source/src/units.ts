/**
 * Units for LifeLabs analytes. `GetAnalyticSummary` — the payload the live
 * collector sniffs — carries **no unit**, while `ViewAnalytics` (one analyte's
 * history, fired only when a user clicks into that analyte) does. So numeric
 * summary results take their unit from {@link LOINC_UNITS}, a researched table
 * keyed by the analyte's LOINC (recovered from `testItemId`), and both payloads
 * map the portal's display spelling to a UCUM code through {@link ucumCodeFor}.
 *
 * @remarks
 * LifeLabs reports in Canadian SI units and spells powers of ten as `x E9/L` /
 * `x E12/L`. An analyte missing from the table yields a unitless quantity, as
 * before — never a guessed unit. Entries come from real payloads (`ViewAnalytics`
 * `testUnit`) or the researched mapping recorded in the package AGENTS.md.
 */

/** The UCUM code system. */
const UCUM_SYSTEM = 'http://unitsofmeasure.org'

/**
 * LifeLabs display unit → UCUM code, for the spellings the portal uses. A
 * spelling not listed here is carried as `Quantity.unit` alone.
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
}

/** The UCUM code for a LifeLabs display unit, or `undefined` for an unlisted spelling. */
const ucumCodeFor = (display: string): string | undefined => UCUM_BY_DISPLAY[display.trim()]

/**
 * LOINC → the display unit LifeLabs prints for that analyte, for the unitless
 * `GetAnalyticSummary` rows. Only entries confirmed from a real payload or the
 * researched mapping; see the package AGENTS.md § Units.
 */
const LOINC_UNITS: Readonly<Record<string, string>> = {
  // Complete Blood Count — confirmed from a real `ViewAnalytics` payload (RBC)
  // and the summary's own reference ranges (WBC `4.0 - 11.0`, Hgb `120- 160`).
  '6690-2': 'x E9/L', // Leukocytes (WBC)
  '789-8': 'x E12/L', // Erythrocytes (RBC)
  '718-7': 'g/L', // Hemoglobin
  '4544-3': 'L/L', // Hematocrit — Canadian labs report a fraction, not %
  '53115-2': 'x E9/L', // Immature granulocytes
  // Chemistry (serum / plasma), Canadian SI.
  '2951-2': 'mmol/L', // Sodium
  '2823-3': 'mmol/L', // Potassium
  '2000-8': 'mmol/L', // Calcium
  '22664-7': 'mmol/L', // Urea
  '14682-9': 'umol/L', // Creatinine
  '33914-3': 'mL/min/1.73m2', // eGFR
  '14933-6': 'umol/L', // Urate
  '14631-6': 'umol/L', // Bilirubin, total
  '1742-6': 'U/L', // ALT
  '1920-8': 'U/L', // AST
  '14771-0': 'mmol/L', // Glucose, fasting
  '4548-4': '%', // Hemoglobin A1c (NGSP %)
  '14334-7': 'mmol/L', // Lithium
  // Lipids.
  '14647-2': 'mmol/L', // Cholesterol, total
  '14646-4': 'mmol/L', // HDL cholesterol
  '39469-2': 'mmol/L', // LDL cholesterol (calculated)
  '70204-3': 'mmol/L', // Non-HDL cholesterol
  '14927-8': 'mmol/L', // Triglyceride
  // Endocrine.
  '3016-3': 'mIU/L', // TSH
  '14715-7': 'pmol/L', // Estradiol
  '14890-8': 'nmol/L', // Progesterone
  '14913-8': 'nmol/L', // Testosterone
  '14866-8': 'pmol/L', // Parathyroid hormone, intact
  '2842-3': 'ug/L', // Prolactin
  '42607-2': 'ug/L', // Prolactin, monomeric
  // Urine test strip: quantitative when numeric ("Negative" stays a string).
  '22705-8': 'mmol/L', // Glucose, urine
  '22702-5': 'mmol/L', // Ketones, urine
}

export { LOINC_UNITS, UCUM_SYSTEM, ucumCodeFor }
