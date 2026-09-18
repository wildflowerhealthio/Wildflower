/**
 * The props contract every format's settings picker renders against.
 *
 * @remarks
 * Its own module rather than a member of `file-importer.ts`: it describes a
 * *component*, not the importer value, and the only things that name it are the
 * three `*-importer-react` packages' pickers and the shell's registry. It lives
 * in this package — which has no React dependency and needs none for a
 * structural props type — so that every format's React package can render
 * against one contract without any of them depending on each other.
 *
 * @packageDocumentation
 */

/**
 * A controlled form over one format's settings: the current value, and the
 * callback the shell re-decodes from.
 *
 * @typeParam TSettings - The format's own settings type
 */
interface SettingsPickerProps<TSettings> {
  /** The format's current settings, as the last decode ran under them. */
  readonly settings: TSettings
  /** Called with the next settings; the shell re-decodes that format. */
  readonly onChange: (settings: TSettings) => void
}

export type { SettingsPickerProps }
