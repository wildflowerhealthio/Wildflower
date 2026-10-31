import { type DicomSettings, dicomImporter } from '@wildflowerhealthio/dicom-importer-core'
import { type HarSettings, harImporter } from '@wildflowerhealthio/har-importer-core'
import type { FileImporter } from '@wildflowerhealthio/importer-fundamentals'
import {
  type LifeLabsPdfSettings,
  lifeLabsPdfImporter,
} from '@wildflowerhealthio/lifelabs-pdf-importer-core'
import type { Effect } from 'effect'

/**
 * The closed, compile-time format registry: every registered
 * {@link FileImporter}, indexed by its format tag and typed through
 * {@link BoundFormat} so each entry keeps its concrete settings without
 * erasure. The React shell layers each format's `SettingsPicker` on top of
 * this record.
 *
 * @remarks
 * Wiring a binding in is three edits *here* — the {@link FormatSettings} map,
 * the {@link formatRegistry} literal, and {@link defaultFormatSettings} — plus
 * `collectFormats` in `read-batch.ts` and the picker entry in
 * `importer-react`'s registry. Every one of them is a mapped or exhaustive
 * type over {@link FormatKind}, so a format added to `FormatSettings` and
 * missed anywhere else **fails to compile**; none of them can drift silently.
 * {@link formatKinds} is derived from the registry rather than listed, because
 * a hand-written `readonly FormatKind[]` is the one slot a missing entry
 * *would* have slipped through.
 *
 * @packageDocumentation
 */

/** Every registered file-format tag. */
type FormatKind = keyof FormatSettings

/**
 * The current settings of every registered format, indexed by tag — the
 * state the settings pickers edit and every decode reads.
 */
type FormatSettings = {
  har: HarSettings
  'lifelabs-pdf': LifeLabsPdfSettings
  dicom: DicomSettings
}

/**
 * The closed registry; its keys are the {@link FormatKind} union.
 *
 * @remarks
 * Checked with `satisfies` rather than annotated, so each entry keeps what its
 * own decode requires and {@link FormatRequirements} can read it back off the
 * entry. The check still holds every entry to its own settings and tag, and a
 * format missing from it, or one too many, fails to compile.
 */
const formatRegistry = {
  har: harImporter,
  'lifelabs-pdf': lifeLabsPdfImporter,
  dicom: dicomImporter,
} satisfies { readonly [K in FormatKind]: FileImporter.Type<FormatSettings[K], K, unknown> }

/**
 * What each registered format's decode requires of the host running it, by
 * tag: `never` for a format that reads its bytes itself.
 */
type FormatRequirements = {
  readonly [K in FormatKind]: Effect.Effect.Context<
    ReturnType<(typeof formatRegistry)[K]['decode']>
  >
}

/**
 * What reading a batch requires of the host: the union of every registered
 * format's {@link FormatRequirements}. `readBatch` and `redecodeFormat` require
 * it; the host provides it where it runs them.
 */
type DecodeRequirements = FormatRequirements[FormatKind]

/**
 * One registered format's importer, parameterised on its {@link FormatKind}
 * key so every field carries the format's concrete types, its decode's
 * requirement included.
 */
type BoundFormat<K extends FormatKind> = FileImporter.Type<
  FormatSettings[K],
  K,
  FormatRequirements[K]
>

/**
 * The default settings of every registered format — the state a fresh import
 * seeds.
 *
 * @remarks
 * Spelled per format on purpose, though it looks like something
 * `Object.fromEntries` could derive. It cannot, soundly: `fromEntries` erases
 * the key-to-value correlation this record's type states, so the derived
 * version needs an `as FormatSettings` and checks nothing. Written out, a
 * format missing from here is a compile error — which is the whole reason this
 * slot exists rather than reading `defaultSettings` off the registry at each
 * use site.
 */
const defaultFormatSettings: FormatSettings = {
  har: formatRegistry.har.defaultSettings,
  'lifelabs-pdf': formatRegistry['lifelabs-pdf'].defaultSettings,
  dicom: formatRegistry.dicom.defaultSettings,
}

/** Whether a key is one the registry holds — the runtime check behind {@link formatKinds}. */
const isFormatKind = (key: string): key is FormatKind => Object.hasOwn(formatRegistry, key)

/**
 * Every registered format tag, in registry (priority) order — the typed walk
 * over the closed registry.
 *
 * @remarks
 * Derived from {@link formatRegistry} rather than listed, so it cannot fall
 * out of step with it: a format added to the registry is walked from that
 * edit alone. The order is the registry literal's own key order, which is
 * what `detect` priority means.
 */
const formatKinds: readonly FormatKind[] = Object.keys(formatRegistry).filter(isFormatKind)

export { defaultFormatSettings, formatKinds, formatRegistry }
export type { BoundFormat, DecodeRequirements, FormatKind, FormatSettings }
