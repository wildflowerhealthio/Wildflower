import { Cause, Effect, Exit, Option } from 'effect'
import { DEFAULT_ENUM_THRESHOLD, mintExportSalt, type PathOverride } from 'har-anonymizer-core'
import { emitHarFromLog, type HttpArchive } from 'http-archive'
import { useCallback, useEffect, useState } from 'react'
import { usePreviousDistinctValue } from 'react-kitchen-sink'

import { anonymizedFileName, downloadBlob, harBlob } from './download-har.ts'
import { buildAnonymizePreview, type AnonymizePreview } from './redaction-preview.ts'

/** The reviewer's settings for one anonymize. */
interface AnonymizeSettings {
  /**
   * Whether the enum carve-out runs.
   *
   * @defaultValue false
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
   * @defaultValue false
   */
  readonly namespaceUris: boolean
  /** Per-path decisions that win over the threshold. */
  readonly overrides: Readonly<Record<string, PathOverride>>
}

/**
 * The settings an anonymize opens with: **nothing verbatim**, at the core's
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
const DEFAULT_ANONYMIZE_SETTINGS: AnonymizeSettings = {
  enumCarveOut: false,
  enumThreshold: DEFAULT_ENUM_THRESHOLD,
  namespaceUris: false,
  overrides: {},
}

/** What {@link useAnonymize} hands the panel. */
interface AnonymizeState {
  /** The current settings. */
  readonly settings: AnonymizeSettings
  /** The rows to review and the archive to emit, or `null` before the first build. */
  readonly preview: AnonymizePreview | null
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

/**
 * The underlying failure of an `Exit` as an `Error` the banner can render.
 *
 * @remarks
 * `Effect.runPromise` rejects with a `FiberFailure` wrapper whose `.message`
 * is Effect's generic "An error has occurred" and whose fields the banner
 * cannot see. `runPromiseExit` hands back the `Cause` instead, so we can
 * pull the typed failure (a `Data.TaggedError` like `PseudonymSpaceExhausted`,
 * its `shape`/`attempts` intact) directly. A defect or an interrupt has no
 * typed failure to surface, so we render the pretty cause.
 */
const causeToError = (cause: Cause.Cause<unknown>): Error => {
  const failure = Cause.failureOption(cause)
  if (Option.isSome(failure)) {
    return failure.value instanceof Error ? failure.value : new Error(String(failure.value))
  }
  return new Error(Cause.pretty(cause))
}

/** The note placed on the archive's `log.comment`, so the file states how it was made. */
const describeSettings = (settings: AnonymizeSettings): string => {
  const overrides = Object.entries(settings.overrides)
  const carveOut = settings.enumCarveOut
    ? `enum carve-out on, threshold ${settings.enumThreshold}`
    : 'enum carve-out off'
  const uris = settings.namespaceUris ? 'schema URLs on' : 'schema URLs off'
  const overrideNote =
    overrides.length === 0
      ? 'no per-path overrides'
      : overrides.map(([path, decision]) => `${path}=${decision}`).join('; ')
  return `Anonymized: ${carveOut}; ${uris}; ${overrideNote}. Request method, request headers and request body were dropped at import — the projection carries the response half only. Pseudonyms are stable within this archive only — a fresh salt is minted per anonymize, so two anonymized archives of one source cannot be linked.`
}

/**
 * Drives one anonymize: mints its salt, keeps the preview in step with the
 * reviewer's settings, and hands the reviewed archive to the browser.
 *
 * @param log - The archive being anonymized. Pass a **stable** reference (the
 *   panel memoises the parsed log) — its identity is what triggers a rebuild.
 * @param fileName - The name of the file the user picked, used to derive the
 *   output name
 * @returns The settings, the preview, and the controls over both
 *
 * @remarks
 * **The salt is minted once, when the anonymize opens, and threaded through
 * every rebuild**, so changing a control re-redacts under the same salt and
 * the archive downloaded is the one reviewed. See the package `AGENTS.md` for
 * why per-rebuild minting would break the stable-within / independent-across
 * property the design rests on.
 */
const useAnonymize = (log: HttpArchive.Log, fileName: string): AnonymizeState => {
  const [salt, setSalt] = useState<string | null>(null)
  const [settings, setSettings] = useState<AnonymizeSettings>(DEFAULT_ANONYMIZE_SETTINGS)
  const [preview, setPreview] = useState<AnonymizePreview | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [isBuilding, setIsBuilding] = useState(true)

  // One salt for the life of this anonymize. Deliberately not in the rebuild
  // effect below: a fresh salt per settings change would re-pseudonymize
  // everything on every keystroke in the threshold box.
  useEffect(() => {
    let cancelled = false
    void Effect.runPromiseExit(mintExportSalt).then((exit) => {
      if (cancelled) return
      if (Exit.isSuccess(exit)) {
        setSalt(exit.value)
        return
      }
      setError(causeToError(exit.cause))
      setIsBuilding(false)
    })
    return (): void => {
      cancelled = true
    }
  }, [])

  const { enumCarveOut, enumThreshold, namespaceUris, overrides } = settings

  // Flip isBuilding to true in the same render as the inputs change,
  // rather than in the rebuild useEffect below — a setState-in-effect
  // would render the previous preview as fresh for one paint, and it's
  // what react/set-state-in-effect forbids. Adjust state during render
  // via usePreviousDistinctValue on each build input, then compare each pair.
  const prevSalt = usePreviousDistinctValue(salt)
  const prevLog = usePreviousDistinctValue(log)
  const prevEnumCarveOut = usePreviousDistinctValue(enumCarveOut)
  const prevEnumThreshold = usePreviousDistinctValue(enumThreshold)
  const prevNamespaceUris = usePreviousDistinctValue(namespaceUris)
  const prevOverrides = usePreviousDistinctValue(overrides)
  const buildInputsChanged =
    prevSalt !== salt ||
    prevLog !== log ||
    prevEnumCarveOut !== enumCarveOut ||
    prevEnumThreshold !== enumThreshold ||
    prevNamespaceUris !== namespaceUris ||
    prevOverrides !== overrides
  if (buildInputsChanged && salt !== null) {
    setIsBuilding(true)
  }

  useEffect(() => {
    if (salt === null) return undefined
    let cancelled = false
    void Effect.runPromiseExit(
      buildAnonymizePreview(log, {
        salt,
        enumCarveOut,
        enumThreshold,
        namespaceUris,
        overrides,
      })
    ).then((exit) => {
      if (cancelled) return
      if (Exit.isSuccess(exit)) {
        setPreview(exit.value)
        setError(null)
      } else {
        // The archive must never be a stale one built under different
        // settings, so a failed rebuild clears the preview rather than
        // leaving the previous one downloadable.
        setPreview(null)
        setError(causeToError(exit.cause))
      }
      setIsBuilding(false)
    })
    return (): void => {
      cancelled = true
    }
  }, [salt, log, enumCarveOut, enumThreshold, namespaceUris, overrides])

  const download = useCallback((): void => {
    if (preview === null) return
    const archive = emitHarFromLog(preview.redacted, {
      comment: describeSettings(settings),
    })
    downloadBlob(harBlob(archive), anonymizedFileName(fileName))
  }, [preview, fileName, settings])

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
  type AnonymizeSettings,
  type AnonymizeState,
  DEFAULT_ANONYMIZE_SETTINGS,
  describeSettings,
  useAnonymize,
}
