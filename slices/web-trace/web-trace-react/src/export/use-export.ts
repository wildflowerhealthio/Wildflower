import { Effect } from 'effect'
import { useCallback, useEffect, useState } from 'react'
import type { TraceExchange } from 'web-trace-core'
import { emitHar } from 'web-trace-core/har'
import {
  DEFAULT_ENUM_THRESHOLD,
  mintExportSalt,
  type PathOverride,
} from 'web-trace-core/pseudonymizer'

import { downloadBlob, harBlob, harFileName } from './download-har.ts'
import { buildExportPreview, type ExportPreview } from './redaction-preview.ts'

/** The reviewer's settings for one export. */
interface ExportSettings {
  /**
   * Whether the enum carve-out runs.
   *
   * @defaultValue true
   */
  readonly enumCarveOut: boolean
  /**
   * The distinct-value ceiling below which a path exports verbatim.
   *
   * @defaultValue 12
   */
  readonly enumThreshold: number
  /**
   * Whether namespace-URI paths — `Coding.system`, `Identifier.system`,
   * `Extension.url` — export as captured.
   *
   * @defaultValue true
   */
  readonly namespaceUris: boolean
  /** Per-path decisions that win over the threshold. */
  readonly overrides: Readonly<Record<string, PathOverride>>
}

/**
 * The settings an export opens with: **nothing verbatim**, at the core's
 * default threshold for when the carve-out is switched on.
 *
 * @remarks
 * Off by default so the safest archive is the one produced by clicking Download
 * without reading anything. The carve-out is genuinely useful — a collector
 * author cannot branch on `status` if it is noise — but it is the setting that
 * lets original values leave the device, so it is opted into against a preview
 * that lists exactly what it exposes, rather than opted out of after the fact.
 *
 * **Schema URLs are off for the same reason**, even though a namespace URI is
 * the safer of the two to expose. Both deliberately disagree with the core's
 * own defaults: the core answers "what should redaction do when nobody said",
 * the panel answers "what should leave the device when nobody looked".
 */
const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  enumCarveOut: false,
  enumThreshold: DEFAULT_ENUM_THRESHOLD,
  namespaceUris: false,
  overrides: {},
}

/** What {@link useExport} hands the export panel. */
interface ExportState {
  /** The current settings. */
  readonly settings: ExportSettings
  /** The rows to review and the exchanges to emit, or `null` before the first build. */
  readonly preview: ExportPreview | null
  /** Whether a preview is being built — true on open, and after every settings change. */
  readonly isBuilding: boolean
  /** What went wrong building the preview, or `null`. */
  readonly error: Error | null
  /** Turns the enum carve-out on or off. */
  readonly setEnumCarveOut: (enabled: boolean) => void
  /** Sets the carve-out's distinct-value ceiling. */
  readonly setEnumThreshold: (threshold: number) => void
  /** Turns the namespace-URI rule on or off. */
  readonly setNamespaceUris: (enabled: boolean) => void
  /** Overrides one path's decision, or clears the override with `null`. */
  readonly setOverride: (path: string, override: PathOverride | null) => void
  /** Emits the reviewed archive and saves it. A no-op before the preview is ready. */
  readonly download: () => void
}

/** Whatever `Effect.runPromise` rejected with, as an `Error` the banner can render. */
const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause))

/** The note placed on the archive's `log.comment`, so the file states how it was made. */
const describeSettings = (settings: ExportSettings): string => {
  const overrides = Object.entries(settings.overrides)
  const carveOut = settings.enumCarveOut
    ? `enum carve-out on, threshold ${settings.enumThreshold}`
    : 'enum carve-out off'
  const uris = settings.namespaceUris ? 'schema URLs on' : 'schema URLs off'
  const overrideNote =
    overrides.length === 0
      ? 'no per-path overrides'
      : overrides.map(([path, decision]) => `${path}=${decision}`).join('; ')
  return `Redacted at export: ${carveOut}; ${uris}; ${overrideNote}. Pseudonyms are stable within this archive only — a fresh salt is minted per export, so two exports of one session cannot be linked.`
}

/**
 * Drives one export: mints its salt, keeps the preview in step with the
 * reviewer's settings, and hands the reviewed archive to the browser.
 *
 * @param exchanges - The exchanges being exported. Pass a **stable** reference
 *   (memoise the filtered subset) — its identity is what triggers a rebuild.
 * @param sessionId - The session the archive names
 * @returns The settings, the preview, and the controls over both
 *
 * @remarks
 * **The salt is minted once, when the export opens, and threaded through every
 * rebuild**, so changing a control re-redacts under the same salt and the
 * archive downloaded is the one reviewed. See the package `AGENTS.md` for why
 * per-rebuild minting would break the stable-within / independent-across
 * property the design rests on.
 */
const useExport = (exchanges: readonly TraceExchange[], sessionId: string): ExportState => {
  const [salt, setSalt] = useState<string | null>(null)
  const [settings, setSettings] = useState<ExportSettings>(DEFAULT_EXPORT_SETTINGS)
  const [preview, setPreview] = useState<ExportPreview | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [isBuilding, setIsBuilding] = useState(true)

  // One salt for the life of this export. Deliberately not in the rebuild
  // effect below: a fresh salt per settings change would re-pseudonymize
  // everything on every keystroke in the threshold box.
  useEffect(() => {
    let cancelled = false
    Effect.runPromise(mintExportSalt)
      .then((minted) => {
        if (!cancelled) setSalt(minted)
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(asError(cause))
          setIsBuilding(false)
        }
      })
    return (): void => {
      cancelled = true
    }
  }, [])

  const { enumCarveOut, enumThreshold, namespaceUris, overrides } = settings

  // Flip isBuilding to true in the same render as the inputs change,
  // rather than in the rebuild useEffect below — a setState-in-effect
  // would render the previous preview as fresh for one paint, and it's
  // what react/set-state-in-effect forbids. Prev-value guard adjusted
  // during render, per the React docs.
  const [prevBuildInputs, setPrevBuildInputs] = useState({
    salt,
    exchanges,
    enumCarveOut,
    enumThreshold,
    namespaceUris,
    overrides,
  })
  const buildInputsChanged =
    prevBuildInputs.salt !== salt ||
    prevBuildInputs.exchanges !== exchanges ||
    prevBuildInputs.enumCarveOut !== enumCarveOut ||
    prevBuildInputs.enumThreshold !== enumThreshold ||
    prevBuildInputs.namespaceUris !== namespaceUris ||
    prevBuildInputs.overrides !== overrides
  if (buildInputsChanged && salt !== null) {
    setPrevBuildInputs({ salt, exchanges, enumCarveOut, enumThreshold, namespaceUris, overrides })
    setIsBuilding(true)
  }

  useEffect(() => {
    if (salt === null) return undefined
    let cancelled = false
    Effect.runPromise(
      buildExportPreview(exchanges, {
        salt,
        enumCarveOut,
        enumThreshold,
        namespaceUris,
        overrides,
      })
    )
      .then((next) => {
        if (cancelled) return
        setPreview(next)
        setError(null)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        // The archive must never be a stale one built under different
        // settings, so a failed rebuild clears the preview rather than
        // leaving the previous one downloadable.
        setPreview(null)
        setError(asError(cause))
      })
      .finally(() => {
        if (!cancelled) setIsBuilding(false)
      })
    return (): void => {
      cancelled = true
    }
  }, [salt, exchanges, enumCarveOut, enumThreshold, namespaceUris, overrides])

  const download = useCallback((): void => {
    if (preview === null) return
    const archive = emitHar(preview.redacted, {
      sessionId,
      comment: describeSettings(settings),
    })
    downloadBlob(harBlob(archive), harFileName(sessionId))
  }, [preview, sessionId, settings])

  return {
    settings,
    preview,
    isBuilding,
    error,
    setEnumCarveOut: (enabled: boolean): void => {
      setSettings((current) => ({ ...current, enumCarveOut: enabled }))
    },
    setEnumThreshold: (threshold: number): void => {
      setSettings((current) => ({ ...current, enumThreshold: threshold }))
    },
    setNamespaceUris: (enabled: boolean): void => {
      setSettings((current) => ({ ...current, namespaceUris: enabled }))
    },
    setOverride: (path: string, override: PathOverride | null): void => {
      setSettings((current) => {
        const { [path]: _cleared, ...rest } = current.overrides
        return {
          ...current,
          overrides: override === null ? rest : { ...rest, [path]: override },
        }
      })
    },
    download,
  }
}

export {
  DEFAULT_EXPORT_SETTINGS,
  describeSettings,
  type ExportSettings,
  type ExportState,
  useExport,
}
