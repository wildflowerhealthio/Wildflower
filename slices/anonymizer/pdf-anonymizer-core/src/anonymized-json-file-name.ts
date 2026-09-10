const UNSAFE_FILE_NAME_CHARACTERS = /[^a-zA-Z0-9._-]+/g

/**
 * The output name for the anonymized positioned-text JSON.
 *
 * @param sourceFileName - The name of the `.pdf` file the user picked
 * @returns `<original-stem>.anonymized.json`, safe for any host filesystem
 *
 * @remarks
 * Strips a trailing `.pdf`/`.PDF` extension (only the last one), sanitises the
 * stem, and falls back to `document` when the stem sanitises to nothing — so
 * the output is never a hidden `.anonymized.json` on Unix.
 */
const anonymizedJsonFileName = (sourceFileName: string): string => {
  const withoutExtension = sourceFileName.replace(/\.pdf$/iu, '')
  const safe = withoutExtension
    .replace(UNSAFE_FILE_NAME_CHARACTERS, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .replace(/^\.+/, '')
  return `${safe === '' ? 'document' : safe}.anonymized.json`
}

export { anonymizedJsonFileName }
