import { Schema } from 'effect'

/**
 * The thirteen Canadian province / territory codes, in the conventional
 * postal-abbreviation order. Sponsored-drug coverage is expressed against
 * this set.
 */
const provinceCodes = [
  'AB',
  'BC',
  'MB',
  'NB',
  'NL',
  'NS',
  'NT',
  'NU',
  'ON',
  'PE',
  'QC',
  'SK',
  'YT',
] as const

/** A Canadian province / territory code. */
const Province = Schema.Literal(...provinceCodes)
type Province = typeof Province.Type

/** Every province, as an immutable list (used to mean "covered everywhere"). */
const allProvinces: readonly Province[] = provinceCodes

/** Human-readable names for the province picker. */
const provinceNames: Readonly<Record<Province, string>> = {
  AB: 'Alberta',
  BC: 'British Columbia',
  MB: 'Manitoba',
  NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador',
  NS: 'Nova Scotia',
  NT: 'Northwest Territories',
  NU: 'Nunavut',
  ON: 'Ontario',
  PE: 'Prince Edward Island',
  QC: 'Quebec',
  SK: 'Saskatchewan',
  YT: 'Yukon',
}

/** Type guard for a valid province code. */
const isProvince: (value: unknown) => value is Province = Schema.is(Province)

/**
 * Parse a comma-separated province string (`"AB,BC,ON"`) into valid codes,
 * trimming whitespace, upper-casing, and dropping any token that is not a
 * known province. An input that yields no valid codes returns `[]` — callers
 * decide whether an empty result means "nowhere" or "everywhere".
 */
const parseProvinceList = (raw: string): readonly Province[] =>
  raw
    .split(',')
    .map((token) => token.trim().toUpperCase())
    .filter(isProvince)

export { provinceCodes, Province, allProvinces, provinceNames, isProvince, parseProvinceList }
