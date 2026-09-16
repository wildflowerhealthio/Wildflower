/**
 * The DICOM importer's per-import settings.
 *
 * @remarks
 * The one knob the format needs, because a DICOM file's clock carries no
 * offset and FHIR's `dateTime` requires one — see `fhir/dates.ts`.
 */
import { DateTime, Option } from 'effect'

interface DicomSettings {
  /** The IANA time zone the acquiring equipment's clock was set to. */
  readonly timeZone: string
}

/**
 * The zone this runtime is in, which is the best guess available without
 * asking: a study is usually imported near where it was acquired.
 *
 * @remarks
 * `Intl` rather than anything DOM, so `-core` stays adapter-free. A runtime
 * reporting a zone `effect/DateTime` cannot resolve falls back to `UTC`, so
 * the default is always a value `decodeDicom` accepts.
 */
const runtimeTimeZone = (): string => {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone
  return Option.isSome(DateTime.zoneMakeNamed(resolved)) ? resolved : 'UTC'
}

/** The default settings: the zone this runtime is in. */
const defaultDicomSettings: DicomSettings = { timeZone: runtimeTimeZone() }

export { defaultDicomSettings, runtimeTimeZone }
export type { DicomSettings }
