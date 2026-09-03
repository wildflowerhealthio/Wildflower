/**
 * DDInter entries that are not medicines. DDInter is a drug–drug database, so
 * these names are only ever matched against the catalog — the "interactions
 * with non-drugs" group is populated with whatever subset the bundled data
 * actually carries, and is empty (with a note in the UI) when it carries none.
 * Compared after `normalizeName`, so case and marks do not matter.
 */
const nonDrugNames: readonly string[] = [
  'Alcohol',
  'Ethanol',
  'Caffeine',
  'Grapefruit',
  'Grapefruit juice',
  'Nicotine',
  'Tobacco',
  'Food',
  'Cannabis',
  'Cannabidiol',
]

export { nonDrugNames }
